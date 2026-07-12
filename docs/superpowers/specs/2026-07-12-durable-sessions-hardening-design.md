# Durable Sessions Hardening — Design

**Date:** 2026-07-12
**Status:** Approved, ready for planning
**Supersedes/extends:** `2026-05-12-durable-sessions-design.md`
**Revision:** v2 — rewritten after an adversarial review (Codex `gpt-5.6-sol`,
xhigh). See "Review resolution" at the end for the findings and how each is
addressed.

## Problem

The durable-sessions feature (snapshot tmux sessions to disk, restore on next
launch after a server death) **silently stopped capturing in production ~May 15**
and stayed dead for two months. It was discovered only when a macOS forced
restart killed the tmux server and wiped the user's 16 active sessions, with no
usable snapshot to restore from.

### Root cause: the implementation diverged from its own spec

The `2026-05-12` design specified a **kernel advisory lock**
(`flock(LOCK_EX | LOCK_NB)` on `<snapshot-dir>/.lock`, line 232) whose entire
purpose is that the OS releases it automatically when the holder dies. The
shipped implementation in `src/snapshot/fs.ts` instead used a bare
`O_CREAT | O_RDWR | O_EXCL` lockfile — a file whose mere existence means
"locked", with **no owner identity and no liveness detection**. It is removed
only by a clean `release()`, which runs only via `Snapshotter.stop()`.

`stop()` runs on graceful exit (`cleanup()` on SIGINT/SIGTERM/SIGHUP/pty-exit)
**and** on permanent control-channel loss (`control.onLost`). It does **not**
run on `kill -9`, OOM, panic, or a forced OS restart — nor on many ordinary
startup-failure paths (see below). Any of those orphans the lockfile, and
because the primitive has no liveness check, the deadlock is permanent:

1. A jmux instance created `.lock`, then exited without releasing it (the
   orphaning event itself is not precisely known; the persistent deadlock it
   caused is what we diagnosed).
2. **Every launch since** → `Restorer.checkEligibility()` → `fs.lock()` →
   `EEXIST` → returns `null` → `{ ok: false, reason: "locked" }` →
   `boot.lockedOut = true`.
3. In `main.ts`, the Snapshotter block is gated on `!boot.lockedOut`, so it is
   skipped entirely — **no captures, ever**, and restore is skipped too.

### Why it was invisible

Two health signals specified in the original design were never implemented
faithfully:

- `getSnapshotChipReason()` returns `null` whenever `snapshotter` is `null`
  (which includes the locked-out path), so no chip appears on the exact path
  that disables the feature.
- Even when a reason *is* computed, the toolbar hardcodes the chip text to the
  generic `"snapshot off"` (`statusChip: reason ? "snapshot off" : null`) and
  the `lock()` result is reduced to a `boolean lockedOut`, discarding the
  reason. The original spec's "click to surface the reason" was never built.

The feature rotted with effectively zero user-visible signal.

## Non-goals

- **Re-launching agents on restore** (`claude` / `claude --continue`) is out of
  scope. Restore reconstructs session structure, cwd, window/pane layout, and
  scrollback — but never re-spawns processes.
- **Surviving with live processes intact** across a server death is impossible
  (processes die with the server); not attempted.
- **Networked/shared snapshot directories** (NFS, multi-host access to one
  `snapshot.dir`) are out of scope. The directory is local, per-machine,
  single-writer. Advisory-lock semantics over network filesystems are
  explicitly not designed for.
- No change to the fundamental architecture: jmux continues to push-snapshot its
  own state to a local file and restore on next launch. This design hardens that
  mechanism; it does not replace it with a derive-from-artifacts approach.

## Design

Four parts: fix the lock, own it correctly across boot, make any future capture
death loud and specific, and add a test that actually reproduces this class of
failure. Plus a small pre-existing-debt fix (temp-file cleanup) encountered in
the path of the work.

### Part 1 — Replace the lock with `proper-lockfile`

