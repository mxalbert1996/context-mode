/**
 * ContentStore disk-I/O hardening tests — store-layer parity with the
 * session-DB hardening (d018ada; see db-base.test.ts for the db-base-level
 * patterns these mirror). Extended for the oracle remediation round:
 * the raw reads (getSourceMeta cache probe, fuzzy vocab lookup, listSources,
 * getIndexState, getChunksBySource, getDistinctiveTerms) and the empty
 * fast-path now carry the same retry + [context-mode:db] logging +
 * `[context-mode:store]` op/path/code context as the writes, and a failed
 * stale re-index produces exactly ONE log line.
 *
 * Covers:
 *  1. Transient SQLITE_IOERR on store writes (store.index) retries with the
 *     db-base exponential backoff and succeeds.
 *  2. Transient SQLITE_IOERR on store open (constructor) retries and succeeds.
 *  3. Persistent SQLITE_IOERR exhausts retries → the tool-visible error
 *     carries op + DB path + SQLite code (`[context-mode:store] … (SQLITE_IOERR)`),
 *     never a bare "disk I/O error" (the original bug report: the bare message
 *     and zero log output made store failures undiagnosable).
 *  4. The failure is logged once as `[context-mode:db] store.index [<code>]:
 *     <message> (<dbPath>)` and the 30s dedupe swallows immediate repeats.
 *  5. Corruption on open still takes the existing delete-and-recreate path
 *     (real driver, real garbage file).
 *  6. Non-Error throw shapes ({ code } objects, strings) are classified like
 *     Errors — retried when transient, contextualized when fatal.
 *  7. Raw reads hardened: getSourceMeta (the ctx_fetch_and_index cache
 *     probe — the oracle-blocker path), fuzzy fallback vocab lookup,
 *     listSources (ctx_search no-results path).
 *  8. Empty indexPlainText("")/indexJSON("") route through the same
 *     retry + enrichment contract (no fast-path bypass).
 *  9. A failed stale re-index logs exactly ONE [context-mode:db] line —
 *     the kDbErrorLogged marker prevents the outer refresh catch from
 *     re-logging an error the inner op already reported.
 *
 * IOERR simulation: a mock SQLite driver is injected through db-base's
 * loadDatabase() seam (the same seam ContentStore uses to pick its driver).
 * Failures are armed per-test as rules — by statement kind (run/get/all)
 * and optionally by SQL fragment — and specific queries can be given
 * canned result rows. Corruption tests disarm the mock and run against
 * the real driver.
 */
import { strict as assert } from "node:assert";
import { unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";

const faults = vi.hoisted(() => ({
  /** When false, loadDatabase() resolves to the real driver. */
  armed: false,
  /** Remaining constructor-time failures (Infinity → persistent). */
  openFailures: 0,
  /** Throw shape used for the simulated IOERR. */
  shape: "errno" as "errno" | "plain" | "code-object" | "string",
  openCalls: 0,
  writeRuns: 0,
  /** Statement-level failure rules: kind + optional SQL fragment + remaining budget. */
  rules: [] as Array<{ kind: "run" | "get" | "all"; sql: string | null; remaining: number }>,
  /** Canned result rows for statement.all()/iterate(), keyed by SQL fragment. */
  rows: {} as Record<string, unknown[]>,
}));

vi.mock("../src/db-base.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/db-base.js")>();

  const makeIoErr = (): unknown => {
    switch (faults.shape) {
      case "plain":
        return new Error("disk I/O error");
      case "code-object":
        return { code: "SQLITE_IOERR", message: "disk I/O error" };
      case "string":
        return "disk I/O error";
      default:
        // better-sqlite3 / node:sqlite SqliteError shape
        return Object.assign(new Error("disk I/O error"), { code: "SQLITE_IOERR" });
    }
  };

  const takeFailure = (sql: string, kind: "run" | "get" | "all"): boolean => {
    for (const rule of faults.rules) {
      if (rule.kind !== kind || rule.remaining <= 0) continue;
      if (rule.sql !== null && !sql.includes(rule.sql)) continue;
      if (rule.remaining !== Number.POSITIVE_INFINITY) rule.remaining--;
      return true;
    }
    return false;
  };

  const rowsFor = (sql: string): unknown[] => {
    for (const [fragment, rows] of Object.entries(faults.rows)) {
      if (sql.includes(fragment)) return rows;
    }
    return [];
  };

  const makeStatement = (sql: string) => ({
    run: (..._args: unknown[]) => {
      faults.writeRuns++;
      if (takeFailure(sql, "run")) throw makeIoErr();
      return { changes: 1, lastInsertRowid: 1 };
    },
    get: (..._args: unknown[]) => {
      if (takeFailure(sql, "get")) throw makeIoErr();
      return undefined;
    },
    all: (..._args: unknown[]) => {
      if (takeFailure(sql, "all")) throw makeIoErr();
      return rowsFor(sql);
    },
    iterate: (..._args: unknown[]) => rowsFor(sql)[Symbol.iterator](),
  });

  const makeMockDb = () => ({
    pragma: (_source: string) => [],
    exec: (_sql: string) => undefined,
    prepare: (sql: string) => makeStatement(sql),
    transaction:
      (fn: (...args: unknown[]) => unknown) =>
      (...args: unknown[]) =>
        fn(...args),
    close: () => {},
  });

  return {
    ...actual,
    loadDatabase: () => {
      if (!faults.armed) return actual.loadDatabase();
      // `new MockDatabase(...)` — a class so the `new` call works; the
      // constructor returns the mock connection object.
      class MockDatabase {
        constructor(_path: string, _opts?: unknown) {
          faults.openCalls++;
          if (faults.openFailures > 0) {
            faults.openFailures--;
            throw makeIoErr();
          }
          return makeMockDb();
        }
      }
      return MockDatabase as unknown as ReturnType<typeof actual.loadDatabase>;
    },
  };
});

