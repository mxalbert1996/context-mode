/**
 * OpenCode / KiloCode TypeScript plugin entry point for context-mode.
 *
 * Dual-flavor compatibility (opencode v1 + v2):
 *   - v1 hosts load the plugin via `server(input)` (PluginModule default
 *     export with shape `{ id, server }`).
 *   - v2 hosts load the plugin via `setup(ctx)` on the default-export object
 *     `{ id, server?, setup }` (v2 PluginModule shape).
 *   Both entries live on the SAME default export object; each host picks the
 *     entrypoint it supports. No `tui` marker is set (it would invalidate
 *     server loading per the v2 migration guide).
 *
 * The v2 PluginContext surface is VERIFIED (opencode2 beta-19135 live probe
 * + docs at opencode.ai/v2/docs/build/plugins): ctx.tool.transform(editor)
 * registers native ctx_* tools (ToolEditor), ctx.tool.hook
 * ("execute.before"/"execute.after") bridges routing enforcement + capture,
 * ctx.session.hook("context"|"prompt") covers system-context injection
 * (continuations AND compaction) and user-prompt capture, and
 * ctx.event.subscribe() streams bus events. The v2 `setup` path probes each
 * surface defensively (typeof checks; UNCONFIRMED payload fields are read
 * defensively) and degrades HONESTLY — one-time log, never fake success.
 * Mandatory for activation: native tool registration AND execute hooks;
 * anything mandatory missing → no claim (MCP fallback stays intact); the
 * session/event surfaces are optional and degrade with one-time logs.
 *
 * Hybrid-host guard: a process-global activation registry (keyed by plugin
 * id + normalized project directory) ensures only ONE flavor activates per
 * project per process. The second entrypoint (v1 server() or v2 setup())
 * returns a noop/empty registration and logs once ("context-mode already
 * active via <flavor>"). v1 claims if no claimant exists; v1 behavior is
 * otherwise unchanged for existing users.
 *
 * Five hooks (v1.0.107 — Mickey OC-1..OC-4 follow-up):
 *   - tool.execute.before  — Routing enforcement (deny/modify/passthrough)
 *   - tool.execute.after   — Session event capture + first-fire AGENTS.md scan (OC-4)
 *   - experimental.session.compacting — Compaction snapshot + budget-capped auto-injection (OC-3)
 *   - experimental.chat.system.transform — ROUTING_BLOCK + resume snapshot injection (OC-1)
 *   - chat.message         — User-prompt capture w/ CCv2 inline filter (OC-2) + AGENTS.md scan (OC-4)
 *
 * KiloCode loads this via: import("@mxalbert/context-mode") → expects default export
 * with shape { server: (input) => Promise<Hooks> } (PluginModule).
 *
 * OpenCode loads this via: import("@mxalbert/context-mode/plugin") → also supports
 * the named export ContextModePlugin for backward compat.
 *
 * Constraints:
 *   - No SessionStart hook (OpenCode doesn't support it — #14808, #5409)
 *   - context injection now via chat.system.transform surrogate (OC-1)
 *   - No routing file auto-write (avoid dirtying project trees)
 *   - Session cleanup happens at plugin init (no SessionStart)
 */

import { dirname, resolve, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, writeSync } from "node:fs";
import { homedir } from "node:os";

import { resolveSessionDbPath, SessionDB } from "../../session/db.js";
import { extractEvents, extractUserEvents, parseOpencodeUsage, buildAgentUsageEvent } from "../../session/extract.js";
import type { HookInput } from "../../session/extract.js";
import { buildResumeSnapshot } from "../../session/snapshot.js";
import type { SessionEvent } from "../../types.js";
import {
  AdapterPlatformType,
  OpenCodeAdapter,
  getPluginGlobalState,
  normalizeProjectKey,
  type PluginGlobalState,
} from "./index.js";
import type { OpenCodeAdapterOptions } from "./index.js";
import { PLATFORM_ENV_VARS } from "../detect.js";
import { zod3ShapeToV4 } from "./zod3tov4.js";
import {
  extractV2ToolErrorText,
  extractV2ToolResultText,
  v2SessionIdOf,
  v2SystemPartText,
  v2ToolNameOf,
  zodSchemaToJsonSchema,
  type PluginClient,
  type PluginClientAppLogBodyExtra,
  type V2SetupContext,
  type V2ToolEditor,
  type V2ToolInfo,
} from "./v2.js";

// ── Types ─────────────────────────────────────────────────
// Host client log types (PluginClient family) live in ./v2.ts and are
// imported above — single definition shared by the v1 and v2 paths.

type PluginContext = {
  client: PluginClient;
  directory: string;
};

type NativeToolContext = {
  sessionID: string;
  messageID: string;
  agent: string;
  directory: string;
  worktree?: string;
  abort?: AbortSignal;
  metadata?: (input: { title?: string; metadata?: Record<string, unknown> }) => void;
};

type NativeToolDefinition = {
  description: string;
  args: Record<string, unknown>;
  /**
   * JSON-Schema view of the tool's Zod input schema (single shared
   * conversion via zodSchemaToJsonSchema) — consumed by the v2 ToolEditor
   * registration (ToolInfo.input). v1 hosts ignore this extra field.
   */
  inputJsonSchema?: Record<string, unknown>;
  execute: (
    args: Record<string, unknown>,
    ctx: NativeToolContext,
  ) => Promise<string | { title?: string; output: string; metadata?: Record<string, unknown> }>;
};

/** OpenCode tool.execute.before — first parameter */
interface BeforeHookInput {
  tool: string;
  sessionID: string;
  callID: string;
}

/** OpenCode tool.execute.before — second parameter */
interface BeforeHookOutput {
  args: any;
}

/** OpenCode tool.execute.after — first parameter */
interface AfterHookInput {
  tool: string;
  sessionID: string;
  callID: string;
  args: any;
}

/** OpenCode tool.execute.after — second parameter */
interface AfterHookOutput {
  title: string;
  output: string;
  metadata: any;
  /**
   * Failure signal consumed by the shared capture handler. The v1 host
   * never sets it (OpenCode doesn't provide isError — the response text
   * alone drives error detection); the v2 execute.after bridge sets it on
   * `status: "error"` so failed tool calls produce error_tool events via
   * the SAME extractEvents path (extract.ts isToolError).
   */
  isError?: boolean;
}

/**
 * OpenCode generic bus `event` hook — single parameter.
 * The plugin SDK delivers every bus Event here (refs/platforms/opencode/
 * packages/plugin/src/index.ts:224). We narrow to `message.updated`, whose
 * `properties.info` is the full assistant Message carrying tokens/cost/modelID.
 */
interface EventHookInput {
  event?: {
    type?: string;
    properties?: { info?: { sessionID?: string } & Record<string, unknown> };
  };
}

/** OpenCode experimental.session.compacting — first parameter */
interface CompactingHookInput {
  sessionID: string;
}

/** OpenCode experimental.session.compacting — second parameter */
interface CompactingHookOutput {
  context: string[];
  prompt?: string;
}

/**
 * OpenCode experimental.chat.system.transform — first parameter.
 * Verified against sst/opencode/dev/packages/plugin/src/index.ts:
 *   input: { sessionID?: string; model: Model }
 * `sessionID` is optional in the SDK type but is in practice always set
 * (the transform runs *for* a session). We treat it as required and
 * skip injection when absent rather than fall back to a fabricated ID.
 *
 * NOTE: We deliberately do NOT use `experimental.chat.messages.transform`.
 * Its SDK input shape is `{}` (no sessionID) and its output is
 * `{ messages: { info: Message; parts: Part[] }[] }` — the prior code
 * (`output.messages.unshift({ role, content })`) wrote a value of the
 * wrong shape and was silently dropped (Mickey / PR #376 root cause).
 */
interface SystemTransformHookInput {
  sessionID?: string;
  model: unknown;
}

/** OpenCode experimental.chat.system.transform — second parameter */
interface SystemTransformHookOutput {
  system: string[];
}

/**
 * OpenCode chat.message hook — verified against
 * refs/platforms/opencode/packages/plugin/src/index.ts:233.
 *   input:  { sessionID; agent?; model?; messageID?; variant? }
 *   output: { message: UserMessage; parts: Part[] }
 * We read text from `parts[*].text` (the orchestrator reference at
 * refs/plugin-examples/opencode/opencode-orchestrator/src/plugin-handlers/
 * chat-message-handler.ts:41-65 uses the same pattern).
 */
interface ChatMessageHookInput {
  sessionID: string;
  agent?: string;
  messageID?: string;
}

interface ChatMessagePart {
  type: string;
  text?: string;
}

interface ChatMessageHookOutput {
  message: unknown;
  parts: ChatMessagePart[];
}

// v2 setup-context / ToolEditor / ToolInfo types live in ./v2.ts (imported
// above) — VERIFIED surface + defensive payload readers live there too.

// Synthetic message tags emitted by harnesses (CCv2 inline filter). When the
// user "message" is actually a system-generated nudge (e.g. tool-result, system
// reminder), capturing it as user_prompt would flood the DB with noise.
const SYNTHETIC_MESSAGE_PREFIXES = [
  "<task-notification>",
  "<system-reminder>",
  "<context_guidance>",
  "<tool-result>",
];

function isSyntheticMessage(text: string): boolean {
  const trimmed = text.trim();
  return SYNTHETIC_MESSAGE_PREFIXES.some((p) => trimmed.startsWith(p));
}

// ── Helpers ───────────────────────────────────────────────

// Quorum markers — must NOT be substrings of each other (#487).
// Each token uniquely identifies the routing block / context-mode rules
// without overlapping any other marker. The XML tag is the primary signal;
// the two distinctive bare tool names are the secondary signals. Together
// any 2 of 3 confirm the system prompt already carries routing instructions.
const ROUTING_MARKERS = [
  "<context_window_protection>",
  "ctx_search",
  "ctx_index",
];