Bun/Node expose no `flock` in stdlib, so rather than re-implement kernel locking
via FFI we adopt **`proper-lockfile`** (added as a dependency): atomic-`mkdir`
acquisition plus a periodic mtime "update" heartbeat and post-acquire
verification. Crucially, a **live holder refreshes the lock's mtime**, so
staleness detection is safe — the failure mode of the old code (a healthy
process holding an identity-less lock that never ages out) cannot recur, and a
*dead* holder's lock ages past `stale` and is reclaimed automatically.

- **Acquire** the lock for the snapshot directory on boot. Options:
  - `stale`: reclaim threshold for a lock whose holder stopped refreshing
    (starting default **30s** — long enough to tolerate brief event-loop
    stalls, short enough for quick post-crash recovery; tunable).
  - `update`: mtime refresh interval (**10s**).
  - `realpath: false` (the lock path need not pre-exist as a real file).
  - `onCompromised`: fired if our lock is lost (e.g. our refresh stalled past
    `stale` and another process stole it). This transitions health to `error`
    and **stops capturing** — we never keep writing after losing exclusivity.
    This makes the "two live writers" hazard observable rather than silent.
- **This eliminates**, by construction, the entire class the old code created:
  no unlink/recreate steal race (proper-lockfile verifies acquisition), no PID
  identity guessing, no `bootId`, no "steal a live holder because it never
  refreshed mtime". A hard-killed holder's lock is reclaimed after `stale`; a
  gracefully-exited holder's lock is released immediately.

**Legacy migration.** The old primitive wrote a 0-byte *file* at
`<dir>/.lock`; `proper-lockfile` manages a lock *directory* at a distinct path,
so the two do not collide and the historical 0-byte orphan is simply irrelevant
to the new mechanism. On startup we nonetheless **defensively remove any
legacy identity-less `<dir>/.lock` file** (an artifact only ≤0.21.1 produces;
the new build never creates that path), so no stale debris lingers. A live
0.21.1 process and a new build share no locking primitive and therefore would
*not* mutually exclude — this is acceptable because the invariant is
single-writer-per-socket-per-machine and the user runs one jmux per socket; it
is called out here rather than silently assumed.

### Part 2 — Correct lock ownership across the whole boot

The lock is acquired in `checkEligibility()` and currently lives in
`boot.snapshotLock` across many `await`s in `performBoot()` before the
Snapshotter takes ownership. If anything throws in that window —
`restorer.run()` failing to write `.bootstrap.conf`, control-start failure,
session-discovery failure, the PTY exiting, or Snapshotter construction throwing
— control reaches `start().catch(() => cleanup())`, which runs with
`snapshotter === null`, so `cleanup()`'s `snapshotter?.stop()` releases nothing.
With the old primitive that leaked a permanent lock; even with
`proper-lockfile` it needlessly holds the lock until process exit and can leave
the boot degraded without signal.

- Give the boot lock a single explicit owner with `try/finally`. The Restorer
  holds it through restore; ownership transfers to the Snapshotter **only once
  the Snapshotter is constructed and started**. **Every** pre-transfer failure
  path releases it.
- Register a release in the process cleanup path **immediately after
  acquisition**, not only after the Snapshotter exists, so no window exists in
  which a failure skips release.

### Part 3 — Honest, per-subsystem health (never rot silently again)

"Last successful write" is too coarse: the periodic scrollback tick calls
`markDirty()` and rewrites `state.json`, so `capturedAt` can stay fresh while
event-driven **topology** capture is dead, or while **scrollback** writes are
failing. A single freshness timestamp would report "healthy" through real
failures. Instead, track independent signals and derive health from all of
them.

**Tracked signals** (each with last-success time, last-attempt time, last
error, and consecutive-failure count):

- last successful **topology reconciliation** (full `list-sessions` /
  `list-windows` derive),
- last successful **state-file commit** (`state.json` written),
- last successful **scrollback sweep**.

**Watchdog** (replaces the naive heartbeat):

