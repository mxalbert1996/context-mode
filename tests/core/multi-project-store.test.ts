/**
 * Regression: multi-project hosts (opencode web) serve MANY projects inside
 * ONE process, with each plugin tool call arriving under
 * withProjectDirOverride({projectDir}). getStore() must return a per-project
 * ContentStore — a single cached instance would funnel every project's
 * ctx_* writes into whichever project ran the first tool, exposing one
 * project's knowledge base to all the others (and concentrating every
 * project onto one long-lived DB connection whose files another process'
 * startup cleanup can unlink — surfacing as SQLITE_IOERR_VNODE). Mirrors
 * the #645 SessionDB singleton re-keying pattern.
 */
import { afterAll, describe, expect, test } from "vitest";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdirSync, writeFileSync } from "node:fs";
import { hashProjectDirCanonical, resolveSessionPath } from "../../src/session/db.js";

const storageRoot = mkdtempSync(join(tmpdir(), "ctx-multi-proj-"));
// Route sessions/content/stats into the temp root so the test never
// touches real user storage, and import server.js as a library —
// CONTEXT_MODE_EMBEDDED_PLUGIN_TOOLS suppresses main()'s stdio connect.
process.env.CONTEXT_MODE_DIR = storageRoot;
process.env.CONTEXT_MODE_EMBEDDED_PLUGIN_TOOLS = "1";
// These tests make more ctx_search calls than the default progressive
// throttle allows (blocked after 8 per window) — raise the caps, they are
// read once at server.js module load.
process.env.CONTEXT_MODE_SEARCH_MAX_RESULTS_AFTER = "100";
process.env.CONTEXT_MODE_SEARCH_BLOCK_AFTER = "100";

afterAll(() => {
  delete process.env.CONTEXT_MODE_DIR;
  delete process.env.CONTEXT_MODE_EMBEDDED_PLUGIN_TOOLS;
  delete process.env.CONTEXT_MODE_SEARCH_MAX_RESULTS_AFTER;
  delete process.env.CONTEXT_MODE_SEARCH_BLOCK_AFTER;
});

describe("multi-project host: per-project content store isolation", () => {
  test("ctx_index/ctx_search under two project overrides use two isolated stores", async () => {
    const { withProjectDirOverride, REGISTERED_CTX_TOOLS } = await import(
      "../../src/server.js"
    );
    const indexTool = REGISTERED_CTX_TOOLS.find((t) => t.name === "ctx_index");
    const searchTool = REGISTERED_CTX_TOOLS.find((t) => t.name === "ctx_search");
    expect(indexTool).toBeDefined();
    expect(searchTool).toBeDefined();

    const projectA = mkdtempSync(join(tmpdir(), "ctx-proj-a-"));
    const projectB = mkdtempSync(join(tmpdir(), "ctx-proj-b-"));

    const indexIn = (project: string, content: string, source: string) =>
      withProjectDirOverride(
        { projectDir: project },
        () => indexTool!.handler({ content, source }),
      );
    await indexIn(projectA, "alpha kumquat uniquetoken project a", "proj-a-doc");
    await indexIn(projectB, "beta lychee uniquetoken project b", "proj-b-doc");

    const contentDir = join(storageRoot, "content");
    const dbA = join(contentDir, `${hashProjectDirCanonical(projectA)}.db`);
    const dbB = join(contentDir, `${hashProjectDirCanonical(projectB)}.db`);
    // The old singleton created only the FIRST project's DB file.
    expect(existsSync(dbA)).toBe(true);
    expect(existsSync(dbB)).toBe(true);

    const searchAs = async (project: string, query: string) => {
      const result = await withProjectDirOverride(
        { projectDir: project },
        () => searchTool!.handler({ queries: [query] }),
      );
      return JSON.stringify(result);
    };

    // Cross-project isolation: the search response echoes the query term
    // itself ("## <query>" headers), so the assertion uses the OTHER
    // project's marker words — present only in that project's content.
    expect(await searchAs(projectB, "kumquat")).not.toContain("project a");
    expect(await searchAs(projectA, "lychee")).not.toContain("project b");
    // Sanity: each project finds its own content.
    expect(await searchAs(projectA, "kumquat")).toContain("project a");
    expect(await searchAs(projectB, "lychee")).toContain("project b");
  });

  test("session-events file: each project consumes only its own events file", async () => {
    const { withProjectDirOverride, REGISTERED_CTX_TOOLS } = await import(
      "../../src/server.js"
    );
    const searchTool = REGISTERED_CTX_TOOLS.find((t) => t.name === "ctx_search");
    expect(searchTool).toBeDefined();

    const projectA = mkdtempSync(join(tmpdir(), "ctx-proj-events-a-"));
    const projectB = mkdtempSync(join(tmpdir(), "ctx-proj-events-b-"));
    const sessionsDir = join(storageRoot, "sessions");
    mkdirSync(sessionsDir, { recursive: true });
    // Simulate the SessionStart hook's per-project events files — the
    // filename derives from the same project-dir hash the hooks use.
    const eventsPathA = resolveSessionPath({ projectDir: projectA, sessionsDir, ext: "-events.md" });
    const eventsPathB = resolveSessionPath({ projectDir: projectB, sessionsDir, ext: "-events.md" });
    writeFileSync(eventsPathA, "# Session Events A\n\nevents-marker-alpha-project\n");
    writeFileSync(eventsPathB, "# Session Events B\n\nevents-marker-beta-project\n");

    const searchAs = async (project: string, query: string) => {
      const result = await withProjectDirOverride(
        { projectDir: project },
        () => searchTool!.handler({ queries: [query] }),
      );
      return JSON.stringify(result);
    };

    // A's tool call must consume ONLY A's events file, never B's.
    await searchAs(projectA, "events-marker-alpha-project");
    expect(existsSync(eventsPathA)).toBe(false);
    expect(existsSync(eventsPathB)).toBe(true);
    // A's events were indexed into A's own store.
    expect(await searchAs(projectA, "events-marker-alpha-project")).toContain("events-marker-alpha");

    // B's events file stays untouched until B makes a call, then lands
    // in B's store.
    await searchAs(projectB, "events-marker-beta-project");
    expect(existsSync(eventsPathB)).toBe(false);
    expect(await searchAs(projectB, "events-marker-beta-project")).toContain("events-marker-beta");
  });
});
