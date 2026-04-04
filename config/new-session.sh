#!/bin/bash
# jmux new session — name + directory picker
# Called via: display-popup -E "new-session.sh"

FZF_COLORS="border:#4f565d,header:#b5bcc9,prompt:#9fe8c3,label:#9fe8c3,pointer:#9fe8c3,fg:#6b7280,fg+:#b5bcc9,hl:#fbd4b8,hl+:#fbd4b8"

# ─── Step 1: Pick a directory ─────────────────────────────────────────

# Build project list: find directories with .git (dir or file — worktrees use a file)
# Search common code directories, limit depth for speed
PROJECT_DIRS=$(find \
    "$HOME/Code" \
    "$HOME/Projects" \
    "$HOME/src" \
    "$HOME/work" \
    "$HOME/dev" \
    -maxdepth 4 -name ".git" 2>/dev/null \
    | sed 's|/\.git$||' \
    | sort -u)

# Add home directory as fallback
PROJECT_DIRS=$(printf "%s\n%s" "$HOME" "$PROJECT_DIRS" | grep -v '^$')

# Replace $HOME with ~ for display, but keep original paths
DISPLAY_DIRS=$(echo "$PROJECT_DIRS" | sed "s|^$HOME|~|")

SELECTED_DIR=$(echo "$DISPLAY_DIRS" | fzf \
    --height=100% \
    --layout=reverse \
    --border=rounded \
    --border-label=" New Session — Pick Directory " \
    --header="Search for a project directory" \
    --header-first \
    --prompt="Dir: " \
    --pointer="▸" \
    --color="$FZF_COLORS")

[ -z "$SELECTED_DIR" ] && exit 0

# Expand ~ back to $HOME
WORK_DIR="${SELECTED_DIR/#\~/$HOME}"

# Default session name to directory basename
DEFAULT_NAME=$(basename "$WORK_DIR")

# ─── Step 2: Session name ─────────────────────────────────────────────

SESSION_NAME=$(echo "" | fzf --print-query \
    --height=100% \
    --layout=reverse \
    --border=rounded \
    --border-label=" New Session — Name " \
    --header="Directory: $SELECTED_DIR" \
    --header-first \
    --prompt="Name: " \
    --query="$DEFAULT_NAME" \
    --pointer="" \
    --no-info \
    --color="$FZF_COLORS" \
    | head -1)

[ -z "$SESSION_NAME" ] && exit 0

# ─── Create session ───────────────────────────────────────────────────

PARENT_CLIENT=$(tmux display-message -p '#{client_name}' 2>/dev/null)
tmux new-session -d -s "$SESSION_NAME" -c "$WORK_DIR"
tmux switch-client -c "$PARENT_CLIENT" -t "$SESSION_NAME"
