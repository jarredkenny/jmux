#!/usr/bin/env bash
#
# Reproduces the durable-session incident end-to-end:
#   boot -> capture -> SIGKILL jmux (orphan the lock) -> kill the tmux server
#   -> wait past the proper-lockfile stale window -> boot again
#   -> assert the orphaned lock is reclaimed and sessions are restored.
# Plus a legacy 0-byte-lock migration case.
#
# Runs inside Dockerfile.snapshot-test (tmux installed, XDG_DATA_HOME=/data).
set -uo pipefail

SOCK=orphan
SNAPDIR="/data/jmux/snapshot/${SOCK}"
# Must exceed the proper-lockfile `stale` (30s) so an orphaned lock ages out.
STALE_WAIT=35

MATCH="src/main.ts --socket ${SOCK}"

boot() {
  # Drive the shipped entrypoint under a PTY, backgrounded.
  script -qfc "JMUX_VERSION=dev bun run src/main.ts --socket ${SOCK}" /dev/null \
    >/dev/null 2>&1 &
  disown 2>/dev/null || true
  for _ in $(seq 1 40); do
    pgrep -f "${MATCH}" >/dev/null 2>&1 && return 0
    sleep 0.25
  done
  return 1
}

# Hard-kill every process in the launch chain (script wrapper, sh -c, and the
# bun process) with SIGKILL. SIGKILL is uncatchable, so jmux's graceful cleanup
# never runs and the lock is left genuinely orphaned — exactly the crash we fix.
hardkill() {
  pkill -9 -f "${MATCH}" 2>/dev/null || true
  for _ in $(seq 1 20); do
    pgrep -f "${MATCH}" >/dev/null 2>&1 || return 0
    sleep 0.2
  done
}

wait_for() { for _ in $(seq 1 80); do [ -e "$1" ] && return 0; sleep 0.25; done; return 1; }
fail() { echo "FAIL: $1"; exit 1; }

echo "== boot 1 =="
boot || fail "jmux did not start (boot 1)"
sleep 2
tmux -L "${SOCK}" new-session -d -s recover-me -c /tmp 2>/dev/null || true
wait_for "${SNAPDIR}/state.json" || fail "no state.json after boot 1"
wait_for "${SNAPDIR}/.lock.lock" || fail "no proper-lockfile artifact after boot 1"
# Ensure the session made it into the snapshot before we kill.
for _ in $(seq 1 40); do grep -q 'recover-me' "${SNAPDIR}/state.json" && break; sleep 0.25; done
grep -q 'recover-me' "${SNAPDIR}/state.json" || fail "recover-me not captured in state.json"
CAP_BEFORE=$(grep -o '"capturedAt": *"[^"]*"' "${SNAPDIR}/state.json" | head -1)

echo "== hard-kill jmux (orphans the lock) =="
hardkill
echo "== kill the tmux server (simulate server death) =="
tmux -L "${SOCK}" kill-server 2>/dev/null || true
[ -e "${SNAPDIR}/.lock.lock" ] || fail "expected the lock to remain orphaned after hard kill"

echo "== wait ${STALE_WAIT}s for the orphaned lock to age past stale =="
sleep "${STALE_WAIT}"

echo "== boot 2 (must reclaim the stale lock and restore) =="
boot || fail "jmux did not start (boot 2)"
RESTORED=0
for _ in $(seq 1 40); do
  tmux -L "${SOCK}" has-session -t recover-me 2>/dev/null && { RESTORED=1; break; }
  sleep 0.5
done
[ "${RESTORED}" = "1" ] || { hardkill; fail "session not restored after boot 2"; }
# A fresh capture must have happened (lock reclaimed -> Snapshotter running).
for _ in $(seq 1 40); do
  CAP_AFTER=$(grep -o '"capturedAt": *"[^"]*"' "${SNAPDIR}/state.json" | head -1)
  [ "${CAP_AFTER}" != "${CAP_BEFORE}" ] && break
  sleep 0.5
done
[ "${CAP_AFTER}" != "${CAP_BEFORE}" ] || { hardkill; fail "capturedAt not refreshed after reclaim"; }

echo "== legacy 0-byte lock migration =="
hardkill
tmux -L "${SOCK}" kill-server 2>/dev/null || true
sleep 1
rm -rf "${SNAPDIR}/.lock.lock"
: > "${SNAPDIR}/.lock"            # aged 0-byte 0.21.1-style lock file
boot || fail "jmux did not start (boot 3)"
wait_for "${SNAPDIR}/.lock.lock" || { hardkill; fail "new lock not acquired over legacy 0-byte lock"; }
[ -e "${SNAPDIR}/.lock" ] && { hardkill; fail "legacy 0-byte lock not removed"; }
hardkill

echo "PASS"
