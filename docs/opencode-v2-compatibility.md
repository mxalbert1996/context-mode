# opencode v1/v2 compatibility

context-mode's opencode plugin supports both opencode v1 and v2 from a single
package. It follows the same approach as
[oh-my-opencode-slim](https://github.com/alvinunreal/oh-my-opencode-slim/blob/master/docs/opencode-v2-compatibility.md):
one default export carries both entry points, and the host decides which one runs.

```ts
// src/adapters/opencode/plugin.ts
export default {
  id: "context-mode",
  server: createContextModePlugin, // v1 host calls server(input)
  setup: setupV2,                  // v2 host calls setup(ctx)
};
```

No `tui` marker is set on the main export (a boolean `tui: true` would make the
plugin invalid for server loading).

## How version detection works

There is no runtime version flag; detection is implicit in which entry the host
calls:

- **v1 hosts** load the plugin via `server(input)` and get the classic
  `tool.execute.before/after`, `event`, `chat.message`,
  `experimental.session.compacting`, and `experimental.chat.system.transform`
  hooks.
- **v2 hosts** call `setup(ctx)`. `setup` **probes capabilities at runtime**
  and registers only what the host actually exposes. Verified against the
  opencode 2 preview (`v0.0.0-beta-19135`):

| v1 behavior | v2 surface used | Mandatory? |
|---|---|---|
| native `ctx_*` tools | `ctx.tool.transform(editor)` — each tool added with `options: { codemode: false }` so it stays individually callable (with the default codemode the executor folds tools into its single `execute` CodeMode tool and direct calls fail) | yes |
| `tool.execute.before/after` | `ctx.tool.hook("execute.before" / "execute.after")` | yes |
| system transform / routing block / resume injection | `ctx.session.hook("context")` (mutable `system: [{type:"text", text}]` parts) — also runs for continuations and compaction | no (degrades) |
| `chat.message` (prompt capture) | `ctx.session.hook("prompt")` (`event.prompt.text`) | no (degrades) |
| `event` capture | `ctx.event.subscribe()` (async iterable) | no (degrades) |
| `ctx.client.app.log` | none — v2 `app` exposes only `name`/`version`/`channel`; logs fall back to stderr | — |

Unavailable optional behaviors are logged **once** at setup and are not faked.
On a v2 host missing a mandatory surface (tool transform or execute hooks),
the plugin does not claim activation, stays in a degraded mode, and keeps the
legacy `mcp.context-mode` MCP entry so the `ctx_*` tools remain reachable.

## Hybrid hosts and the activation guard

Some v1 hosts (≥ 1.17.10) also boot the v2 core, so both entries can run in the
same process. The plugin keeps a process-global activation registry keyed by
plugin id + canonicalized project directory:

- The first entry with the **full mandatory surface** claims activation.
- A second entry (either flavor) for the same project returns an empty/noop
  registration and logs once.
- v2 claims only if it can provide tool hooks **and** native tool registration;
  otherwise it unregisters what it can, closes its database handle, releases the
  claim, and lets the v1 entry claim.
- On teardown (failure or cleanup), all captured dispose handles are called in
  reverse order and the database is closed before the claim is released.

Host limitation: hosts that accept registrations without returning unregister
handles cannot be fully cleaned up. Such stale callbacks are neutralized by a
runtime liveness flag (they become silent no-ops). On v2 hosts that accept
plugin registrations without returning unregister handles, a failed setup may
leave inert `ctx_*` tool stubs until host reload; they are neutralized and safe,
but host-specific tool precedence may affect which provider is invoked.

## Configuration

The adapter reads and writes both config keys:

- v1: `"plugin": ["context-mode"]`
- v2: `"plugins": ["context-mode"]`

Existing keys are kept in sync; when neither exists, the v1 `plugin` key is
written. The legacy `mcp.context-mode` block is removed only when native tool
availability is confirmed (on v2 that means the plugin claimed activation with
full native tool registration); it is kept only when that cannot be confirmed
— degraded setups where the plugin cannot claim — so `ctx_*` tools stay
available via MCP.

## Disk I/O error hardening

Recurring `SQLITE_IOERR` ("disk I/O error") on healthy disks was traced to
transient driver behavior and cross-process shared-file mutation — not to disk
failure or database corruption (upstream issues #992, #880, #905; PRs #1030,
#1056). Changes:

- **Transient retry**: `SQLITE_IOERR` / "disk I/O error" is now retried with
  the same exponential backoff as `SQLITE_BUSY`. Corruption
  (`SQLITE_CORRUPT`) is never retried.
- **No default mmap**: the 256 MB `mmap_size` default was removed. Opt in with
  `CONTEXT_MODE_DB_MMAP_SIZE=<bytes>` (integer ≥ 0) if your workload benefits.
- **No close-time checkpoint**: `wal_checkpoint(TRUNCATE)` at close was removed
  from the shared close path — closing no longer mutates database files another
  process may hold open. WAL sidecar files may remain after close; that is
  intentional.
- **Detailed error logging**: previously-silent database failures (schema
  init/migration, read paths that return empty results) now log to stderr as
  `[context-mode:db] <op> [<code>]: <message>`. Identical errors are deduped to
  once per ~30 seconds. Plugin hook errors log via `client.app.log` when
  available with a stderr fallback (never stdout), with the same dedupe.

Set `OPENCODE_DEBUG=1` for full stack traces in both the plugin and DB logs.
