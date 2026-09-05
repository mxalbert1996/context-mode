import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { writeFileSync, mkdtempSync, rmSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

/**
 * Focused tests for the NATIVE ctx_* tools availability signal in
 * hooks/core/routing.mjs (v2-native routing enforcement fix).
 *
 * Root cause (smoke-verified): `mcpRedirect` returned null (passthrough)
 * whenever `!isMCPReady()` — on opencode v2 the plugin registers ctx_* tools
 * NATIVELY (no MCP server, no sentinel), so every curl/HTTP redirect (and
 * deny actions pointing at MCP alternatives) silently passed through even
 * though the referenced tools WERE available natively. The fix adds an
 * in-process availability signal the plugin sets after a native claim.
 *
 * Sentinel isolation (same mechanism as tests/hooks/core-routing.test.ts):
 * CONTEXT_MODE_MCP_SENTINEL_DIR points at an isolated temp dir. An EMPTY dir
 * ⇒ MCP NOT ready; writing the live-PID sentinel ⇒ ready.
 */

const sentinelDir = mkdtempSync(join(tmpdir(), "ctx-native-routing-"));
process.env.CONTEXT_MODE_MCP_SENTINEL_DIR = sentinelDir;
const mcpSentinel = resolve(sentinelDir, `context-mode-mcp-ready-${process.pid}`);

// Dynamic import for .mjs module
let mod: any;

beforeAll(async () => {
  mod = await import("../../hooks/core/routing.mjs");
});

beforeEach(() => {
  mod.resetGuidanceThrottle();
  mod.resetContextModeToolsAvailable();
  // Start each test with NO live sentinel → MCP not ready.
  try {
    unlinkSync(mcpSentinel);
  } catch {
    /* already absent */
  }
});

afterAll(() => {
  try {
    rmSync(sentinelDir, { recursive: true, force: true });
  } catch {
    /* cleanup best effort */
  }
  delete process.env.CONTEXT_MODE_MCP_SENTINEL_DIR;
  mod.resetContextModeToolsAvailable();
});

const DANGEROUS_CURL = { command: "curl https://example.com/data" };

describe("routing: native ctx_* tools availability signal (v2)", () => {
  it("flag false + MCP not ready → dangerous curl passes through (default behavior preserved)", () => {
    expect(mod.isContextModeToolsAvailable()).toBe(false);
    const decision = mod.routePreToolUse("Bash", DANGEROUS_CURL, "/tmp/rt-native-off", "opencode");
    // Pre-fix behavior: no MCP server + no flag → passthrough.
    expect(decision).toBeNull();
  });

  it("flag true + MCP not ready → dangerous curl returns the modify redirect action", () => {
    mod.setContextModeToolsAvailable(true);
    expect(mod.isContextModeToolsAvailable()).toBe(true);
    const decision = mod.routePreToolUse("Bash", DANGEROUS_CURL, "/tmp/rt-native-on", "opencode");
    expect(decision).not.toBeNull();
    expect(decision.action).toBe("modify");
    const cmd: string = decision.updatedInput.command;
    expect(cmd).toContain("curl/wget redirected");
    // Guidance points at the natively-registered tools (opencode namer).
    expect(cmd).toContain("ctx_execute");
    expect(cmd).toContain("ctx_fetch_and_index");
  });

  it("flag true + MCP ready → still redirects (EITHER availability signal suffices)", () => {
    mod.setContextModeToolsAvailable(true);
    writeFileSync(mcpSentinel, String(process.pid));
    try {
      const decision = mod.routePreToolUse("Bash", DANGEROUS_CURL, "/tmp/rt-native-both", "opencode");
      expect(decision?.action).toBe("modify");
    } finally {
      try {
        unlinkSync(mcpSentinel);
      } catch {
        /* cleanup best effort */
      }
    }
  });

  it("flag true does NOT override caller-level suppression (subagent mcpToolsAvailable=false preserved)", () => {
    mod.setContextModeToolsAvailable(true);
    const decision = mod.routePreToolUse(
      "Bash",
      DANGEROUS_CURL,
      "/tmp/rt-native-sub",
      "opencode",
      undefined,
      { mcpToolsAvailable: false },
    );
    // Caller says "not available" (e.g. subagent context) → suppression kept.
    expect(decision).toBeNull();
  });

  it("inline-HTTP redirect site shares the same availability gate", () => {
    mod.setContextModeToolsAvailable(true);
    const decision = mod.routePreToolUse(
      "Bash",
      { command: "python3 -c \"import requests; requests.get('https://example.com')\"" },
      "/tmp/rt-native-http",
      "opencode",
    );
    expect(decision).not.toBeNull();
    expect(decision.action).toBe("modify");
    expect(String(decision.updatedInput.command)).toContain("Inline HTTP redirected");
  });

  it("WebFetch deny redirect site shares the same availability gate", () => {
    mod.setContextModeToolsAvailable(true);
    const decision = mod.routePreToolUse(
      "WebFetch",
      { url: "https://example.com/docs" },
      "/tmp/rt-native-wf",
      "opencode",
    );
    expect(decision).not.toBeNull();
    expect(decision.action).toBe("deny");
    expect(decision.reason).toContain("ctx_fetch_and_index");
  });

  it("reset restores the default (flag cleared → passthrough again with MCP not ready)", () => {
    mod.setContextModeToolsAvailable(true);
    mod.resetContextModeToolsAvailable();
    expect(mod.isContextModeToolsAvailable()).toBe(false);
    expect(mod.routePreToolUse("Bash", DANGEROUS_CURL, "/tmp/rt-native-reset", "opencode")).toBeNull();
  });
});
