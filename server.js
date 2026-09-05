// opencode v2 plugin loader entry: the v2 resolver expects a root-level
// `server` module (or a "./server" package export) — see
// docs/opencode-v2-compatibility.md. Re-export the plugin (default export
// carries both v1 `server` and v2 `setup` entries).
export { default } from "./build/adapters/opencode/plugin.js";
