/**
 * db-base unit tests — Lane B disk-I/O hardening (upstream #992/#905;
 * PRs #1030/#1056/#880).
 *
 * Covers the four db-base-level changes:
 *  1. withRetry classifies SQLITE_IOERR / "disk I/O error" as transient
 *     (same exponential backoff as SQLITE_BUSY), including non-Error
 *     throw shapes ({ code } objects, strings).
 *  2. mmap_size is opt-in via CONTEXT_MODE_DB_MMAP_SIZE — no default mmap.
 *  3. closeDB performs NO close-time wal_checkpoint(TRUNCATE) and no other
 *     destructive cross-process mutation.
 *  4. logDbError emits `[context-mode:db]` lines with op/code/message,
 *     dedupes per op+code+message within ~30s, and includes the stack
 *     only when OPENCODE_DEBUG is set.
 */
import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import {
  applyWALPragmas,
  closeDB,
  DB_LOG_PREFIX,
  getRecentDbErrorCountForTests,
  isTransientSqliteError,
  logDbError,
  resetDbErrorLogForTests,
  resolveMmapSizeFromEnv,
  withRetry,
} from "../src/db-base.js";

type DbArg = Parameters<typeof applyWALPragmas>[0];

afterEach(() => {
  resetDbErrorLogForTests();
});

// ════════════════════════════════════════════
// 1. withRetry — SQLITE_IOERR is transient
// ════════════════════════════════════════════

describe("withRetry — SQLITE_IOERR / disk I/O error retry loop", () => {
  test("retries on better-sqlite3-shaped error ({ code: SQLITE_IOERR }) and eventually returns", () => {
    let calls = 0;
    const result = withRetry(() => {
      calls++;
      if (calls < 3) {
        const err = new Error("disk I/O error") as NodeJS.ErrnoException;
        err.code = "SQLITE_IOERR";
        throw err;
      }
      return "ok";
    }, [1, 1, 1]);
    assert.equal(result, "ok");
    assert.equal(calls, 3);
  });

  test("retries on bare 'disk I/O error' message (no code property)", () => {
    let calls = 0;
    const result = withRetry(() => {
      calls++;
      if (calls < 2) throw new Error("disk I/O error");
      return "ok";
    }, [1]);
    assert.equal(result, "ok");
    assert.equal(calls, 2);
  });

  test("retries on 'SQLITE_IOERR:' prefixed message (bun:sqlite shape)", () => {
    let calls = 0;
    const result = withRetry(() => {
      calls++;
      if (calls < 2) throw new Error("SQLITE_IOERR: disk I/O error");
      return 7;
    }, [1]);
    assert.equal(result, 7);
    assert.equal(calls, 2);
  });

  test("retries on case-variant 'Disk I/O error' message", () => {
    let calls = 0;
    const result = withRetry(() => {
      calls++;
      if (calls < 2) throw new Error("Disk I/O error");
      return "ok";
    }, [1]);
    assert.equal(result, "ok");
    assert.equal(calls, 2);
  });

  test("retries non-Error { code } throw shape — not treated as fatal", () => {
    let calls = 0;
    const result = withRetry(() => {
      calls++;
      if (calls < 2) throw { code: "SQLITE_IOERR" }; // eslint-disable-line no-throw-literal
      return 42;
    }, [1]);
    assert.equal(result, 42);
    assert.equal(calls, 2);
  });

  test("retries non-Error string throw 'disk I/O error'", () => {
    let calls = 0;
    const result = withRetry(() => {
      calls++;
      if (calls < 2) throw "disk I/O error"; // eslint-disable-line no-throw-literal
      return "ok";
    }, [1]);
    assert.equal(result, "ok");
    assert.equal(calls, 2);
  });

  test("does NOT retry fatal corruption errors", () => {
    let calls = 0;
    assert.throws(
      () => withRetry(() => { calls++; throw new Error("file is not a database"); }, [1, 1, 1]),
      /file is not a database/,
    );
    assert.equal(calls, 1);
  });

  test("does NOT retry non-Error { code: SQLITE_CORRUPT } throw shape", () => {
    let calls = 0;
    assert.throws(
      () => withRetry(() => { calls++; throw { code: "SQLITE_CORRUPT" }; }, [1, 1, 1]),
    );
    assert.equal(calls, 1);
  });

  test("throws descriptive error after exhausting IOERR retries", () => {
    let calls = 0;
    const err = (() => {
      try {
        withRetry(() => {
          calls++;
          throw new Error("SQLITE_IOERR: disk I/O error");
        }, [1, 1]);
      } catch (e) { return e as Error; }
      throw new Error("expected throw");
    })();
    assert.match(err.message, /transient SQLite error after 2 retries/);
    assert.match(err.message, /Original error: SQLITE_IOERR/);
    assert.equal(calls, 3);
  });

  test("preserves the SQLITE_BUSY retry contract (existing behavior intact)", () => {
    let calls = 0;
    const result = withRetry(() => {
      calls++;
      if (calls < 2) throw new Error("SQLITE_BUSY: database is locked");
      return "ok";
    }, [1]);
    assert.equal(result, "ok");
    assert.equal(calls, 2);
  });
});