import { ContentStore } from "../src/store.js";
import { resetDbErrorLogForTests } from "../src/db-base.js";

function tempDbPath(tag: string): string {
  return join(
    tmpdir(),
    `ctx-store-diskio-${tag}-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.db`,
  );
}

/** Arm N remaining IOERR failures for statements of `kind`, optionally
 *  restricted to statements whose SQL contains `sql`. */
function armFailure(opts: { kind: "run" | "get" | "all"; remaining: number; sql?: string }): void {
  faults.rules.push({ kind: opts.kind, sql: opts.sql ?? null, remaining: opts.remaining });
}

/** Canned rows for statement.all()/iterate() on queries containing `sqlFragment`. */
function armRows(sqlFragment: string, rows: unknown[]): void {
  faults.rows[sqlFragment] = rows;
}

/** Invoke `fn` and capture whether it threw (assert-friendly exhaustion probe;
 *  exhausting the default delays burns the real 100+500+2000ms backoff ≈ 2.6s,
 *  well under the 30s testTimeout). */
function exhaust(fn: () => unknown): { threw: boolean; error: unknown } {
  try {
    fn();
    return { threw: false, error: undefined };
  } catch (error) {
    return { threw: true, error };
  }
}

function armMock(): void {
  faults.armed = true;
}

afterEach(() => {
  faults.armed = false;
  faults.openFailures = 0;
  faults.shape = "errno";
  faults.openCalls = 0;
  faults.writeRuns = 0;
  faults.rules = [];
  faults.rows = {};
  resetDbErrorLogForTests();
  vi.restoreAllMocks();
});

// ════════════════════════════════════════════
// 1+2. Transient IOERR — retried, then succeeds
// ════════════════════════════════════════════

describe("ContentStore — transient SQLITE_IOERR retry", () => {
  test("store.index retries a transient IOERR mid-write and succeeds", () => {
    armMock();
    armFailure({ kind: "run", remaining: 2 }); // fail the first two write statements
    const store = new ContentStore(tempDbPath("transient-index"));
    const result = store.index({ content: "hello world content", source: "diskio" });
    assert.equal(result.sourceId, 1);
    assert.ok(result.totalChunks >= 1);
    // Two failed statements + at least the first statement of the successful attempt
    assert.ok(faults.writeRuns >= 3);
    store.close();
  });

  test("constructor retries a transient IOERR on open and succeeds", () => {
    armMock();
    faults.openFailures = 1;
    const store = new ContentStore(tempDbPath("transient-open"));
    assert.equal(faults.openCalls, 2);
    // Store fully functional after the retried open
    const result = store.index({ content: "content after open retry", source: "openretry" });
    assert.equal(result.sourceId, 1);
    store.close();
  });

  test("cleanupStaleSources (write transaction) retries a transient IOERR and succeeds", () => {
    armMock();
    armFailure({ kind: "run", remaining: 1 });
    const store = new ContentStore(tempDbPath("transient-cleanup"));
    const removed = store.cleanupStaleSources(14);
    assert.equal(removed, 1); // mock run() reports changes: 1
    store.close();
  });
});

// ════════════════════════════════════════════
// 3. Persistent IOERR — op/path/code in the tool error
// ════════════════════════════════════════════

