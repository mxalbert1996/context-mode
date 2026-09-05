/**
 * Single source of truth for the npm package identity of context-mode.
 *
 * v2.0.0 fork rename: the npm package name is scoped
 * ("@mxalbert/context-mode") while the plugin/display id stays
 * "context-mode" (bin name, MCP server name, hook names, storage dirs).
 * Mirrors the constants in scripts/postinstall.mjs and
 * scripts/heal-installed-plugins.mjs.
 */

/** npm package name — what `npm install -g` / registry URLs resolve. */
export const PACKAGE_NAME = "@mxalbert/context-mode";

/** Plugin/display id — unchanged brand string (NOT the npm package name). */
export const PACKAGE_SLUG = "context-mode";

/**
 * Claude Code registry key: "<pluginId>@<npmPackage>". A scoped package
 * yields a double-@ key ("context-mode@@mxalbert/context-mode").
 */
export const PLUGIN_KEY = `${PACKAGE_SLUG}@${PACKAGE_NAME}`;

/** npm registry endpoint for the latest published version. */
export const NPM_LATEST_URL = `https://registry.npmjs.org/${encodeURIComponent(PACKAGE_NAME)}/latest`;

/**
 * Per-package cache layout OpenCode/KiloCode use for npm-installed plugins:
 *   POSIX  : ~/.cache/<platform>/packages/@mxalbert/context-mode@latest/node_modules/@mxalbert/context-mode
 *   Windows: %LOCALAPPDATA%\<platform>\packages\@mxalbert\context-mode@latest\node_modules\@mxalbert\context-mode
 */
export function packageCachePath(): string[] {
  return ["packages", `${PACKAGE_NAME}@latest`, "node_modules", PACKAGE_NAME];
}
