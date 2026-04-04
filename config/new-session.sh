#!/bin/bash
# jmux new session — fzf name prompt
# Called via: display-popup -E "new-session.sh"

FZF_COLORS="border:#4f565d,header:#b5bcc9,prompt:#9fe8c3,label:#9fe8c3,pointer:#9fe8c3,fg:#6b7280,fg+:#b5bcc9,hl:#fbd4b8,hl+:#fbd4b8"

SESSION_NAME=$(echo "" | fzf --print-query \
    --height=100% \
    --layout=reverse \
    --border=rounded \
    --border-label=" New Session " \
    --header="Enter a name for the session" \
    --header-first \
    --prompt="Name: " \
    --pointer="" \
    --no-info \
    --color="$FZF_COLORS" \
    | head -1)

[ -z "$SESSION_NAME" ] && exit 0

tmux new-session -d -s "$SESSION_NAME"
tmux switch-client -t "$SESSION_NAME"
