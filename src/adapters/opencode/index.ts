/**
 * adapters/opencode — OpenCode platform adapter.
 *
 * Implements HookAdapter for OpenCode's TypeScript plugin paradigm.
 *
 * OpenCode hook specifics:
 *   - I/O: TS plugin functions (not JSON stdin/stdout)
 *   - Hook names: tool.execute.before, tool.execute.after, experimental.session.compacting
 *   - Arg modification: output.args mutation
 *   - Blocking: throw Error in tool.execute.before
 *   - Output modification: output.output mutation (TUI bug for bash #13575)
 *   - SessionStart: broken (#14808, no hook #5409)
 *   - Session ID: input.sessionID (camelCase!)
 *   - Project dir: ctx.directory in plugin init (no env var)
 *   - Config: opencode.json plugin array, .opencode/plugins/*.ts
 *   - Session dir: ~/.config/opencode/context-mode/sessions/
 */

import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  copyFileSync,
  accessSync,
  existsSync,
  constants,
  realpathSync,
} from "node:fs";
import { resolve, join } from "node:path";
import { homedir } from "node:os";

import { BaseAdapter, resolveContextModeDataRoot } from "../base.js";
import { stripJsonComments } from "../../util/jsonc.js";

import type {
  HookAdapter,
  HookParadigm,
  PlatformCapabilities,
  DiagnosticResult,
  PreToolUseEvent,
  PostToolUseEvent,
  PreCompactEvent,
  SessionStartEvent,
  PreToolUseResponse,
  PostToolUseResponse,
  PreCompactResponse,
  SessionStartResponse,
  HookRegistration,
  PlatformId,
} from "../types.js";

// ─────────────────────────────────────────────────────────
// OpenCode raw input types
// ─────────────────────────────────────────────────────────

/** Represents the combined input+output from OpenCode hooks, flattened for adapter parse methods. */
interface OpenCodeHookInput {
  /** From input.tool (both before and after hooks) */
  tool?: string;
  /** From input.sessionID */
  sessionID?: string;
  /** From input.callID */
  callID?: string;
  /** From output.args (before hook) or input.args (after hook) */
  args?: Record<string, unknown>;
  /** From output.output (after hook) */
  output?: string;
  /** From output.title (after hook) */
  title?: string;
  /** From output.metadata (after hook) */
  metadata?: unknown;
  /** For session start source (custom) */
  source?: string;
}

// ─────────────────────────────────────────────────────────
// Hook constants (re-exported from hooks.ts)
// ─────────────────────────────────────────────────────────

import { HOOK_TYPES as OPENCODE_HOOK_NAMES } from "./hooks.js";

// ─────────────────────────────────────────────────────────
// Adapter implementation
// ─────────────────────────────────────────────────────────

export type AdapterPlatformType = Extract<PlatformId, "opencode" | "kilo">;

/**
 * Runtime degradation options (opencode v2 compat). The plugin path probes
 * the host at setup time and reports what it ACTUALLY acquired — a degraded
 * capability is reported as unavailable instead of claimed.
 */
export interface OpenCodeAdapterOptions {
  /**
   * True when the host does not expose a session-context hook (e.g. opencode
   * v2 without a confirmed ctx.session.hook equivalent of the v1
   * experimental.chat.system.transform surrogate). Reports sessionStart /
   * canInjectSessionContext as unavailable instead of claiming them.
   */
  sessionContextDegraded?: boolean;
  /**
   * True when the host does not expose a compaction hook equivalent
   * (experimental.session.compacting is v1-only).
   */
  preCompactDegraded?: boolean;
}

/**
 * Whether a plugin array (the v1 `plugin` key or the v2 `plugins` key)
 * contains a context-mode entry.
 */
function pluginEntriesIncludeContextMode(value: unknown): boolean {
  return (
    Array.isArray(value) &&
    value.some((p: unknown) => typeof p === "string" && p.includes("context-mode"))
  );
}

// ─────────────────────────────────────────────────────────
// Process-global plugin state (hybrid-host guard + log dedupe)
// ─────────────────────────────────────────────────────────