function systemHasRoutingInstructions(system: string[]): boolean {
  const text = system.join("\n");
  // Word-boundary check guards against unrelated identifiers that happen to
  // share a prefix/suffix (e.g. a hypothetical `ctx_search_v2`).
  const wordBoundary = (m: string) => {
    if (m.startsWith("<")) return text.includes(m);
    const re = new RegExp(`(?:^|\\W)${m.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\$&")}(?:\\W|$)`);
    return re.test(text);
  };
  return ROUTING_MARKERS.filter(wordBoundary).length >= 2;
}

/**
 * Detect whether the plugin is running under KiloCode or OpenCode.
 *
 * Reuses the canonical PLATFORM_ENV_VARS list (src/adapters/detect.ts) instead
 * of hardcoding env var names — single source of truth, future-proof if Kilo
 * or OpenCode add/rename env vars upstream.
 *
 * Order matters: KiloCode is an OpenCode fork and sets `OPENCODE=1` in
 * addition to `KILO_PID`. PLATFORM_ENV_VARS lists `kilo` BEFORE `opencode`
 * so KILO_PID wins the iteration.
 *
 * Pre-fix version was `return process.env.KILO_PID ? "kilo" : "opencode";` —
 * surfaced by github.com/mksglu/context-mode/pull/376 (mikij). Full symmetric
 * fix: also actively check opencode env vars instead of blind fallback.
 */
function getPlatform(): AdapterPlatformType {
  for (const [platform, vars] of PLATFORM_ENV_VARS) {
    if (platform !== "kilo" && platform !== "opencode") continue;
    if (vars.some((v) => process.env[v.name])) {
      return platform as AdapterPlatformType;
    }
  }
  // Plugin host should always set one of the env vars. Fallback to opencode
  // (the wider ecosystem) when neither is set, for predictable behavior.
  return "opencode";
}

// ── Hybrid-host guard state (shared machinery lives in hooks.ts) ────

/** Test-only: clear process-global activation + log-dedupe state. */
export function __resetPluginStateForTests(): void {
  const state = getPluginGlobalState();
  state.activations.clear();
  state.loggedOnce.clear();
  state.errorDedupe.clear();
}

/** Test-only: expose the process-global state for assertions. */
export function __getPluginGlobalState(): PluginGlobalState {
  return getPluginGlobalState();
}

// ── Logging (detailed error reporting for hook catch-alls) ────

/**
 * Write to stderr — NEVER stdout (stdout is a protocol/transport channel for
 * MCP hosts and must never receive diagnostics).
 */
function stderrWrite(message: string): void {
  try {
    process.stderr.write(`[context-mode] ${message}\n`);
  } catch {
    // stderr unavailable — nothing further we can do
  }
}

// ── File sink (opencode data-dir diagnostics log) ─────────
// Plugin diagnostics must NOT leak onto the v1 TUI (user decision): the
// stderr fallback exists solely as a last resort when the file sink itself
// is unavailable. Both opencode v1 and v2 use the data dir name `opencode`
// under the XDG data root (v1 already keeps `log/` there), so the plugin
// appends its diagnostics next to the host's own dated log files.

let sinkFd: number | null = null;
let sinkPath: string | null = null;
let sinkFailed = false;

/** Resolve the sink path — verified layout: <data-root>/opencode/log/context-mode.log. */
function resolveSinkPath(): string {
  const dataRoot =
    process.env.XDG_DATA_HOME && process.env.XDG_DATA_HOME.length > 0
      ? process.env.XDG_DATA_HOME
      : join(homedir(), ".local", "share");
  return join(dataRoot, "opencode", "log", "context-mode.log");
}

/**
 * Lazily open the append fd (O_APPEND|O_CREAT|O_WRONLY). Returns the sink
 * path on success or null when the sink is unavailable (mkdir/open failed,
 * or a previous write failure marked the sink dead). Never throws.
 */
function sinkLogFilePath(): string | null {
  if (sinkFailed) return null;
  if (sinkFd !== null && sinkPath !== null) return sinkPath;
  const path = resolveSinkPath();
  try {
    mkdirSync(dirname(path), { recursive: true });
  } catch {
    sinkFailed = true;
    return null;
  }
  try {
    sinkFd = openSync(path, "a");
    sinkPath = path;
    return path;
  } catch {
    sinkFailed = true;
    return null;
  }
}

/**
 * One newline-terminated line: `[<ISO-8601>] [<LEVEL>] <message>`.
 * Returns false on ANY write failure (the fd is then closed and the sink
 * marked dead so the caller can degrade to stderr). Never throws.
 */
function writeSinkLine(level: EmitLevel, message: string): boolean {
  const fd = sinkFd;
  if (fd === null) return false;
  try {
    writeSync(fd, `[${new Date().toISOString()}] [${level.toUpperCase()}] ${message}\n`);
    return true;
  } catch {
    try {
      closeSync(fd);
    } catch {
      // Best-effort close — the fd may already be unusable.
    }
    sinkFd = null;
    sinkPath = null;
    sinkFailed = true;
    return false;
  }
}

/** Test-only: close the cached fd and clear the sink cache so each test gets a fresh sink. */
export function __resetPluginLogSinkForTests(): void {
  if (sinkFd !== null) {
    try {
      closeSync(sinkFd);
    } catch {
      /* already closed */
    }
  }
  sinkFd = null;
  sinkPath = null;
  sinkFailed = false;
}

type EmitLevel = "info" | "warn" | "error";

/**
 * SINGLE best-effort host-logger for the whole plugin (unified stack).
 *
 * Policy (user decision: plugin diagnostics must NOT leak onto the v1 TUI):
 *   1. ALWAYS write to the file sink inside opencode's data dir
 *      (<XDG_DATA_HOME ?? ~/.local/share>/opencode/log/context-mode.log).
 *   2. Additionally call ctx.client.app.log when available (v2 host
 *      integration — never touches the TUI in normal runs).
 *   3. stderr ONLY as the last resort — when the file sink is unavailable
 *      or its write failed.
 * Never throws and never rejects: log failures must not break hooks or
 * turns. All emitters (debug safeLog, deduped hook-error logs, one-time
 * setup/degradation logs, setup failure logs) route through this function;
 * the dedupe/rate-limit and OPENCODE_DEBUG stack policy live in the callers
 * that own those semantics (logHookErrorImpl / formatPluginError).
 */
function emitHostLog(
  ctx: unknown,
  level: EmitLevel,
  message: string,
  extra?: PluginClientAppLogBodyExtra,
): void {
  const maybeClient = (ctx as { client?: PluginClient } | null | undefined)?.client;
  const logFn =
    maybeClient && typeof maybeClient === "object"
      ? maybeClient?.app?.log
      : undefined;
  const hasExtra = extra !== undefined && extra !== null;

  // 1. File sink — ALWAYS.
  let sinkOk = false;
  const sinkPath = sinkLogFilePath();
  if (sinkPath !== null) sinkOk = writeSinkLine(level, message);

  // 2. Host client integration — preserved.
  if (typeof logFn === "function") {
    try {
      Promise.resolve(
        logFn.call(maybeClient, {
          body: {
            service: "context-mode-logger",
            level,
            message,
            extra: hasExtra ? extra : undefined,
          },
        }),
      ).catch(() => {
        if (!sinkOk) stderrWrite(message);
      });
    } catch {
      if (!sinkOk) stderrWrite(message);
    }
    return;
  }
  // 3. stderr last-resort ONLY when the file sink failed.
  if (!sinkOk) stderrWrite(message);
}

/**
 * Format a plugin error line: plugin tag, hook name, sessionId, error
 * name/code/message. Stack is FULL when OPENCODE_DEBUG, otherwise the first
 * ~2 stack lines are included.
 */
function formatPluginError(hookName: string | null, err: unknown, sessionId?: string): string {
  const e = (err ?? {}) as { name?: string; code?: string; message?: string; stack?: string };
  const message =
    typeof e.message === "string" && e.message ? e.message : String(err);
  const head =
    `[context-mode] hook ${hookName ?? "plugin"}` +
    (sessionId ? ` (session ${sessionId})` : "") +
    ` failed: ` +
    [e.name, e.code ? `code=${e.code}` : null, message].filter(Boolean).join(" ");
  const stack = typeof e.stack === "string" && e.stack ? e.stack : "";
  if (process.env.OPENCODE_DEBUG) {
    return stack ? `${head}\n${stack}` : head;
  }
  const stackLines = stack
    ? stack.split("\n").slice(1, 3).filter((l) => l.trim().length > 0)
    : [];
  return stackLines.length > 0 ? `${head}\n${stackLines.join("\n")}` : head;
}

const ERROR_LOG_DEDUPE_WINDOW_MS = 30_000;
const ERROR_LOG_DEDUPE_MAX_KEYS = 256;

/**
 * Detailed, rate-limited error logging for the hook catch-alls. Identical
 * errors (same hook + code + message) are logged at most once per 30s so a
 * wedged SQLite handle does not spam the log on every tool call.
 */
function logHookErrorImpl(
  state: PluginGlobalState,
  ctx: unknown,
  hookName: string,
  err: unknown,
  sessionId?: string,
): void {
  const e = (err ?? {}) as { code?: string; message?: string };
  const message =
    typeof e.message === "string" && e.message ? e.message : String(err);
  const key = `${hookName}|${e.code ?? ""}|${message}`;
  const now = Date.now();
  const last = state.errorDedupe.get(key);
  if (last !== undefined && now - last < ERROR_LOG_DEDUPE_WINDOW_MS) return;
  if (state.errorDedupe.size >= ERROR_LOG_DEDUPE_MAX_KEYS) {
    // Bounded memory: drop the oldest entry before inserting.
    const oldest = state.errorDedupe.keys().next().value;
    if (oldest !== undefined) state.errorDedupe.delete(oldest);
  }
  state.errorDedupe.set(key, now);
  emitHostLog(ctx, "error", formatPluginError(hookName, err, sessionId), { sessionId });
}

/** One-time log — each key is emitted at most once per process. */
function logOnceImpl(
  state: PluginGlobalState,
  ctx: unknown,
  key: string,
  message: string,
  level: EmitLevel = "info",
): void {
  if (state.loggedOnce.has(key)) return;
  state.loggedOnce.add(key);
  emitHostLog(ctx, level, message);
}

