#!/bin/bash
# jmux settings modal — reads/writes ~/.config/jmux/config.json
# Called via: display-popup -E "settings.sh"

CONFIG_DIR="$HOME/.config/jmux"
CONFIG_FILE="$CONFIG_DIR/config.json"
FZF_COLORS="border:#4f565d,header:#b5bcc9,prompt:#9fe8c3,label:#9fe8c3,pointer:#9fe8c3,fg:#6b7280,fg+:#b5bcc9,hl:#fbd4b8,hl+:#fbd4b8"

# ─── Helpers ──────────────────────────────────────────────────────────

read_config() {
    bun -e "
        const c = await Bun.file('$CONFIG_FILE').json().catch(() => ({}));
        console.log(JSON.stringify(c));
    " 2>/dev/null || echo "{}"
}

write_config() {
    local json="$1"
    mkdir -p "$CONFIG_DIR"
    echo "$json" | bun -e "
        const stdin = await Bun.stdin.text();
        const c = JSON.parse(stdin);
        await Bun.write('$CONFIG_FILE', JSON.stringify(c, null, 2) + '\n');
    "
}

get_value() {
    local json="$1" key="$2" default="$3"
    echo "$json" | bun -e "
        const stdin = await Bun.stdin.text();
        const c = JSON.parse(stdin);
        console.log(c['$key'] ?? '$default');
    " 2>/dev/null || echo "$default"
}

set_value() {
    local json="$1" key="$2" value="$3" type="$4"
    echo "$json" | bun -e "
        const stdin = await Bun.stdin.text();
        const c = JSON.parse(stdin);
        const v = '$value';
        const t = '$type';
        if (t === 'number') c['$key'] = parseInt(v, 10);
        else if (t === 'bool') c['$key'] = v === 'true';
        else if (t === 'array') c['$key'] = v.split(',').map(s => s.trim()).filter(Boolean);
        else c['$key'] = v;
        console.log(JSON.stringify(c));
    " 2>/dev/null
}

# ─── Main loop ────────────────────────────────────────────────────────

while true; do
    CONFIG=$(read_config)

    SIDEBAR_WIDTH=$(get_value "$CONFIG" "sidebarWidth" "26")
    PROJECT_DIRS_RAW=$(echo "$CONFIG" | bun -e "
        const c = JSON.parse(await Bun.stdin.text());
        const dirs = c.projectDirs ?? ['~/Code', '~/Projects', '~/src', '~/work', '~/dev'];
        console.log(dirs.join(', '));
    " 2>/dev/null || echo "~/Code, ~/Projects, ~/src, ~/work, ~/dev")
    WTM_ENABLED=$(get_value "$CONFIG" "wtmIntegration" "true")
    CLAUDE_CMD=$(get_value "$CONFIG" "claudeCommand" "claude")

    # Format display
    WTM_DISPLAY="on"
    [ "$WTM_ENABLED" = "false" ] && WTM_DISPLAY="off"

    SELECTION=$(printf "%s\n%s\n%s\n%s" \
        "Sidebar Width            $SIDEBAR_WIDTH" \
        "Claude Command           $CLAUDE_CMD" \
        "Project Directories      $PROJECT_DIRS_RAW" \
        "wtm Integration          $WTM_DISPLAY" \
        | fzf \
            --height=100% \
            --layout=reverse \
            --border=rounded \
            --border-label=" Settings " \
            --header="Select a setting to change" \
            --header-first \
            --prompt="  " \
            --pointer="▸" \
            --no-info \
            --color="$FZF_COLORS")

    [ -z "$SELECTION" ] && exit 0

    case "$SELECTION" in
        "Sidebar Width"*)
            NEW_WIDTH=$(echo "" | fzf --print-query \
                --height=100% \
                --layout=reverse \
                --border=rounded \
                --border-label=" Sidebar Width " \
                --header="Current: $SIDEBAR_WIDTH (takes effect on restart)" \
                --header-first \
                --prompt="Width: " \
                --query="$SIDEBAR_WIDTH" \
                --pointer="" \
                --no-info \
                --color="$FZF_COLORS" \
                | head -1)

            if [ -n "$NEW_WIDTH" ]; then
                CONFIG=$(set_value "$CONFIG" "sidebarWidth" "$NEW_WIDTH" "number")
                write_config "$CONFIG"
            fi
            ;;

        "Project Directories"*)
            NEW_DIRS=$(echo "" | fzf --print-query \
                --height=100% \
                --layout=reverse \
                --border=rounded \
                --border-label=" Project Directories " \
                --header="Comma-separated list of directories to search" \
                --header-first \
                --prompt="Dirs: " \
                --query="$PROJECT_DIRS_RAW" \
                --pointer="" \
                --no-info \
                --color="$FZF_COLORS" \
                | head -1)

            if [ -n "$NEW_DIRS" ]; then
                CONFIG=$(set_value "$CONFIG" "projectDirs" "$NEW_DIRS" "array")
                write_config "$CONFIG"
            fi
            ;;

        "Claude Command"*)
            NEW_CMD=$(echo "" | fzf --print-query \
                --height=100% \
                --layout=reverse \
                --border=rounded \
                --border-label=" Claude Command " \
                --header="Command to launch Claude Code from toolbar" \
                --header-first \
                --prompt="Cmd: " \
                --query="$CLAUDE_CMD" \
                --pointer="" \
                --no-info \
                --color="$FZF_COLORS" \
                | head -1)

            if [ -n "$NEW_CMD" ]; then
                CONFIG=$(set_value "$CONFIG" "claudeCommand" "$NEW_CMD" "string")
                write_config "$CONFIG"
            fi
            ;;

        "wtm Integration"*)
            if [ "$WTM_ENABLED" = "true" ]; then
                CONFIG=$(set_value "$CONFIG" "wtmIntegration" "false" "bool")
            else
                CONFIG=$(set_value "$CONFIG" "wtmIntegration" "true" "bool")
            fi
            write_config "$CONFIG"
            ;;
    esac
done