export type PluginFlavor = "v1" | "v2";

export type ActivationEntry = {
  flavor: PluginFlavor;
  claimedAt: number;
  /**
   * Whether the claimant CONFIRMED native ctx_* tool registration at setup
   * time. v1 server() always registers the native tool map → true. v2
   * setup() sets this only after a working native tool surface is acquired;
   * a v2 claimant without confirmed native tools must NOT have the legacy
   * mcp.context-mode removed (it is the only remaining tool provider).
   */
  nativeToolsConfirmed?: boolean;
};

export type PluginGlobalState = {
  /** Hybrid-host activation registry, keyed by plugin id + normalized project dir. */
  activations: Map<string, ActivationEntry>;
  /** Keys of one-time (setup/degradation/duplicate) logs already emitted. */
  loggedOnce: Set<string>;
  /** Dedupe map for hook error logs, keyed by hook|code|message → last-logged ms. */
  errorDedupe: Map<string, number>;
};

const PLUGIN_STATE_KEY = "__contextModePluginState";

/**
 * Process-global state bag. Stored on globalThis so the guard survives the
 * plugin being loaded twice from different module copies (e.g. build/ and
 * .opencode/plugins/ copies loaded by the same host process). Defined here
 * (plugin.ts already imports this module) so the plugin runtime and the
 * adapter share the SAME registry.
 */
export function getPluginGlobalState(): PluginGlobalState {
  const g = globalThis as typeof globalThis & { [PLUGIN_STATE_KEY]?: PluginGlobalState };
  if (!g[PLUGIN_STATE_KEY]) {
    g[PLUGIN_STATE_KEY] = {
      activations: new Map(),
      loggedOnce: new Set(),
      errorDedupe: new Map(),
    };
  }
  return g[PLUGIN_STATE_KEY];
}

/**
 * Normalize a project directory for the activation registry key:
 * symlink-canonicalized (macOS /var ↔ /private/var — chdir reports the
 * resolved path while hosts may pass the unresolved one) + absolute +
 * case-folded on case-insensitive filesystems (darwin/win32). Dirs that do
 * not exist on disk fall back to lexical resolution.
 */
export function normalizeProjectKey(dir: string): string {
  let abs: string;
  try {
    abs = realpathSync(dir);
  } catch {
    abs = resolve(dir);
  }
  return process.platform === "win32" || process.platform === "darwin"
    ? abs.toLowerCase()
    : abs;
}

/**
 * Non-creating peek at the activation registry for a project. Used by the
 * adapter's legacy-MCP-removal policy (configureAllHooks / validateHooks):
 *
 *   - undefined → no plugin runtime has initialized in THIS process (e.g.
 *     the CLI runs standalone); callers fall back to the config-shape
 *     heuristic (v1 `plugin` key → native tools confirmed).
 *   - true/false → an in-process claimant exists (or the registry is live
 *     with no claimant for this project); its CONFIRMED native-tool state
 *     is authoritative — never remove mcp.context-mode on a guess.
 */
export function peekConfirmedNativeTools(projectDir: string): boolean | undefined {
  const g = globalThis as typeof globalThis & { [PLUGIN_STATE_KEY]?: PluginGlobalState };
  const state = g[PLUGIN_STATE_KEY]; // deliberately does NOT create the state
  if (!state) return undefined;
  const entry = state.activations.get(normalizeProjectKey(projectDir));
  if (!entry) return false;
  return entry.nativeToolsConfirmed === true;
}

/**
 * Whether the plugin's native ctx_* tools are CONFIRMED available — the
 * precondition for removing the legacy mcp.context-mode block.
 *
 * 1. In-process confirmation via the plugin activation registry (above):
 *    an active claimant for this project reports whether it actually
 *    registered native tools. A v1 claimant always did; a v2 claimant only
 *    when its full mandatory surface succeeded. This is authoritative —
 *    a v2 claimant with UNCONFIRMED native tools must keep mcp.context-mode
 *    even when the v1 `plugin` key is present in config (otherwise a
 *    hybrid host could end up with NO ctx_* tool provider at all).
 * 2. No plugin runtime in this process (standalone CLI doctor/upgrade):
 *    fall back to the config-shape heuristic — a context-mode entry under
 *    the v1 `plugin` key confirms availability (v1 server() always
 *    registers the native tool map). Keeps current v1 behavior.
 */