// ── Plugin runtime (shared state for v1 and v2 paths) ─────

/**
 * Per-plugin-process state shared by the v1 `server()` path and the v2
 * `setup()` path. Both flavors bridge to the SAME handler functions built
 * over this runtime — logic is never duplicated across flavors.
 */
interface PluginRuntime {
  ctx: PluginContext;
  platform: AdapterPlatformType;
  adapter: OpenCodeAdapter;
  projectDir: string;
  db: SessionDB;
  routing: {
    routePreToolUse: (...args: unknown[]) => any;
    /** v2-native availability signal (hooks/core/routing.mjs) — optional: older routing copies lack it. */
    setContextModeToolsAvailable?: (available: boolean) => void;
  };
  routingBlock: string;
  autoInjectionMod: { buildAutoInjection: (events: unknown) => string };
  captureAgentsMd: (sessionId: string) => void;
  buildNativeTools: () => Promise<Record<string, NativeToolDefinition>>;
  logger: (message?: string, extra?: PluginClientAppLogBodyExtra) => Promise<void>;
  safeLog: (message?: string, extra?: PluginClientAppLogBodyExtra) => Promise<void>;
  logHookError: (hookName: string, err: unknown, sessionId?: string) => void;
  logOnce: (key: string, message: string, level?: EmitLevel) => void;
  /**
   * Liveness gate for v2-registered callbacks (defense-in-depth). Set to
   * true by teardownV2 BEFORE any dispose / claim release: hosts whose
   * registration calls succeed but return NO dispose handle cannot be fully
   * unregistered, so their stale callbacks are neutralized instead — every
   * v2 entry point below checks this flag and no-ops (no throw, no DB touch)
   * once the runtime is torn down. The v1 path never tears a runtime down.
   */
  closed: boolean;
}

/**
 * Initialize the shared plugin runtime: dynamic imports of the .mjs islands,
 * routing security init, per-project SessionDB (eager — matches v1 behavior),
 * startup session cleanup, and the AGENTS.md capture machinery (OC-4).
 */
async function createPluginRuntime(
  ctx: PluginContext,
  projectDirOverride?: string,
  adapterOptions?: OpenCodeAdapterOptions,
): Promise<PluginRuntime> {
  // Resolve build dir from compiled JS location
  const platform = getPlatform();
  const adapter = new OpenCodeAdapter(platform, adapterOptions);
  const buildDir = dirname(fileURLToPath(import.meta.url));
  // initSecurity() looks for `<dir>/security.js`, which lives at the
  // top of build/ — two levels up from this adapter directory.
  const buildRoot = resolve(buildDir, "..", "..");

  // Load routing module (ESM .mjs, lives outside build/ in hooks/)
  const routingPath = resolve(buildDir, "..", "..", "..", "hooks", "core", "routing.mjs");
  const routing = (await import(pathToFileURL(routingPath).href)) as PluginRuntime["routing"];
  await (routing as unknown as { initSecurity: (root: string) => Promise<unknown> }).initSecurity(buildRoot);

  // OC-1 / OC-3: Load hook helpers once at plugin init. Dynamic import keeps
  // the .mjs ESM islands isolated from the .ts compile graph.
  const routingBlockPath = resolve(buildDir, "..", "..", "..", "hooks", "routing-block.mjs");
  const routingBlockMod = await import(pathToFileURL(routingBlockPath).href);
  const toolNamingPath = resolve(buildDir, "..", "..", "..", "hooks", "core", "tool-naming.mjs");
  const toolNamingMod = await import(pathToFileURL(toolNamingPath).href);
  const autoInjectionPath = resolve(buildDir, "..", "..", "..", "hooks", "auto-injection.mjs");
  const autoInjectionMod = (await import(pathToFileURL(autoInjectionPath).href)) as PluginRuntime["autoInjectionMod"];

  // Pre-build the routing block once per process — it is platform-specific
  // (tool naming differs between opencode and kilo) but does NOT depend on
  // sessionID, so we cache it. createToolNamer accepts both "opencode" and
  // "kilo" per hooks/core/tool-naming.mjs:25-26.
  const toolNamer = (toolNamingMod as unknown as { createToolNamer: (platform: string) => unknown }).createToolNamer(platform);
  const routingBlock: string = (routingBlockMod as unknown as { createRoutingBlock: (namer: unknown) => string }).createRoutingBlock(toolNamer);

  // Initialize per-process state. We do NOT fabricate a sessionId here —
  // OpenCode/Kilo provide the real `input.sessionID` on every hook, and a
  // process-global UUID would (a) never match prior-session resume rows and
  // (b) collide across multi-session reuse (Mickey / PR #376 root cause).
  const projectDir = projectDirOverride ?? ctx?.directory ?? process.cwd();
  // C2 narrowing: resolve DB path through the canonical helper directly.
  // BaseAdapter no longer exposes getSessionDBPath; the adapter only owns
  // the sessions DIR (per-platform), the helper owns the per-project FILE
  // (case-fold + worktree-suffix + one-shot legacy migration).
  const db = new SessionDB({
    dbPath: resolveSessionDbPath({ projectDir, sessionsDir: adapter.getSessionDir() }),
  });

  // Clean up old sessions on startup (no SessionStart hook to do this).
  db.cleanupOldSessions(7);

  // OC-4 (#487 follow-up): per-session capture gate. PR #487 trusted the host
  // to deliver AGENTS.md events, but OpenCode only fires `rule_content` events
  // when the user explicitly reads the file. snapshot.ts:172 + analytics.ts:152
  // CONSUME `rule_content` to render rules into the resume snapshot — without
  // this capture path, AGENTS.md is silently absent from continuity output.
  // Keyed by sessionId (NOT projectDir) so multi-session reuse within a long-
  // lived plugin process still gets per-session capture exactly once.
  const agentsMdCaptured = new Set<string>();

  /**
   * OC-4: Read AGENTS.md (with CLAUDE.md / CONTEXT.md fallbacks) from the
   * project directory and persist as `rule` + `rule_content` events. Mirrors
   * the CC SessionStart pattern at hooks/sessionstart.mjs:121-132 and the
   * OpenCode instruction.ts FILES order. Idempotent via `agentsMdCaptured`
   * Set keyed by sessionId. Fail-soft: missing/unreadable files do not throw.
   */
  function captureAgentsMd(sessionId: string): void {
    if (agentsMdCaptured.has(sessionId)) return;
    agentsMdCaptured.add(sessionId);
    const candidates = ["AGENTS.md", "CLAUDE.md", "CONTEXT.md"];
    for (const name of candidates) {
      try {
        const p = join(projectDir, name);
        if (!existsSync(p)) continue;
        const content = readFileSync(p, "utf-8");
        if (!content.trim()) continue;
        db.insertEvent(sessionId, {
          type: "rule",
          category: "rule",
          data: p,
          priority: 1,
        } as SessionEvent, "PluginInit");
        db.insertEvent(sessionId, {
          type: "rule_content",
          category: "rule",
          data: content,
          priority: 1,
        } as SessionEvent, "PluginInit");
      } catch {
        // file missing or unreadable — skip silently
      }
    }
  }

  /**
   * Debug logger — thin wrapper over the UNIFIED host-logger (emitHostLog).
   * Same body shape as before (service/level/message/extra), but never
   * rejects: emitHostLog already handles transport failures by falling back
   * to stderr, so a broken ctx.client.app.log cannot break the turn (#448).
   */
  function logger(
    message = "context-mode debug log",
    extra?: PluginClientAppLogBodyExtra,
  ): Promise<void> {
    emitHostLog(ctx, "info", message, extra);
    return Promise.resolve();
  }

  /**
   * Drop-in wrapper for `logger` that NEVER rejects (#448).
   *
   * The OPENCODE_DEBUG branch awaits `logger(...)` from inside the chat-turn
   * hot path (chat.system.transform). If `ctx.client.app.log` rejects —
   * transport error, closed stream, oversized payload — the promise rejection
   * propagates back to OpenCode core and can break the turn. Debug logging
   * is best-effort; swallow errors silently and let the turn proceed.
   */
  async function safeLog(
    message?: string,
    extra?: PluginClientAppLogBodyExtra,
  ): Promise<void> {
    try {
      await logger(message, extra);
    } catch {
      // Never break the turn on debug-log failure.
    }
  }

  async function buildNativeTools(): Promise<Record<string, NativeToolDefinition>> {
    // Import the existing MCP server registry without starting its stdio
    // transport. This is the plugin-only bridge for #574: OpenCode/Kilo
    // call ctx_* tools in-process through Hooks.tool instead of spawning
    // a separate MCP child per session.
    const prevEmbedded = process.env.CONTEXT_MODE_EMBEDDED_PLUGIN_TOOLS;
    process.env.CONTEXT_MODE_EMBEDDED_PLUGIN_TOOLS = "1";
    let mod: typeof import("../../server.js");
    try {
      mod = await import("../../server.js");
    } finally {
      if (prevEmbedded === undefined) delete process.env.CONTEXT_MODE_EMBEDDED_PLUGIN_TOOLS;
      else process.env.CONTEXT_MODE_EMBEDDED_PLUGIN_TOOLS = prevEmbedded;
    }
    const tools: Record<string, NativeToolDefinition> = {};

    for (const registered of mod.REGISTERED_CTX_TOOLS) {
      const config = registered.config as Record<string, unknown>;
      // Zod schema object that the MCP framework normally calls
      // safeParseAsync() on before invoking the handler. The native
      // OpenCode plugin path bypasses MCP's transport layer entirely
      // (refs/platforms/opencode/packages/opencode/src/tool/registry.ts:127),
      // so we must parse args here too — otherwise z.preprocess() coercions
      // (coerceCommandsArray / coerceJsonArray in server.ts) and defaults
      // never fire. Fixes #621.
      const inputSchema = config.inputSchema as
        | { shape?: unknown; _def?: { shape?: unknown }; parse?: (input: unknown) => unknown }
        | undefined;
      const shape =
        typeof inputSchema?.shape === "object" && inputSchema.shape !== null
          ? inputSchema.shape
          : typeof inputSchema?._def?.shape === "function"
            ? (inputSchema._def.shape as () => unknown)()
            : {};

      // Both KiloCode and recent OpenCode bundle Zod v4 in-host; v3 schemas
      // crash with `n._zod.def` undefined. Gate widened from kilo-only (#632)
      // because every consumer of this file is an OpenCode-family host.
      const argsForHost = zod3ShapeToV4(shape as Record<string, unknown>);

      tools[registered.name] = {
        description: String(config.description ?? ""),
        args: argsForHost,
        // v2-only consumer: JSON-Schema view of the SAME Zod schema (the
        // MCP layer hands the Zod schema to the SDK, which converts
        // internally — this helper is the shared conversion point here).
        inputJsonSchema: zodSchemaToJsonSchema(inputSchema),
        async execute(args: Record<string, unknown>, toolCtx: NativeToolContext) {
          toolCtx.metadata?.({ title: String(config.title ?? registered.name) });
          const project = toolCtx.directory || projectDir;

          // Run the registered Zod schema BEFORE the handler — same contract
          // as the MCP SDK (server/mcp.js safeParseAsync at line 174). This
          // applies z.preprocess() coercions, populates .default() values,
          // and produces the validation error the handler expects (#621).
          let parsedArgs: Record<string, unknown> = args ?? {};
          if (typeof inputSchema?.parse === "function") {
            try {
              parsedArgs = inputSchema.parse(args ?? {}) as Record<string, unknown>;
            } catch (err) {
              // Surface validation failures with a clear, actionable message
              // (mirrors MCP SDK error format) instead of a downstream
              // "x.map is not a function" crash.
              const message = err instanceof Error ? err.message : String(err);
              throw new Error(
                `Invalid arguments for ${registered.name}: ${message}`,
              );
            }
          }

          const result = await mod.withProjectDirOverride({ projectDir: project, sessionId: toolCtx.sessionID }, async () =>
            registered.handler(parsedArgs),
          );

          const r = result as {
            content?: Array<{ type?: string; text?: string }>;
            isError?: boolean;
          };
          const text = Array.isArray(r?.content)
            ? r.content
                .filter((c) => c?.type === "text" && typeof c.text === "string")
                .map((c) => c.text)
                .join("\n")
            : typeof result === "string"
              ? result
              : JSON.stringify(result ?? "");

          if (r?.isError) throw new Error(text || `${registered.name} returned an error`);
          return { title: String(config.title ?? registered.name), output: text };
        },
      };
    }

    return tools;
  }

  const state = getPluginGlobalState();

  return {
    ctx,
    platform,
    adapter,
    projectDir,
    db,
    routing,
    routingBlock,
    autoInjectionMod,
    captureAgentsMd,
    buildNativeTools,
    logger,
    safeLog,
    closed: false,
    logHookError: (hookName: string, err: unknown, sessionId?: string) =>
      logHookErrorImpl(state, ctx, hookName, err, sessionId),
    logOnce: (key: string, message: string, level: EmitLevel = "info") =>
      logOnceImpl(state, ctx, key, message, level),
  };
}