describe("isTransientSqliteError — classification", () => {
  test("true for SQLITE_BUSY / locked errors", () => {
    expect(isTransientSqliteError(new Error("SQLITE_BUSY: database is locked"))).toBe(true);
    expect(isTransientSqliteError(new Error("database is locked"))).toBe(true);
    expect(isTransientSqliteError({ code: "SQLITE_BUSY" })).toBe(true);
    expect(isTransientSqliteError("SQLITE_BUSY")).toBe(true);
  });

  test("true for SQLITE_IOERR / disk I/O error in every driver shape", () => {
    expect(isTransientSqliteError({ code: "SQLITE_IOERR", message: "disk I/O error" })).toBe(true);
    expect(isTransientSqliteError(new Error("SQLITE_IOERR: disk I/O error"))).toBe(true);
    expect(isTransientSqliteError(new Error("disk I/O error"))).toBe(true);
    expect(isTransientSqliteError("disk I/O error")).toBe(true);
    expect(isTransientSqliteError("Disk I/O error")).toBe(true);
  });

  test("false for corruption, generic, and non-error values", () => {
    expect(isTransientSqliteError(new Error("SQLITE_CORRUPT: database disk image is malformed"))).toBe(false);
    expect(isTransientSqliteError({ code: "SQLITE_CORRUPT" })).toBe(false);
    expect(isTransientSqliteError(new Error("file is not a database"))).toBe(false);
    expect(isTransientSqliteError(new Error("boom"))).toBe(false);
    expect(isTransientSqliteError("plain string")).toBe(false);
    expect(isTransientSqliteError(42)).toBe(false);
  });
});

// ════════════════════════════════════════════
// 2. mmap_size — opt-in only
// ════════════════════════════════════════════

/** Minimal driver mock that records every pragma source string. */
function makePragmaRecorder() {
  const pragmas: string[] = [];
  const closeCalls: number[] = [];
  return {
    pragmas,
    closeCalls,
    db: {
      pragma(source: string): unknown {
        pragmas.push(source);
        return [];
      },
      exec(_sql: string): void {},
      close(): void {
        closeCalls.push(1);
      },
    } as unknown as DbArg,
  };
}