describe("ContentStore — persistent SQLITE_IOERR exhaustion", () => {
  test("store.index error carries op, DB path, and code — not a bare 'disk I/O error'", () => {
    armMock();
    armFailure({ kind: "run", remaining: Number.POSITIVE_INFINITY });
    const dbPath = tempDbPath("persistent-index");
    const store = new ContentStore(dbPath);
    const { threw, error } = exhaust(() => store.index({ content: "never lands", source: "diskio-fail" }));
    assert.ok(threw, "store.index must throw when retries are exhausted");
    const msg = (error as Error).message;
    expect(msg).toContain("[context-mode:store]");
    expect(msg).toContain("store.index failed on");
    expect(msg).toContain(dbPath);
    expect(msg).toContain("SQLITE_IOERR");
    expect(msg).toContain("disk I/O error");
    store.close();
  });

  test("constructor error carries op, DB path, and code when open keeps failing", () => {
    armMock();
    faults.openFailures = Number.POSITIVE_INFINITY;
    const dbPath = tempDbPath("persistent-open");
    const { threw, error } = exhaust(() => new ContentStore(dbPath));
    assert.ok(threw, "ContentStore constructor must throw when open keeps failing");
    const msg = (error as Error).message;
    expect(msg).toContain("[context-mode:store]");
    expect(msg).toContain("store.open failed on");
    expect(msg).toContain(dbPath);
    expect(msg).toContain("SQLITE_IOERR");
    expect(msg).toContain("disk I/O error");
  });

  test("store.search error carries op and DB path when reads keep failing", () => {
    armMock();
    armFailure({ kind: "all", remaining: Number.POSITIVE_INFINITY });
    const dbPath = tempDbPath("persistent-search");
    const store = new ContentStore(dbPath);
    const { threw, error } = exhaust(() => store.search("anything"));
    assert.ok(threw, "store.search must throw when retries are exhausted");
    const msg = (error as Error).message;
    expect(msg).toContain("[context-mode:store]");
    expect(msg).toContain("store.search failed on");
    expect(msg).toContain(dbPath);
    store.close();
  });
});

// ════════════════════════════════════════════
// 4. [context-mode:db] logging + 30s dedupe
// ════════════════════════════════════════════

describe("ContentStore — [context-mode:db] failure logging", () => {
  test("exhausted store.index failure is logged once; dedupe swallows immediate repeats", () => {
    armMock();
    armFailure({ kind: "run", remaining: Number.POSITIVE_INFINITY });
    const dbPath = tempDbPath("logged-once");
    const store = new ContentStore(dbPath);
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      exhaust(() => store.index({ content: "log once a", source: "log1" }));
      exhaust(() => store.index({ content: "log once b", source: "log2" }));
      // Same op + code + message + path → the second failure is suppressed.
      expect(spy).toHaveBeenCalledTimes(1);
      const line = String(spy.mock.calls[0][0]);
      expect(line.startsWith("[context-mode:db]")).toBe(true);
      expect(line).toContain("store.index");
      expect(line).toContain("SQLITE_IOERR");
      expect(line).toContain("disk I/O error");
      expect(line).toContain(dbPath);
      expect(line).not.toContain("    at "); // no stack without OPENCODE_DEBUG
    } finally {
      store.close();
    }
  });
});

// ════════════════════════════════════════════
// 5. Corruption on open — delete-and-recreate preserved (real driver)
// ════════════════════════════════════════════

describe("ContentStore — corruption on open still recovers", () => {
  test.skipIf(process.platform === "win32")(
    "garbage DB file → [context-mode:db] line, delete-and-recreate, functional store",
    () => {
      const dbPath = tempDbPath("corrupt");
      writeFileSync(dbPath, "THIS IS NOT A SQLITE DATABASE FILE");
      writeFileSync(dbPath + "-wal", "CORRUPT WAL");
      const spy = vi.spyOn(console, "error").mockImplementation(() => {});
      // faults.armed stays false → real driver → real recovery path.
      const store = new ContentStore(dbPath);
      try {
        assert.equal(store.getStats().sources, 0); // fresh DB, old file gone
        store.index({ content: "recovered content", source: "recovered" });
        assert.ok(store.search("recovered").length > 0);
        // The corruption itself was surfaced on stderr, not swallowed.
        const lines = spy.mock.calls.map((c) => String(c[0]));
        expect(
          lines.some((l) => l.startsWith("[context-mode:db]") && l.includes("store.open")),
        ).toBe(true);
      } finally {
        store.cleanup();
      }
    },
  );
});