function nativeToolsConfirmedForRemoval(settings: Record<string, unknown>): boolean {
  const inProcess = peekConfirmedNativeTools(process.cwd());
  if (inProcess !== undefined) return inProcess;
  return pluginEntriesIncludeContextMode(settings.plugin);
}

export class OpenCodeAdapter extends BaseAdapter implements HookAdapter {
  get name(): string {
    return this.platform === "kilo" ? "KiloCode" : "OpenCode";
  }
  readonly paradigm: HookParadigm = "ts-plugin";
  private settingsPath?: string;

  readonly capabilities: PlatformCapabilities;

  private platform: AdapterPlatformType;

  constructor(platform: AdapterPlatformType = "opencode", options?: OpenCodeAdapterOptions) {
    // sessionDirSegments unused — opencode overrides getSessionDir()
    // with XDG_CONFIG_HOME / APPDATA logic
    super([".config", platform]);
    this.platform = platform;
    // Capability honesty (v2 compat): defaults keep the v1 claims unchanged.
    // Degradation options flip the affected claims to false so callers
    // (doctor, hybrid activation checks) never see a capability that the
    // runtime could not actually acquire.
    const sessionContextAvailable = options?.sessionContextDegraded !== true;
    const preCompactAvailable = options?.preCompactDegraded !== true;
    this.capabilities = {
      preToolUse: true,
      postToolUse: true,
      preCompact: preCompactAvailable,
      sessionStart: sessionContextAvailable,
      canModifyArgs: true,
      canModifyOutput: true, // with TUI bug caveat for bash (#13575)
      canInjectSessionContext: sessionContextAvailable,
    };
  }

  /**
   * Runtime honesty hook — the plugin path marks a capability unavailable
   * after probing the host (e.g. a v2 session-context registration call
   * failed even though the surface existed). Mirrors the constructor options
   * for state that is only knowable after registration attempts.
   */
  markCapabilityDegraded(cap: "sessionStart" | "canInjectSessionContext" | "preCompact"): void {
    if (cap === "sessionStart") this.capabilities.sessionStart = false;
    else if (cap === "canInjectSessionContext") this.capabilities.canInjectSessionContext = false;
    else this.capabilities.preCompact = false;
  }

  // ── Input parsing ──────────────────────────────────────

  parsePreToolUseInput(raw: unknown): PreToolUseEvent {
    const input = raw as OpenCodeHookInput;
    return {
      toolName: input.tool ?? "",
      toolInput: input.args ?? {},
      sessionId: this.extractSessionId(input),
      projectDir: process.env.OPENCODE_PROJECT_DIR || process.cwd(),
      raw,
    };
  }

  parsePostToolUseInput(raw: unknown): PostToolUseEvent {
    const input = raw as OpenCodeHookInput;
    return {
      toolName: input.tool ?? "",
      toolInput: input.args ?? {},
      toolOutput: input.output,
      isError: undefined, // OpenCode doesn't provide isError
      sessionId: this.extractSessionId(input),
      projectDir: process.env.OPENCODE_PROJECT_DIR || process.cwd(),
      raw,
    };
  }

  parsePreCompactInput(raw: unknown): PreCompactEvent {
    const input = raw as OpenCodeHookInput;
    return {
      sessionId: this.extractSessionId(input),
      projectDir: process.env.OPENCODE_PROJECT_DIR || process.cwd(),
      raw,
    };
  }

  parseSessionStartInput(raw: unknown): SessionStartEvent {
    const input = raw as OpenCodeHookInput;
    const rawSource = input.source ?? "startup";

    let source: SessionStartEvent["source"];
    switch (rawSource) {
      case "compact":
        source = "compact";
        break;
      case "resume":
        source = "resume";
        break;
      case "clear":
        source = "clear";
        break;
      default:
        source = "startup";
    }

    return {
      sessionId: this.extractSessionId(input),
      source,
      projectDir: process.env.OPENCODE_PROJECT_DIR || process.cwd(),
      raw,
    };
  }

