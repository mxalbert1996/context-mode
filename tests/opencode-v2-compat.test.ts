import "./setup-home";
/**
 * Tests for opencode v1/v2 dual-flavor plugin compatibility.
 *
 * The v2 fake host here implements the VERIFIED v2 API (opencode2
 * beta-19135 live probe + docs build/plugins):
 *   ctx.tool.transform(editor)      — ToolEditor {list,get,namespace,add,update,remove}
 *   ctx.tool.hook("execute.before"|"execute.after", cb)
 *   ctx.session.hook("context"|"prompt", cb)
 *   ctx.event.subscribe({signal})   — AsyncIterable {type, ...}
 *
 * Covers:
 *   (a) default export surface: { id, server (v1), setup (v2) } + named exports
 *   (b) hybrid-host activation guard: single activation per project per
 *       process, second entry is a noop, no duplicate SessionDB construction
 *   (c) full-native claim: native ctx_* tools registered via ToolEditor with
 *       correct names/JSON schemas/executables, execute-hook bridging
 *       (input replacement propagation, capture), session context routing
 *       block + resume snapshot injection, prompt capture, event-bus feeding
 *   (d) teardown disposes transform/hook/session/event registrations, closes
 *       the DB, and the liveness gate neutralizes stale handle-less callbacks
 *   (e) genuinely-missing surfaces degrade honestly with one-time logs; MCP
 *       fallback retained for setups that fail to claim
 *   (f) detailed error logging in the hook catch-alls (client log + file
 *       sink; stderr is the last-resort when the sink is unavailable)
 *
 * SessionDB is wrapped in a constructor spy (delegating to the real class) so
 * duplicate DB init is detectable while runtime behavior stays real.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, unlinkSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { __resetPluginLogSinkForTests, __resetPluginStateForTests } from "../src/adapters/opencode/plugin.js";

// ── SessionDB constructor spy (mock module-wide, delegate to real class) ──

// vi.hoisted: the vi.mock factory below is hoisted above module-level `let`
// declarations, so the spy handle must live in a hoisted binding.
const mockState = vi.hoisted(() => ({
  ctorSpy: undefined as { mockClear: () => void } | undefined,
  instances: [] as any[],
}));

vi.mock("../src/session/db.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/session/db.js")>();
  // IMPORTANT: `function` impl (not arrow) — the mock is invoked via `new`
  // from plugin.ts; arrows cannot be constructed (Reflect.construct throws).
  const spy = vi.fn(function SessionDBCtorSpy(this: unknown, ...args: any[]) {
    // Delegate to the REAL class — spy only records construction.
    const inst = new actual.SessionDB(...(args as Parameters<typeof actual.SessionDB>));
    mockState.instances.push(inst);
    return inst;
  });
  mockState.ctorSpy = spy;
  return {
    ...actual,
    SessionDB: spy as unknown as typeof actual.SessionDB,
  };
});

async function getSessionDbCtor(): Promise<{ mock: { calls: unknown[] } }> {
  const { SessionDB } = await import("../src/session/db.js");
  return SessionDB as unknown as { mock: { calls: unknown[] } };
}

// ── Test helpers ──────────────────────────────────────────

type LogEntry = { level?: string; message?: string; extra?: { sessionId?: string } };

type V2Host = ReturnType<typeof makeV2Ctx>;

/**
 * Fake v2 host implementing the VERIFIED v2 API surface. Mandatory surfaces
 * (tool.transform + tool.hook) are present by default; optional surfaces
 * (session.hook, event.subscribe) are opt-in.
 */
function makeV2Ctx(
  projectDir: string,
  opts: {
    log?: LogEntry[];
    /** No ctx.tool.transform AND no ctx.tool.hook → mandatory probe fails. */
    omitToolSurface?: boolean;
    /** No ctx.tool.transform only (native tool registration fails). */
    omitToolTransform?: boolean;
    /** Custom tool.hook registration fn (throw injection etc.). */
    hookImpl?: (name: unknown, cb: unknown) => Promise<void>;
    withSession?: boolean;
    withEventBus?: boolean;
  } = {},
) {
  const logs = opts.log ?? [];
  const addedTools = new Map<string, any>();
  const toolHooks = new Map<string, (event: unknown) => unknown>();
  const sessionHooks = new Map<string, (event: unknown) => unknown>();
  const appliedNamespaces: unknown[] = [];
  const eventQueue: unknown[] = [];
  const eventWaiters: Array<() => void> = [];
  let eventSignal: AbortSignal | undefined;

  const editor = {
    list: () => [...addedTools.values()],
    get: (id: string) => addedTools.get(id),
    namespace: (options: unknown) => {
      appliedNamespaces.push(options);
    },
    add: (tool: { name: string }) => {
      addedTools.set(tool.name, tool);
    },
    update: (id: string, fn: (t: unknown) => unknown) => {
      addedTools.set(id, fn(addedTools.get(id)));
    },
    remove: (id: string) => {
      addedTools.delete(id);
    },
  };

  const pushEvent = (ev: unknown) => {
    eventQueue.push(ev);
    eventWaiters.shift()?.();
  };

  // Real v2 hosts return an AsyncIterable — [Symbol.asyncIterator] must be
  // a METHOD (not an invoked generator object) for `for await` to consume it.
  const eventIterable = {
    [Symbol.asyncIterator]: async function* () {
      while (!eventSignal?.aborted) {
        if (eventQueue.length === 0) {
          await new Promise<void>((res) => eventWaiters.push(res));
          if (eventSignal?.aborted) break;
        }
        const ev = eventQueue.shift();
        if (ev !== undefined) yield ev;
      }
    },
  };

  const ctx: Record<string, any> = {
    directory: projectDir,
    client: {
      app: {
        log: async (o: { body?: LogEntry } & LogEntry) => {
          logs.push((o?.body ?? o) as LogEntry);
        },
      },
    },
  };
  if (!opts.omitToolSurface) {
    ctx.tool = {};
    if (!opts.omitToolTransform) {
      ctx.tool.transform = async (cb: (editor: unknown) => unknown) => {
        await cb(editor);
        // Registration → dispose clears the registered tools.
        return () => {
          addedTools.clear();
        };
      };
    }
    if (!opts.omitToolHook) {
      ctx.tool.hook = opts.hookImpl
        ? opts.hookImpl
        : async (name: string, cb: (event: unknown) => unknown) => {
            toolHooks.set(name, cb);
            return () => {
              toolHooks.delete(name);
            };
          };
    }
  }
  if (opts.withSession) {
    ctx.session = {
      hook: async (name: string, cb: (event: unknown) => unknown) => {
        sessionHooks.set(name, cb);
        return () => {
          sessionHooks.delete(name);
        };
      },
    };
  }
  if (opts.withEventBus) {
    ctx.event = {
      subscribe: async (o?: { signal?: AbortSignal }) => {
        eventSignal = o?.signal;
        eventSignal?.addEventListener("abort", () => {
          while (eventWaiters.length > 0) eventWaiters.shift()!();
        });
        return eventIterable;
      },
    };
  }
  return {
    ctx,
    logs,
    addedTools,
    toolHooks,
    sessionHooks,
    editor,
    appliedNamespaces,
    pushEvent,
    getEventSignal: () => eventSignal,
  };
}

