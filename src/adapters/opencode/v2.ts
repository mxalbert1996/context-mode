/**
 * adapters/opencode/v2 — self-contained OpenCode v2 helper machinery.
 *
 * Holds only what has a clean seam from the plugin orchestration in
 * plugin.ts (which owns the shared v1 handlers, the v2 registration/
 * bridging functions, setupV2, and the hybrid activation guard):
 *   - the host-client log types (shared by the v1 and v2 logging paths)
 *   - the VERIFIED v2 setup-context surface types (opencode2 beta-19135
 *     live probe + docs build/plugins)
 *   - the Zod → JSON-Schema converter feeding ToolInfo.input
 *   - defensive field readers for the UNCONFIRMED v2 hook payload shapes
 *
 * Imports NOTHING from plugin.ts — no cycles. Exports kept minimal.
 */

// ── Host client log types (shared v1 + v2) ────────────────

export type PluginClientAppLogBodyExtra = {
  sessionId?: string;
  source?: string;
};

export type PluginClientAppLogBody = {
  service: string;
  level: "info" | "warn" | "error" | "debug"; // Strict union for log levels
  message: string;
  extra?: PluginClientAppLogBodyExtra;
};

export type PluginClientAppLogOptions = {
  body: PluginClientAppLogBody;
};

export type PluginClientApp = {
  log: (options: PluginClientAppLogOptions) => Promise<void>;
};

export type PluginClient = {
  app: PluginClientApp;
};

// ── Verified v2 setup-context surface ─────────────────────

/**
 * VERIFIED against opencode2 beta-19135 (live probe) + the v2 plugin docs
 * (opencode.ai/v2/docs/build/plugins):
 *   ctx.tool  { reload, transform, hook }
 *   ctx.session { hook, create, get, prompt, interrupt, rename, context, … }
 *   ctx.event { subscribe }
 *   ctx.app   { name, version, channel }   — NO app.log on v2
 * Fields marked UNCONFIRMED (hook payload extras, event names) are accessed
 * defensively — never assume a field exists.
 */

/** v2 ToolEditor — handed to the ctx.tool.transform callback. */
export type V2ToolEditor = {
  list?: () => unknown[];
  get?: (id: string) => unknown;
  namespace?: (options: unknown) => unknown;
  add?: (tool: unknown) => unknown;
  update?: (id: string, fn: (tool: unknown) => unknown) => unknown;
  remove?: (id: string) => unknown;
};

/** v2 ToolInfo — what we register via editor.add() (docs: build/plugins). */
export type V2ToolInfo = {
  name: string;
  description?: string;
  /** JSON-Schema object schema for the tool input. */
  input: Record<string, unknown>;
  options?: { namespace?: string; codemode?: boolean };
  execute: (input: unknown, tool: unknown) => Promise<unknown>;
};

export type V2SetupContext = {
  directory?: string;
  project?: { directory?: string };
  client?: PluginClient;
  app?: { name?: string; version?: string; channel?: string };
  tool?: {
    reload?: (...args: unknown[]) => unknown;
    transform?: (cb: (editor: V2ToolEditor) => unknown) => unknown;
    hook?: (name: string, cb: (event: unknown) => unknown) => unknown;
  };
  session?: {
    hook?: (name: string, cb: (event: unknown) => unknown) => unknown;
  };
  event?: {
    /** AsyncIterable of { type, ... } events; exact event shapes UNCONFIRMED. */
    subscribe?: (options?: { signal?: AbortSignal }) => unknown;
  };
  /**
   * v2 permission domain (verified against opencode2 beta-19135 live probe:
   * ctx.permission.hook("evaluate", cb) fires for every core-tool permission
   * assert with a MUTABLE event { action, resources, source?, effect, message? }
   * — hook mutations of effect/message win the decision). Optional: older v2
   * builds and all v1 hosts lack the surface; the plugin degrades to the
   * execute.before throw-based behavior there.
   */
  permission?: {
    hook?: (name: string, cb: (event: unknown) => unknown) => unknown;
  };
};

// ── Zod → JSON-Schema (ToolInfo.input) ────────────────────

/**
 * Whether a Zod schema position is OMITTABLE for JSON-Schema `required`
 * purposes. Unwraps wrapper constructs recursively:
 *   ZodOptional → true (field may be absent)
 *   ZodDefault → true (the default satisfies the field — omittable)
 *   ZodEffects (z.preprocess/refine) → unwrap to the inner schema
 *   ZodCatch → unwrap to the inner schema
 *   ZodNullable → false (null allowed, but the field is still required —
 *     matches zod-to-json-schema semantics)
 */
function zodSchemaIsOmittable(schema: unknown, depth = 0): boolean {
  if (depth > 12 || schema === null || typeof schema !== "object") return false;
  const def = (schema as { _def?: Record<string, any> })._def;
  if (!def) return false;
  switch (def.typeName) {
    case "ZodOptional":
      return true;
    case "ZodDefault":
      return true;
    case "ZodCatch":
      return zodSchemaIsOmittable(def.innerType, depth + 1);
    case "ZodEffects":
      return zodSchemaIsOmittable(def.schema, depth + 1);
    case "ZodNullable":
      return false;
    default:
      return false;
  }
}

/**
 * Convert a Zod (v3-classic) schema into a JSON-Schema object — the shared
 * single conversion point for the v2 ToolInfo `input` field. The MCP layer
 * passes its Zod schemas to the SDK (which converts internally), so there is
 * no repo util to reuse; this helper covers exactly the constructs the
 * ctx_* tools use (object/optional/default/enum/string/number/boolean/
 * array/preprocess/record/union/literal/any) and degrades to a permissive
 * `{}` (accept anything) for anything it does not understand — a weird
 * schema must never break tool registration.
 */