  // ── Response formatting ────────────────────────────────

  formatPreToolUseResponse(response: PreToolUseResponse): unknown {
    if (response.decision === "deny") {
      // OpenCode TS plugin paradigm: throw Error to block
      throw new Error(
        response.reason ?? "Blocked by context-mode hook",
      );
    }
    if (response.decision === "modify" && response.updatedInput) {
      // OpenCode: output.args mutation
      return { args: response.updatedInput };
    }
    if (response.decision === "ask") {
      // OpenCode: no native "ask" mechanism — throw to be safe
      throw new Error(
        response.reason ?? "Action requires user confirmation (security policy)",
      );
    }
    // "context" — OpenCode's tool.execute.before cannot inject additionalContext
    // in PreToolUse (platform limitation). The guidance is delivered via
    // CLAUDE.md/AGENTS.md routing instructions instead. Passthrough.
    // "allow" — passthrough
    return undefined;
  }

  formatPostToolUseResponse(response: PostToolUseResponse): unknown {
    const result: Record<string, unknown> = {};
    if (response.updatedOutput) {
      // OpenCode: output.output mutation (TUI bug for bash #13575)
      result.output = response.updatedOutput;
    }
    if (response.additionalContext) {
      result.additionalContext = response.additionalContext;
    }
    return Object.keys(result).length > 0 ? result : undefined;
  }

  formatPreCompactResponse(response: PreCompactResponse): unknown {
    // experimental.session.compacting — return context string
    return response.context ?? "";
  }

  formatSessionStartResponse(response: SessionStartResponse): unknown {
    return response.context ?? "";
  }

  // ── Configuration ──────────────────────────────────────

  getSettingsPath(): string {
    if (this.settingsPath) return this.settingsPath;
    // Edge case (#849): writeSettings() called without a prior readSettings()
    // (which is what populates this.settingsPath). Never create a `.json` that
    // would shadow an existing `.jsonc` — OpenCode merges the project-root
    // `.jsonc` LAST, so it is the authoritative config
    // (refs/platforms/opencode/packages/opencode/src/config/config.ts:406-408
    // + paths.ts:15-22). Prefer the existing `.jsonc` as the write target.
    const jsoncPath = resolve(`${this.platform}.jsonc`);
    if (existsSync(jsoncPath)) return jsoncPath;
    return resolve(`${this.platform}.json`);
  }

  private paths(): string[] {
    // `.jsonc` is listed BEFORE `.json` so it is selected as the write target
    // when both exist (#849). OpenCode loads the project-root `.json` then
    // `.jsonc` and merges `.jsonc` last — scalars override-last, arrays concat
    // (refs/platforms/opencode/packages/opencode/src/config/config.ts:406-408,
    // 258-260 + paths.ts:15-22). The `.jsonc` is therefore the authoritative
    // file holding the user's real config; a `.json` is often an empty/auto-
    // generated placeholder. Writing into the placeholder would create a
    // file that shadows the user's real `.jsonc`. Preferring `.jsonc` for the
    // write target avoids that silent config destruction. Read order is
    // irrelevant for the plugin early-return (hasContextModePlugin) path.
    if (this.platform === "kilo") {
      // Kilo runtime accepts `.kilo/`, `.kilocode/`, and `.opencode/` as
      // project config dirs (refs/platforms/kilo/packages/opencode/src/
      // kilocode/config/config.ts:50,408). Mirror that here so context-mode
      // discovers config regardless of which suffix the user adopted.
      return [
        resolve("kilo.jsonc"),
        resolve("kilo.json"),
        resolve(".kilo", "kilo.jsonc"),
        resolve(".kilo", "kilo.json"),
        resolve(".kilocode", "kilo.jsonc"),
        resolve(".kilocode", "kilo.json"),
        join(homedir(), ".config", "kilo", "kilo.jsonc"),
        join(homedir(), ".config", "kilo", "kilo.json"),
      ];
    }
    return [
      resolve("opencode.jsonc"),
      resolve("opencode.json"),
      resolve(".opencode", "opencode.jsonc"),
      resolve(".opencode", "opencode.json"),
      join(homedir(), ".config", "opencode", "opencode.jsonc"),
      join(homedir(), ".config", "opencode", "opencode.json"),
    ];
  }