async function createV1Plugin(projectDir: string, logCollector?: LogEntry[]) {
  const { ContextModePlugin } = await import("../src/adapters/opencode/plugin.js");
  return ContextModePlugin({
    directory: projectDir,
    client: {
      app: {
        log: async (o: { body?: LogEntry } & LogEntry) => {
          logCollector?.push((o?.body ?? o) as LogEntry);
        },
      },
    },
  } as any) as Promise<Record<string, any>>;
}

async function getActivationRegistry() {
  const { __getPluginGlobalState } = await import("../src/adapters/opencode/plugin.js");
  return __getPluginGlobalState().activations;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ── Global fixtures ───────────────────────────────────────

// MCP readiness sentinel — routing.mjs checks process.ppid in-process
const _sentinelDir = process.platform === "win32" ? tmpdir() : "/tmp";
const mcpSentinel = resolve(_sentinelDir, `context-mode-mcp-ready-${process.pid}`);

let tempDir: string;

beforeEach(() => {
  writeFileSync(mcpSentinel, String(process.pid));
  __resetPluginStateForTests();
  // Reset the per-test construction count (mock impl stays — it delegates
  // to the real class; only call history is cleared).
  mockState.ctorSpy?.mockClear();
  mockState.instances.length = 0;
});

afterEach(() => {
  try {
    unlinkSync(mcpSentinel);
  } catch {
    /* cleanup best effort */
  }
});

beforeAll(() => {
  tempDir = mkdtempSync(join(tmpdir(), "opencode-v2-compat-"));
});

afterAll(() => {
  try {
    rmSync(tempDir, { recursive: true, force: true });
  } catch {
    /* cleanup best effort */
  }
});

// ── Tests ─────────────────────────────────────────────────

describe("opencode v2 compatibility", () => {
  // ── (a) Dual export surface ───────────────────────────

  describe("dual export surface", () => {
    it("default export exposes id + server (v1) + setup (v2)", async () => {
      const mod = await import("../src/adapters/opencode/plugin.js");
      expect(mod.default).toHaveProperty("id", "context-mode");
      expect(typeof mod.default.server).toBe("function");
      expect(typeof mod.default.setup).toBe("function");
      // v2 PluginModule shape: NO tui marker (it would invalidate server loading)
      expect(mod.default).not.toHaveProperty("tui");
    });

    it("named exports work for direct import (backward compat + v2 setup)", async () => {
      const mod = await import("../src/adapters/opencode/plugin.js");
      expect(typeof mod.ContextModePlugin).toBe("function");
      expect(typeof mod.ContextModeSetup).toBe("function");
      expect(mod.default.server).toBe(mod.ContextModePlugin);
      expect(mod.default.setup).toBe(mod.ContextModeSetup);
    });
  });

  // ── (b) Hybrid-host activation guard ──────────────────

  describe("hybrid-host activation guard", () => {
    it("server() then setup() for the same project → single DB init, setup is a noop", async () => {
      const { ContextModeSetup } = await import("../src/adapters/opencode/plugin.js");
      const projectDir = join(tempDir, "guard-v1-then-v2");
      const logs: LogEntry[] = [];

      const plugin = await createV1Plugin(projectDir, logs);
      expect(plugin).toHaveProperty("tool.execute.before");

      const host = makeV2Ctx(projectDir, { log: logs });
      const result = await ContextModeSetup(host.ctx as any);

      // v2 entry did NOT activate: noop registration, no tool hooks registered
      expect(result).toBeUndefined();
      expect(host.toolHooks.size).toBe(0);
      expect(host.addedTools.size).toBe(0);

      // Single activation → exactly ONE SessionDB construction (no duplicate DB init)
      const ctor = await getSessionDbCtor();
      expect(ctor.mock.calls.length).toBe(1);

      // One-time log identifies the active flavor
      expect(logs.some((l) => /already active via v1/.test(l.message ?? ""))).toBe(true);

      // Registry records the v1 claimant for this project
      const registry = await getActivationRegistry();
      const keys = [...registry.keys()].filter((k) => k.includes("guard-v1-then-v2"));
      expect(keys).toHaveLength(1);
      expect(registry.get(keys[0])?.flavor).toBe("v1");
    });

    it("setup() then server() for the same project → single DB init, server returns empty registration", async () => {
      const { ContextModeSetup } = await import("../src/adapters/opencode/plugin.js");
      const projectDir = join(tempDir, "guard-v2-then-v1");
      const logs: LogEntry[] = [];
      const host = makeV2Ctx(projectDir, { log: logs, withSession: true });

      const cleanup = await ContextModeSetup(host.ctx as any);
      expect(typeof cleanup).toBe("function");
      // v2 claimed and registered the mandatory hooks
      expect([...host.toolHooks.keys()].sort()).toEqual([
        "execute.after",
        "execute.before",
      ]);
      expect(host.addedTools.size).toBeGreaterThan(0);

      // Now a v1 host loads the same project → noop, no DB init
      const plugin = await createV1Plugin(projectDir, logs);
      expect(plugin).not.toHaveProperty("tool.execute.before");
      expect(plugin).not.toHaveProperty("tool.execute.after");
      expect(Object.keys(plugin.tool ?? {})).toEqual([]);

      const ctor = await getSessionDbCtor();
      expect(ctor.mock.calls.length).toBe(1);

      expect(logs.some((l) => /already active via v2/.test(l.message ?? ""))).toBe(true);

      const registry = await getActivationRegistry();
      const keys = [...registry.keys()].filter((k) => k.includes("guard-v2-then-v1"));
      expect(keys).toHaveLength(1);
      expect(registry.get(keys[0])?.flavor).toBe("v2");

      (cleanup as () => void)?.();
    });

    it("server() twice for the same project → second call is an empty registration (no duplicate DB init)", async () => {
      const projectDir = join(tempDir, "guard-v1-then-v1");
      const logs: LogEntry[] = [];
      await createV1Plugin(projectDir, logs);
      const second = await createV1Plugin(projectDir, logs);

      expect(second).not.toHaveProperty("tool.execute.before");
      expect(Object.keys(second.tool ?? {})).toEqual([]);

      const ctor = await getSessionDbCtor();
      expect(ctor.mock.calls.length).toBe(1);
      expect(logs.filter((l) => /already active via v1/.test(l.message ?? "")).length).toBe(1);
    });
  });

  // ── (c) Full-native v2 claim ──────────────────────────

  describe("v2 native claim (tool.transform + tool.hook)", () => {
    it("registers native ctx_* tools via ToolEditor with correct names, JSON schemas and executables", async () => {
      const { ContextModeSetup } = await import("../src/adapters/opencode/plugin.js");
      const projectDir = join(tempDir, "native-tools");
      const host = makeV2Ctx(projectDir);

      const cleanup = (await ContextModeSetup(host.ctx as any)) as () => void;

      // All ctx_* tools registered under their v1-identical names — NO
      // namespace applied (effective names stay ctx_*).
      expect(host.appliedNamespaces).toEqual([]);
      for (const name of [
        "ctx_batch_execute",
        "ctx_doctor",
        "ctx_execute",
        "ctx_execute_file",
        "ctx_fetch_and_index",
        "ctx_index",
        "ctx_insight",
        "ctx_purge",
        "ctx_search",
        "ctx_stats",
        "ctx_upgrade",
      ]) {
        expect(host.addedTools.has(name), `missing tool ${name}`).toBe(true);
      }

      // JSON schema derived from the SAME Zod schema the MCP layer registers
      const ctxExecute = host.addedTools.get("ctx_execute");
      expect(ctxExecute.input.type).toBe("object");
      expect(ctxExecute.input.properties.language.enum).toContain("shell");
      expect(ctxExecute.input.properties.language.description).toBe("Runtime language");
      expect(ctxExecute.input.properties.code.type).toBe("string");

      // Requiredness sees through ZodDefault / ZodEffects(z.preprocess)
      // wrappers (Gate-4 fix): params the host may omit (defaults, coerced
      // optionals) must NOT appear in `input.required` — otherwise
      // HOST-side JSON-Schema validation can reject the call before our
      // Zod parse (coercions + defaults) ever runs.
      const ctxFetch = host.addedTools.get("ctx_fetch_and_index");
      for (const field of ["concurrency", "force", "ttl"]) {
        expect(ctxFetch.input.required, `ctx_fetch_and_index.${field} must be omittable`).not.toContain(field);
        expect(ctxFetch.input.properties[field]).toBeDefined();
      }
      const ctxBatch = host.addedTools.get("ctx_batch_execute");
      for (const field of ["concurrency", "query_scope"]) {
        expect(ctxBatch.input.required, `ctx_batch_execute.${field} must be omittable`).not.toContain(field);
        expect(ctxBatch.input.properties[field]).toBeDefined();
      }
      const ctxSearch = host.addedTools.get("ctx_search");
      for (const field of ["limit", "sort", "queries"]) {
        expect(ctxSearch.input.required, `ctx_search.${field} must be omittable`).not.toContain(field);
        expect(ctxSearch.input.properties[field]).toBeDefined();
      }
      // commands stays genuinely required
      expect(ctxBatch.input.required).toContain("commands");

      // execute() runs the registered handler (same path as v1) and returns
      // { content } — Tool.TextContent compatible.
      const result = (await host.addedTools.get("ctx_stats").execute({}, {})) as {
        content: string;
      };
      expect(typeof result.content).toBe("string");
      expect(result.content).toContain("context-mode");

      cleanup?.();
    });

    it("zodSchemaToJsonSchema: defaulted and z.preprocess-wrapped optional params stay omittable (not in required)", async () => {
      const { zodSchemaToJsonSchema } = await import("../src/adapters/opencode/v2.js");
      const { z } = await import("zod");
      const schema = z.object({
        required: z.string(),
        // ZodDefault wrapping ZodOptional (ctx_fetch_and_index.concurrency shape)
        defaultedOptional: z.coerce.number().optional().default(4),
        // bare ZodDefault
        defaultedOnly: z.string().default("x"),
        // z.preprocess wrapper under optional (ctx_fetch_and_index.force shape)
        coercedOptional: z.preprocess((v: unknown) => v, z.array(z.string())).optional(),
        // deeply wrapped: preprocess whose INNER schema is optional
        preprocessedInnerOptional: z.preprocess((v: unknown) => v, z.string().optional()),
        // plain optional
        trulyOptional: z.string().optional(),
      });
      const json = zodSchemaToJsonSchema(schema);

      // Only the genuinely-required field is required
      expect(json.required).toEqual(["required"]);
      // …while every omittable field is still present in properties
      const props = json.properties as Record<string, any>;
      expect(props.defaultedOptional).toMatchObject({ type: "number", default: 4 });
      expect(props.defaultedOnly).toMatchObject({ type: "string", default: "x" });
      expect(props.coercedOptional).toMatchObject({ type: "array" });
      expect(props.preprocessedInnerOptional).toMatchObject({ type: "string" });
      expect(props.trulyOptional).toMatchObject({ type: "string" });
    });

    it("execute.before hook bridges routing enforcement with input replacement propagation", async () => {
      const { ContextModeSetup } = await import("../src/adapters/opencode/plugin.js");
      const projectDir = join(tempDir, "bridge-before");
      const host = makeV2Ctx(projectDir);

      const cleanup = (await ContextModeSetup(host.ctx as any)) as () => void;

      const before = host.toolHooks.get("execute.before") as any;
      expect(before).toBeTypeOf("function");

      // Deny decision: routing blocks curl — the throw propagates to the host
      const denyEvent: { tool: unknown; input: Record<string, unknown> } = {
        tool: "Bash",
        input: { command: "curl https://example.com/data" },
      };
      let blocked = false;
      try {
        await before(denyEvent);
        expect(String(denyEvent.input.command)).toMatch(/^echo /);
        expect(String(denyEvent.input.command)).toContain("context-mode");
      } catch (e: any) {
        blocked = true;
        expect(e.message).toContain("context-mode");
      }
      expect(blocked || String(denyEvent.input.command).startsWith("echo ")).toBe(true);

      // Guidance injection MUTATES event.input in place (replacement propagates)
      const guidanceEvent: { tool: unknown; input: Record<string, unknown> } = {
        tool: "grep",
        input: { command: "grep hello" },
      };
      await before(guidanceEvent);
      expect(guidanceEvent.input).toHaveProperty("additionalContext");
      expect(String(guidanceEvent.input.additionalContext)).toContain("<context_guidance>");

      cleanup?.();
    });

    it("execute.after hook captures tool results into the session DB", async () => {
      const { ContextModeSetup } = await import("../src/adapters/opencode/plugin.js");
      const projectDir = join(tempDir, "bridge-after-capture");
      const host = makeV2Ctx(projectDir);

      const cleanup = (await ContextModeSetup(host.ctx as any)) as () => void;

      const after = host.toolHooks.get("execute.after") as any;
      expect(after).toBeTypeOf("function");

      await after({
        status: "completed",
        tool: "Read",
        sessionID: "v2-capture-sess",
        input: { file_path: "/src/index-v2.ts" },
        result: { content: "export default {}" },
      });
      const inst = mockState.instances.at(-1);
      const events = inst.getEvents("v2-capture-sess") as any[];
      expect(events.length).toBeGreaterThan(0);
      expect(JSON.stringify(events)).toContain("index-v2.ts");

      // FAILED tool call → STILL captured (Gate-4 fix): the error status is
      // mapped to the shared extractEvents path with an explicit isError
      // flag, producing an error_tool event (v1 parity — and richer, since
      // v1 only sees error-ish Bash response text). No throw, and the
      // deduped diagnostic log is preserved.
      await expect(
        after({
          status: "error",
          tool: "Read",
          sessionID: "v2-capture-sess",
          input: { file_path: "/missing.ts" },
          error: "ENOENT: no such file or directory, open '/missing.ts'",
        }),
      ).resolves.toBeUndefined();
      const eventsAfter = inst.getEvents("v2-capture-sess") as any[];
      const errorTool = eventsAfter.find((e: any) => e.type === "error_tool");
      expect(errorTool).toBeDefined();
      expect(String(errorTool.data)).toContain("ENOENT");

      cleanup?.();
    });

    it("session context hook pushes routing block + resume snapshot as {text} parts (original parts preserved)", async () => {
      const { ContextModeSetup } = await import("../src/adapters/opencode/plugin.js");
      const { resolveSessionDbPath } = await import("../src/session/db.js");
      const { OpenCodeAdapter } = await import("../src/adapters/opencode/index.js");
      const { SessionDB: RealSessionDB } = (await vi.importActual("../src/session/db.js")) as any;

      const projectDir = join(tempDir, "bridge-session-context");
      const host = makeV2Ctx(projectDir, { withSession: true });

      const cleanup = (await ContextModeSetup(host.ctx as any)) as () => void;
      const contextHook = host.sessionHooks.get("context") as any;
      expect(contextHook).toBeTypeOf("function");

      // Seed a resume row from a DONOR session (self-injection guard excludes self)
      const adapter = new OpenCodeAdapter("opencode");
      const seedDb = new RealSessionDB({
        dbPath: resolveSessionDbPath({ projectDir, sessionsDir: adapter.getSessionDir() }),
      });
      seedDb.upsertResume("bridge-donor", "<session_resume>donor snapshot</session_resume>", 3);
      seedDb.close();

      // 1st invocation: routing block + resume snapshot pushed as {text} parts
      const headerPart = { text: "HEADER" };
      const event: { sessionID?: string; model?: unknown; system: Array<{ text: string }> } = {
        sessionID: "bridge-consumer",
        model: {},
        system: [headerPart],
      };
      await contextHook(event);

      expect(event.system.length).toBeGreaterThanOrEqual(2);
      // Original part object preserved positionally (reconciliation)
      expect(event.system[0]).toBe(headerPart);
      const texts = event.system.map((p) => p.text);
      expect(texts.some((t) => t.includes("<context_window_protection>"))).toBe(true);
      expect(texts.some((t) => t.includes("session_resume"))).toBe(true);

      // 2nd invocation (continuation): snapshot consumed — routing block
      // re-injects (per-turn reliability), original part still preserved
      const event2 = { sessionID: "bridge-consumer", model: {}, system: [{ text: "HEADER" }] };
      await contextHook(event2);
      expect(event2.system[0]).toBe(event2.system[0]);
      const texts2 = event2.system.map((p) => p.text);
      expect(texts2.some((t) => t.includes("<context_window_protection>"))).toBe(true);
      expect(texts2.some((t) => t.includes("session_resume"))).toBe(false);

      cleanup?.();
    });

    it("session prompt hook captures user prompt text as a user_prompt event", async () => {
      const { ContextModeSetup } = await import("../src/adapters/opencode/plugin.js");
      const projectDir = join(tempDir, "bridge-prompt");
      mkdirSync(projectDir, { recursive: true });
      const host = makeV2Ctx(projectDir, { withSession: true });

      const cleanup = (await ContextModeSetup(host.ctx as any)) as () => void;
      const promptHook = host.sessionHooks.get("prompt") as any;
      expect(promptHook).toBeTypeOf("function");

      await promptHook({
        sessionID: "v2-prompt-sess",
        prompt: { text: "switch to mission mode and prefer the elegant solution" },
        metadata: {},
        delivery: "user",
      });

      const inst = mockState.instances.at(-1);
      const events = inst.getEvents("v2-prompt-sess") as any[];
      const userPrompt = events.find((e: any) => e.type === "user_prompt");
      expect(userPrompt).toBeDefined();
      expect(String(userPrompt.data)).toContain("mission mode");

      cleanup?.();
    });

    it("event subscription feeds the shared handler (usage capture) and stops on cleanup", async () => {
      const { ContextModeSetup } = await import("../src/adapters/opencode/plugin.js");
      const projectDir = join(tempDir, "bridge-event-bus");
      const host = makeV2Ctx(projectDir, { withEventBus: true });

      const cleanup = (await ContextModeSetup(host.ctx as any)) as () => Promise<void>;
      expect(host.getEventSignal()).toBeDefined(); // subscribe got a signal

      // Non-usage event → shared handler filters it out without throwing
      host.pushEvent({ type: "session.updated", properties: {} });
      // Usage event → shared handler captures an agent_usage event
      host.pushEvent({
        type: "message.updated",
        properties: {
          info: {
            sessionID: "v2-bus-sess",
            role: "assistant",
            modelID: "gpt-test",
            tokens: { input: 10, output: 5 },
          },
        },
      });
      const inst = mockState.instances.at(-1);
      await vi.waitFor(() => {
        const events = inst.getEvents("v2-bus-sess") as any[];
        expect(events.some((e: any) => e.type === "agent_usage")).toBe(true);
      });

      const usageCountBefore = (inst.getEvents("v2-bus-sess") as any[]).filter(
        (e: any) => e.type === "agent_usage",
      ).length;

      await cleanup();

      // Cleanup aborted the subscription signal
      expect(host.getEventSignal()?.aborted).toBe(true);
      // The runtime DB handle was closed by teardown — open a FRESH read
      // handle on the same path to observe post-cleanup behavior.
      const { resolveSessionDbPath, SessionDB: ReadHandle } = await import("../src/session/db.js");
      const { OpenCodeAdapter } = await import("../src/adapters/opencode/index.js");
      const reader = new ReadHandle({
        dbPath: resolveSessionDbPath({
          projectDir,
          sessionsDir: new OpenCodeAdapter("opencode").getSessionDir(),
        }),
      });
      const countViaReader = () =>
        (reader.getEvents("v2-bus-sess") as any[]).filter((e: any) => e.type === "agent_usage")
          .length;
      expect(countViaReader()).toBe(usageCountBefore);

      // No further handler invocations after cleanup (stale pump is dead)
      host.pushEvent({
        type: "message.updated",
        properties: {
          info: {
            sessionID: "v2-bus-sess",
            role: "assistant",
            modelID: "gpt-test",
            tokens: { input: 100, output: 50 },
          },
        },
      });
      await sleep(40);
      expect(countViaReader()).toBe(usageCountBefore);
      reader.close();
    });
  });

  // ── (d) Teardown + liveness neutralization ────────────

  describe("routing availability signal (native ctx_* tools)", () => {
    it("v2 native claim sets the routing flag; teardown clears it; v1 never sets it", async () => {
      const { ContextModeSetup } = await import("../src/adapters/opencode/plugin.js");
      const routing = await import("../../hooks/core/routing.mjs");
      const projectDir = join(tempDir, "routing-native-flag");

      // MCP NOT ready: the sentinel is removed so the flag is the ONLY
      // availability signal (exactly the v2-native condition).
      try {
        unlinkSync(mcpSentinel);
      } catch {
        /* already absent */
      }
      expect(routing.isContextModeToolsAvailable()).toBe(false);

      const host = makeV2Ctx(projectDir);
      const cleanup = (await ContextModeSetup(host.ctx as any)) as () => Promise<void>;
      expect(typeof cleanup).toBe("function");

      // Native claim → ctx_* tools reachable in-process → flag set
      expect(routing.isContextModeToolsAvailable()).toBe(true);

      await cleanup();
      // Teardown with no remaining native claimant → flag cleared so
      // redirects never point at dead tools.
      expect(routing.isContextModeToolsAvailable()).toBe(false);

      // A v1 claim NEVER sets the flag (current v1 behavior: MCP sentinel gate)
      await createV1Plugin(projectDir);
      expect(routing.isContextModeToolsAvailable()).toBe(false);
    });
  });

  describe("teardown and liveness neutralization", () => {
    it("v2 cleanup disposes transform/hook/session/event registrations, closes the DB, and stale callbacks stop firing", async () => {
      const { ContextModeSetup } = await import("../src/adapters/opencode/plugin.js");
      const projectDir = join(tempDir, "guard-cleanup-release");

      const first = makeV2Ctx(projectDir, { withSession: true, withEventBus: true });
      const cleanup = (await ContextModeSetup(first.ctx as any)) as () => Promise<void>;
      expect(typeof cleanup).toBe("function");

      expect(first.addedTools.has("ctx_stats")).toBe(true);
      expect(first.toolHooks.has("execute.before")).toBe(true);
      expect(first.sessionHooks.has("context")).toBe(true);

      const inst = mockState.instances.at(-1);
      const closeSpy = vi.spyOn(inst, "close");

      await cleanup();

      // Every registration was disposed
      expect(first.addedTools.size).toBe(0); // transform registration disposed
      expect(first.toolHooks.size).toBe(0);
      expect(first.sessionHooks.size).toBe(0);
      expect(first.getEventSignal()?.aborted).toBe(true); // subscription aborted
      // The runtime DB handle was closed (no leak across reload)
      expect(closeSpy).toHaveBeenCalledTimes(1);
      // Claim released
      const registry = await getActivationRegistry();
      expect([...registry.keys()].filter((k) => k.includes("guard-cleanup-release"))).toHaveLength(0);

      // Re-claim after cleanup → second runtime (2nd DB construction), fresh
      // registrations work, and no stale double-firing occurs.
      const second = makeV2Ctx(projectDir, { withSession: true, withEventBus: true });
      const cleanup2 = (await ContextModeSetup(second.ctx as any)) as () => Promise<void>;
      expect(second.addedTools.has("ctx_stats")).toBe(true);
      const ctor = await getSessionDbCtor();
      expect(ctor.mock.calls.length).toBe(2);
      await cleanup2();
    });

    it("handle-less host: failed setup leaves only NEUTRALIZED stale callbacks — silent no-op after teardown, coexisting with a later v1 claim", async () => {
      const { ContextModeSetup } = await import("../src/adapters/opencode/plugin.js");
      const projectDir = join(tempDir, "handleless-stale-neutralized");
      const logs: LogEntry[] = [];
      mkdirSync(projectDir, { recursive: true });

      // Host whose registration calls SUCCEED but return NO dispose handle:
      //   - transform: runs the editor callback, returns undefined
      //   - tool.hook: registers "before" handle-less, REJECTS "after" and
      //     any non-string name → mandatory hook registration fails partway,
      //     AFTER native tools were registered.
      const toolHooks = new Map<string, unknown>();
      const addedTools = new Map<string, any>();
      const editor = {
        list: () => [...addedTools.values()],
        get: (id: string) => addedTools.get(id),
        namespace: () => undefined,
        add: (tool: { name: string }) => {
          addedTools.set(tool.name, tool);
        },
        update: (id: string, fn: (t: unknown) => unknown) => addedTools.set(id, fn(addedTools.get(id))),
        remove: (id: string) => addedTools.delete(id),
      };
      const ctx = {
        directory: projectDir,
        client: {
          app: {
            log: async (o: { body?: LogEntry } & LogEntry) => {
              logs.push((o?.body ?? o) as LogEntry);
            },
          },
        },
        tool: {
          transform: async (cb: (editor: unknown) => unknown) => {
            await cb(editor);
            // returns undefined → handle-less
          },
          hook: async (name: unknown, cb: unknown) => {
            if (typeof name !== "string") throw new Error("map form rejected");
            if (name === "execute.after") throw new Error("after rejected");
            toolHooks.set(name, cb); // returns undefined → handle-less
          },
        },
      };

      const result = await ContextModeSetup(ctx as any);

      // Failed setup: claim released, failure logged
      expect(result).toBeUndefined();
      const registry = await getActivationRegistry();
      expect([...registry.keys()].filter((k) => k.includes("handleless-stale-neutralized"))).toHaveLength(0);
      expect(
        logs.some((l) => /tool execute hook registration failed/.test(l.message ?? "")),
      ).toBe(true);

      // The host kept handle-less registrations: the stale "before" hook and
      // the stale native tool map. Both must be NEUTRALIZED by the liveness
      // gate (teardownV2 set rt.closed BEFORE the claim release).
      const staleBefore = toolHooks.get("execute.before") as any;
      expect(staleBefore).toBeTypeOf("function");
      expect(addedTools.get("ctx_search")).toBeDefined();

      // The failed v2 runtime's DB (closed by teardown)
      const staleDb = mockState.instances.at(-1);
      const ensureSpy = vi.spyOn(staleDb, "ensureSession");

      // The failed setup itself emitted ONE error-level log (the hook
      // registration failure). Baseline it — stale callbacks must add NONE.
      const errorCountBaseline = logs.filter((l) => l.level === "error").length;
      expect(errorCountBaseline).toBe(1);

      // Invoking the stale tool-hook callback: silent no-op — no throw,
      // no DB touch, no error log.
      await expect(
        staleBefore(
          { tool: "Bash", sessionID: "s-stale", input: { command: "curl https://example.com" } },
        ),
      ).resolves.toBeUndefined();
      await expect(
        staleBefore({ tool: "Read", sessionID: "s-stale", input: { file_path: "/x.ts" } }),
      ).resolves.toBeUndefined();
      expect(ensureSpy).not.toHaveBeenCalled(); // no DB touch
      expect(logs.filter((l) => l.level === "error").length).toBe(errorCountBaseline);

      // Stale native tool: harmless inactive note instead of executing
      const staleToolResult = (await addedTools.get("ctx_search").execute(
        { queries: ["anything"] },
        {},
      )) as { content: string };
      expect(staleToolResult.content).toContain("inactive");
      expect(logs.filter((l) => l.level === "error").length).toBe(errorCountBaseline);

      // v1 subsequently claims the same project and works normally…
      const plugin = await createV1Plugin(projectDir, logs);
      expect(plugin).toHaveProperty("tool.execute.before");
      await plugin["tool.execute.after"](
        { tool: "Read", sessionID: "s-v1-after", callID: "c1", args: { file_path: "/v1/x.ts" } },
        { title: "Read", output: "v1 content", metadata: {} },
      );
      const v1Db = mockState.instances.at(-1);
      const v1Events = v1Db.getEvents("s-v1-after") as any[];
      expect(v1Events.length).toBeGreaterThan(0); // v1 capture works

      // …and the stale v2 callbacks stay silent next to the live v1 hooks
      // (no double-fire: v2 handler must not insert into ANY db or log).
      const v1DbEventsBefore = (v1Db.getEvents("s-stale") as any[]).length;
      await expect(
        staleBefore({ tool: "Read", sessionID: "s-stale", input: { file_path: "/stale/y.ts" } }),
      ).resolves.toBeUndefined();
      expect((v1Db.getEvents("s-stale") as any[]).length).toBe(v1DbEventsBefore);
      expect(logs.filter((l) => l.level === "error").length).toBe(errorCountBaseline);
    });
  });

  // ── (e) Capability probing + honest degradation ────────

  describe("v2 capability probing", () => {
    it("missing mandatory surfaces → setup does not claim, no DB init, logs MCP fallback advice", async () => {
      const { ContextModeSetup } = await import("../src/adapters/opencode/plugin.js");
      const projectDir = join(tempDir, "probe-no-tool-surface");
      const { ctx, logs } = makeV2Ctx(projectDir, { omitToolSurface: true });

      const result = await ContextModeSetup(ctx as any);

      expect(result).toBeUndefined();
      const ctor = await getSessionDbCtor();
      expect(ctor.mock.calls.length).toBe(0); // no runtime → no DB init
      const registry = await getActivationRegistry();
      expect([...registry.keys()].filter((k) => k.includes("probe-no-tool-surface"))).toHaveLength(0);
      expect(logs.some((l) => /no native v2 tool surface/.test(l.message ?? ""))).toBe(true);
      expect(logs.some((l) => /MCP fallback \(mcp\.context-mode\)/.test(l.message ?? ""))).toBe(true);
      expect(logs.find((l) => /no native v2 tool surface/.test(l.message ?? ""))?.level).toBe("info");
    });

    it("tool.hook present but registration throws → activation released, native registrations disposed", async () => {
      const { ContextModeSetup } = await import("../src/adapters/opencode/plugin.js");
      const projectDir = join(tempDir, "probe-hook-throws");
      const { ctx, logs, addedTools } = makeV2Ctx(projectDir, {
        hookImpl: async () => {
          throw new Error("host rejected registration");
        },
      });

      const result = await ContextModeSetup(ctx as any);

      expect(result).toBeUndefined();
      const registry = await getActivationRegistry();
      expect([...registry.keys()].filter((k) => k.includes("probe-hook-throws"))).toHaveLength(0);
      // Runtime was constructed (registration needs handlers over the DB),
      // but the claim is released — no half-activation.
      const ctor = await getSessionDbCtor();
      expect(ctor.mock.calls.length).toBe(1);
      expect(
        logs.some((l) => /tool execute hook registration failed/.test(l.message ?? "")),
      ).toBe(true);
      // The native tools registered BEFORE the hook failure were disposed.
      expect(addedTools.size).toBe(0);
    });

    it("optional surfaces missing → degrades with ONE-TIME logs, still claims and returns cleanup", async () => {
      const { ContextModeSetup } = await import("../src/adapters/opencode/plugin.js");
      const projectDir = join(tempDir, "probe-optional-missing");
      const { ctx, logs, toolHooks, addedTools } = makeV2Ctx(projectDir);

      const cleanup = await ContextModeSetup(ctx as any);
      expect(typeof cleanup).toBe("function");
      expect([...toolHooks.keys()].sort()).toEqual(["execute.after", "execute.before"]);
      expect(addedTools.size).toBeGreaterThan(0);

      // One-time degradation logs (each message appears exactly once)
      const sessionCtxLogs = logs.filter((l) =>
        /session context injection unavailable \(no ctx\.session\.hook\('context'\)\)/.test(l.message ?? ""),
      );
      expect(sessionCtxLogs.length).toBe(1);
      expect(logs.some((l) => /user-prompt capture unavailable \(no ctx\.session\.hook\('prompt'\)\)/.test(l.message ?? ""))).toBe(true);
      expect(logs.some((l) => /event bus unavailable \(no ctx\.event\.subscribe\)/.test(l.message ?? ""))).toBe(true);
      // Native tools are mandatory and the fake host provides them —
      // no native-degradation log may appear.
      expect(logs.some((l) => /native tool registration unavailable/.test(l.message ?? ""))).toBe(false);

      (cleanup as () => void)?.();
    });

    it("degradation logs are one-time per process (not per setup call)", async () => {
      const { ContextModeSetup } = await import("../src/adapters/opencode/plugin.js");
      const logs: LogEntry[] = [];

      const a = makeV2Ctx(join(tempDir, "probe-onetime-a"));
      (a.ctx as any).client.app.log = async (o: any) => logs.push((o?.body ?? o) as LogEntry);
      (await ContextModeSetup(a.ctx as any))?.();

      const b = makeV2Ctx(join(tempDir, "probe-onetime-b"));
      (b.ctx as any).client.app.log = async (o: any) => logs.push((o?.body ?? o) as LogEntry);
      (await ContextModeSetup(b.ctx as any))?.();

      const sessionCtxLogs = logs.filter((l) =>
        /session context injection unavailable \(no ctx\.session\.hook\('context'\)\)/.test(l.message ?? ""),
      );
      expect(sessionCtxLogs.length).toBe(1); // logged once, not once per project
    });
  });

  // ── (f) Hybrid MCP-fallback policy ────────────────────

  describe("hybrid MCP fallback policy", () => {
    it("hybrid: native tools do NOT register → v2 does not claim (NO hooks registered), v1 can claim, MCP kept until v1 confirms", async () => {
      const { ContextModeSetup } = await import("../src/adapters/opencode/plugin.js");
      const projectDir = join(tempDir, "hybrid-v2-native-missing");
      const logs: LogEntry[] = [];

      // v2 runs FIRST: tool.hook would work, but there is NO native tool
      // surface. Native tools are probed BEFORE tool hooks, so a native
      // failure fails setup with ZERO registrations — the stale-callback
      // window is closed by construction on this path.
      const { ctx, toolHooks } = makeV2Ctx(projectDir, {
        log: logs,
        omitToolTransform: true,
      });
      const result = await ContextModeSetup(ctx as any);

      // v2 must NOT claim: native tools are part of the mandatory surface
      expect(result).toBeUndefined();
      // Native-first ordering: setup fails BEFORE any tool hook is
      // registered → no stale handle-less callbacks can exist on this path.
      expect(toolHooks.size).toBe(0);
      const registry = await getActivationRegistry();
      expect([...registry.keys()].filter((k) => k.includes("hybrid-v2-native-missing"))).toHaveLength(0);
      // The mandatory-surface PROBE rejects before any registration attempt.
      expect(
        logs.some(
          (l) =>
            /no native v2 tool surface/.test(l.message ?? "") &&
            /activation not claimed/.test(l.message ?? ""),
        ),
      ).toBe(true);

      // Legacy-MCP policy while NO claimant is confirmed: even though the v1
      // `plugin` key is present, the live plugin state says native tools are
      // NOT confirmed for this project → mcp.context-mode must be KEPT.
      // (The CLI-style peek keys on process.cwd() — chdir into the project,
      // exactly like a real `context-mode upgrade` invocation.)
      const prevCwd = process.cwd();
      mkdirSync(projectDir, { recursive: true });
      process.chdir(projectDir);
      try {
        writeFileSync(
          join(projectDir, "opencode.json"),
          JSON.stringify(
            {
              plugin: ["context-mode"],
              mcp: {
                "context-mode": { type: "local", command: ["context-mode"] },
                other: { type: "local", command: ["other"] },
              },
            },
            null,
            2,
          ) + "\n",
        );
        const { OpenCodeAdapter } = await import("../src/adapters/opencode/index.js");
        const changes = new OpenCodeAdapter().configureAllHooks("/tmp/plugin");
        expect(changes).toContain(
          "Kept legacy context-mode MCP block (v2 native tool registration unconfirmed)",
        );
        expect(JSON.parse(readFileSync(join(projectDir, "opencode.json"), "utf-8")).mcp).toHaveProperty(
          "context-mode",
        );
      } finally {
        process.chdir(prevCwd);
      }

      // v1 server() CAN now claim — full hooks returned
      const plugin = await createV1Plugin(projectDir, logs);
      expect(plugin).toHaveProperty("tool.execute.before");
      expect(plugin).toHaveProperty("tool");

      // Once v1 is the CONFIRMED claimant, current v1 removal behavior applies
      process.chdir(projectDir);
      try {
        const { OpenCodeAdapter } = await import("../src/adapters/opencode/index.js");
        const changes = new OpenCodeAdapter().configureAllHooks("/tmp/plugin");
        expect(changes).toContain("Removed legacy context-mode MCP block (plugin-native tools)");
      } finally {
        process.chdir(prevCwd);
      }
    });
  });

  // ── (g) Detailed error logging in hook catch-alls ─────

  describe("hook catch-all error logging", () => {
    it("logs errors via client.app.log with hook name, sessionId and error code; dedupes identical errors", async () => {
      const projectDir = join(tempDir, "log-client-dedupe");
      const logs: LogEntry[] = [];
      const plugin = await createV1Plugin(projectDir, logs);

      const inst = mockState.instances.at(-1);
      const boom = Object.assign(new Error("disk I/O error"), { code: "SQLITE_IOERR" });
      const ensureSpy = vi.spyOn(inst, "ensureSession").mockImplementation(() => {
        throw boom;
      });

      const hookCall = () =>
        plugin["tool.execute.after"](
          { tool: "Read", sessionID: "s-log-1", callID: "c1", args: { file_path: "/x.ts" } },
          { title: "Read", output: "x", metadata: {} },
        );

      await hookCall();
      await hookCall(); // identical error within the dedupe window → suppressed
      await hookCall();

      const errLogs = logs.filter(
        (l) => l.level === "error" && /tool\.execute\.after/.test(l.message ?? ""),
      );
      expect(errLogs.length).toBe(1); // dedupe: 3 failures → 1 log
      expect(errLogs[0].message).toContain("disk I/O error");
      expect(errLogs[0].message).toContain("code=SQLITE_IOERR");
      expect(errLogs[0].message).toContain("session s-log-1");
      expect(errLogs[0].extra?.sessionId).toBe("s-log-1");
      // Non-debug: at most head + ~2 stack lines
      expect(errLogs[0].message!.split("\n").length).toBeLessThanOrEqual(3);

      // A DIFFERENT error at the same site is logged again (key includes message)
      ensureSpy.mockRestore();
      vi.spyOn(inst, "insertEvent").mockImplementation(() => {
        throw Object.assign(new Error("write failed"), { code: "SQLITE_CORRUPT" });
      });
      await hookCall();
      const corruptLogs = logs.filter(
        (l) => l.level === "error" && /SQLITE_CORRUPT/.test(l.message ?? ""),
      );
      expect(corruptLogs.length).toBe(1);
    });

    it("OPENCODE_DEBUG=1 includes the full stack trace", async () => {
      const prevDebug = process.env.OPENCODE_DEBUG;
      process.env.OPENCODE_DEBUG = "1";
      try {
        const projectDir = join(tempDir, "log-debug-stack");
        const logs: LogEntry[] = [];
        const plugin = await createV1Plugin(projectDir, logs);
        const inst = mockState.instances.at(-1);
        vi.spyOn(inst, "ensureSession").mockImplementation(() => {
          throw new Error("deep failure");
        });
        await plugin["tool.execute.after"](
          { tool: "Read", sessionID: "s-debug", callID: "c1", args: {} },
          { title: "Read", output: "", metadata: {} },
        );
        const errLogs = logs.filter((l) => l.level === "error" && /deep failure/.test(l.message ?? ""));
        expect(errLogs.length).toBe(1);
        expect(errLogs[0].message).toContain("at "); // full stack present in debug mode
      } finally {
        if (prevDebug === undefined) delete process.env.OPENCODE_DEBUG;
        else process.env.OPENCODE_DEBUG = prevDebug;
      }
    });

    it("falls back to stderr (never stdout) when the file sink is unavailable", async () => {
      // Point XDG_DATA_HOME at a regular FILE — mkdir of the sink dir fails
      // through it → the sink is unavailable → the stderr LAST-RESORT path
      // fires (stdout is still never touched).
      const blocker = join(tempDir, "sink-blocker");
      writeFileSync(blocker, "occupied");
      const prevXdg = process.env.XDG_DATA_HOME;
      process.env.XDG_DATA_HOME = blocker;
      __resetPluginLogSinkForTests();

      const stderrWrites: string[] = [];
      const writeSpy = vi
        .spyOn(process.stderr, "write")
        .mockImplementation(((chunk: unknown) => {
          stderrWrites.push(String(chunk));
          return true;
        }) as any);

      try {
        const { ContextModePlugin } = await import("../src/adapters/opencode/plugin.js");
        const projectDir = join(tempDir, "log-stderr-fallback");
        // NO client — with the sink dead, stderr is the last resort.
        const plugin = (await ContextModePlugin({ directory: projectDir } as any)) as Record<string, any>;
        const inst = mockState.instances.at(-1);
        vi.spyOn(inst, "ensureSession").mockImplementation(() => {
          throw new Error("boom-stderr-fallback");
        });
        await plugin["tool.execute.after"](
          { tool: "Read", sessionID: "s-stderr", callID: "c1", args: {} },
          { title: "Read", output: "", metadata: {} },
        );
        expect(
          stderrWrites.some(
            (w) => w.includes("tool.execute.after") && w.includes("boom-stderr-fallback"),
          ),
        ).toBe(true);
        expect(stderrWrites.some((w) => w.startsWith("[context-mode]"))).toBe(true);
      } finally {
        writeSpy.mockRestore();
        if (prevXdg === undefined) delete process.env.XDG_DATA_HOME;
        else process.env.XDG_DATA_HOME = prevXdg;
        __resetPluginLogSinkForTests();
        try {
          rmSync(blocker, { force: true });
        } catch {
          /* cleanup best effort */
        }
      }
    });
  });

  // ── (h) File sink (opencode data-dir diagnostics log) ──
  // User decision: plugin diagnostics must NOT leak onto the v1 TUI.
  // emitHostLog ALWAYS writes to <data-root>/opencode/log/context-mode.log;
  // stderr is the last-resort ONLY when the sink is unavailable/failed.

  describe("plugin log file sink", () => {
    let sinkRoot: string;
    let prevXdg: string | undefined;

    const sinkPath = () => join(sinkRoot, "opencode", "log", "context-mode.log");
    const readSink = () => readFileSync(sinkPath(), "utf-8");

    beforeEach(() => {
      sinkRoot = mkdtempSync(join(tmpdir(), "ctx-sink-"));
      prevXdg = process.env.XDG_DATA_HOME;
      process.env.XDG_DATA_HOME = sinkRoot;
      __resetPluginLogSinkForTests();
    });

    afterEach(() => {
      if (prevXdg === undefined) delete process.env.XDG_DATA_HOME;
      else process.env.XDG_DATA_HOME = prevXdg;
      __resetPluginLogSinkForTests();
      try {
        rmSync(sinkRoot, { recursive: true, force: true });
      } catch {
        /* cleanup best effort */
      }
    });

    it("messages land in <data-root>/opencode/log/context-mode.log with ISO ts + level", async () => {
      const { ContextModePlugin } = await import("../src/adapters/opencode/plugin.js");
      const projectDir = join(tempDir, "sink-basic");
      const plugin = (await ContextModePlugin({ directory: projectDir } as any)) as Record<string, any>;
      const inst = mockState.instances.at(-1);
      vi.spyOn(inst, "ensureSession").mockImplementation(() => {
        throw Object.assign(new Error("sink-shape-probe"), { code: "E_PROBE" });
      });
      await plugin["tool.execute.after"](
        { tool: "Read", sessionID: "s-shape", callID: "c1", args: {} },
        { title: "Read", output: "", metadata: {} },
      );
      const content = readSink();
      expect(content).toMatch(/\[\d{4}-\d{2}-\d{2}T/); // ISO-8601 timestamp
      expect(content).toMatch(/\[ERROR\] [^\n]*tool\.execute\.after/);
      expect(content).toContain("sink-shape-probe");
      expect(content).toContain("code=E_PROBE");
      // No client → no client-integration path — the file is the only sink.
    });

    it("duplicate-activation message is level info (demoted) in the file AND the client log", async () => {
      const projectDir = join(tempDir, "sink-dup");
      const logs: LogEntry[] = [];
      await createV1Plugin(projectDir, logs);
      const second = await createV1Plugin(projectDir, logs);
      expect(second).not.toHaveProperty("tool.execute.before");

      const content = readSink();
      expect(content).toMatch(/\[INFO\] [^\n]*already active via v1/);
      expect(content).not.toMatch(/\[WARN\][^\n]*already active via v1/);
      // v2 host integration preserved: the client log carried the SAME info
      expect(
        logs.some((l) => l.level === "info" && /already active via v1/.test(l.message ?? "")),
      ).toBe(true);
    });

    it("no stderr write on success — even with NO host client (file sink only)", async () => {
      const stderrSpy = vi
        .spyOn(process.stderr, "write")
        .mockImplementation((() => true) as any);
      try {
        const { ContextModePlugin } = await import("../src/adapters/opencode/plugin.js");
        const projectDir = join(tempDir, "sink-no-stderr");
        // NO client — without the file sink this used to hit stderr.
        const plugin = (await ContextModePlugin({ directory: projectDir } as any)) as Record<string, any>;
        const inst = mockState.instances.at(-1);
        vi.spyOn(inst, "ensureSession").mockImplementation(() => {
          throw new Error("boom-file-sink");
        });
        await plugin["tool.execute.after"](
          { tool: "Read", sessionID: "s-sink", callID: "c1", args: {} },
          { title: "Read", output: "", metadata: {} },
        );
        const content = readSink();
        expect(content).toContain("tool.execute.after");
        expect(content).toContain("boom-file-sink");
        expect(stderrSpy).not.toHaveBeenCalled();
      } finally {
        stderrSpy.mockRestore();
      }
    });
  });
});
