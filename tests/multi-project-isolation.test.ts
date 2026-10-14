import "./setup-home";
import { describe, expect, test } from "vitest";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

/**
 * Per-project singleton scoping (multi-location plugin hosts).
 *
 * OpenCode v2 runs one plugin setup per location in a single server process,
 * so the server module's singletons must be keyed per project: each ctx_* tool
 * call arrives inside withProjectDirOverride. These tests pin the two
 * regressions found in review: fetched-page leakage across projects (the
 * shared PageStore returned one project's pages as another project's relabel
 * set) and process-global session stats (aggregation across projects, plus a
 * project purge resetting other projects' counters).
 */
process.env.CONTEXT_MODE_EMBEDDED_PLUGIN_TOOLS = "1";

const server = await import("../src/server.js");
const { withProjectDirOverride, __statsForTests, __resetStatsForTests, __trackResponseForTests, __indexFetchedForTests } =
  server;

const projA = mkdtempSync(join(tmpdir(), "cm-iso-proj-a-"));
const projB = mkdtempSync(join(tmpdir(), "cm-iso-proj-b-"));

async function inProject<T>(projectDir: string, fn: () => T | Promise<T>): Promise<T> {
  return withProjectDirOverride({ projectDir }, async () => fn());
}

describe("per-project session stats (multi-location isolation)", () => {
  test("tool calls are counted per project; one project's reset leaves the other intact", async () => {
    await inProject(projA, () =>
      __trackResponseForTests("ctx_search", { content: [{ type: "text", text: "alpha result" }] }),
    );
    await inProject(projA, () =>
      __trackResponseForTests("ctx_search", { content: [{ type: "text", text: "alpha result" }] }),
    );
    await inProject(projB, () =>
      __trackResponseForTests("ctx_search", { content: [{ type: "text", text: "beta result" }] }),
    );

    const statsA = await inProject(projA, () => __statsForTests());
    const statsB = await inProject(projB, () => __statsForTests());
    expect(statsA.calls.ctx_search).toBe(2);
    expect(statsB.calls.ctx_search).toBe(1);
    expect(statsA.bytesReturned.ctx_search).toBeGreaterThan(statsB.bytesReturned.ctx_search);

    // ctx_purge scope:'project' resets ONLY the calling project's bucket
    await inProject(projB, () => __resetStatsForTests());
    expect((await inProject(projA, () => __statsForTests())).calls.ctx_search).toBe(2);
    expect((await inProject(projB, () => __statsForTests())).calls.ctx_search).toBeUndefined();
  });
});

describe("per-project fetched-page store (multi-location isolation)", () => {
  const NAV = "* [Home](/)\n* [Docs](/docs)\n";
  const FOOTER = "(c) 2026 Example Inc.\n";
  const page = (article: string) => `# Example\n\n${NAV}\n${article}\n${FOOTER}`;
  const HOST = "https://iso.test";

  const index = (url: string, markdown: string) =>
    __indexFetchedForTests({ url, markdown, header: "text/html", route: "html" });

  test("second page of a host relabels the first ONLY within the same project", async () => {
    // Project A: cold-start fetch (provisional), then a second page of the
    // same host — A's first page is re-classified within A.
    await inProject(projA, () => index(`${HOST}/one`, page("First article body.")));
    const aTwo = await inProject(projA, () => index(`${HOST}/two`, page("Second article body, different words.")));
    expect(aTwo.extraction ?? "").toContain("re-classified 1 earlier page(s)");

    // Project B fetches the same second page of the same host: its page
    // store has no prior pages of this host, so NOTHING of A's may be
    // re-labelled into B's index (pre-fix this leaked A's page into B).
    const bTwo = await inProject(projB, () => index(`${HOST}/two`, page("Second article body, different words.")));
    expect(bTwo.extraction ?? "").not.toContain("re-classified 1 earlier page(s)");
    expect(bTwo.extraction ?? "").toContain("PROVISIONAL");
  });
});
