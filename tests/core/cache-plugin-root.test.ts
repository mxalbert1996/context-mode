import "../setup-home";
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { PACKAGE_NAME, packageCachePath } from "../../src/package-identity.js";

/**
 * Slice 7 — OpenCode/KiloCode silently changed where they store npm
 * plugins (now `packages/<pkg>@latest/node_modules/<pkg>`).
 * The old flat `node_modules/<pkg>` path no longer exists, so doctor
 * + upgrade reported false negatives.
 *
 * Static guard against regression of the published path layout.
 * (Per PR #376.) The npm package is now the scoped
 * `@mxalbert/context-mode` (v2.0.0 fork rename) — the cache layout
 * segments come from `packageCachePath()` in src/package-identity.ts.
 */

const CLI_SRC = readFileSync(resolve(__dirname, "../../src/cli.ts"), "utf-8");

describe("cachePluginRoot — OpenCode/KiloCode 2025+ layout", () => {
  it("derives the layout from packageCachePath() on POSIX", () => {
    // cli.ts must delegate to the shared constants module (was a hardcoded
    // array before the scoped-package rename). Spread args mean we don't
    // expect a single literal path.
    expect(CLI_SRC).toMatch(/packageCachePath\(\)/);
    expect(CLI_SRC).toMatch(/\.cache/);
  });

  it("uses the matching packages layout on Windows", () => {
    // Path segments are passed via spread so the literal substring won't appear
    // sequentially; instead assert the spread + Windows branch are both present.
    expect(CLI_SRC).toMatch(/process\.platform\s*===\s*"win32"/);
    expect(CLI_SRC).toMatch(/packageCachePath\(\)/);
    expect(CLI_SRC).toMatch(/AppData[\s\S]{0,200}Local/);
  });

  it("packageCachePath returns the scoped npm cache layout", () => {
    expect(packageCachePath()).toEqual([
      "packages",
      `${PACKAGE_NAME}@latest`,
      "node_modules",
      PACKAGE_NAME,
    ]);
    expect(packageCachePath()).toEqual([
      "packages",
      "@mxalbert/context-mode@latest",
      "node_modules",
      "@mxalbert/context-mode",
    ]);
  });
});
