# Durable Sessions — Design Spec

**Date:** 2026-05-12
**Status:** Approved for implementation planning
**Scope:** Make jmux sessions survive system crashes (kernel panic, power loss, reboot) by snapshotting structural state and pane scrollback to disk and silently restoring on next launch.

## Problem

A jmux session today is durable only as long as the underlying tmux server is alive. On system crash or reboot, every session, window, pane, layout, scrollback buffer, accumulated OTEL state (cost, cache, last tool), permission mode, and attention flag is lost. `~/.config/jmux/state.json` persists issue/MR links but has no concept of what sessions ever existed; the link records become orphans pruned on next startup. The user has lost all sessions twice; this is unacceptable.

## Goal

After any crash, the next `jmux` launch silently restores every session that existed at the moment of last capture: same names, same cwds, same worktree linkage, same window/pane layout, painted scrollback, accumulated metadata, and Claude panes resumed with `--continue`. Non-Claude panes restore to a fresh shell at the right cwd with the prior command line visible in painted scrollback (the user's own shell history handles up-arrow recall).

## Non-goals (v1)

- Restoring live processes other than Claude. Non-Claude commands are not auto-relaunched.
- Snapshot sync across machines. Local only.
- Restoring into a tmux server that already has live sessions. Eligibility requires a fresh server.
- Replaying in-flight Claude API calls. `--continue` is the resume mechanism; mid-flight requests are gone.
- Per-session pick-list at restore time. Restore is all-or-nothing per the auto-restore UX decision.

## Durability target

The implementation must support:

> A user who SIGKILLs jmux (or whose laptop loses power) at an arbitrary moment loses at most ~200 ms of structural state and ~5 s of scrollback. On next launch, jmux deterministically rebuilds every session, paints scrollback, and relaunches Claude panes with `--continue`. Partial restore failures degrade gracefully and never destroy the snapshot.

## Architecture

### Module layout

```
src/snapshot/
  index.ts        — public API: Snapshotter, Restorer
  schema.ts       — TypeScript types + validator for state.json
  capture.ts      — Snapshotter: subscribes to state, writes snapshot files
  restore.ts      — Restorer: reads snapshot, drives tmux to recreate sessions
  deps.ts         — injection seams: FileSystem, TmuxRunner, Clock
  migrations.ts   — formatVersion migrators (empty for v1; pipeline tested)
src/main.ts       — wires Snapshotter to existing events; calls Restorer pre-UI
```

**Boundary rules:**

- `capture.ts` only reads state and writes files. It does not drive tmux.
- `restore.ts` only writes to tmux via the existing `TmuxControl` and never touches snapshot files except to read them. After successful restore, control passes to Snapshotter for capture.
- `schema.ts` is the contract between capture and restore. Both import it; neither imports the other.
- `main.ts` change is ~30 lines: instantiate Snapshotter post-boot, run Restorer pre-UI when conditions are met.

### Files on disk

```
~/.local/share/jmux/snapshot/
  <socket-name>/                 ("default" for default socket, else tmux -L name)
    .lock                        (flock-protected, single-writer guarantee)
    state.json                   (atomically replaced)
    state.json.tmp               (only present mid-write)
    meta.json                    (format version, last write ts, jmux version)
    restore.log                  (per-session restore outcomes, appended)
    scrollback/
      <session>/
        <window-idx>-<pane-idx>.ansi
```

Path follows the XDG `$XDG_DATA_HOME` convention: config (preferences) stays in `~/.config/jmux/`, machine-local recreatable data lives in `~/.local/share/jmux/`. Override via `$JMUX_SNAPSHOT_DIR` for tests and unusual deployments.

The snapshot dir is keyed by tmux socket name so multiple jmux processes on different sockets (`jmux -L work`, `jmux -L play`) get independent snapshots. The `.lock` is per-subdir, so same-socket contention is detected and different-socket processes coexist.

### Snapshot schema (`state.json`)

```ts
export const SNAPSHOT_FORMAT_VERSION = 1;

export interface SnapshotFile {
  formatVersion: 1;
  jmuxVersion: string;
  capturedAt: string;             // ISO timestamp
  tmuxSocket: string;             // "" for default socket
  lastFocusedSession: string | null;
  sessions: SnapshotSession[];
}

export interface SnapshotSession {
  name: string;                   // sanitized tmux session name
  cwd: string;                    // session creation cwd
  worktreePath: string | null;    // absolute path if wtm-managed, else null
  projectGroup: string | null;    // wtm project basename, for sidebar grouping
  pinned: boolean;
  attention: boolean;
  permissionMode: "plan" | "accept" | null;
  otel: {
    costUsd: number;
    cacheWasHit: boolean | null;
    lastRequestTime: string | null;
    lastCompactionTime: string | null;
    lastTool: string | null;
    lastUserPromptTime: string | null;
    lastError: string | null;
    failedMcpServers: string[];
  } | null;
  links: SessionLink[];
  windows: SnapshotWindow[];
}

export interface SnapshotWindow {
  index: number;
  name: string;
  layout: string;                 // tmux's canonical layout string
  active: boolean;
  panes: SnapshotPane[];
}

export interface SnapshotPane {
  index: number;
  cwd: string;
  command: string;                // pane_start_command at session creation
  kind: "claude" | "shell" | "other";
  scrollbackFile: string | null;
}

export interface SessionLink {
  type: "issue" | "mr";
  id: string;
}
```

**Design notes:**

- Layout is stored as tmux's canonical string (`#{window_layout}`). On restore, `select-layout` consumes it verbatim. No tree reconstruction, no rounding-error chasing.
- `kind` is detected at capture time (centralized regex) so restore is a dumb switch.
- `scrollbackFile` is a separate per-pane file, not inline JSON: keeps `state.json` parse cost trivial and avoids the JSON-escape cost of ANSI byte streams.
- `lastFocusedSession` is updated on every focus change (cheap) so the restored PTY attaches to the session the user was actually using.
- OTEL is nullable; fresh sessions don't synthesize zeros.
- Runtime-only fields (tmux PID, client name, in-memory ScreenBridge grid) are deliberately absent — the entire point of the snapshot is that the prior process is dead.

### Injection seams (must exist before any logic is written)

```ts
// src/snapshot/deps.ts
export interface FileSystem {
  readFile(path: string): Promise<Uint8Array | null>;
  writeAtomic(path: string, bytes: Uint8Array): Promise<void>;  // tmp+rename
  rename(from: string, to: string): Promise<void>;
  unlink(path: string): Promise<void>;
  readDir(path: string): Promise<string[]>;
  mkdir(path: string, recursive?: boolean): Promise<void>;
  stat(path: string): Promise<{ size: number; mtimeMs: number } | null>;
  lock(path: string): Promise<Lock | null>;
}

export interface TmuxRunner {
  run(args: string[], opts?: { timeoutMs?: number }): Promise<{
    stdout: string; stderr: string; exitCode: number;
  }>;
}

export interface Clock {
  now(): number;
  setInterval(fn: () => void, ms: number): () => void;
  setTimeout(fn: () => void, ms: number): () => void;
}
```

Production implementations are thin wrappers around `Bun.write`, `Bun.spawn`, `fs.promises`, and the real clock. Tests pass in-memory or recording fakes.

## Capture

Two independent write loops in `Snapshotter`. Both write atomically (tmp+rename). Both share a single in-memory `SnapshotFile` model.

### Loop 1 — structural state

Event-driven, debounced. Subscribes to:

| Source | Event | Effect on model |
| --- | --- | --- |
| `TmuxControl` | `%sessions-changed` | full rebuild via list-sessions/windows/panes |
| `TmuxControl` | `%window-add`, `%window-close`, `%window-renamed` | targeted window update |
| `TmuxControl` | `%layout-change` | window's layout string |
| `TmuxControl` | `%session-renamed` | session name |
| `SessionState` | `linksChanged` (new event to expose) | session's `links[]` |
| `OtelReceiver` | per-session `update` | session's `otel` |
| pin/attention watchers in `main.ts` | callbacks | session flags |
| focus tracker | session switch | `lastFocusedSession` |

Each event marks the model dirty and schedules a flush. Flush is debounced at **200 ms trailing-edge**: repeated events within 200 ms collapse to one write. On flush, serialize and atomically write `state.json.tmp` → `rename`.

On `SIGTERM`, `SIGINT`, `SIGHUP`, and clean exit, a synchronous final flush bypasses the debounce so graceful shutdown loses no structural state.

For events whose handler can't update the model incrementally (`%sessions-changed`, layout changes requiring pane re-enumeration), the snapshotter shells out via `TmuxRunner` to re-derive the affected subtree only — full rebuilds are limited to session add/remove.

### Loop 2 — scrollback

Timer-driven, 5 s period (configurable via `~/.config/jmux/config.json`, key `snapshot.scrollbackIntervalMs`, min 1000). Each tick:

1. `tmux list-sessions -F '#{session_name}'`.
2. For each session: `list-windows` + `list-panes`.
3. For each pane: `tmux capture-pane -p -e -J -S - -t <session>:<window>.<pane>`, write to `scrollback/<session>/<w>-<p>.ansi.tmp`, rename.
4. GC: remove any `<session>/` directory that no longer corresponds to a live session.

Guards:

- Async tick, no overlap: if a tick takes >5 s the next is skipped.
- Per-pane error isolation: a `capture-pane` failure (pane closed between enumerate and capture) skips that pane only.
- Empty-output panes write `null` into the model's `scrollbackFile` field and the file is removed; restore won't paint a blank screen.
- Scrollback file size cap (`snapshot.scrollbackMaxBytes`, default 2 MiB per pane). On overflow, drop oldest bytes after UTF-8 boundary alignment and prepend `\n--- truncated: oldest N bytes dropped ---\n`. tmux's `history-limit` (default 2000) caps real growth; 2 MiB is generous headroom.

### Single-writer lock

A `flock(LOCK_EX | LOCK_NB)` on `<snapshot-dir>/.lock` is acquired **once per boot**: the Restorer takes it before checking eligibility and **hands the held lock to the Snapshotter** after restore completes (success or skip). The lock is never released between restore and the start of capture, so no other jmux process can interleave between the two phases. If acquisition fails at boot, jmux runs in **degraded mode**: Restorer skips, Snapshotter no-ops for this process lifetime, and a discreet `snapshot off` chip appears in the toolbar (click to surface the reason: lock held, dir not writable, etc.). The chip is suppressed when the user has explicitly set `snapshot.enabled: false` in config — that's intentional opt-out, not a problem to surface.

### What is deliberately NOT captured

- Hover/focus state, sidebar scroll, modal open state — UI ephemera.
- `pane_current_command` — only `pane_start_command` matters; `current_command` is exactly what dies.
- Diff panel state — re-spawns against current cwd on demand.
- OTEL receiver port / spans in flight.
- Bytes in flight through `ScreenBridge`.

## Restore

Runs once, synchronously, before the PTY attaches.

### Boot sequence

```
1. start TmuxControl (-C)                  // metadata channel only
2. tmux list-sessions                      // anything live?
3. eligible for restore?                   // see eligibility rules
4.   if yes: Restorer.run()                // re-create everything
5. spawn TmuxPty (-A -s <lastFocused>)     // user-visible attach
6. wire up Snapshotter                     // begin capturing again
```

### Eligibility — restore runs only if all are true

- `state.json` exists and validates against schema (else move to `state.json.broken-<ISO-ts>`, log, skip).
- `tmux list-sessions` returns zero sessions (fresh tmux server).
- `.lock` is acquirable (no other jmux process).

If any condition fails, jmux boots normally and the existing snapshot is left untouched. The snapshot is never deleted by the restore path — only overwritten by successful capture.

### Per-session sequence

For each `SnapshotSession`:

1. Verify cwd exists. Missing → log to `restore.log`, skip session, continue with next.
2. **First window:** `tmux new-session -d -s <name> -c <cwd> <painter-argv>` (`-d` = detached, no client attaches yet).
3. **Subsequent windows:** `tmux new-window -t <session>:<idx> -c <cwd> <painter-argv>`.
4. **Subsequent panes in a window:** `tmux split-window -t <session>:<w> -c <cwd> <painter-argv>` (split direction irrelevant; layout fixes it).
5. **Apply layout:** `tmux select-layout -t <session>:<w> <layoutString>`.
6. **Names:** `rename-window` for each window, `select-window` to mark active.
7. **In-memory rehydration:** OTEL accumulators, permissionMode, pinned/attention flags pushed into live caches keyed by session name. Issue/MR links already loaded by existing `SessionState`.

After all sessions are built, the PTY attaches to `lastFocusedSession` (or the first session if null).

### The painter argv

The single trick that gets scrollback into a pane's history *before* the real command runs:

```
sh -c 'F=$1; [ -s "$F" ] && cat "$F"; \
       printf "\n\033[2m--- restored @ %s ---\033[0m\n" "$2"; \
       shift 2; exec "$@"' \
   jmux-restore /path/to/scrollback.ansi 2026-05-12T18:43:01Z \
   /bin/zsh -i
```

- `$0` (`jmux-restore`) is cosmetic, not visible in scrollback.
- `cat` paints bytes through tmux's pty as if the prior process had emitted them — tmux's history fills correctly, scroll-up works.
- `printf` writes a dim separator so the user sees the history/live boundary.
- `exec` replaces the painter shell with the target — signals propagate correctly, no orphan layer.

Tail per pane kind:

- `kind: "claude"` → `<configured claudeCommand> --continue` (current config wins; not snapshot's old value).
- `kind: "shell" | "other"` → `$SHELL -i`. Captured command line is visible in painted scrollback; the user's persistent shell history (`~/.zsh_history` etc.) handles up-arrow recall.

`buildPainterArgv(scrollbackPath, capturedAt, command): string[]` is a pure function — the unit-test seam.

### Partial-failure semantics

**Granularity is per session.** Within a session, *any* subprocess failure (new-window, split-window, select-layout, rename-window) is treated as a session-level failure: the partial session is `kill-session`'d and the Restorer moves to the next. There is no "restore N of M panes for session X" — half-restored sessions are confusing UX and the layout invariants don't hold. Better to fully skip with a clear log entry.

- Sessions are isolated from each other. Failure of session N logs to `restore.log` and N+1 proceeds.
- If session N is partially built when failure hits, `kill-session -t <N>` cleans up; no half-built artifacts visible to the user.
- Entire restore failure (tmux server dies mid-restore) → log, leave snapshot intact, exit clean. jmux still boots, just empty. User retries.
- Restorer Ctrl+C handler sweeps partially-built sessions (any session present in tmux not yet marked "restored" in the Restorer's internal log gets `kill-session`'d), exits clean. Snapshot untouched.

### `restore.log` format

Newline-delimited JSON, appended (never truncated). One record per session attempt. Rotated only by the user (`rm` the file); growth is bounded by per-restore session count, so unlikely to need rotation in practice.

```json
{"ts":"2026-05-12T18:43:01Z","session":"feature-x","outcome":"restored","windowCount":2,"paneCount":5}
{"ts":"2026-05-12T18:43:02Z","session":"old-branch","outcome":"skipped","reason":"cwd_missing","cwd":"/repos/foo/old-branch"}
{"ts":"2026-05-12T18:43:03Z","session":"broken","outcome":"failed","reason":"select_layout_rejected","stderr":"..."}
```

`outcome` is one of `restored | skipped | failed`. `reason` is a stable enum string suitable for grepping.

### User-visible UX during restore

A single-line splash: `restoring N sessions from <capturedAt>...`. Each session restored bumps a counter. If restore takes >2 s the splash adds an animated spinner. Restore is not cancellable mid-flight; partial restores are not useful.

## Error handling

### Snapshot integrity

- **Atomic writes:** every persist uses write-temp + `fs.rename`. Atomic on local POSIX filesystems. Reader sees old or new, never partial.
- **Disk full:** `rename` returns ENOSPC; Snapshotter logs, keeps model dirty, retries on next debounce/tick. No crash.
- **Orphaned `.tmp` files:** mid-write crash leaves `*.tmp` behind. Boot does one-shot sweep before Restorer runs.
- **Parse / schema failure:** move to `state.json.broken-<ISO-ts>`, log, skip restore. Evidence preserved.
- **Unknown `formatVersion`:** log loudly, back up, skip. Never guess at a newer schema.
- **Older `formatVersion`:** registered migrator runs in-memory before validation. v1 ships with no migrators; pipeline tested via a fake v0→v1.

### tmux state weirdness

- **Control channel dies during capture:** TmuxControl's existing reconnect kicks in. Snapshotter pauses both loops while disconnected; on reconnect does a full re-derivation (no trust in cached deltas across reconnect).
- **tmux server dies during restore:** Restorer aborts on first failed command, logs, leaves snapshot intact. jmux still boots empty.
- **Session name collision:** impossible by construction (eligibility requires empty server).
- **Layout string rejected:** logged but session not killed. Panes exist in arbitrary geometry; degraded but usable; user can resize.

### External filesystem & worktree state

- **cwd missing** (worktree blown away, repo moved, broken symlink): session skipped, `restore.log` records name + intended cwd + linked issue.
- **Snapshot dir not writable:** detected at lock acquisition. Degraded mode; toolbar shows `snapshot off` chip with reason on click.
- **Scrollback file size cap:** see capture loop 2.

### Process lifecycle

- **Graceful shutdown** (SIGTERM/SIGINT/SIGHUP, clean exit): synchronous final flush of structural model. Scrollback not flushed (runs on its own 5 s loop; shutdown isn't worth N pane captures).
- **SIGKILL / OOM:** worst-case loss is one debounce window (~200 ms structural) + one scrollback tick (~5 s). This is the documented durability floor.
- **Snapshotter starts before TmuxControl connects:** events queue in a bounded ring buffer (1 K events, drops oldest if exceeded — pathological, never expected) and drain on connect.

### Configuration drift between capture and restore

- **`claudeCommand` changed:** Restorer uses *current* config, not snapshot's. Config is the source of truth for "how to spawn Claude."
- **`sidebarWidth`, panel sizes:** live in `config.json`, not snapshot. Restore silent about them.
- **Pinned set changed:** snapshot's `pinned` flag wins for restored sessions; live config edits take over immediately.

### Snapshot freshness

Not gated on age. Auto-restore is silent per UX decision; a freshness modal would contradict it. `capturedAt` is logged prominently. Escape hatch: `rm -rf ~/.local/share/jmux/snapshot/<socket>/` (documented in README).

## Testing strategy

### Test files (the contract for implementation)

```
src/__tests__/snapshot/
  schema.test.ts            — validator accepts good, rejects bad, round-trips JSON
  capture-events.test.ts    — event handlers update model correctly
  capture-debounce.test.ts  — 200 ms trailing-edge, no missed flushes, signal-flush
  capture-scrollback.test.ts— tick loop enumerates, writes, GCs, per-pane error isolation
  capture-lock.test.ts      — single-writer enforced; second instance no-ops
  capture-atomic.test.ts    — disk-full retry, .tmp sweep, concurrent writes never tear
  restore-eligibility.test.ts — only when server empty + snapshot valid + lock free
  restore-sequence.test.ts  — argv order: new-session → splits → select-layout → rename
  restore-partial.test.ts   — failing session is kill-session'd, next proceeds
  restore-missing-cwd.test.ts — skipped sessions land in restore.log
  painter-argv.test.ts      — buildPainterArgv for claude/shell/other, escaping
  migrations.test.ts        — fake v0→v1 migrator runs, registry routes correctly
  multi-socket.test.ts      — two snapshot dirs operate independently
  integration-tmux.test.ts  — REAL tmux on temp socket: capture → kill → restore → assert
```

### Tier 1 — pure unit tests (`bun test`, <2 s)

All files except `integration-tmux.test.ts`. No filesystem, no subprocesses, no real timers (Clock is faked). Coverage target: every branch in `capture.ts` and `restore.ts`, every error path triggered by injection. Runs on every commit.

### Tier 2 — real-filesystem tests (`bun test`, <5 s)

`capture-atomic.test.ts` uses a real temp dir to verify the atomic write helper against actual `rename`. Includes a stress test: two writers race on the same path for 1 s, reader never observes a partial or empty file. Only place we trust filesystem behavior over its mock.

### Tier 3 — real-tmux integration (`integration-tmux.test.ts`)

Deliberate exception to the CLAUDE.md "no tmux in tests" rule. Reasoning: layout strings, split semantics, pane indexing, and `capture-pane` output format are tmux-version-specific and cannot be reliably mocked. Mocks here give false confidence.

Test shape:

1. Spawn `tmux -L <unique-socket> -f /dev/null new-session -d -s a -c $TMPDIR sh` (no user config).
2. Build a known topology: 2 sessions, 3 windows total, 5 panes total, varied layouts, scripted content piped into each pane.
3. Run Snapshotter, force flush, assert files on disk match topology.
4. `tmux -L <socket> kill-server`. Snapshot persists.
5. Run Restorer pointed at the same snapshot + a fresh socket.
6. Assert `list-sessions/windows/panes` matches step 2 exactly, including layout strings.
7. Assert scrollback paint completed (sample active pane's `capture-pane -p -S -` and grep original content).

Runs in CI on Linux + macOS. Gated to its own file via `describe.skipIf(!hasTmux())` so contributors without tmux can still run the default suite.

### Property-based test

`schema.test.ts` includes a fast-check property: generate arbitrary valid `SnapshotFile` values, serialize, parse, validate — asserts the validator's accepted set equals the constructor's output. Catches drift between schema and types better than enumerated examples.

### CI gates

- `bun run typecheck` — must pass.
- `bun test` — full suite (Tiers 1, 2, 3) must pass on Linux and macOS runners.
- Snapshot-related coverage threshold: **95% branch coverage** on `src/snapshot/**`. Enforced via `bun test --coverage` plus a small script that fails if the threshold drops. The rest of the codebase keeps its current (untracked) coverage; we don't impose this elsewhere.

### What we intentionally do NOT test

- Real Claude `--continue` behavior. We test that we pass the flag with a recording runner; we don't spawn Claude.
- Cross-platform tmux versions beyond Linux/macOS modern versions. Minimum is tmux 3.2+ (already in CLAUDE.md).
- Disk failure modes deeper than ENOSPC (bit rot, fsync semantics). Out of scope; tmp+rename is the contract we promise.

### Confidence claim

After this suite passes:

> A user who SIGKILLs jmux at any moment loses at most ~200 ms structural state and ~5 s of scrollback. On next boot, jmux deterministically rebuilds the session tree, paints scrollback, and relaunches Claude with `--continue`. Partial failures degrade gracefully and the snapshot is never destroyed by the restore code path.

What we do NOT claim from tests alone: that restored sessions feel subjectively identical to live sessions. That requires manual verification, explicitly part of the implementation phase, not the test phase.

## Configuration surface added

`~/.config/jmux/config.json`:

```json
{
  "snapshot": {
    "enabled": true,
    "scrollbackIntervalMs": 5000,
    "scrollbackMaxBytes": 2097152,
    "dir": null
  }
}
```

- `enabled` (default true): master switch. Off → Snapshotter no-ops, Restorer skips.
- `scrollbackIntervalMs` (default 5000, min 1000).
- `scrollbackMaxBytes` (default 2 MiB per pane).
- `dir` (default null → XDG path): override snapshot directory.

`$JMUX_SNAPSHOT_DIR` env var trumps config (for tests).

## Open scope explicitly closed

- Snapshot cloud sync, dotfiles inclusion: not v1.
- Restoring into a busy tmux server (merge semantics): not v1.
- Per-session pick-list at restore: not v1.
- Non-Claude command auto-relaunch: not v1.
- Diff panel state: not snapshotted; re-spawns on demand.
- ScreenBridge byte-stream tee for fidelity: rejected (only sees active session).
- Shelling out to tmux-resurrect: rejected (external dep + still needs jmux-side state layer).
