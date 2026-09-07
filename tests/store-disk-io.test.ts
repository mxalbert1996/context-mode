/**
 * ContentStore disk-I/O hardening tests — store-layer parity with the
 * session-DB hardening (d018ada; see db-base.test.ts for the db-base-level
 * patterns these mirror).
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
 *
 * IOERR simulation: a mock SQLite driver is injected through db-base's
 * loadDatabase() seam (the same seam ContentStore uses to pick its driver),
 * armed per-test via the hoisted `faults` object. Corruption tests disarm
 * the mock and run against the real driver.
 */
import { strict as assert } from "node:assert";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";

const faults = vi.hoisted(() => ({
  /** When false, loadDatabase() resolves to the real driver. */
  armed: false,
  /** Remaining constructor-time failures (Infinity → persistent). */
  openFailures: 0,
  /** Remaining statement.run() failures (Infinity → persistent). */
  writeFailures: 0,
  /** Remaining statement.all() failures (Infinity → persistent). */
  queryFailures: 0,
  /** Throw shape used for the simulated IOERR. */
  shape: "errno" as "errno" | "plain" | "code-object" | "string",
  openCalls: 0,
  writeRuns: 0,
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

  const makeStatement = () => ({
    run: (..._args: unknown[]) => {
      faults.writeRuns++;
      if (faults.writeFailures > 0) {
        faults.writeFailures--;
        throw makeIoErr();
      }
      return { changes: 1, lastInsertRowid: 1 };
    },
    get: (..._args: unknown[]) => undefined,
    all: (..._args: unknown[]) => {
      if (faults.queryFailures > 0) {
        faults.queryFailures--;
        throw makeIoErr();
      }
      return [];
    },
    iterate: (..._args: unknown[]) => [][Symbol.iterator](),
  });

  const makeMockDb = () => ({
    pragma: (_source: string) => [],
    exec: (_sql: string) => undefined,
    prepare: (_sql: string) => makeStatement(),
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
  faults.writeFailures = 0;
  faults.queryFailures = 0;
  faults.shape = "errno";
  faults.openCalls = 0;
  faults.writeRuns = 0;
  resetDbErrorLogForTests();
  vi.restoreAllMocks();
});

// ════════════════════════════════════════════
// 1+2. Transient IOERR — retried, then succeeds
// ════════════════════════════════════════════

describe("ContentStore — transient SQLITE_IOERR retry", () => {
  test("store.index retries a transient IOERR mid-write and succeeds", () => {
    armMock();
    faults.writeFailures = 2; // fail the first two write statements
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
    faults.writeFailures = 1;
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
    faults.writeFailures = Number.POSITIVE_INFINITY;
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
    faults.queryFailures = Number.POSITIVE_INFINITY;
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
    faults.writeFailures = Number.POSITIVE_INFINITY;
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
    faults.writeFailures = 1;
    const store = new ContentStore(tempDbPath("shape-code-object"));
    const result = store.index({ content: "shape object content", source: "shape" });
    assert.ok(result.totalChunks >= 1);
    store.close();
  });

  test("string throw 'disk I/O error' persisting → enriched tool error, not bare", () => {
    armMock();
    faults.shape = "string";
    faults.writeFailures = Number.POSITIVE_INFINITY;
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
