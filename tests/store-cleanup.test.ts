/**
 * cleanupStaleContentDBs — WAL-aware staleness contract.
 *
 * In production this function's only remaining caller sweeps the legacy
 * shared content dir (maxAgeDays 0, pre-platform-isolation data); the
 * per-platform content dir gets NO automatic deletion because mtime cannot
 * distinguish a live-but-idle open connection from an abandoned DB — on
 * macOS, unlinking those files under a live connection invalidates its
 * file descriptors and every later write fails with disk I/O error
 * (SQLITE_IOERR_VNODE), unrecoverable by retry (pinned behaviorally in
 * tests/core/content-db-retention.test.ts). These unit tests pin the
 * function-level contract: a non-empty -wal only ever EXTENDS a DB's life
 * (its mtime counts as the latest write), never shortens it.
 */
import { describe, expect, test } from "vitest";
import {
  existsSync,
  mkdtempSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cleanupStaleContentDBs } from "../src/store.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;

function makeContentDir(): string {
  return mkdtempSync(join(tmpdir(), "ctx-store-cleanup-"));
}

/** Create a fake .db (+ optional non-empty -wal) with controlled mtimes. */
function makeDb(
  dir: string,
  name: string,
  dbMtime: Date,
  walBytes: number,
  walMtime: Date,
): void {
  const dbPath = join(dir, name);
  writeFileSync(dbPath, "SQLite format 3\0");
  utimesSync(dbPath, dbMtime, dbMtime);
  if (walBytes > 0) {
    const walPath = `${dbPath}-wal`;
    writeFileSync(walPath, Buffer.alloc(walBytes, 1));
    utimesSync(walPath, walMtime, walMtime);
  }
}

describe("cleanupStaleContentDBs — WAL-aware staleness", () => {
  test("live-but-idle store (fresh main db, -wal idle >1h) is NOT deleted", () => {
    const dir = makeContentDir();
    makeDb(dir, "live-idle.db", new Date(), 4096, new Date(Date.now() - 2 * HOUR_MS));

    const cleaned = cleanupStaleContentDBs(dir, 14);

    expect(cleaned).toBe(0);
    expect(existsSync(join(dir, "live-idle.db"))).toBe(true);
    expect(existsSync(join(dir, "live-idle.db-wal"))).toBe(true);
  });

  test("active WAL-mode store (main db old, -wal fresh) is NOT deleted", () => {
    const dir = makeContentDir();
    makeDb(dir, "active-wal.db", new Date(Date.now() - 20 * DAY_MS), 4096, new Date());

    const cleaned = cleanupStaleContentDBs(dir, 14);

    expect(cleaned).toBe(0);
    expect(existsSync(join(dir, "active-wal.db"))).toBe(true);
    expect(existsSync(join(dir, "active-wal.db-wal"))).toBe(true);
  });

  test("stale db with no -wal is still deleted (14-day contract preserved)", () => {
    const dir = makeContentDir();
    makeDb(dir, "old.db", new Date(Date.now() - 20 * DAY_MS), 0, new Date());

    const cleaned = cleanupStaleContentDBs(dir, 14);

    expect(cleaned).toBe(1);
    expect(existsSync(join(dir, "old.db"))).toBe(false);
  });

  test("db with main AND non-empty -wal both stale is deleted with sidecars", () => {
    const dir = makeContentDir();
    const old = new Date(Date.now() - 20 * DAY_MS);
    makeDb(dir, "old-wal.db", old, 4096, old);
    writeFileSync(join(dir, "old-wal.db-shm"), "shm");

    const cleaned = cleanupStaleContentDBs(dir, 14);

    expect(cleaned).toBe(1);
    expect(existsSync(join(dir, "old-wal.db"))).toBe(false);
    expect(existsSync(join(dir, "old-wal.db-wal"))).toBe(false);
    expect(existsSync(join(dir, "old-wal.db-shm"))).toBe(false);
  });

  test("empty -wal does not extend a stale db's life", () => {
    const dir = makeContentDir();
    const dbPath = join(dir, "empty-wal.db");
    writeFileSync(dbPath, "SQLite format 3\0");
    utimesSync(dbPath, new Date(Date.now() - 20 * DAY_MS), new Date(Date.now() - 20 * DAY_MS));
    writeFileSync(`${dbPath}-wal`, Buffer.alloc(0));
    utimesSync(`${dbPath}-wal`, new Date(), new Date());

    const cleaned = cleanupStaleContentDBs(dir, 14);

    expect(cleaned).toBe(1);
    expect(existsSync(dbPath)).toBe(false);
  });

  test("missing content dir is a no-op returning 0", () => {
    expect(cleanupStaleContentDBs(join(tmpdir(), "ctx-no-such-dir-xyz"), 14)).toBe(0);
  });
});