export function zodSchemaToJsonSchema(schema: unknown, depth = 0): Record<string, unknown> {
  if (depth > 12 || schema === null || typeof schema !== "object") return {};
  try {
    const def = (schema as { _def?: Record<string, any> })._def ?? {};
    const described = (out: Record<string, unknown>): Record<string, unknown> => {
      if (typeof def.description === "string" && def.description) out.description = def.description;
      return out;
    };
    switch (def.typeName) {
      case "ZodString": {
        const out = described({ type: "string" });
        for (const check of Array.isArray(def.checks) ? def.checks : []) {
          if (check?.kind === "min" && typeof check.value === "number") out.minLength = check.value;
          if (check?.kind === "max" && typeof check.value === "number") out.maxLength = check.value;
        }
        return out;
      }
      case "ZodNumber":
        return described({ type: "number" });
      case "ZodBoolean":
        return described({ type: "boolean" });
      case "ZodEnum":
        return described({ type: "string", enum: Array.isArray(def.values) ? def.values : [] });
      case "ZodLiteral":
        return described({ enum: [def.value] });
      case "ZodArray":
        return described({ type: "array", items: zodSchemaToJsonSchema(def.type, depth + 1) });
      case "ZodRecord":
        return described({ type: "object", additionalProperties: zodSchemaToJsonSchema(def.valueType, depth + 1) });
      case "ZodUnion":
        return described({ anyOf: (Array.isArray(def.options) ? def.options : []).map((o: unknown) => zodSchemaToJsonSchema(o, depth + 1)) });
      case "ZodOptional":
      case "ZodNullable":
      case "ZodCatch":
        return zodSchemaToJsonSchema(def.innerType, depth + 1);
      case "ZodDefault": {
        const out = zodSchemaToJsonSchema(def.innerType, depth + 1);
        try {
          out.default = typeof def.defaultValue === "function" ? def.defaultValue() : def.defaultValue;
        } catch {
          // Non-computable default — omit it; the schema stays permissive.
        }
        return out;
      }
      case "ZodEffects":
        // z.preprocess / refine / transform — the INNER schema is the
        // contract; the coercion runs in the execute path (same as v1).
        return zodSchemaToJsonSchema(def.schema, depth + 1);
      case "ZodObject": {
        const shape =
          typeof def.shape === "function"
            ? (def.shape as () => Record<string, unknown>)()
            : def.shape ?? {};
        const properties: Record<string, unknown> = {};
        const required: string[] = [];
        for (const [key, value] of Object.entries(shape)) {
          properties[key] = zodSchemaToJsonSchema(value, depth + 1);
          // Requiredness sees through ZodOptional/ZodDefault/ZodEffects
          // (z.preprocess) wrappers — a defaulted or coerced-optional param
          // must stay omittable, otherwise HOST-side JSON-Schema validation
          // can reject the call before our Zod parse (with its coercions
          // and defaults) ever runs.
          if (!zodSchemaIsOmittable(value)) required.push(key);
        }
        return described({ type: "object", properties, required });
      }
      case "ZodAny":
      case "ZodUnknown":
        return described({});
      default:
        // Unknown construct — permissive.
        return described({});
    }
  } catch {
    return {};
  }
}

// ── Defensive readers for UNCONFIRMED v2 hook payloads ────

export function v2ToolNameOf(event: Record<string, any>): string {
  if (typeof event.tool === "string") return event.tool;
  if (event.tool && typeof event.tool === "object") {
    const t = event.tool as Record<string, any>;
    if (typeof t.name === "string") return t.name;
    if (typeof t.id === "string") return t.id;
  }
  return "";
}

export function v2SessionIdOf(event: Record<string, any>): string {
  const candidate =
    event.sessionID ??
    event.session?.id ??
    event.tool?.sessionID ??
    event.input?.sessionID ??
    event.metadata?.sessionID;
  return typeof candidate === "string" && candidate ? candidate : "";
}

/**
 * Extract displayable text from an UNCONFIRMED v2 tool-result shape
 * ({content: "..."} | {content: [{text}]} | {output} | string | other).
 */
export function extractV2ToolResultText(result: unknown): string {
  if (typeof result === "string") return result;
  if (result === null || typeof result !== "object") return "";
  const r = result as Record<string, any>;
  if (typeof r.content === "string") return r.content;
  if (Array.isArray(r.content)) {
    return r.content
      .map((part) => (part && typeof part === "object" && typeof part.text === "string" ? part.text : ""))
      .filter(Boolean)
      .join("\n");
  }
  if (typeof r.output === "string") return r.output;
  try {
    return JSON.stringify(r);
  } catch {
    return String(result);
  }
}

/**
 * Extract displayable text from an UNCONFIRMED v2 tool-error shape
 * (Error | string | {message} | object | undefined). Feeds the shared
 * post-tool capture on `execute.after` error status so failed tool calls
 * still produce error_tool events (v1 parity — extract.ts isToolError).
 */
export function extractV2ToolErrorText(error: unknown): string {
  if (typeof error === "string") return error;
  if (error instanceof Error) {
    const code = (error as { code?: string }).code;
    return code ? `${error.message} (code=${code})` : error.message;
  }
  if (error !== null && typeof error === "object") {
    const e = error as Record<string, any>;
    if (typeof e.message === "string" && e.message) return e.message;
    try {
      return JSON.stringify(e);
    } catch {
      // fall through to String
    }
  }
  return error !== undefined && error !== null ? String(error) : "tool execute failed";
}

/** Read displayable text out of a v2 SystemPart (string or {text}). */
export function v2SystemPartText(part: unknown): string {
  if (typeof part === "string") return part;
  if (part !== null && typeof part === "object") {
    const text = (part as Record<string, any>).text;
    if (typeof text === "string") return text;
  }
  return "";
}
