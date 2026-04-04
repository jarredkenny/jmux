#!/bin/bash
# jmux move window — pick a destination session
# Called via: display-popup -E "move-window.sh"

FZF_COLORS="border:#4f565d,header:#b5bcc9,prompt:#9fe8c3,label:#9fe8c3,pointer:#9fe8c3,fg:#6b7280,fg+:#b5bcc9,hl:#fbd4b8,hl+:#fbd4b8"

CURRENT_WINDOW=$(tmux display-message -p '#W')
CURRENT_SESSION=$(tmux display-message -p '#S')

# List all sessions except the current one
SESSIONS=$(tmux list-sessions -F '#S' | grep -v "^${CURRENT_SESSION}$")

if [ -z "$SESSIONS" ]; then
    echo "No other sessions to move to."
    sleep 1
    exit 0
fi

TARGET=$(echo "$SESSIONS" | fzf \
    --height=100% \
    --layout=reverse \
    --border=rounded \
    --border-label=" Move Window " \
    --header="Moving: $CURRENT_WINDOW → ?" \
    --header-first \
    --prompt="Session: " \
    --pointer="▸" \
    --color="$FZF_COLORS")

[ -z "$TARGET" ] && exit 0

tmux move-window -t "$TARGET:"
