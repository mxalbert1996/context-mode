/**
 * Packaging guard for the opencode AGENTS.md mandate injection.
 *
 * The plugin composes the condensed routing block with the FULL
 * configs/opencode/AGENTS.md mandate at RUNTIME (composeRoutingGuidance in
 * src/adapters/opencode/plugin.ts), so the template must (a) ship with the
 * npm package and (b) exist at the exact path the plugin resolves from its
 * build dir (build/adapters/opencode → package root via ../../../) — and
 * from src/adapters/opencode under tsx/vitest.
 *
 * Dependency-free by design: fs + JSON.parse only (no setup-home, no mocks).
 */

import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const packageJsonPath = resolve(process.cwd(), "package.json");
const templatePath = resolve(process.cwd(), "configs", "opencode", "AGENTS.md");

describe("opencode AGENTS.md template shipping (runtime mandate injection depends on it)", () => {
  it("package.json files[] ships configs (and therefore configs/opencode/AGENTS.md)", () => {
    const pkg = JSON.parse(readFileSync(packageJsonPath, "utf-8")) as {
      files?: unknown;
    };
    expect(Array.isArray(pkg.files), "package.json must declare a files[] allowlist").toBe(true);
    expect((pkg.files as unknown[])).toContain("configs");
  });

  it("configs/opencode/AGENTS.md exists and carries the mandate markers", () => {
    expect(existsSync(templatePath)).toBe(true);
    const content = readFileSync(templatePath, "utf-8");
    // Signature line consumed by the plugin's dedupe guard (project-root
    // copies carrying it suppress the plugin's own injection).
    expect(content).toContain("context-mode — MANDATORY routing rules");
    // The full-mandate section the plugin appends after the condensed block.
    expect(content).toContain("## Think in Code — MANDATORY");
  });

  it("the plugin's runtime template path resolves from BOTH build/ and src/ layouts", () => {
    // pluginsTemplatePathFor() resolves <buildDir>/../../../configs/opencode/AGENTS.md.
    // From the compiled layout (build/adapters/opencode — what the smoke loads):
    const fromBuild = resolve(process.cwd(), "build", "adapters", "opencode");
    if (existsSync(fromBuild)) {
      expect(
        existsSync(resolve(fromBuild, "..", "..", "..", "configs", "opencode", "AGENTS.md")),
        "template must be reachable from build/adapters/opencode via ../../../",
      ).toBe(true);
    }
    // From the source layout (src/adapters/opencode — tsx/vitest + plugin cache installs):
    const fromSrc = resolve(process.cwd(), "src", "adapters", "opencode");
    expect(
      existsSync(resolve(fromSrc, "..", "..", "..", "configs", "opencode", "AGENTS.md")),
      "template must be reachable from src/adapters/opencode via ../../../",
    ).toBe(true);
  });
});