describe("applyWALPragmas — mmap_size opt-in via CONTEXT_MODE_DB_MMAP_SIZE", () => {
  test("default path (env unset) sets NO mmap_size pragma", () => {
    const { db, pragmas } = makePragmaRecorder();
    applyWALPragmas(db, {});
    expect(pragmas).toContain("journal_mode = WAL");
    expect(pragmas).toContain("synchronous = NORMAL");
    const mmap = pragmas.filter((p) => p.startsWith("mmap_size"));
    expect(mmap).toEqual([]);
  });

  test("env var set → mmap_size pragma applied with the requested byte count", () => {
    const { db, pragmas } = makePragmaRecorder();
    applyWALPragmas(db, { CONTEXT_MODE_DB_MMAP_SIZE: "1048576" });
    expect(pragmas).toContain("mmap_size = 1048576");
  });

  test("env var '0' → explicit opt-out applied as mmap_size = 0", () => {
    const { db, pragmas } = makePragmaRecorder();
    applyWALPragmas(db, { CONTEXT_MODE_DB_MMAP_SIZE: "0" });
    expect(pragmas).toContain("mmap_size = 0");
  });

  test("invalid env values are treated as unset (no pragma, no throw)", () => {
    for (const bad of ["abc", "-5", "1.5", "", "   "]) {
      const { db, pragmas } = makePragmaRecorder();
      applyWALPragmas(db, { CONTEXT_MODE_DB_MMAP_SIZE: bad });
      expect(pragmas.filter((p) => p.startsWith("mmap_size"))).toEqual([]);
    }
  });

  test("WAL + NORMAL pragmas still applied in all cases", () => {
    const { db, pragmas } = makePragmaRecorder();
    applyWALPragmas(db, { CONTEXT_MODE_DB_MMAP_SIZE: "4096" });
    expect(pragmas[0]).toBe("journal_mode = WAL");
    expect(pragmas[1]).toBe("synchronous = NORMAL");
    expect(pragmas[2]).toBe("mmap_size = 4096");
  });
});

describe("resolveMmapSizeFromEnv — parser contract", () => {
  test("returns null when unset/empty/invalid", () => {
    expect(resolveMmapSizeFromEnv({})).toBeNull();
    expect(resolveMmapSizeFromEnv({ CONTEXT_MODE_DB_MMAP_SIZE: undefined })).toBeNull();
    expect(resolveMmapSizeFromEnv({ CONTEXT_MODE_DB_MMAP_SIZE: "" })).toBeNull();
    expect(resolveMmapSizeFromEnv({ CONTEXT_MODE_DB_MMAP_SIZE: "abc" })).toBeNull();
    expect(resolveMmapSizeFromEnv({ CONTEXT_MODE_DB_MMAP_SIZE: "-1" })).toBeNull();
    expect(resolveMmapSizeFromEnv({ CONTEXT_MODE_DB_MMAP_SIZE: "1.5" })).toBeNull();
  });

  test("returns the parsed integer for valid non-negative values", () => {
    expect(resolveMmapSizeFromEnv({ CONTEXT_MODE_DB_MMAP_SIZE: "0" })).toBe(0);
    expect(resolveMmapSizeFromEnv({ CONTEXT_MODE_DB_MMAP_SIZE: "  4096  " })).toBe(4096);
    expect(resolveMmapSizeFromEnv({ CONTEXT_MODE_DB_MMAP_SIZE: "268435456" })).toBe(268435456);
  });
});

test("source-pin invariant: the old default mmap_size (268435456) no longer exists in db-base.ts", () => {
  const src = readFileSync(resolve(__dirname, "..", "src", "db-base.ts"), "utf8");
  expect(src).not.toContain("268435456");
});

// ════════════════════════════════════════════
// 3. closeDB — no TRUNCATE checkpoint, no destructive mutation
// ════════════════════════════════════════════

