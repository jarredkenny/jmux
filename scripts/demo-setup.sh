#!/bin/bash
# Sets up a demo tmux server for jmux screenshots.
# Usage: ./scripts/demo-setup.sh
# Then:  bun run bin/jmux -L jmux-demo

SOCKET="jmux-demo"
CONFIG="$(cd "$(dirname "$0")/.." && pwd)/config/tmux.conf"
JMUX_DIR="$HOME/Code/personal/jmux"

# Kill any existing demo server
tmux -L "$SOCKET" kill-server 2>/dev/null
sleep 0.3

# ─────────────────────────────────────────────
# Session: jmux — the project itself
# ─────────────────────────────────────────────
tmux -f "$CONFIG" -L "$SOCKET" new-session -d -s "jmux" -c "$JMUX_DIR"

# Window 1: shell with a recent git log visible
tmux -L "$SOCKET" send-keys "git log --oneline --graph -15" Enter

# Window 2: editor — two panes showing source
tmux -L "$SOCKET" new-window -t "jmux" -c "$JMUX_DIR"
tmux -L "$SOCKET" send-keys "vim src/main.ts" Enter
sleep 0.2
tmux -L "$SOCKET" split-window -h -t "jmux" -c "$JMUX_DIR"
tmux -L "$SOCKET" send-keys "vim src/sidebar.ts" Enter

# Window 3: tests running
tmux -L "$SOCKET" new-window -t "jmux" -c "$JMUX_DIR"
tmux -L "$SOCKET" send-keys "bun test --watch" Enter

# Back to window 1
tmux -L "$SOCKET" select-window -t "jmux:1"

# ─────────────────────────────────────────────
# Session: mist-fm — a music app
# ─────────────────────────────────────────────
tmux -L "$SOCKET" new-session -d -s "mist-fm" -c "$HOME/Code/personal/mist-fm"

# Window 1: dev server
tmux -L "$SOCKET" send-keys "echo '  Listening on http://localhost:3000'" Enter
tmux -L "$SOCKET" send-keys "echo '  Ready in 247ms'" Enter

# Window 2: shell
tmux -L "$SOCKET" new-window -t "mist-fm" -c "$HOME/Code/personal/mist-fm"
tmux -L "$SOCKET" send-keys "ls -la" Enter

tmux -L "$SOCKET" select-window -t "mist-fm:1"

# ─────────────────────────────────────────────
# Session: blog — static site
# ─────────────────────────────────────────────
tmux -L "$SOCKET" new-session -d -s "blog" -c "$HOME/Code/personal/blog"
tmux -L "$SOCKET" send-keys "ls" Enter

# ─────────────────────────────────────────────
# Session: dotfiles — config management
# ─────────────────────────────────────────────
tmux -L "$SOCKET" new-session -d -s "dotfiles" -c "$HOME"

# Window 1: editing config
tmux -L "$SOCKET" send-keys "vim ~/.config/ghostty/config" Enter

# Window 2: shell
tmux -L "$SOCKET" new-window -t "dotfiles" -c "$HOME"
tmux -L "$SOCKET" send-keys "ls ~/.config/" Enter

tmux -L "$SOCKET" select-window -t "dotfiles:1"

# ─────────────────────────────────────────────
# Session: worktree-mgr — another project
# ─────────────────────────────────────────────
tmux -L "$SOCKET" new-session -d -s "wtm" -c "$HOME/Code/personal/worktree-manager"
tmux -L "$SOCKET" send-keys "git status" Enter

# ─────────────────────────────────────────────
# Session: scratch — quick throwaway
# ─────────────────────────────────────────────
tmux -L "$SOCKET" new-session -d -s "scratch" -c /tmp
tmux -L "$SOCKET" send-keys "htop" Enter

# ─────────────────────────────────────────────
# Set attention flag on one session for the screenshot
# ─────────────────────────────────────────────
tmux -L "$SOCKET" set-option -t "mist-fm" @jmux-attention 1

echo ""
echo "Demo server ready on socket: $SOCKET"
echo ""
echo "Sessions:"
tmux -L "$SOCKET" list-sessions -F "  #S (#{session_windows} windows)"
echo ""
echo "  mist-fm has @jmux-attention set (orange ! indicator)"
echo ""
echo "Run jmux with:"
echo "  cd $JMUX_DIR && bun run bin/jmux -L $SOCKET"
echo ""