// ── Shared hook handlers (bridged by BOTH v1 and v2 paths) ────

/**
 * The six hook behaviors, built over the shared runtime. The v1 path maps
 * them 1:1 onto the v1 hook names; the v2 path wraps them in shape-tolerant
 * adapters and registers them against whatever v2 surfaces it can probe.
 */
interface SharedHandlers {
  toolExecuteBefore: (input: BeforeHookInput, output: BeforeHookOutput) => Promise<void>;
  toolExecuteAfter: (input: AfterHookInput, output: AfterHookOutput) => Promise<void>;
  event: (input: EventHookInput) => Promise<void>;
  chatMessage: (input: ChatMessageHookInput, output: ChatMessageHookOutput) => Promise<void>;
  sessionCompacting: (input: CompactingHookInput, output: CompactingHookOutput) => Promise<string>;
  chatSystemTransform: (input: SystemTransformHookInput, output: SystemTransformHookOutput) => Promise<void>;
}

function createSharedHandlers(rt: PluginRuntime): SharedHandlers {
  return {
    // ── PreToolUse: Routing enforcement ─────────────────

    "toolExecuteBefore": async (input: BeforeHookInput, output: BeforeHookOutput): Promise<void> => {
      const sessionId = input?.sessionID;
      const toolName = input?.tool ?? "";
      const toolInput = output?.args ?? {};

      let decision;
      try {
        decision = rt.routing.routePreToolUse(toolName, toolInput, rt.projectDir, rt.platform);
      } catch (err) {
        // Routing failure → allow passthrough. Previously silent; now logged
        // (deduped) so routing config issues are visible without flooding.
        rt.logHookError("tool.execute.before", err, sessionId);
        return;
      }

      if (!decision) return; // No routing match → passthrough

      if (decision.action === "deny" || decision.action === "ask") {
        // Throw to block — OpenCode catches this and denies the tool call
        throw new Error(decision.reason ?? "Blocked by context-mode");
      }

      if (decision.action === "modify" && decision.updatedInput) {
        // Mutate output.args — OpenCode reads the mutated output object
        Object.assign(output.args, decision.updatedInput);
      }

      if (decision.action === "context" && decision.additionalContext) {
        // Mutate output.args — OpenCode reads the mutated output object
        output.args.additionalContext = decision.additionalContext;
      }
    },

    // ── PostToolUse: Session event capture ──────────────

    "toolExecuteAfter": async (input: AfterHookInput, output: AfterHookOutput): Promise<void> => {
      const sessionId = input?.sessionID;
      if (!sessionId) return;
      try {
        rt.db.ensureSession(sessionId, rt.projectDir);
        // OC-4 (#487 follow-up): AGENTS.md → rule_content capture for snapshot
        // and auto-memory parity. Idempotent per-session via Set guard.
        rt.captureAgentsMd(sessionId);

        const hookInput: HookInput = {
          tool_name: input.tool ?? "",
          tool_input: input.args ?? {},
          tool_response: output.output,
          // v1 host never provides isError (response text alone drives
          // error detection); the v2 execute.after bridge sets it on
          // status:"error" so failed tool calls are captured via the SAME
          // extractEvents path (extract.ts isToolError).
          tool_output: output?.isError === true ? { isError: true } : undefined,
        };

        const events = extractEvents(hookInput);
        for (const event of events) {
          // Cast: extract.ts SessionEvent lacks data_hash (computed by insertEvent)
          rt.db.insertEvent(sessionId, event as SessionEvent, "PostToolUse");
        }
      } catch (err) {
        // Session capture must never break the tool call — but it is no
        // longer SILENT: log detail (deduped) so e.g. SQLite disk I/O errors
        // are diagnosable.
        rt.logHookError("tool.execute.after", err, sessionId);
      }
    },

    // ── event: per-turn token + cost capture (paid-observability) ───
    // The generic bus `event` hook (refs/platforms/opencode/packages/plugin/
    // src/index.ts:224) delivers every Event; we filter `message.updated`
    // (published on each assistant-message update incl. step-finish —
    // session.ts:673) and read tokens/cost/modelID off properties.info
    // (assistant filter via role; refs stream.transport.ts:214-216).
    //
    // CAVEAT (refs processor.ts:717-718): message-level `.tokens` is the LAST
    // step's snapshot (overwritten per step-finish), while `.cost` is
    // cumulative for the turn. parseOpencodeUsage passes `.cost` through as
    // native_cost_usd so the billed $ stays exact despite the token snapshot
    // being last-step only. `message.updated` fires multiple times per turn;
    // because tokens are a terminal snapshot and cost is cumulative, the last
    // event for a message carries the final figures — re-emitting on each
    // update is idempotent at the cost column and merely refreshes the
    // last-step token telemetry. db.insertEvent both persists locally AND
    // forwards to the platform (the TS-plugin equivalent of the .mjs
    // attributeAndInsertEvents path).
    "event": async (input: EventHookInput): Promise<void> => {
      let sessionId: string | undefined;
      try {
        const ev = input?.event;
        if (!ev || ev.type !== "message.updated") return;
        sessionId = ev.properties?.info?.sessionID;
        if (!sessionId || typeof sessionId !== "string") return;

        const counts = parseOpencodeUsage(ev);
        if (!counts) return;
        const usageEvent = buildAgentUsageEvent(counts);
        if (!usageEvent) return;

        rt.db.ensureSession(sessionId, rt.projectDir);
        rt.db.insertEvent(sessionId, usageEvent, "MessageUpdated");
      } catch (err) {
        // Usage capture must never break the session — log (deduped).
        rt.logHookError("event", err, sessionId);
      }
    },

    // ── chat.message: User-prompt capture (OC-2 / Z2) ───
    // SDK signature verified at refs/platforms/opencode/packages/plugin/src/
    // index.ts:233. Orchestrator reference at refs/plugin-examples/opencode/
    // opencode-orchestrator/src/plugin-handlers/chat-message-handler.ts:41-65.
    // CCv2 inline filter: skip synthetic harness messages (system reminders,
    // tool results, etc.) so we don't pollute the user-prompt event stream.
    "chatMessage": async (input: ChatMessageHookInput, output: ChatMessageHookOutput): Promise<void> => {
      const sessionId = input?.sessionID;
      if (!sessionId) return;
      try {
        const parts = Array.isArray(output?.parts) ? output.parts : [];
        const textPart = parts.find((p) => p && p.type === "text" && typeof p.text === "string" && p.text.length > 0);
        if (!textPart || !textPart.text) return;
        const message = textPart.text;
        if (isSyntheticMessage(message)) return;

        rt.db.ensureSession(sessionId, rt.projectDir);
        // OC-4 (#487 follow-up): also capture on chat.message so sessions that
        // never invoke a tool still seed rule_content events for continuity.
        rt.captureAgentsMd(sessionId);

        // 1. Always save the raw prompt
        rt.db.insertEvent(sessionId, {
          type: "user_prompt",
          category: "user-prompt",
          data: message,
          priority: 1,
        } as SessionEvent, "UserPromptSubmit");

        // 2. Extract role/decision/intent/skill events from the prompt body
        const userEvents = extractUserEvents(message);
        for (const ev of userEvents) {
          rt.db.insertEvent(sessionId, ev as SessionEvent, "UserPromptSubmit");
        }
      } catch (err) {
        // chat.message must never break the turn — log (deduped).
        rt.logHookError("chat.message", err, sessionId);
      }
    },

    // ── PreCompact: Snapshot generation ─────────────────

    "sessionCompacting": async (input: CompactingHookInput, output: CompactingHookOutput): Promise<string> => {
      const sessionId = input?.sessionID;
      if (!sessionId) return "";
      try {
        rt.db.ensureSession(sessionId, rt.projectDir);
        const events = rt.db.getEvents(sessionId);
        if (events.length === 0) return "";

        const stats = rt.db.getSessionStats(sessionId);
        const snapshot = buildResumeSnapshot(events, {
          compactCount: (stats?.compact_count ?? 0) + 1,
        });

        rt.db.upsertResume(sessionId, snapshot, events.length);
        rt.db.incrementCompactCount(sessionId);

        // Mutate output.context to inject the snapshot
        output.context.push(snapshot);

        if (process.env.OPENCODE_DEBUG) {
          await rt.safeLog(snapshot, {
            sessionId,
            source: "on compaction - snapshot",
          });
        }

        // OC-3 / Z3: Add budget-capped auto-injection (P1 role / P2 rules /
        // P3 skills / P4 intent — ≤500 tokens / ~2000 chars per
        // hooks/auto-injection.mjs). Pushed as a separate context entry so
        // OpenCode can fold it independently from the verbose snapshot.
        try {
          const autoBlock: string = rt.autoInjectionMod.buildAutoInjection(events);
          if (autoBlock && autoBlock.length > 0) {
            output.context.push(autoBlock);
          }

          if (process.env.OPENCODE_DEBUG) {
            await rt.safeLog(autoBlock, {
              sessionId,
              source: "on compaction - autoBlock",
            });
          }
        } catch (err) {
          // Auto-injection failure must NOT break the snapshot path — log (deduped).
          rt.logHookError("experimental.session.compacting", err, sessionId);
        }

        return snapshot;
      } catch (err) {
        rt.logHookError("experimental.session.compacting", err, sessionId);
        return "";
      }
    },

    // ── SessionStart equivalent (PR #376) ───────────────
    // OpenCode lacks a real SessionStart hook (#14808, #5409). The closest
    // surrogate is `experimental.chat.system.transform` — verified shape:
    //   input:  { sessionID?: string; model: Model }
    //   output: { system: string[] }
    // We claim the most-recent unconsumed resume snapshot atomically (race-
    // safe across concurrent processes) and prepend it to the system prompt.
    "chatSystemTransform": async (
      input: SystemTransformHookInput,
      output: SystemTransformHookOutput,
    ): Promise<void> => {
      const sessionId = input?.sessionID;
      if (!sessionId) return;

      // ── OC-1 / CCv1: ROUTING_BLOCK injection ──────────────
      // Inject the <context_window_protection> XML block on the first
      // chat.system.transform per session. This is INDEPENDENT of the
      // resume snapshot path below — routing block must fire even when
      // no prior session row exists. Splice at index 1 (NOT unshift) for
      // the same OpenCode llm.ts:117-128 cache-fold reason as resume.
      //
      // Skip injection when system prompt already contains context-mode
      // routing rules (e.g. via AGENTS.md / CLAUDE.md loaded by the host).
      // Detect by checking for a quorum of distinctive tool names — any two
      // of ctx_execute, ctx_batch_execute, ctx_fetch_and_index confirms the
      // instructions are present and avoids ~2K chars of duplication.
      if (Array.isArray(output?.system)) {
        if (!systemHasRoutingInstructions(output.system)) {
          try {
            output.system.splice(1, 0, rt.routingBlock);
          } catch {
            // Never break the chat turn on routing-block injection failure.
          }

          if (process.env.OPENCODE_DEBUG) {
            await rt.safeLog(output.system[1], {sessionId, source: 'on routing block injection'});
          }
        } else if (process.env.OPENCODE_DEBUG) {
          await rt.safeLog(`routing block skipped — system prompt already contains context-mode instructions`, {sessionId, source: 'on routing block injection'});
        }
      }

      try {
        // Pass current sessionId so SQL excludes self-injection (v1.0.106 — Mickey #376
        // follow-up): if Session B compacts mid-flight and produces its own row,
        // B's next system.transform must NOT claim that row back into B's prompt.
        const row = rt.db.claimLatestUnconsumedResume(sessionId);
        if (!row || !row.snapshot) return;        // no row → retry on next turn

        if (process.env.OPENCODE_DEBUG) {
          await rt.safeLog(row.snapshot, {
            sessionId,
            source: "on resume - snapshot",
          });
        }

        if (Array.isArray(output?.system)) {
          // Insert at index 1 (after the header) — NOT unshift.
          // OpenCode's llm.ts:117-128 saves `header = system[0]` BEFORE this
          // hook runs and then folds the rest into a 2-part structure
          // `[header, body]` only if `system[0] === header` after the hook.
          // Prepending via unshift replaces system[0] with the snapshot,
          // making the equality check fail → cache-fold is skipped → every
          // system block is sent as a separate `role: "system"` message →
          // provider prompt cache is invalidated on every resume injection.
          // Inserting at index 1 keeps the header invariant and lets the
          // snapshot ride along inside the cached body block.
          output.system.splice(1, 0, row.snapshot);
          // Mark consumed only AFTER successful splice so failed paths can retry
          if (process.env.OPENCODE_DEBUG) {
            await rt.safeLog(output.system[1], { sessionId, source: "on resume" });
          }
        }
      } catch (err) {
        // Never break the chat turn — but log detail (deduped) so DB-level
        // failures (e.g. disk I/O) are diagnosable.
        rt.logHookError("experimental.chat.system.transform", err, sessionId);
      }
    },
  };
}

