#!/bin/bash
# jmux rename session
# Called via: display-popup -E "rename-session.sh"

FZF_COLORS="border:#4f565d,header:#b5bcc9,prompt:#9fe8c3,label:#9fe8c3,pointer:#9fe8c3,fg:#6b7280,fg+:#b5bcc9,hl:#fbd4b8,hl+:#fbd4b8"

CURRENT_NAME=$(tmux display-message -p '#S')

NEW_NAME=$(echo "" | fzf --print-query \
    --height=100% \
    --layout=reverse \
    --border=rounded \
    --border-label=" Rename Session " \
    --header="Current: $CURRENT_NAME" \
    --header-first \
    --prompt="Name: " \
    --query="$CURRENT_NAME" \
    --pointer="" \
    --no-info \
    --color="$FZF_COLORS" \
    | head -1)

[ -z "$NEW_NAME" ] && exit 0
[ "$NEW_NAME" = "$CURRENT_NAME" ] && exit 0

tmux rename-session "$NEW_NAME"