- A periodic **full-capture attempt** runs regardless of change activity, with
  `try/catch` around model generation, `JSON.stringify`, and the write (today
  serialization and model-build sit outside `flushNow`'s catch).
- Bounded **retry/backoff** after a failed write instead of silently setting
  `dirty` and waiting for the next unrelated event.
- On any health **transition**, call `scheduleRender()` so an otherwise idle TUI
  redraws to show the change (today nothing forces a redraw when capture goes
  bad).
- Compute `nextExpectedCaptureAt`; a check on each render **and** an independent
  timer flag "overdue" if the watchdog itself stopped firing.
- **Persist** the latest health to disk so the *next* launch can report "the
  previous run ended unhealthy," catching failures that happen too late for the
  live UI to show.

**Honest limitation, stated explicitly:** a fully stalled/frozen event loop
cannot self-report — no in-process watchdog can. We document this boundary
rather than claim absolute coverage; the persisted-health-on-next-launch signal
is the backstop for that case.

### Part 4 — Typed health state + specific UI

Replace the `Lock | null → boolean lockedOut → generic "snapshot off"` pipeline
with a typed health state shared by boot and the Snapshotter:

```
type SnapshotHealth =
  | "disabled"              // user opted out
  | "starting"
  | "healthy"
  | "locked_live"           // another live jmux holds the lock (informational)
  | "locked_unknown"        // lock present, ownership indeterminate — needs attention
  | "stale"                 // enabled + running, newest capture older than threshold
  | "error"                 // capture attempts failing / lock compromised
  | "stopped"
  | "control_channel_lost"  // preserved from today
```

- Lock acquisition returns a **structured** result (owner/age/error/reason), not
  a bare `null`, so boot can classify `locked_live` vs `locked_unknown` vs
  `error` rather than labeling every refusal "another live jmux."
- The toolbar renders a **specific** label per state (not a single hardcoded
  string), and settings gains **read-only rows**: current health, last
  successful topology/state/scrollback times, and last error. This is the
  "click to surface the reason" the original spec promised, finally delivered.
- Rendering is triggered on every health transition.

### Part 5 — Pre-existing debt fixed in-path: temp-file cleanup + durability

`writeAtomic()` writes `state.json.tmp.<pid>.<counter>`, but startup cleanup
only unlinks names ending exactly in `.tmp`, so crash debris (including up to
2 MiB-per-pane scrollback temp files) accumulates and can itself cause the
disk-full condition Part 3 detects. Existing tests assert the wrong fixed name
`path + ".tmp"`.

- Centralize temp-name recognition and sweep `*.tmp.<pid>.<counter>` safely at
  startup. Update tests to use the actually-generated names.
- After `rename(tmp, path)`, **fsync the parent directory** so the rename is
  durable across power loss (today only the file is fsynced, not its directory
  entry).

### Part 6 — A test harness that reproduces the incident

A real-tmux + real-fs integration test already exists
(`src/__tests__/snapshot/integration-tmux.test.ts`), so real-tmux coverage is
*not* the gap. The gap is the **top-level boot/orphan-lock lifecycle**, which no
test exercises — and the current `bun run docker` harness cannot serve: it runs
`-it` (interactive) and `Dockerfile.test` **deliberately does not install
tmux** (it tests the dependency-onboarding flow).

Add a dedicated **non-interactive** integration image/script that:

1. Installs tmux; uses an isolated socket and a **persistent** XDG data dir
   (so state survives a container/process restart).
2. Launches the shipped entrypoint under a PTY.
3. Waits for both the lock and a valid snapshot to appear.
4. Sends **SIGKILL to the exact jmux PID** (not container SIGTERM, which would
   run clean shutdown and release the lock).
5. **Separately kills the tmux server** — otherwise the server survives and the
   second boot hits `server_busy`, so restore never runs and the test proves
   nothing.
6. Restarts the entrypoint and asserts: topology restored, a **newer**
   `capturedAt`, and **exactly one** lock owner.
7. Separately seeds an **aged 0-byte 0.21.1-style `.lock`** and asserts the
   chosen migration behavior (defensive removal + clean acquire).

Plus focused tests with **real subprocess barriers** (not a mocked FS, which
would only encode the algorithm's own assumptions) for concurrent acquisition:
two processes contend, exactly one acquires, the other reports `locked_live`.

## Files in scope

- `package.json` — add `proper-lockfile` dependency.
- `src/snapshot/fs.ts` — replace `lock()` with a `proper-lockfile`-backed
  implementation returning a structured status; fix temp-file sweep recognition;
  fsync parent dir after rename.
- `src/snapshot/deps.ts` — `lock()` contract returns structured status; health
  signal types.
- `src/snapshot/restore.ts` — consume structured lock status; classify
  eligibility reasons.
- `src/snapshot/capture.ts` — per-subsystem health tracking, watchdog with
  retry/backoff and full-catch, `onCompromised` handling, persisted health.
- `src/main.ts` — scoped boot-lock ownership with `try/finally` + immediate
  cleanup registration; typed `SnapshotHealth`; state-driven specific chip;
  settings health rows; render-on-transition.
- Tests — new boot/orphan-lifecycle harness (non-interactive, tmux-installed);
  legacy-lock migration test; real-subprocess concurrency test; corrected
  temp-file tests; per-subsystem health tests.

## Success criteria

1. A lock orphaned by a hard-killed/rebooted jmux is automatically reclaimed on
   the next launch (after `stale`); snapshotting resumes without manual
   intervention. A gracefully-exited holder's lock is reclaimed immediately.
2. No boot path can leak the lock into a degraded-but-silent state: every
   pre-transfer failure releases it, and losing the lock while running
   (`onCompromised`) stops capture and surfaces `error`.
3. When snapshotting is enabled but not truly healthy, a **specific** visible
   state is shown (`locked_live` / `locked_unknown` / `stale` / `error`), backed
   by per-subsystem signals — no single-timestamp false "healthy".
4. A test in a runnable harness fails if the lock ever deadlocks on an orphaned
   lockfile, if restore fails to run after a real server death, or if the legacy
   0-byte lock is mishandled.

## Immediate mitigation (already applied)

The orphaned 0-byte `.lock` (mtime May 15 14:53) was deleted from
`~/.local/share/jmux/snapshot/default/`. On the next jmux restart — even on the
current published 0.21.1 build — `checkEligibility()` acquires cleanly and
snapshotting resumes for the recovered sessions. This unblocks capture now,
independent of shipping the code fix.

## Review resolution

Adversarial review (Codex `gpt-5.6-sol`, xhigh) raised 10 findings against v1;
all verified against source and accepted except one scoping pushback:

| # | Finding | Resolution |
|---|---------|------------|
| C1 | unlink+`O_EXCL` steal is racy (multi-owner) | Part 1 — `proper-lockfile`, no manual steal |
| C2 | mtime backstop steals a live 0.21.1 holder | Part 1 — live holder refreshes mtime; legacy handled by defensive removal |
| M3 | PID liveness ≠ identity; PID reuse; shared-dir | Part 1 removes PID/bootId logic; shared-dir is a **non-goal** (only scoping pushback) |
| M4 | ordinary startup errors leak the lock | Part 2 — scoped `try/finally` ownership + immediate cleanup registration |
| M5 | fresh writes mask dead topology/scrollback | Part 3 — per-subsystem health signals |
| M6 | heartbeat isn't a real watchdog | Part 3 — periodic full-capture watchdog, retry/backoff, render-on-transition, persisted health |
| M7 | UI can't produce a specific reason | Part 4 — typed `SnapshotHealth`, structured lock status, specific labels + settings rows |
| F8 | proposed docker test can't run / doesn't reproduce | Part 6 — dedicated non-interactive tmux harness; kill jmux **and** server; legacy-lock case |
| F9 | factual errors in v1 problem statement | Corrected: `stop()` also runs on control loss; real-tmux test already exists; `bootId` can't detect the 0-byte orphan |
| F10 | temp-file cleanup already broken; no dir fsync | Part 5 — sweep `*.tmp.<pid>.<counter>`; fsync parent dir |