// ── v2 runtime capability probing ─────────────────────────

/**
 * A dispose/unregister handle returned by a v2 host registration. The v2
 * surface is UNCONFIRMED, so handles are normalized defensively: a bare
 * function, or an object exposing dispose/unregister/stop/off/close.
 */
type V2Dispose = () => Promise<void> | void;

type V2RegisterOutcome = {
  ok: boolean;
  /** Unregister handle(s) for what was actually registered (may be absent). */
  dispose?: V2Dispose;
};

/** Normalize an unconfirmed host return value into a dispose handle. */
function normalizeDisposeHandle(ret: unknown): V2Dispose | undefined {
  if (typeof ret === "function") return ret as V2Dispose;
  if (ret !== null && typeof ret === "object") {
    const obj = ret as Record<string, unknown>;
    for (const key of ["dispose", "unregister", "stop", "off", "close"] as const) {
      const candidate = obj[key];
      if (typeof candidate === "function") {
        return (candidate as (...a: unknown[]) => unknown).bind(obj) as V2Dispose;
      }
    }
  }
  return undefined;
}

/**
 * Tolerant registration call against an unconfirmed host function. Unlike a
 * boolean probe, the returned registration/dispose handle (if any) is
 * CAPTURED so failed/cleaned-up setups can unregister everything they
 * registered — no live partial registrations, no double-registered handlers
 * after a reload.
 */
async function tryRegister(
  fn: unknown,
  thisArg: unknown,
  ...args: unknown[]
): Promise<V2RegisterOutcome> {
  if (typeof fn !== "function") return { ok: false };
  try {
    const ret = await (fn as (...a: unknown[]) => unknown).call(thisArg, ...args);
    return { ok: true, dispose: normalizeDisposeHandle(ret) };
  } catch {
    return { ok: false };
  }
}

/** Chain several dispose handles into one (executed in reverse order). */
function chainDisposes(disposes: V2Dispose[]): V2Dispose {
  return async () => {
    for (const dispose of [...disposes].reverse()) {
      try {
        await dispose();
      } catch {
        // Best-effort unregistration.
      }
    }
  };
}

/**
 * Tear down a v2 activation: mark the runtime closed, unregister everything
 * registered (reverse order, best-effort), close the runtime DB handle (no
 * leak across setup failure / reload), then the caller releases the registry
 * claim.
 *
 * HOST LIMITATION (defense-in-depth): hosts whose registration calls succeed
 * but return NO dispose handle cannot be fully unregistered from here. The
 * liveness flag below is set FIRST — before any dispose and before the claim
 * is released — so every v2-registered callback becomes a silent no-op: a
 * stale handle-less callback can never touch the closed DB or double-fire
 * next to a later v1 activation for the same project.
 */
async function teardownV2(disposes: V2Dispose[], rt?: PluginRuntime): Promise<void> {
  // Liveness FIRST — see the host-limitation note above.
  if (rt) rt.closed = true;
  for (const dispose of [...disposes].reverse()) {
    try {
      await dispose();
    } catch {
      // Best-effort unregistration — a hostile/absent surface must not
      // prevent the DB close or claim release below.
    }
  }
  try {
    rt?.db?.close();
  } catch {
    // Best-effort DB close (Lane B owns SessionDB.close semantics).
  }
}

/**
 * Sync the process-global routing availability signal (hooks/core/routing.mjs
 * `setContextModeToolsAvailable`) with the activation registry: TRUE when
 * any activation in this process has CONFIRMED native ctx_* tools (v2
 * native claim) — routing may then emit redirect/deny guidance pointing at
 * ctx_* tools even without an MCP server (they ARE registered natively in
 * this process). FALSE otherwise — the default; v1 never touches the flag
 * and keeps gating on the MCP readiness sentinel exactly as before, so
 * every other platform's behavior is unchanged.
 *
 * Best-effort: a missing setter (older routing copy) or a setter failure
 * must never break setup/teardown.
 */