// ════════════════════════════════════════════
// 6. Non-Error throw shapes
// ════════════════════════════════════════════

describe("ContentStore — non-Error throw shapes", () => {
  test("{ code: SQLITE_IOERR } object throw is retried transiently and succeeds", () => {
    armMock();
    faults.shape = "code-object";
    armFailure({ kind: "run", remaining: 1 });
    const store = new ContentStore(tempDbPath("shape-code-object"));
    const result = store.index({ content: "shape object content", source: "shape" });
    assert.ok(result.totalChunks >= 1);
    store.close();
  });

  test("string throw 'disk I/O error' persisting → enriched tool error, not bare", () => {
    armMock();
    faults.shape = "string";
    armFailure({ kind: "run", remaining: Number.POSITIVE_INFINITY });
    const dbPath = tempDbPath("shape-string");
    const store = new ContentStore(dbPath);
    const { threw, error } = exhaust(() => store.index({ content: "shape string content", source: "shape" }));
    assert.ok(threw, "store.index must throw when retries are exhausted");
    const msg = (error as Error).message;
    expect(msg).toContain("[context-mode:store] store.index failed on");
    expect(msg).toContain(dbPath);
    expect(msg).toContain("disk I/O error");
    store.close();
  });
});

// ════════════════════════════════════════════
// 7. Raw reads hardened (oracle remediation)
// ════════════════════════════════════════════

describe("ContentStore — raw reads carry the retry/log/context contract", () => {
  test("store.getSourceMeta (ctx_fetch_and_index cache probe) retries a transient IOERR and then answers", () => {
    armMock();
    armFailure({ kind: "get", remaining: 1 });
    const store = new ContentStore(tempDbPath("sourcemeta-transient"));
    // Mock get() returns undefined on success → null meta; the point is it
    // no longer rejects on the first IOERR.
    assert.equal(store.getSourceMeta("https://example.com/doc"), null);
    store.close();
  });

  test("store.getSourceMeta (BLOCKER: ctx_fetch cache probe) — persistent IOERR → enriched + logged once", () => {
    armMock();
    armFailure({ kind: "get", remaining: Number.POSITIVE_INFINITY });
    const dbPath = tempDbPath("sourcemeta-persistent");
    const store = new ContentStore(dbPath);
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const { threw, error } = exhaust(() => store.getSourceMeta("https://example.com/doc"));
      assert.ok(threw, "getSourceMeta must throw when retries are exhausted");
      const msg = (error as Error).message;
      expect(msg).toContain("[context-mode:store]");
      expect(msg).toContain("store.getSourceMeta failed on");
      expect(msg).toContain(dbPath);
      expect(msg).toContain("SQLITE_IOERR");
      expect(msg).toContain("disk I/O error");
      expect(spy).toHaveBeenCalledTimes(1);
      const line = String(spy.mock.calls[0][0]);
      expect(line.startsWith("[context-mode:db]")).toBe(true);
      expect(line).toContain("store.getSourceMeta");
      expect(line).toContain(dbPath);
    } finally {
      store.close();
    }
  });

  test("fuzzy fallback vocab lookup IOERR → enriched through searchWithFallback + logged once", () => {
    armMock();
    // Porter/trigram layers return no rows (no rule, no canned rows → []) —
    // the failure hits only the fuzzy-correct vocabulary lookup.
    armFailure({ kind: "all", remaining: Number.POSITIVE_INFINITY, sql: "FROM vocabulary" });
    const dbPath = tempDbPath("fuzzy-vocab");
    const store = new ContentStore(dbPath);
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const { threw, error } = exhaust(() => store.searchWithFallback("kubernetes"));
      assert.ok(threw, "searchWithFallback must propagate the fuzzyCorrect failure");
      const msg = (error as Error).message;
      expect(msg).toContain("[context-mode:store]");
      expect(msg).toContain("store.fuzzyCorrect failed on");
      expect(msg).toContain(dbPath);
      expect(msg).toContain("SQLITE_IOERR");
      expect(spy).toHaveBeenCalledTimes(1);
      const line = String(spy.mock.calls[0][0]);
      expect(line.startsWith("[context-mode:db]")).toBe(true);
      expect(line).toContain("store.fuzzyCorrect");
      expect(line).toContain(dbPath);
    } finally {
      store.close();
    }
  });

  test("store.listSources (ctx_search no-results path) — persistent IOERR → enriched + logged once", () => {
    armMock();
    // Target only the listSources statement ("ORDER BY id DESC").
    armFailure({ kind: "all", remaining: Number.POSITIVE_INFINITY, sql: "ORDER BY id DESC" });
    const dbPath = tempDbPath("listsources");
    const store = new ContentStore(dbPath);
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const { threw, error } = exhaust(() => store.listSources());
      assert.ok(threw, "listSources must throw when retries are exhausted");
      const msg = (error as Error).message;
      expect(msg).toContain("[context-mode:store]");
      expect(msg).toContain("store.listSources failed on");
      expect(msg).toContain(dbPath);
      expect(msg).toContain("SQLITE_IOERR");
      expect(spy).toHaveBeenCalledTimes(1);
      const line = String(spy.mock.calls[0][0]);
      expect(line.startsWith("[context-mode:db]")).toBe(true);
      expect(line).toContain("store.listSources");
      expect(line).toContain(dbPath);
    } finally {
      store.close();
    }
  });
});

