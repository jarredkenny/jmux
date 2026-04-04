#!/bin/bash
# Sets up a demo tmux server for jmux screenshots.
# Usage: ./scripts/demo-setup.sh
# Then:  bun run bin/jmux -L jmux-demo

SOCKET="jmux-demo"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
JMUX_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
CONFIG="$JMUX_DIR/config/tmux.conf"

# Create fake project directories for demo
DEMO_DIR=$(mktemp -d)
mkdir -p "$DEMO_DIR/webapp" "$DEMO_DIR/api" "$DEMO_DIR/infra" "$DEMO_DIR/blog"

# Init git repos so branches show in sidebar
for dir in webapp api infra blog; do
  git -C "$DEMO_DIR/$dir" init -q
  git -C "$DEMO_DIR/$dir" commit --allow-empty -m "init" -q
done
git -C "$DEMO_DIR/webapp" checkout -qb feat/auth
git -C "$DEMO_DIR/api" checkout -qb main 2>/dev/null
git -C "$DEMO_DIR/infra" checkout -qb release/v2

# Kill any existing demo server
tmux -L "$SOCKET" kill-server 2>/dev/null
sleep 0.3

# ─────────────────────────────────────────────
# Session: jmux — the project itself
# ─────────────────────────────────────────────
tmux -f "$CONFIG" -L "$SOCKET" new-session -d -s "jmux" -c "$JMUX_DIR"

# Window 1: git log
tmux -L "$SOCKET" send-keys "git log --oneline --graph -15" Enter

# Window 2: editor split panes
tmux -L "$SOCKET" new-window -t "jmux" -c "$JMUX_DIR"
tmux -L "$SOCKET" send-keys "vim src/main.ts" Enter
sleep 0.2
tmux -L "$SOCKET" split-window -h -t "jmux" -c "$JMUX_DIR"
tmux -L "$SOCKET" send-keys "vim src/sidebar.ts" Enter

# Window 3: tests
tmux -L "$SOCKET" new-window -t "jmux" -c "$JMUX_DIR"
tmux -L "$SOCKET" send-keys "bun test --watch" Enter

tmux -L "$SOCKET" select-window -t "jmux:1"

# ─────────────────────────────────────────────
# Session: webapp — frontend project
# ─────────────────────────────────────────────
tmux -L "$SOCKET" new-session -d -s "webapp" -c "$DEMO_DIR/webapp"

# Window 1: dev server output
tmux -L "$SOCKET" send-keys "echo '  VITE v5.4.2  ready in 312ms'" Enter
tmux -L "$SOCKET" send-keys "echo ''" Enter
tmux -L "$SOCKET" send-keys "echo '  Local:   http://localhost:5173/'" Enter
tmux -L "$SOCKET" send-keys "echo '  Network: http://192.168.1.42:5173/'" Enter

# Window 2: shell
tmux -L "$SOCKET" new-window -t "webapp" -c "$DEMO_DIR/webapp"
tmux -L "$SOCKET" send-keys "ls -la" Enter

tmux -L "$SOCKET" select-window -t "webapp:1"

# ─────────────────────────────────────────────
# Session: api — backend service
# ─────────────────────────────────────────────
tmux -L "$SOCKET" new-session -d -s "api" -c "$DEMO_DIR/api"
tmux -L "$SOCKET" send-keys "echo 'Server listening on :8080'" Enter

# ─────────────────────────────────────────────
# Session: infra — infrastructure
# ─────────────────────────────────────────────
tmux -L "$SOCKET" new-session -d -s "infra" -c "$DEMO_DIR/infra"
tmux -L "$SOCKET" send-keys "echo 'Terraform plan: 3 to add, 1 to change, 0 to destroy.'" Enter

# Window 2: logs
tmux -L "$SOCKET" new-window -t "infra" -c "$DEMO_DIR/infra"
tmux -L "$SOCKET" send-keys "echo 'Tailing deploy logs...'" Enter

tmux -L "$SOCKET" select-window -t "infra:1"

# ─────────────────────────────────────────────
# Session: blog — static site
# ─────────────────────────────────────────────
tmux -L "$SOCKET" new-session -d -s "blog" -c "$DEMO_DIR/blog"
tmux -L "$SOCKET" send-keys "ls" Enter

# ─────────────────────────────────────────────
# Session: scratch — throwaway
# ─────────────────────────────────────────────
tmux -L "$SOCKET" new-session -d -s "scratch" -c /tmp
tmux -L "$SOCKET" send-keys "htop" Enter

# ─────────────────────────────────────────────
# Set attention flag on one session
# ─────────────────────────────────────────────
tmux -L "$SOCKET" set-option -t "webapp" @jmux-attention 1

echo ""
echo "Demo server ready on socket: $SOCKET"
echo "Demo projects in: $DEMO_DIR"
echo ""
echo "Sessions:"
tmux -L "$SOCKET" list-sessions -F "  #S (#{session_windows} windows)"
echo ""
echo "  webapp has @jmux-attention set (orange ! indicator)"
echo ""
echo "Run jmux with:"
echo "  cd $JMUX_DIR && bun run bin/jmux -L $SOCKET"
echo ""
echo "Cleanup:"
echo "  tmux -L $SOCKET kill-server && rm -rf $DEMO_DIR"
echo ""