function syncRoutingNativeToolsFlag(rt: PluginRuntime | undefined, state: PluginGlobalState): void {
  const setFn = (rt?.routing as
    | { setContextModeToolsAvailable?: (available: boolean) => void }
    | undefined)?.setContextModeToolsAvailable;
  if (typeof setFn !== "function") return;
  try {
    setFn([...state.activations.values()].some((entry) => entry.nativeToolsConfirmed === true));
  } catch {
    // Best-effort — enforcement must never break on a signal error.
  }
}

/**
 * Resolve the project directory from an unconfirmed v2 setup context.
 * Probes ctx.directory (v1 parity) then ctx.project.directory, falling back
 * to process.cwd() like the v1 path.
 */
function resolveV2ProjectDir(ctx: V2SetupContext | undefined): string {
  const dir =
    ctx?.directory ??
    (ctx as { project?: { directory?: string } } | undefined)?.project?.directory;
  return resolve(typeof dir === "string" && dir.length > 0 ? dir : process.cwd());
}

/**
 * v2 execute-hook bridges around the shared handlers. Each entry point
 * checks the runtime liveness flag FIRST: after a teardown (failed setup or
 * cleanup), any callback the host kept despite a missing dispose handle
 * becomes a silent no-op — no throw, no DB touch — even if a v1 activation
 * later claims the same project.
 *
 * execute.before event { tool, input } (input INSPECTABLE/REPLACEABLE):
 * the shared v1 handler mutates `output.args` in place; we pass
 * `output.args === event.input` (same object) so replacements propagate to
 * the host. A deny decision throws — the host decides how to block.
 *
 * execute.after event { status: "completed"|"error", result?, error? }
 * (extra fields UNCONFIRMED — accessed defensively): completed results feed
 * the shared capture handler; ERROR status ALSO captures the failed tool
 * call (error_tool events via the shared extractEvents path, with an
 * explicit isError flag — richer than v1) alongside the deduped log.
 */
function createV2ExecuteHookBridges(rt: PluginRuntime, handlers: SharedHandlers) {
  return {
    before: async (event: unknown) => {
      if (rt.closed) return undefined; // torn down — silent no-op
      const ev = (event ?? {}) as Record<string, any>;
      if (ev.input === null || typeof ev.input !== "object") ev.input = {};
      const v1Input = {
        tool: v2ToolNameOf(ev),
        sessionID: v2SessionIdOf(ev),
        callID: typeof ev.callID === "string" ? ev.callID : "",
      } as unknown as BeforeHookInput;
      // Same-object mutation target: output.args IS event.input.
      const v1Output = { args: ev.input } as unknown as BeforeHookOutput;
      await handlers.toolExecuteBefore(v1Input, v1Output);
      return ev.input;
    },
    after: async (event: unknown) => {
      if (rt.closed) return undefined; // torn down — silent no-op
      const ev = (event ?? {}) as Record<string, any>;
      const sessionId = v2SessionIdOf(ev);
      const toolName = v2ToolNameOf(ev);
      const v1Input = {
        tool: toolName,
        sessionID: sessionId,
        callID: typeof ev.callID === "string" ? ev.callID : "",
        args: ev.input ?? {},
      } as unknown as AfterHookInput;
      if (ev.status === "error") {
        // FAILED tool call — still CAPTURED, not dropped: v1 produces
        // error_tool events through extractEvents/isToolError (which reads
        // an explicit isError flag, extract.ts:117-121). v2's status gives
        // us that flag directly — richer than v1 (which only sees
        // error-ish Bash response text) and the SAME shared extraction
        // path. The diagnosable log is preserved alongside the capture.
        rt.logHookError("v2.tool.execute.after", ev.error ?? new Error("tool execute failed"), sessionId);
        const v1ErrorOutput = {
          title: toolName,
          output: extractV2ToolErrorText(ev.error),
          metadata: undefined,
          isError: true,
        } as unknown as AfterHookOutput;
        await handlers.toolExecuteAfter(v1Input, v1ErrorOutput);
        return undefined;
      }
      const v1Output = {
        title: toolName,
        output: extractV2ToolResultText(ev.result),
        metadata: ev.result && typeof ev.result === "object" ? (ev.result as Record<string, any>).metadata : undefined,
      } as unknown as AfterHookOutput;
      await handlers.toolExecuteAfter(v1Input, v1Output);
      return ev.result;
    },
  };
}

/**
 * Register the MANDATORY execute-hook bridges via ctx.tool.hook
 * ("execute.before" / "execute.after" — verified v2 names). Returns which
 * hooks registered and the dispose handles for everything registered.
 */
async function registerToolExecuteHooksV2(
  ctx: V2SetupContext | undefined,
  rt: PluginRuntime,
  handlers: SharedHandlers,
): Promise<{ before: boolean; after: boolean; via: string; disposes: V2Dispose[] }> {
  const tool = ctx?.tool ?? {};
  const result = { before: false, after: false, via: "", disposes: [] as V2Dispose[] };
  const hookFn = typeof tool.hook === "function" ? tool.hook : undefined;
  if (!hookFn) return result;
  const bridges = createV2ExecuteHookBridges(rt, handlers);

  const beforeReg = await tryRegister(hookFn, tool, "execute.before", bridges.before);
  if (beforeReg.ok) {
    result.before = true;
    if (beforeReg.dispose) result.disposes.push(beforeReg.dispose);
  }
  const afterReg = await tryRegister(hookFn, tool, "execute.after", bridges.after);
  if (afterReg.ok) {
    result.after = true;
    if (afterReg.dispose) result.disposes.push(afterReg.dispose);
  }
  if (result.before && result.after) result.via = "ctx.tool.hook(execute.before/after)";
  return result;
}

/**
 * OPTIONAL: register the session "context" hook that bridges the v1
 * experimental.chat.system.transform behavior (routing block + resume
 * snapshot injection). v2 delivers `event.system: SystemPart[]` (MUTABLE,
 * push {text}) and the hook "runs again for compaction" — covering the v1
 * compaction-injection flows too. The v1 shared handler splices STRINGS at
 * index 1 of a string array, so we: (1) build a string view of the parts,
 * (2) run the shared handler on that view, (3) reconcile back — original
 * part objects are preserved positionally (content-equality match) and
 * INSERTED strings become `{ type: "text", text }` parts — required by the
 * runtime schema (LLM.SystemPart), even though the docs example shows bare
 * `{ text }`. This keeps
 * any extra part fields (e.g. provider cache hints) intact.
 * Returns ok=false when the surface is absent or registration fails.
 */
async function registerSessionContextV2(
  ctx: V2SetupContext | undefined,
  rt: PluginRuntime,
  handlers: SharedHandlers,
): Promise<V2RegisterOutcome> {
  const sessionHook =
    ctx?.session && typeof ctx.session.hook === "function" ? ctx.session.hook : undefined;
  if (!sessionHook) return { ok: false };
  const handler = async (event: unknown) => {
    if (rt.closed) return undefined; // torn down — silent no-op
    const ev = (event ?? {}) as Record<string, any>;
    const sessionId = ev.sessionID ?? ev.session?.id;
    if (!sessionId || !Array.isArray(ev.system)) return undefined; // cannot attribute — honest no-op
    const originalParts: unknown[] = ev.system.slice();
    const v1System: string[] = originalParts.map(v2SystemPartText);
    await handlers.chatSystemTransform(
      { sessionID: sessionId, model: ev.model ?? {} } as unknown as SystemTransformHookInput,
      { system: v1System } as SystemTransformHookOutput,
    );
    // Reconcile the (possibly grown) string array back onto event.system.
    const rebuilt: unknown[] = [];
    let oi = 0;
    for (const text of v1System) {
      if (oi < originalParts.length && v2SystemPartText(originalParts[oi]) === text) {
        rebuilt.push(originalParts[oi]); // unchanged — keep the original part object
        oi += 1;
      } else {
        rebuilt.push({ type: "text", text }); // inserted by the shared handler (routing block / snapshot); runtime schema (LLM.SystemPart) requires type:"text"
      }
    }
    ev.system.length = 0;
    for (const part of rebuilt) ev.system.push(part);
    return ev.system;
  };
  return tryRegister(sessionHook, ctx?.session, "context", handler);
}

/**
 * OPTIONAL: register the session "prompt" hook — the v1 chat.message
 * equivalent for user-prompt capture (event.prompt.text). Synthetic-harness
 * filtering and event extraction happen in the shared handler.
 */
async function registerSessionPromptV2(
  ctx: V2SetupContext | undefined,
  rt: PluginRuntime,
  handlers: SharedHandlers,
): Promise<V2RegisterOutcome> {
  const sessionHook =
    ctx?.session && typeof ctx.session.hook === "function" ? ctx.session.hook : undefined;
  if (!sessionHook) return { ok: false };
  const handler = async (event: unknown) => {
    if (rt.closed) return undefined; // torn down — silent no-op
    const ev = (event ?? {}) as Record<string, any>;
    const prompt = ev.prompt;
    const text = typeof prompt === "string" ? prompt : prompt && typeof prompt === "object" ? prompt.text : undefined;
    if (typeof text !== "string" || text.length === 0) return undefined;
    const sessionId = v2SessionIdOf(ev);
    if (!sessionId) return undefined; // cannot attribute capture — honest no-op
    const v1Input = {
      sessionID: sessionId,
      agent: typeof ev.agent === "string" ? ev.agent : undefined,
      messageID: typeof ev.metadata?.messageID === "string" ? ev.metadata.messageID : undefined,
    } as unknown as ChatMessageHookInput;
    const v1Output = {
      message: prompt ?? {},
      parts: [{ type: "text", text }],
    } as unknown as ChatMessageHookOutput;
    await handlers.chatMessage(v1Input, v1Output);
    return undefined;
  };
  return tryRegister(sessionHook, ctx?.session, "prompt", handler);
}