  getSessionDir(): string {
    // Issue #649: honor CONTEXT_MODE_DATA_DIR universal storage override
    // ahead of OpenCode/Kilo's XDG-rooted default. opencode.json + plugin
    // discovery stay under getConfigDir() so OpenCode itself sees its own
    // config in the expected location.
    const override = resolveContextModeDataRoot();
    const dir = override
      ? join(override, "context-mode", "sessions")
      : join(this.getConfigDir(), "context-mode", "sessions");
    mkdirSync(dir, { recursive: true });
    return dir;
  }

  /**
   * OpenCode/KiloCode honor XDG_CONFIG_HOME on POSIX and APPDATA on Windows.
   * Falls back to ~/.config/<platform> (or %APPDATA%\<platform>).
   * Always absolute. `_projectDir` is accepted for interface symmetry but
   * unused — config is home/XDG-rooted, never project-scoped.
   */
  getConfigDir(_projectDir?: string): string {
    let root: string;
    if (process.platform === "win32") {
      root = process.env.APPDATA || join(homedir(), "AppData", "Roaming");
    } else {
      root = process.env.XDG_CONFIG_HOME || join(homedir(), ".config");
    }
    return join(root, this.platform);
  }

  getInstructionFiles(): string[] {
    return ["AGENTS.md"];
  }

  generateHookConfig(_pluginRoot: string): HookRegistration {
    // OpenCode uses TS plugin paradigm — hooks are registered via plugin array
    // in opencode.json, not via command-based hook entries.
    // Return the hook name mapping for documentation purposes.
    return {
      [OPENCODE_HOOK_NAMES.BEFORE]: [
        {
          matcher: "",
          hooks: [
            {
              type: "plugin",
              command: "context-mode",
            },
          ],
        },
      ],
      [OPENCODE_HOOK_NAMES.AFTER]: [
        {
          matcher: "",
          hooks: [
            {
              type: "plugin",
              command: "context-mode",
            },
          ],
        },
      ],
      [OPENCODE_HOOK_NAMES.COMPACTING]: [
        {
          matcher: "",
          hooks: [
            {
              type: "plugin",
              command: "context-mode",
            },
          ],
        },
      ],
    };
  }

  readSettings(): Record<string, unknown> | null {
    this.settingsPath = undefined;
    const configPaths = this.paths();
    const globalPaths = new Set(configPaths.filter(p => p.includes(homedir())));
    let firstValidSettings: Record<string, unknown> | null = null;
    let firstValidPath: string | undefined;

    for (const configPath of configPaths) {
      try {
        const raw = readFileSync(configPath, "utf-8");
        const text = configPath.endsWith(".jsonc") ? stripJsonComments(raw) : raw;
        const settings = JSON.parse(text) as Record<string, unknown>;

        if (!firstValidSettings) {
          firstValidSettings = settings;
          firstValidPath = configPath;
        }

        const isGlobalConfig = globalPaths.has(configPath);

        if (this.hasContextModePlugin(settings) || isGlobalConfig) {
          this.settingsPath = configPath;
          return settings;
        }
      } catch {
        continue;
      }
    }

    if (firstValidSettings) {
      this.settingsPath = firstValidPath;
      return firstValidSettings;
    }
    return null;
  }

  writeSettings(settings: Record<string, unknown>): void {
    // Write to opencode.json(c)/kilo.json(c) in current directory
    writeFileSync(
      this.getSettingsPath(),
      JSON.stringify(settings, null, 2) + "\n",
      "utf-8",
    );
  }

  // ── Diagnostics (doctor) ─────────────────────────────────