describe("closeDB — safe close without cross-process mutations", () => {
  test("performs no wal_checkpoint pragma and closes exactly once", () => {
    const { db, pragmas, closeCalls } = makePragmaRecorder();
    closeDB(db);
    const checkpointCalls = pragmas.filter((p) => p.toLowerCase().includes("wal_checkpoint"));
    expect(checkpointCalls).toEqual([]);
    expect(pragmas).toEqual([]);
    expect(closeCalls).toHaveLength(1);
  });

  test("still swallows close errors (finally/cleanup-path contract)", () => {
    const throwing = {
      pragma(): unknown { return []; },
      exec(): void {},
      close(): void { throw new Error("already closed"); },
    } as unknown as DbArg;
    expect(() => closeDB(throwing)).not.toThrow();
  });

  test("source-pin invariant: closeDB body contains no wal_checkpoint call", () => {
    const src = readFileSync(resolve(__dirname, "..", "src", "db-base.ts"), "utf8");
    const fnIdx = src.indexOf("export function closeDB");
    expect(fnIdx).toBeGreaterThan(-1);
    // Bound the function body at the next top-level export (docblock
    // above the function is excluded by slicing from the export keyword).
    const fnBody = src.slice(fnIdx).split(/\nexport (?:function|abstract|class|const|let|var) /)[0] ?? "";
    expect(fnBody).not.toMatch(/wal_checkpoint/i);
    // The close itself must survive.
    expect(fnBody).toContain("db.close()");
  });
});

// ════════════════════════════════════════════
// 4. logDbError — [context-mode:db] structured stderr logging
// ════════════════════════════════════════════

function captureConsoleError() {
  return vi.spyOn(console, "error").mockImplementation(() => {});
}

describe("logDbError — prefix, op, code, message", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.OPENCODE_DEBUG;
  });

  test("logs one compact line with the stable prefix, op name, code, and message", () => {
    resetDbErrorLogForTests();
    const spy = captureConsoleError();
    const err = Object.assign(new Error("disk I/O error"), { code: "SQLITE_IOERR" });
    logDbError("Unit.op", err);
    expect(spy).toHaveBeenCalledTimes(1);
    const line = String(spy.mock.calls[0][0]);
    expect(line.startsWith("[context-mode:db]")).toBe(true);
    expect(line).toContain("Unit.op");
    expect(line).toContain("SQLITE_IOERR");
    expect(line).toContain("disk I/O error");
    expect(line).not.toContain("    at "); // no stack without OPENCODE_DEBUG
  });

  test("omits the code segment when the error carries none", () => {
    resetDbErrorLogForTests();
    const spy = captureConsoleError();
    logDbError("Unit.plain", new Error("database is closed"));
    const line = String(spy.mock.calls[0][0]);
    expect(line.startsWith(DB_LOG_PREFIX)).toBe(true);
    expect(line).toContain("database is closed");
    // Exactly one bracket pair: the stable prefix itself.
    expect(line.match(/\[/g)?.length).toBe(1);
  });

  test("appends the optional detail (e.g. DB path) and includes it in the dedupe key", () => {
    resetDbErrorLogForTests();
    const spy = captureConsoleError();
    const err = new Error("disk I/O error");
    logDbError("Unit.detail", err, "/tmp/a.db");
    logDbError("Unit.detail", err, "/tmp/b.db"); // different detail → NOT deduped
    expect(spy).toHaveBeenCalledTimes(2);
    expect(String(spy.mock.calls[0][0])).toContain("/tmp/a.db");
    expect(String(spy.mock.calls[1][0])).toContain("/tmp/b.db");
  });

  test("handles non-Error throw shapes (strings, { code } objects)", () => {
    resetDbErrorLogForTests();
    const spy = captureConsoleError();
    logDbError("Unit.string", "plain string failure");
    expect(String(spy.mock.calls[0][0])).toContain("plain string failure");
    logDbError("Unit.code", { code: "SQLITE_BUSY", message: "database is locked" });
    const codeLine = String(spy.mock.calls[1][0]);
    expect(codeLine).toContain("SQLITE_BUSY");
    expect(codeLine).toContain("database is locked");
  });

  test("never throws — even for hostile error values", () => {
    resetDbErrorLogForTests();
    const evil = { get message(): string { throw new Error("getter boom"); } };
    expect(() => logDbError("Unit.evil", evil)).not.toThrow();
    expect(() => logDbError("Unit.evil", Symbol("x"))).not.toThrow();
  });
});