/**
 * OPTIONAL: subscribe to the v2 event bus — ctx.event.subscribe({ signal })
 * returns an AsyncIterable of { type, ... } events (exact shapes
 * UNCONFIRMED — handled generically). Events are fed to the shared event
 * handler in the closest v1 mapping: { event: { type, properties } } where
 * properties falls back to the whole event object; the shared handler
 * filters non-usage events itself. The pump runs DETACHED (subscribing
 * synchronously returns after the registration); cleanup aborts the
 * controller, which ends the iteration on the next event or waiter wake-up.
 */
async function registerEventBusV2(
  ctx: V2SetupContext | undefined,
  rt: PluginRuntime,
  handlers: SharedHandlers,
): Promise<V2RegisterOutcome> {
  const eventSurface = ctx?.event;
  const subscribe =
    eventSurface && typeof eventSurface.subscribe === "function" ? eventSurface.subscribe : undefined;
  if (!subscribe || !eventSurface) return { ok: false };
  const controller = new AbortController();
  let stream: unknown;
  try {
    stream = await Promise.resolve(subscribe.call(eventSurface, { signal: controller.signal }));
  } catch {
    return { ok: false };
  }
  const handler = (raw: unknown) => {
    if (rt.closed) return Promise.resolve(); // torn down — silent no-op
    const ev = (raw ?? {}) as Record<string, any>;
    // Generic mapping: the shared handler filters by type and reads
    // properties defensively — a shape it does not understand is a no-op.
    return handlers.event({ event: { type: ev.type, properties: ev.properties ?? ev } });
  };
  const pump = (async () => {
    const iterable = stream as AsyncIterable<unknown> | undefined;
    if (
      !iterable ||
      typeof (iterable as unknown as Record<symbol, unknown>)[Symbol.asyncIterator] !== "function"
    ) {
      return;
    }
    for await (const raw of iterable) {
      if (rt.closed || controller.signal.aborted) break;
      try {
        await handler(raw);
      } catch (err) {
        rt.logHookError("v2.event", err);
      }
    }
  })().catch(() => {
    // Aborted or the host stream errored — best-effort capture only.
  });
  const abortDispose: V2Dispose = () => {
    // Abort is the contract (host ends the stream); the pump is NOT awaited
    // here — hosts may only notice the abort on the next event, and teardown
    // must never hang on that.
    controller.abort();
  };
  const hostDispose = normalizeDisposeHandle(stream);
  return {
    ok: true,
    dispose: hostDispose ? chainDisposes([abortDispose, hostDispose]) : abortDispose,
  };
}

/**
 * MANDATORY: register the native ctx_* tools via ctx.tool.transform(editor)
 * (verified v2 API). The ToolEditor receives one ToolInfo per ctx_* tool:
 *   { name, description, input: <JSON Schema from the SAME Zod schema the
 *    MCP layer registers>, execute }
 * NO namespace is set so effective tool names stay `ctx_*` — identical to
 * the v1 native path. Every registered execute is liveness-wrapped so a
 * tool the host kept after teardown becomes a harmless no-op. ok=false
 * means the MCP fallback (mcp.context-mode) remains the tool provider and —
 * per the activation policy — v2 must NOT claim activation.
 */
async function registerNativeToolsV2(
  ctx: V2SetupContext | undefined,
  rt: PluginRuntime,
): Promise<V2RegisterOutcome> {
  const transformFn =
    ctx?.tool && typeof ctx.tool.transform === "function" ? ctx.tool.transform : undefined;
  if (!transformFn) return { ok: false };
  let tools: Record<string, NativeToolDefinition>;
  try {
    // Same source v1 uses: REGISTERED_CTX_TOOLS via ../../server.js, with
    // the same Zod-preprocessing execute path (buildNativeTools).
    tools = await rt.buildNativeTools();
  } catch {
    // Native tool bridge failed to build — MCP fallback remains.
    return { ok: false };
  }

  const infos: V2ToolInfo[] = Object.entries(tools).map(([name, def]) => ({
    name,
    description: def.description,
    input: def.inputJsonSchema ?? {},
    // codemode:false exposes each tool as an individually callable tool.
    // With the default (codemode enabled) the v2 executor folds tools into
    // its single `execute` CodeMode tool, so a direct `ctx_stats` call
    // fails with "Unknown tool" (verified against the v2 executor).
    options: { codemode: false },
    execute: async (input: unknown, tool: unknown) => {
      if (rt.closed) {
        return { content: "context-mode: inactive (plugin setup was torn down)" };
      }
      try {
        // Defensive metadata hook (UNCONFIRMED whether v2 exposes one).
        const metadata = (tool as Record<string, any> | null | undefined)?.metadata;
        if (typeof metadata === "function") {
          try {
            metadata.call(tool, { title: name });
          } catch {
            // Metadata is advisory — never fail the call over it.
          }
        }
        // Reuse the v1 execute path verbatim: same Zod preprocessing,
        // same withProjectDirOverride capture attribution, same error
        // semantics. Tool ctx fields are UNCONFIRMED on v2 — defaults keep
        // the handler working with the plugin's own project dir.
        const toolCtx = (tool ?? {}) as NativeToolContext;
        const result = await def.execute((input ?? {}) as Record<string, unknown>, {
          sessionID: toolCtx.sessionID ?? "",
          messageID: toolCtx.messageID ?? "",
          agent: toolCtx.agent ?? "v2",
          directory: toolCtx.directory || rt.projectDir,
          worktree: toolCtx.worktree,
          abort: toolCtx.abort,
          metadata: typeof metadata === "function" ? metadata.bind(tool) : undefined,
        });
        const text =
          typeof result === "string"
            ? result
            : result && typeof result === "object" && typeof (result as { output?: unknown }).output === "string"
              ? (result as { output: string }).output
              : JSON.stringify(result ?? "");
        return { content: text };
      } catch (err) {
        // Surface the failure to the host AND log it (deduped) so e.g.
        // Zod validation issues are diagnosable.
        rt.logHookError(`v2.tool.${name}`, err);
        throw err;
      }
    },
  }));

  // Single transform callback registers every tool; the returned
  // Registration is captured as the dispose handle for teardown.
  return tryRegister(transformFn, ctx?.tool, (editor: V2ToolEditor) => {
    const add = typeof editor?.add === "function" ? editor.add : undefined;
    if (typeof add !== "function") {
      throw new Error("v2 ToolEditor.add unavailable");
    }
    for (const info of infos) {
      add.call(editor, info);
    }
  });
}

/**
 * Bookkeeping helper for OPTIONAL v2 registrations (finding: single
 * attempt → capability flag → one-time degradation log). No behavior
 * change vs the previous inline branches — just one code path.
 *
 * Returns the registration status ("registered" | "unavailable") for the
 * setup summary line plus the dispose handles to tear down later.
 */
async function attemptOptionalV2(
  rt: PluginRuntime,
  opts: {
    surfacePresent: boolean;
    register: () => Promise<V2RegisterOutcome>;
    logKeyMissing: string;
    missingMessage: string;
    logKeyFailed?: string;
    failedMessage?: string;
    degradeCapabilities?: Array<"sessionStart" | "canInjectSessionContext" | "preCompact">;
  },
): Promise<{ status: "registered" | "unavailable"; disposes: V2Dispose[] }> {
  if (!opts.surfacePresent) {
    rt.logOnce(opts.logKeyMissing, opts.missingMessage, "warn");
    for (const cap of opts.degradeCapabilities ?? []) rt.adapter.markCapabilityDegraded(cap);
    return { status: "unavailable", disposes: [] };
  }
  const reg = await opts.register();
  if (reg.ok) {
    return { status: "registered", disposes: reg.dispose ? [reg.dispose] : [] };
  }
  if (opts.logKeyFailed && opts.failedMessage) {
    rt.logOnce(opts.logKeyFailed, opts.failedMessage, "warn");
  } else {
    rt.logOnce(opts.logKeyMissing, opts.missingMessage, "warn");
  }
  for (const cap of opts.degradeCapabilities ?? []) rt.adapter.markCapabilityDegraded(cap);
  return { status: "unavailable", disposes: [] };
}

// ── Plugin Factory (v1 — server(input)) ───────────────────

/**
 * Plugin factory. Called once when a v1 host (KiloCode/OpenCode ≤ v1) loads
 * the plugin. Returns an object mapping hook event names to async handler
 * functions over the shared runtime.
 *
 * Hybrid-host guard: if the v2 setup() path (or another v1 server() call)
 * already claimed activation for this project, this returns an EMPTY
 * registration — no hooks, no DB init — and logs once.
 *
 * KiloCode expects: export default { id: string, server: (input) => Promise<Hooks> }
 * OpenCode expects: export const ContextModePlugin = (ctx) => Promise<Hooks>
 */
async function createContextModePlugin(ctx: PluginContext) {
  const state = getPluginGlobalState();
  const projectKey = normalizeProjectKey(ctx?.directory ?? process.cwd());

  // Hybrid-host guard — duplicate activation → noop registration.
  const existing = state.activations.get(projectKey);
  if (existing) {
    logOnceImpl(
      state,
      ctx,
      `duplicate-activation:${projectKey}`,
      `context-mode already active via ${existing.flavor} — duplicate v1 registration is a noop for this project`,
      "info",
    );
    return { tool: {} };
  }

  // v1 native tools are CONFIRMED by construction: server() always returns
  // the full native tool map (buildNativeTools below). Recorded so the
  // adapter's legacy-MCP-removal policy can trust this claimant in-process.
  state.activations.set(projectKey, {
    flavor: "v1",
    claimedAt: Date.now(),
    nativeToolsConfirmed: true,
  });
  try {
    const rt = await createPluginRuntime(ctx);
    const handlers = createSharedHandlers(rt);
    const nativeTools = await rt.buildNativeTools();

    return {
      tool: nativeTools,

      // ── PreToolUse: Routing enforcement ───────────────
      "tool.execute.before": handlers.toolExecuteBefore,

      // ── PostToolUse: Session event capture ────────────
      "tool.execute.after": handlers.toolExecuteAfter,

      // ── event: per-turn token + cost capture ──────────
      event: handlers.event,

      // ── chat.message: User-prompt capture (OC-2 / Z2) ─
      "chat.message": handlers.chatMessage,

      // ── PreCompact: Snapshot generation ───────────────
      "experimental.session.compacting": handlers.sessionCompacting,

      // ── SessionStart equivalent (PR #376) ─────────────
      "experimental.chat.system.transform": handlers.chatSystemTransform,
    };
  } catch (err) {
    // Release the claim so a retry (or the other flavor) can activate.
    state.activations.delete(projectKey);
    throw err;
  }
}