  validateHooks(_pluginRoot: string): DiagnosticResult[] {
    const results: DiagnosticResult[] = [];
    const settings = this.readSettings();

    if (!settings) {
      results.push({
        check: "Plugin configuration",
        status: "fail",
        message: `Could not read ${this.platform}.json or ${this.platform}.jsonc`,
        fix: "context-mode upgrade",
      });
      return results;
    }

    // Check for "context-mode" in the plugin array — the v1 `plugin` key and
    // the v2 `plugins` key are both honored (opencode v2 renamed the key).
    const hasPlugin = this.hasContextModePlugin(settings);
    if (Array.isArray(settings.plugin) || Array.isArray(settings.plugins)) {
      results.push({
        check: "Plugin registration",
        status: hasPlugin ? "pass" : "fail",
        message: hasPlugin
          ? "context-mode found in plugin array"
          : "context-mode not found in plugin array",
        fix: hasPlugin
          ? undefined
          : "context-mode upgrade",
      });
    } else {
      results.push({
        check: "Plugin registration",
        status: "fail",
        message: `No plugin array found in ${this.platform}.json or ${this.platform}.jsonc`,
        fix: "context-mode upgrade",
      });
    }

    // Legacy mcp.context-mode removal policy (v2 compat): only remove when
    // plugin-native ctx_* tools are CONFIRMED available — via the plugin
    // activation registry when a claimant is live in this process, otherwise
    // via the config-shape heuristic (v1 `plugin` key). A v2 claimant whose
    // native tool registration did NOT succeed must keep the MCP entry: it
    // is the only remaining tool provider.
    if (this.hasLegacyContextModeMcp(settings)) {
      if (nativeToolsConfirmedForRemoval(settings)) {
        results.push({
          check: "Legacy MCP registration",
          status: "warn",
          message: "mcp.context-mode is redundant: ctx_* tools are now provided by the plugin",
          fix: "context-mode upgrade (removes only mcp.context-mode; preserves other MCP servers)",
        });
      } else {
        results.push({
          check: "Legacy MCP registration",
          status: "pass",
          message:
            "mcp.context-mode retained as tool fallback: v2 plugin native tool registration unconfirmed",
        });
      }
    }

    // Note: SessionStart handled via experimental.chat.system.transform surrogate
    // — claim it only when the session-context capability was actually acquired
    // (v2-degraded hosts report it as unavailable instead).
    if (this.capabilities.sessionStart) {
      results.push({
        check: "SessionStart hook",
        status: "pass",
        message:
          `SessionStart via experimental.chat.system.transform surrogate (native hook pending #14808, #5409)`,
      });
    } else {
      results.push({
        check: "SessionStart hook",
        status: "warn",
        message:
          "SessionStart surrogate unavailable: session-context hook not confirmed on this host (v2 degraded) — resume snapshot injection inactive",
      });
    }

    return results;
  }

  checkPluginRegistration(): DiagnosticResult {
    const settings = this.readSettings();
    if (!settings) {
      return {
        check: "Plugin registration",
        status: "warn",
        message: `Could not read ${this.platform}.json or ${this.platform}.jsonc`,
      };
    }

    if (this.hasContextModePlugin(settings)) {
      return {
        check: "Plugin registration",
        status: "pass",
        message: "context-mode found in plugin array",
      };
    }

    return {
      check: "Plugin registration",
      status: "fail",
      message: `context-mode not found in ${this.platform}.json plugin array`,
      fix: "context-mode upgrade",
    };
  }

  getInstalledVersion(): string {
    // Check ~/.cache/opencode/node_modules/ for context-mode
    try {
      const pkgPath = resolve(
        homedir(),
        ".cache",
        this.platform,
        "node_modules",
        "context-mode",
        "package.json",
      );
      const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
      if (typeof pkg.version === "string") return pkg.version;
    } catch {
      /* not found */
    }
    return "not installed";
  }

  // ── Upgrade ────────────────────────────────────────────