describe("logDbError — ~30s rate limit", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    delete process.env.OPENCODE_DEBUG;
  });

  test("same op + code + message within the window is logged once", () => {
    resetDbErrorLogForTests();
    const spy = captureConsoleError();
    const err = Object.assign(new Error("disk I/O error"), { code: "SQLITE_IOERR" });
    logDbError("Unit.ratelimit", err);
    logDbError("Unit.ratelimit", err);
    logDbError("Unit.ratelimit", err);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  test("a different op for the same error is NOT suppressed", () => {
    resetDbErrorLogForTests();
    const spy = captureConsoleError();
    const err = new Error("database is locked");
    logDbError("Unit.opA", err);
    logDbError("Unit.opB", err);
    expect(spy).toHaveBeenCalledTimes(2);
  });

  test("the same error is logged again once the ~30s window has passed", () => {
    resetDbErrorLogForTests();
    const spy = captureConsoleError();
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const err = new Error("disk I/O error");
    logDbError("Unit.clock", err);
    // Still inside the window → suppressed.
    vi.setSystemTime(29_999);
    logDbError("Unit.clock", err);
    expect(spy).toHaveBeenCalledTimes(1);
    // Window expired → logged again.
    vi.setSystemTime(30_001);
    logDbError("Unit.clock", err);
    expect(spy).toHaveBeenCalledTimes(2);
  });

  test("resetDbErrorLogForTests clears the dedupe table", () => {
    resetDbErrorLogForTests();
    const spy = captureConsoleError();
    const err = new Error("dedupe me");
    logDbError("Unit.reset", err);
    logDbError("Unit.reset", err);
    expect(spy).toHaveBeenCalledTimes(1);
    resetDbErrorLogForTests();
    logDbError("Unit.reset", err);
    expect(spy).toHaveBeenCalledTimes(2);
  });

  test("hard cap: a >256-key burst inside one window stays bounded; fresh keys still dedupe", () => {
    resetDbErrorLogForTests();
    const spy = captureConsoleError();
    const BURST = 300;
    for (let i = 0; i < BURST; i++) {
      logDbError(`Unit.burst-${i}`, new Error(`burst message ${i}`));
    }
    // Each distinct key logs exactly once, but the dedupe table itself is
    // hard-capped at DB_LOG_MAX_KEYS — previously the expired-only prune
    // let it grow to 300 and stay there until aging out.
    expect(getRecentDbErrorCountForTests()).toBe(256);
    expect(spy.mock.calls.length).toBe(BURST);

    // A key still inside the cap and window keeps normal dedupe semantics.
    logDbError("Unit.burst-299", new Error("burst message 299"));
    logDbError("Unit.burst-299", new Error("burst message 299"));
    expect(spy.mock.calls.length).toBe(BURST); // suppressed, no new lines
    expect(getRecentDbErrorCountForTests()).toBe(256);

    // The oldest keys were hard-evicted (oldest-first), so re-logging one
    // of them emits a fresh line — proof eviction actually happened —
    // while the table stays pinned at the cap.
    logDbError("Unit.burst-0", new Error("burst message 0"));
    expect(spy.mock.calls.length).toBe(BURST + 1);
    expect(getRecentDbErrorCountForTests()).toBe(256);
  });
});

describe("logDbError — OPENCODE_DEBUG stack", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.OPENCODE_DEBUG;
  });

  test("includes the stack when OPENCODE_DEBUG is set", () => {
    resetDbErrorLogForTests();
    process.env.OPENCODE_DEBUG = "1";
    const spy = captureConsoleError();
    logDbError("Unit.debug", new Error("with stack"));
    const line = String(spy.mock.calls[0][0]);
    expect(line).toContain("    at "); // stack frames
  });

  test("omits the stack when OPENCODE_DEBUG is unset", () => {
    resetDbErrorLogForTests();
    delete process.env.OPENCODE_DEBUG;
    const spy = captureConsoleError();
    logDbError("Unit.nodebug", new Error("no stack"));
    expect(String(spy.mock.calls[0][0])).not.toContain("    at ");
  });
});