// ════════════════════════════════════════════
// 8. Empty fast-path no longer bypasses the contract
// ════════════════════════════════════════════

describe("ContentStore — empty indexPlainText/indexJSON fast path", () => {
  test("empty indexPlainText('') retries a transient IOERR and succeeds", () => {
    armMock();
    armFailure({ kind: "run", remaining: 1 });
    const store = new ContentStore(tempDbPath("empty-transient"));
    // A direct #insertChunks call would have failed on the first run; going
    // through withRetry lands the 0-chunk source row instead.
    const result = store.indexPlainText("", "empty-src");
    assert.equal(result.sourceId, 1);
    assert.equal(result.totalChunks, 0);
    store.close();
  });

  test("empty indexPlainText('')/indexJSON('') persistent IOERR → enriched, not bare", () => {
    armMock();
    armFailure({ kind: "run", remaining: Number.POSITIVE_INFINITY });
    const dbPath = tempDbPath("empty-persistent");
    const store = new ContentStore(dbPath);
    const plain = exhaust(() => store.indexPlainText("", "empty-a"));
    assert.ok(plain.threw, "empty indexPlainText must throw when retries are exhausted");
    const plainMsg = (plain.error as Error).message;
    expect(plainMsg).toContain("[context-mode:store] store.indexPlainText failed on");
    expect(plainMsg).toContain(dbPath);
    // indexJSON("") delegates to indexPlainText("") → same contract, same op.
    const json = exhaust(() => store.indexJSON("", "empty-b"));
    assert.ok(json.threw, "empty indexJSON must throw when retries are exhausted");
    const jsonMsg = (json.error as Error).message;
    expect(jsonMsg).toContain("[context-mode:store] store.indexPlainText failed on");
    expect(jsonMsg).toContain(dbPath);
    store.close();
  });
});

// ════════════════════════════════════════════
// 9. Failed stale re-index — exactly ONE log line
// ════════════════════════════════════════════

describe("ContentStore — stale refresh double-log regression", () => {
  test("failed stale re-index emits exactly ONE [context-mode:db] line, owned by store.index", () => {
    armMock();
    const staleFile = join(
      tmpdir(),
      `ctx-stale-src-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.md`,
    );
    writeFileSync(staleFile, "brand new content for the stale file");
    // Staleness scan returns one file-backed source whose recorded hash is
    // stale → refresh proceeds to re-index through this.index().
    armRows("file_path IS NOT NULL", [
      {
        label: "doc-1",
        file_path: staleFile,
        content_hash: "stale",
        indexed_at: "2000-01-01T00:00:00.000",
      },
    ]);
    // The re-index write fails persistently → the inner store.index logs
    // once and throws an enriched, marker-carrying error; the outer refresh
    // catch must NOT log it again (previously: two lines, the second
    // structure-stripped because the fresh Error dropped .code).
    armFailure({ kind: "run", remaining: Number.POSITIVE_INFINITY });
    const dbPath = tempDbPath("stale-single-log");
    const store = new ContentStore(dbPath);
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      // Refresh is swallowed per-source, so the search itself completes.
      assert.deepEqual(store.searchWithFallback("anything"), []);
      assert.equal(store.lastRefreshCount, 0); // re-index did not succeed
      expect(spy).toHaveBeenCalledTimes(1);
      const line = String(spy.mock.calls[0][0]);
      expect(line.startsWith("[context-mode:db]")).toBe(true);
      expect(line).toContain("store.index"); // the owning op
      expect(line).not.toContain("store.refreshStaleSources");
      expect(line).toContain("SQLITE_IOERR");
      expect(line).toContain(dbPath);
    } finally {
      store.close();
      try { unlinkSync(staleFile); } catch { /* ignore */ }
    }
  });
});
