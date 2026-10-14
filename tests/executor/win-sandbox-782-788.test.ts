import { describe, it, expect } from "vitest";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, basename } from "node:path";
import {
  PolyglotExecutor,
  rewriteWindowsBuildTools,
} from "../../src/executor.js";
import { detectRuntimes } from "../../src/runtime.js";

// ─────────────────────────────────────────────────────────────────────
// Cluster C3 — Windows ctx_execute sandbox.
//
// #782: Maven (mvn) fails on Windows in the ctx_execute sandbox because
//   Git Bash's `mvn` shell script takes the mingw=true branch and leaves
//   CLASSWORLDS_JAR as a POSIX path that native java.exe can't resolve.
//   The third-way fix (Option C in the issue) rewrites a bare `mvn`
//   invocation to `mvn.cmd` on Windows — the native launcher that uses
//   Windows paths — WITHOUT re-enabling global MSYS path-conversion
//   suppression that #826/#791 deliberately removed for native git.
//
// #788: Two sub-bugs:
//   (a) Non-shell ctx_execute runtimes (python/js/ts/…) ran with cwd set
//       to the .ctx-mode-* sandbox tmpDir, so repo-relative checks like
//       `package.json` exists() failed. They must run in the project root
//       (or per-call cwd override) like shell does. The script FILE still
//       lives in the sandbox; only the process cwd changes.
//   (b) `.ctx-mode-*` temp dirs leaked on Windows when they contained
//       SQLite -wal/-shm files with lingering handles — the single rmSync
//       threw EBUSY/EPERM and the silent catch{} swallowed it. Cleanup
//       must retry.
// ─────────────────────────────────────────────────────────────────────

const runtimes = detectRuntimes();

describe("#782 — Windows mvn path-conversion (rewriteWindowsBuildTools)", () => {
  it("rewrites a bare `mvn` invocation to `mvn.cmd` on win32", () => {
    expect(rewriteWindowsBuildTools("mvn clean install", "win32")).toBe(
      "mvn.cmd clean install",
    );
  });

  it("rewrites `mvn` after a shell operator (&&, |, ;, newline)", () => {
    expect(
      rewriteWindowsBuildTools("cd app && mvn -version", "win32"),
    ).toBe("cd app && mvn.cmd -version");
    expect(rewriteWindowsBuildTools("mvn test; echo done", "win32")).toBe(
      "mvn.cmd test; echo done",
    );
    expect(rewriteWindowsBuildTools("echo a\nmvn package", "win32")).toBe(
      "echo a\nmvn.cmd package",
    );
  });

  it("does NOT touch mvn on non-Windows platforms", () => {
    expect(rewriteWindowsBuildTools("mvn clean install", "linux")).toBe(
      "mvn clean install",
    );
    expect(rewriteWindowsBuildTools("mvn clean install", "darwin")).toBe(
      "mvn clean install",
    );
  });

  it("does NOT double-rewrite an already-.cmd invocation", () => {
    expect(rewriteWindowsBuildTools("mvn.cmd clean install", "win32")).toBe(
      "mvn.cmd clean install",
    );
  });

  it("does NOT rewrite a wrapper (mvnw) or a substring like `mvnd`/`mymvn`", () => {
    expect(rewriteWindowsBuildTools("./mvnw clean", "win32")).toBe(
      "./mvnw clean",
    );
    expect(rewriteWindowsBuildTools("mymvn run", "win32")).toBe("mymvn run");
    expect(rewriteWindowsBuildTools("mvnd build", "win32")).toBe("mvnd build");
  });
});

describe.runIf(runtimes.python)(
  "#788(a) — non-shell ctx_execute runs in project root",
  () => {
    it("python sees the project root as cwd, not the sandbox tmpDir", async () => {
      const projectDir = mkdtempSync(join(tmpdir(), "ctx-proj-py-"));
      try {
        const executor = new PolyglotExecutor({
          runtimes,
          projectRoot: () => projectDir,
        });
        const result = await executor.execute({
          language: "python",
          code: "import os; print(os.path.basename(os.getcwd()))",
        });
        expect(result.exitCode).toBe(0);
        // cwd basename must be the project dir, NOT a `.ctx-mode-*` tmp dir.
        expect(result.stdout.trim()).toBe(basename(projectDir));
        expect(result.stdout).not.toContain(".ctx-mode-");
      } finally {
        try {
          rmSync(projectDir, { recursive: true, force: true });
        } catch {
          /* ignore */
        }
      }
    });

    it("python honors a per-call cwd override", async () => {
      const projectDir = mkdtempSync(join(tmpdir(), "ctx-proj-wrong-"));
      const overrideDir = mkdtempSync(join(tmpdir(), "ctx-proj-override-"));
      try {
        const executor = new PolyglotExecutor({
          runtimes,
          projectRoot: () => projectDir,
        });
        const result = await executor.execute({
          language: "python",
          code: "import os; print(os.path.basename(os.getcwd()))",
          cwd: overrideDir,
        });
        expect(result.exitCode).toBe(0);
        expect(result.stdout.trim()).toBe(basename(overrideDir));
      } finally {
        try {
          rmSync(projectDir, { recursive: true, force: true });
        } catch {
          /* ignore */
        }
        try {
          rmSync(overrideDir, { recursive: true, force: true });
        } catch {
          /* ignore */
        }
      }
    });
  },
);

describe("#788(b) — sandbox temp dir is cleaned up after run", () => {
  it("removes this run's sandbox dir after a completed non-shell run", async () => {
    const executor = new PolyglotExecutor({ runtimes });

    // The executed process reports its own sandbox dir: the executor sets
    // TMPDIR to the .ctx-mode-* tmpDir for EVERY language (see #spawn env).
    // Asserting THIS run's dir is hermetic — a global .ctx-mode-* scan of the
    // shared OS temp dir races against sibling test files running in
    // parallel (vitest runs files concurrently and they legitimately create
    // sandboxes too, so a dir created mid-window reads as a false leak).
    const lang = runtimes.python ? "python" : "shell";
    const code = lang === "python"
      ? "import os; print(os.environ.get('TMPDIR', ''))"
      : 'echo "$TMPDIR"';

    const result = await executor.execute({ language: lang, code });
    expect(result.exitCode).toBe(0);

    const sandboxDir = result.stdout.trim().split("\n").at(-1)?.trim() ?? "";
    expect(basename(sandboxDir)).toMatch(/^\.ctx-mode-/);

    // cleanupTmpDir runs synchronously before execute() resolves.
    expect(existsSync(sandboxDir)).toBe(false);
  });
});
