# Durable Sessions Hardening — Design

**Date:** 2026-07-12
**Status:** Approved, ready for planning
**Supersedes/extends:** `2026-05-12-durable-sessions-design.md`

## Problem

The durable-sessions feature (snapshot tmux sessions to disk, restore on next
launch after a server death) **silently stopped working in production ~May 15**
and stayed dead for two months. It was discovered only when a macOS forced
restart killed the tmux server and wiped the user's 16 active sessions, with no
snapshot to restore from.

### Root cause: stale-lock deadlock with no liveness detection

`src/snapshot/fs.ts` `lock()` implements a lockfile as a bare
`O_CREAT | O_RDWR | O_EXCL` create. It has **no owner identity and no liveness
check**. The file is removed only by a clean `release()`, which runs only via
`Snapshotter.stop()` on graceful exit (`cleanup()` on
SIGINT/SIGTERM/SIGHUP/pty-exit).

A hard death — `kill -9`, OOM killer, panic, or a forced OS restart — never runs
`stop()`, so the lockfile is orphaned. Because `lock()` has no way to tell that
the holder is dead, the deadlock is permanent and silent:

1. **May 15 14:53** — a jmux instance created `.lock`, then died hard without
   releasing it. A 0-byte `.lock` was orphaned.
2. **Every launch since** → `Restorer.checkEligibility()` →
   `fs.lock()` → `EEXIST` → returns `null` → `{ ok: false, reason: "locked" }`
   → `boot.lockedOut = true`.
3. In `main.ts`, the Snapshotter construction block is gated on
   `!boot.lockedOut`, so it is skipped entirely — **no captures, ever**, and
   restore is skipped too.

### Why it was invisible

`getSnapshotChipReason()` returns `null` whenever `snapshotter` is `null`, which
includes the locked-out path. The one failure mode that disabled the feature is
also the one that suppresses its own warning. The feature rotted with zero
user-visible signal.

## Non-goals

- **Re-launching agents on restore** (`claude` / `claude --continue`) is out of
  scope. Restore reconstructs session structure, cwd, window/pane layout, and
  scrollback — but never re-spawns processes.
- **Surviving with live processes intact** across a server death is impossible
  (processes die with the server); not attempted.
- No change to the fundamental architecture: jmux continues to push-snapshot its
  own state to a file and restore on next launch. This design hardens that
  mechanism; it does not replace it with a derive-from-artifacts approach.

## Design

Three parts: fix the deadlock, make any future death loud, and add a test that
would have caught this.

### Part 1 — Liveness-aware locking

Replace the bare `O_EXCL` lockfile with a lock that records its owner and can
determine whether that owner is still alive, so an orphaned lock is
**self-healing** rather than a permanent deadlock. We stop relying on catching
every exit path (impossible for `kill -9` / power loss).

**Lock record.** On acquire, write an identity payload into the lockfile instead
of leaving it empty:

```json
{ "pid": 12345, "startedAt": "2026-07-12T09:51:28.000Z", "bootId": "<token>" }
```

**Acquire algorithm:**

1. Attempt `O_CREAT | O_RDWR | O_EXCL`. On success, write the identity payload
   and return a `Lock` whose `release()` closes and unlinks (unchanged
   semantics).
2. On `EEXIST`, read and adjudicate the existing record:
   - **Reboot check (primary):** if the record's `bootId` ≠ the current
     `bootId`, the system rebooted since the lock was written, so the holder
     cannot be alive → **steal**. This is the exact case that caused the
     incident.
   - **PID liveness:** else if `process.kill(pid, 0)` throws `ESRCH`, the holder
     process is gone → **steal**.
   - **mtime backstop:** if the record is unreadable, legacy/empty (a 0-byte
     lock from an old build), or malformed, treat as stealable when its mtime
     exceeds a hard staleness threshold.
   - Otherwise the holder is presumed alive → return `null` (respect the lock),
     exactly as today.
3. **Steal is race-safe:** unlink the stale lockfile, then re-acquire via
   `O_EXCL`. If two processes race to steal, exactly one wins the `O_EXCL`
   create; the loser observes `EEXIST` and returns `null` (backs off) rather
   than double-stealing.

**`bootId` derivation** (portable, best-effort):