// ── Plugin Factory (v2 — setup(ctx)) ──────────────────────

/**
 * v2 plugin setup. Registers the v1-equivalent behaviors against whatever
 * v2 surfaces the host exposes (runtime capability probing) and honors the
 * hybrid-host activation guard.
 *
 * ACTIVATION POLICY: v2 may claim ONLY when the FULL mandatory surface
 * succeeds — tool execute before/after hooks AND native ctx_* tool
 * registration. If native tools cannot be registered, v2 does NOT claim
 * (one-time degraded-reason log, MCP fallback retained) so a v1 server()
 * entry can still claim for this project; on pure v2 hosts the same path
 * yields honest degraded mode with mcp.context-mode retained. Optional
 * capabilities (session context, event bus) degrade with one-time logs —
 * never a fake success.
 *
 * Returns a cleanup function (where the host supports one) that unregisters
 * everything registered, closes the runtime DB handle, and releases the
 * activation claim so a plugin reload can re-claim without double-registering
 * or leaking the old DB.
 */
async function setupV2(ctx: V2SetupContext): Promise<(() => void) | void> {
  const state = getPluginGlobalState();
  const projectDir = resolveV2ProjectDir(ctx);
  const projectKey = normalizeProjectKey(projectDir);

  // Hybrid-host guard — duplicate activation → noop + one-time log.
  const existing = state.activations.get(projectKey);
  if (existing) {
    logOnceImpl(
      state,
      ctx,
      `duplicate-activation:${projectKey}`,
      `context-mode already active via ${existing.flavor} — duplicate v2 setup is a noop for this project`,
      "info",
    );
    return;
  }

  // Mandatory capability probes: BOTH native-tool (ctx.tool.transform) and
  // execute-hook (ctx.tool.hook) surfaces must exist BEFORE we claim
  // activation — native tools provide the ctx_* commands (the MCP fallback
  // must stay intact otherwise) and execute hooks provide routing enforcement.
  const hasToolTransform = typeof ctx?.tool?.transform === "function";
  const hasToolHookSurface = typeof ctx?.tool?.hook === "function";
  if (!hasToolTransform || !hasToolHookSurface) {
    logOnceImpl(
      state,
      ctx,
      `v2-no-tool-surface:${projectKey}`,
      "context-mode v2 setup: no native v2 tool surface (ctx.tool.transform / ctx.tool.hook) — activation not claimed; ctx_* tools remain available via the MCP fallback (mcp.context-mode)",
      "info",
    );
    return;
  }

  // Claim early so concurrent/second entries noop while setup is in flight;
  // the claim is RELEASED below unless the full mandatory surface succeeds.
  state.activations.set(projectKey, {
    flavor: "v2",
    claimedAt: Date.now(),
    nativeToolsConfirmed: false,
  });

  const disposes: V2Dispose[] = [];
  let rt: PluginRuntime | undefined;

  /** Failure path: unregister everything, close the DB, release the claim. */
  const failSetup = async (message: string, level: EmitLevel = "warn"): Promise<void> => {
    await teardownV2(disposes, rt);
    state.activations.delete(projectKey);
    // No (remaining) native claimant → routing availability signal back to
    // its default so redirects never point at dead tools.
    syncRoutingNativeToolsFlag(rt, state);
    emitHostLog(ctx, level, message);
  };

  try {
    const sessionHookSurface = typeof ctx?.session?.hook === "function";
    // const (not let): closures below (optional registrations, cleanup) must
    // see a definitely-assigned runtime — TS cannot narrow the outer `let`.
    const activeRt: PluginRuntime = await createPluginRuntime(
      ctx as unknown as PluginContext,
      projectDir,
      {
        sessionContextDegraded: !sessionHookSurface,
        // v2 session.hook("context") also runs for compaction — compaction
        // injection degrades exactly with the session-context surface. A
        // registration FAILURE despite the surface is corrected below via
        // markCapabilityDegraded.
        preCompactDegraded: !sessionHookSurface,
      },
    );
    rt = activeRt;
    const handlers = createSharedHandlers(activeRt);

    // Mandatory 1/2: native ctx_* tools via ctx.tool.transform — attempted
    // FIRST as the most failure-prone mandatory piece. Failing here leaves
    // ZERO registrations on this path (no tool hooks exist yet to tear down
    // or leave stale).
    const nativeReg = await registerNativeToolsV2(ctx, activeRt);
    if (!nativeReg.ok) {
      await failSetup(
        "context-mode v2 setup: native tool registration unavailable (no ctx.tool.transform/ToolEditor) — activation not claimed so the v1 entry can still claim; ctx_* tools remain available via the MCP fallback (mcp.context-mode)",
      );
      return;
    }
    if (nativeReg.dispose) disposes.push(nativeReg.dispose);

    // Mandatory 2/2: tool execute before/after. On failure the teardown
    // below unregisters the native tools captured above; hooks the host
    // registered WITHOUT a dispose handle are neutralized by the liveness
    // gate (rt.closed) instead — they can never touch the closed DB.
    const toolRegs = await registerToolExecuteHooksV2(ctx, activeRt, handlers);
    if (!toolRegs.before || !toolRegs.after) {
      await failSetup(
        `context-mode v2 setup: tool execute hook registration failed (before=${toolRegs.before}, after=${toolRegs.after}) — activation not claimed; ctx_* tools remain available via the MCP fallback (mcp.context-mode)`,
        "error",
      );
      return;
    }
    disposes.push(...toolRegs.disposes);

    // Full mandatory surface acquired — the claim is now real.
    state.activations.set(projectKey, {
      flavor: "v2",
      claimedAt: Date.now(),
      nativeToolsConfirmed: true,
    });
    // Native ctx_* tools are now reachable in-process → routing may emit
    // curl/HTTP redirect + deny guidance pointing at them even without an
    // MCP server (v1 never sets this: it gates on the MCP sentinel as always).
    syncRoutingNativeToolsFlag(activeRt, state);

    // Optional: session "context" hook (routing block + resume snapshot +
    // compaction injection — v2 runs this hook for continuations AND
    // compaction, covering the v1 system.transform AND compacting flows).
    const sessionContext = await attemptOptionalV2(activeRt, {
      surfacePresent: sessionHookSurface,
      register: () => registerSessionContextV2(ctx, activeRt, handlers),
      logKeyMissing: "v2-session-context-missing",
      missingMessage:
        "context-mode v2: session context injection unavailable (no ctx.session.hook('context')) — routing block + resume snapshot + compaction injection will not happen",
      logKeyFailed: "v2-session-context-failed",
      failedMessage:
        "context-mode v2: session context hook registration failed — routing block + resume snapshot + compaction injection will not happen",
      degradeCapabilities: ["sessionStart", "canInjectSessionContext", "preCompact"],
    });
    disposes.push(...sessionContext.disposes);

    // Optional: session "prompt" hook (user-prompt capture — v1 chat.message
    // equivalent).
    const promptCapture = await attemptOptionalV2(activeRt, {
      surfacePresent: sessionHookSurface,
      register: () => registerSessionPromptV2(ctx, activeRt, handlers),
      logKeyMissing: "v2-prompt-capture-missing",
      missingMessage:
        "context-mode v2: user-prompt capture unavailable (no ctx.session.hook('prompt')) — prompt capture inactive",
    });
    disposes.push(...promptCapture.disposes);

    // Optional: event bus (per-turn token + cost capture).
    const eventBus = await attemptOptionalV2(activeRt, {
      surfacePresent: typeof ctx?.event?.subscribe === "function",
      register: () => registerEventBusV2(ctx, activeRt, handlers),
      logKeyMissing: "v2-event-bus-missing",
      missingMessage:
        "context-mode v2: event bus unavailable (no ctx.event.subscribe) — per-turn token/cost capture inactive",
    });
    disposes.push(...eventBus.disposes);

    rt.logOnce(
      "v2-setup-complete",
      `context-mode v2 setup complete: native tools via ctx.tool.transform; tool hooks via ${toolRegs.via}; session context: ${sessionContext.status}; prompt capture: ${promptCapture.status}; event bus: ${eventBus.status}`,
      "info",
    );

    return async () => {
      // Cleanup: unregister everything registered, close the runtime DB
      // handle, then release the activation claim so a reload can re-claim.
      await teardownV2(disposes, rt);
      state.activations.delete(projectKey);
      // Torn down → routing availability signal off (unless another native
      // claimant remains in this process).
      syncRoutingNativeToolsFlag(rt, state);
    };
  } catch (err) {
    // Setup failed — leave no live partial registrations and no leaked DB
    // handle; release the claim so a retry (or the other flavor) can activate.
    await teardownV2(disposes, rt);
    state.activations.delete(projectKey);
    syncRoutingNativeToolsFlag(rt, state);
    emitHostLog(ctx, "error", formatPluginError(null, err));
    return;
  }
}

// ── Exports ──────────────────────────────────────────────
// KiloCode PluginModule / OpenCode v2 PluginModule: default export with
// { id, server, setup } shape — v1 hosts call server(input), v2 hosts call
// setup(ctx). No `tui` marker (would invalidate server loading).
// OpenCode compat: named exports for direct import("@mxalbert/context-mode/plugin")
export default {
  id: "context-mode",
  server: createContextModePlugin,
  setup: setupV2,
};
export { createContextModePlugin as ContextModePlugin, setupV2 as ContextModeSetup };
// Test surface — exported for unit testing the quorum substring fix (#487).
export { systemHasRoutingInstructions, ROUTING_MARKERS };