  configureAllHooks(_pluginRoot: string): string[] {
    const settings = this.readSettings() ?? {};
    const changes: string[] = [];

    // Config compat (opencode v1 → v2): the v1 key is `plugin`, the v2 key is
    // `plugins`. Both are honored on READ and kept in sync on WRITE when they
    // exist, so whichever host flavor loads picks up the plugin. When NEITHER
    // key exists, write the v1 key (v1-shaped hosts read `plugin`; hosts
    // ≥1.17.10 that boot the v2 core also load via server()).
    const v1KeyPresent = Array.isArray(settings.plugin);
    const v2KeyPresent = Array.isArray(settings.plugins);

    if (v1KeyPresent) {
      const plugins = [...(settings.plugin as unknown[])];
      if (pluginEntriesIncludeContextMode(plugins)) {
        changes.push("context-mode already in plugin array");
      } else {
        plugins.push("context-mode");
        changes.push("Added context-mode to plugin array");
      }
      settings.plugin = plugins;
    }
    if (v2KeyPresent) {
      const plugins = [...(settings.plugins as unknown[])];
      if (pluginEntriesIncludeContextMode(plugins)) {
        changes.push("context-mode already in plugins array");
      } else {
        plugins.push("context-mode");
        changes.push("Added context-mode to plugins array");
      }
      settings.plugins = plugins;
    }
    if (!v1KeyPresent && !v2KeyPresent) {
      settings.plugin = ["context-mode"];
      changes.push("Added context-mode to plugin array");
    }

    // Legacy mcp.context-mode removal policy (v2 compat): only remove when
    // plugin-native ctx_* tools are CONFIRMED available — via the plugin
    // activation registry when a claimant is live in this process, otherwise
    // via the config-shape heuristic (v1 `plugin` key). A v2 claimant whose
    // native tool registration did NOT succeed must keep the MCP entry: it
    // is the only remaining tool provider.
    const nativeToolsConfirmed = nativeToolsConfirmedForRemoval(settings);
    const mcp = settings.mcp;
    if (mcp && typeof mcp === "object" && !Array.isArray(mcp)) {
      const servers = mcp as Record<string, unknown>;
      if (Object.prototype.hasOwnProperty.call(servers, "context-mode")) {
        if (nativeToolsConfirmed) {
          delete servers["context-mode"];
          changes.push("Removed legacy context-mode MCP block (plugin-native tools)");
        } else {
          changes.push("Kept legacy context-mode MCP block (v2 native tool registration unconfirmed)");
        }
      }
      if (Object.keys(servers).length === 0) delete settings.mcp;
    }

    this.writeSettings(settings);
    return changes;
  }

  backupSettings(): string | null {
    const check = this.checkPluginRegistration();
    
    if (!this.settingsPath) return null;

    if (check.status === "pass") {
      return this.settingsPath;
    } else {
      try {
        accessSync(this.settingsPath, constants.R_OK);
        const backupPath = this.settingsPath + ".bak";
        copyFileSync(this.settingsPath, backupPath);
        return backupPath;
      } catch { 
        return null;
       }
    }
  }

  setHookPermissions(_pluginRoot: string): string[] {
    // OpenCode uses TS plugin paradigm — no shell scripts to chmod
    return [];
  }

  updatePluginRegistry(_pluginRoot: string, _version: string): void {
    // OpenCode manages plugins through npm/opencode.json — no separate registry
  }

  // ── Internal helpers ───────────────────────────────────

  /**
   * Check whether a settings object has the context-mode plugin registered.
   * Honors both the v1 `plugin` key and the v2 `plugins` key (opencode v2
   * renamed the config key).
   */
  private hasContextModePlugin(settings: Record<string, unknown>): boolean {
    return (
      pluginEntriesIncludeContextMode(settings.plugin) ||
      pluginEntriesIncludeContextMode(settings.plugins)
    );
  }

  private hasLegacyContextModeMcp(settings: Record<string, unknown>): boolean {
    const mcp = settings.mcp;
    return !!(
      mcp &&
      typeof mcp === "object" &&
      !Array.isArray(mcp) &&
      Object.prototype.hasOwnProperty.call(mcp, "context-mode")
    );
  }

  /**
   * Extract session ID from OpenCode hook input.
   * OpenCode uses camelCase sessionID.
   */
  private extractSessionId(input: OpenCodeHookInput): string {
    if (input.sessionID) return input.sessionID;
    return `pid-${process.ppid}`;
  }
}