- macOS: `sysctl -n kern.boottime` → hash the `{ sec, usec }` boot timestamp.
- Linux (Docker test env): `/proc/sys/kernel/random/boot_id`.
- If neither is available, `bootId` is `null`; the reboot check is skipped and
  we fall back to PID-liveness + mtime backstop. Correctness degrades
  gracefully (PID reuse across reboots is the only case the backstop must
  catch, which the mtime threshold covers).

**Interface impact.** The `Lock`/`FileSystem` contract in `src/snapshot/deps.ts`
gains what it needs to write/read identity and query liveness. The `Clock`
abstraction already exists for testable time; `bootId` and PID-liveness are
injected the same way so tests can drive dead/live/rebooted scenarios
deterministically.

### Part 2 — Self-verification (never rot silently again)

Make *any* capture death loud, not just the lock case.

- **Chip driven by state, not object existence.** Replace the
  `if (!snapshotter) return null` short-circuit in `getSnapshotChipReason()`.
  New rule: if `config.snapshot.enabled !== false` but we are **not actively
  capturing**, always surface a chip with a specific reason:
  - `locked` — another *live* jmux owns the lock (legitimate; informational).
  - `stale` — enabled and running, but the newest successful capture is older
    than the freshness threshold (see heartbeat).
  - `error` — capture attempts are throwing (degraded).
- **Freshness heartbeat.** Track the timestamp of the last *successful* write.
  While snapshotting is enabled and jmux is running, if the newest `capturedAt`
  exceeds N minutes, surface the `stale` chip. This catches future silent
  deaths beyond locks — e.g. `writeAtomic` throwing on a full/again-read-only
  disk — that Part 1 alone would not.
- **Inspectable health.** Surface last-capture-time and current reason in the
  settings/status surface so the user can glance at snapshot health rather than
  discovering failure by data loss.

### Part 3 — Regression coverage on the real boot path

This class of bug survived because tests are unit-level over mocked `fs`/tmux;
the real boot path (real filesystem lock + real tmux server) was never
exercised, so a lock that deadlocks in production passed every test.

- **Real-build integration test** in the `bun run docker` clean-env harness:
  1. Boot, create sessions, capture a snapshot, exit **without** clean
     shutdown so the lock is orphaned.
  2. Boot again → assert snapshotting **acquires the lock and writes a fresh
     snapshot** (i.e. the orphaned lock is stolen, not deadlocked), and restore
     runs.
- **Focused lock tests** (unit/integration with injected liveness + clock):
  - dead-PID → steal
  - live-PID (same boot) → respect (return `null`)
  - different `bootId` → steal even if PID appears live (reboot + PID reuse)
  - legacy 0-byte / malformed lock past mtime threshold → steal
  - concurrent steal → exactly one winner, loser backs off

## Immediate mitigation (already applied)

The orphaned 0-byte `.lock` (mtime May 15 14:53) was deleted from
`~/.local/share/jmux/snapshot/default/`. On the next jmux restart — even on the
current published 0.21.1 build — `checkEligibility()` will acquire cleanly and
snapshotting resumes for the recovered sessions. This unblocks capture now,
independent of shipping the code fix.

## Files in scope

- `src/snapshot/fs.ts` — liveness-aware `lock()` (identity payload, adjudicate
  on `EEXIST`, race-safe steal).
- `src/snapshot/deps.ts` — `Lock`/`FileSystem` contract additions; injected
  `bootId` + PID-liveness for testability.
- `src/main.ts` — `getSnapshotChipReason()` state-driven rewrite; freshness
  heartbeat wiring; health surfaced in settings/status.
- `src/snapshot/capture.ts` — expose last-successful-capture timestamp / degraded
  reason for the heartbeat and chip.
- Tests — new lock tests in `src/snapshot/__tests__/` (or existing snapshot test
  location) and a real-boot integration test under the docker harness.

## Success criteria

1. An orphaned lock from a hard-killed/rebooted jmux is automatically reclaimed
   on the next launch; snapshotting resumes without manual intervention.
2. When snapshotting is enabled but not actually capturing (locked-out-by-dead,
   stale, or error), a specific, visible chip is shown — no silent failure.
3. A test in the real-build harness fails if the lock ever deadlocks on an
   orphaned lockfile again.
