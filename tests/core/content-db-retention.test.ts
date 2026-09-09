/**
 * Startup retention contract: the per-platform content directory gets NO
 * automatic file deletion. mtime cannot distinguish an open-but-idle
 * store (a multi-project web host with a project untouched for weeks)
 * from an abandoned DB, and unlinking a live store's db/-wal/-shm makes
 * every later write fail with an unrecoverable disk I/O error
 * (SQLITE_IOERR_VNODE on macOS). These tests pin that no ctx_* call —
 * which runs the one-time startup cleanups — ever unlinks another
 * project's DB files, however stale they look.
 */
import { afterAll, describe, expect, test } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const storageRoot = mkdtempSync(join(tmpdir(), "ctx-db-retention-"));
process.env.CONTEXT_MODE_DIR = storageRoot;
// Import server.js as a library — suppress main()'s stdio MCP connect.
process.env.CONTEXT_MODE_EMBEDDED_PLUGIN_TOOLS = "1";

afterAll(() => {
  delete process.env.CONTEXT_MODE_DIR;
  delete process.env.CONTEXT_MODE_EMBEDDED_PLUGIN_TOOLS;
});

describe("content DB retention: no automatic file deletion", () => {
  test("a startup store creation never unlinks another project's stale DB files", async () => {
    // Seed another project's DB that looks maximally stale: main and
    // non-empty -wal both >14 days old, plus a -shm sidecar.
    const contentDir = join(storageRoot, "content");
    mkdirSync(contentDir, { recursive: true });
    const staleDb = join(contentDir, "0123456789abcdef.db");
    const stale = new Date(Date.now() - 20 * 24 * 60 * 60 * 1000);
    writeFileSync(staleDb, "SQLite format 3\0");
    utimesSync(staleDb, stale, stale);
    writeFileSync(`${staleDb}-wal`, Buffer.alloc(4096, 1));
    utimesSync(`${staleDb}-wal`, stale, stale);
    writeFileSync(`${staleDb}-shm`, "shm");

    const { withProjectDirOverride, REGISTERED_CTX_TOOLS } = await import(
      "../../src/server.js"
    );
    const indexTool = REGISTERED_CTX_TOOLS.find((t) => t.name === "ctx_index");
    expect(indexTool).toBeDefined();

    // Any tool call in a different project runs the first-store-creation
    // startup path (legacy-dir sweep + orphaned PID DB cleanup).
    const project = mkdtempSync(join(tmpdir(), "ctx-proj-retention-"));
    await withProjectDirOverride(
      { projectDir: project },
      () => indexTool!.handler({ content: "retention probe content", source: "retention-doc" }),
    );

    expect(existsSync(staleDb)).toBe(true);
    expect(existsSync(`${staleDb}-wal`)).toBe(true);
    expect(existsSync(`${staleDb}-shm`)).toBe(true);
  });
});
