#!/bin/bash
# jmux new session — name + directory picker with wtm worktree support
# Called via: display-popup -E "new-session.sh"

FZF_COLORS="border:#4f565d,header:#b5bcc9,prompt:#9fe8c3,label:#9fe8c3,pointer:#9fe8c3,fg:#6b7280,fg+:#b5bcc9,hl:#fbd4b8,hl+:#fbd4b8"

# ─── Step 1: Pick a directory ─────────────────────────────────────────

# Read project directories from config, fall back to defaults
CONFIG_FILE="$HOME/.config/jmux/config.json"
SEARCH_DIRS=""
if [ -f "$CONFIG_FILE" ]; then
    SEARCH_DIRS=$(bun -e "
        const c = await Bun.file('$CONFIG_FILE').json().catch(() => ({}));
        const dirs = c.projectDirs ?? [];
        console.log(dirs.map(d => d.replace('~', process.env.HOME)).join('\n'));
    " 2>/dev/null)
fi
if [ -z "$SEARCH_DIRS" ]; then
    SEARCH_DIRS=$(printf "%s\n%s\n%s\n%s\n%s" \
        "$HOME/Code" "$HOME/Projects" "$HOME/src" "$HOME/work" "$HOME/dev")
fi

# Build project list: find directories with .git (dir or file — worktrees use a file)
# Search common code directories, limit depth for speed
PROJECT_DIRS=$(echo "$SEARCH_DIRS" | xargs -I{} find "{}" \
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

# ─── Step 1.5: Detect wtm bare repo ──────────────────────────────────

# Check if this is a bare repo (wtm-managed) and wtm is available
IS_BARE=false
WTM_ENABLED=$(bun -e "
    const c = await Bun.file('$CONFIG_FILE').json().catch(() => ({}));
    console.log(c.wtmIntegration ?? true);
" 2>/dev/null || echo "true")
if [ "$WTM_ENABLED" = "true" ] && command -v wtm &>/dev/null && [ -f "$WORK_DIR/.git/config" ]; then
    if git --git-dir="$WORK_DIR/.git" config --get core.bare 2>/dev/null | grep -q "true"; then
        IS_BARE=true
    fi
fi

if [ "$IS_BARE" = true ]; then
    # ─── wtm flow: create worktree or pick existing ───────────────

    # List existing worktrees (non-bare)
    EXISTING=$(git --git-dir="$WORK_DIR/.git" worktree list --porcelain 2>/dev/null \
        | grep "^branch " \
        | sed 's|branch refs/heads/||' \
        | sort)

    # Detect default branch
    DEFAULT_BRANCH=""
    for b in main master develop; do
        if git --git-dir="$WORK_DIR/.git" rev-parse --verify "refs/remotes/origin/$b" &>/dev/null; then
            DEFAULT_BRANCH="$b"
            break
        fi
    done

    # Build options: existing worktrees + "new worktree" option
    OPTIONS=""
    if [ -n "$EXISTING" ]; then
        OPTIONS=$(echo "$EXISTING" | sed 's/^/  /')
    fi
    OPTIONS=$(printf "+ new worktree\n%s" "$OPTIONS" | grep -v '^$')

    PROJECT_NAME=$(basename "$WORK_DIR")
    CHOICE=$(echo "$OPTIONS" | fzf \
        --height=100% \
        --layout=reverse \
        --border=rounded \
        --border-label=" $PROJECT_NAME — Worktree " \
        --header="Pick a worktree or create a new one" \
        --header-first \
        --prompt="Branch: " \
        --pointer="▸" \
        --color="$FZF_COLORS")

    [ -z "$CHOICE" ] && exit 0

    if [ "$CHOICE" = "+ new worktree" ]; then
        # ─── New worktree: pick base branch, then name ────────────

        # List remote branches for base selection
        REMOTE_BRANCHES=$(git --git-dir="$WORK_DIR/.git" for-each-ref \
            --format='%(refname:short)' refs/remotes/origin/ 2>/dev/null \
            | sed 's|^origin/||' \
            | grep -v '^HEAD$' \
            | sort)

        BASE_BRANCH=$(echo "$REMOTE_BRANCHES" | fzf \
            --height=100% \
            --layout=reverse \
            --border=rounded \
            --border-label=" $PROJECT_NAME — Base Branch " \
            --header="Branch to create worktree from" \
            --header-first \
            --prompt="From: " \
            --pointer="▸" \
            --query="$DEFAULT_BRANCH" \
            --color="$FZF_COLORS")

        [ -z "$BASE_BRANCH" ] && exit 0

        # Prompt for worktree/branch name
        WORKTREE_NAME=$(echo "" | fzf --print-query \
            --height=100% \
            --layout=reverse \
            --border=rounded \
            --border-label=" $PROJECT_NAME — Branch Name " \
            --header="From: $BASE_BRANCH" \
            --header-first \
            --prompt="Name: " \
            --pointer="" \
            --no-info \
            --color="$FZF_COLORS" \
            | head -1)

        [ -z "$WORKTREE_NAME" ] && exit 0

        # Create session in bare repo dir, split into two panes
        WORKTREE_PATH="$WORK_DIR/$WORKTREE_NAME"
        PARENT_CLIENT=$(tmux display-message -p '#{client_name}' 2>/dev/null)
        # Left pane: run wtm create (fetch, hooks visible here)
        tmux new-session -d -s "$WORKTREE_NAME" -c "$WORK_DIR" \
            "wtm create $WORKTREE_NAME --from $BASE_BRANCH --no-shell; cd $WORKTREE_NAME; exec \$SHELL"
        # Right pane: wait for worktree, then open shell
        tmux split-window -h -d -t "$WORKTREE_NAME" -c "$WORK_DIR" \
            "while [ ! -d '$WORKTREE_PATH' ]; do sleep 0.2; done; cd '$WORKTREE_PATH' && exec \$SHELL"
        # Switch to the session (focus on left pane)
        tmux select-pane -t "$WORKTREE_NAME.0"
        tmux switch-client -c "$PARENT_CLIENT" -t "$WORKTREE_NAME"
        exit 0
    else
        # Existing worktree selected — find its path
        BRANCH_NAME=$(echo "$CHOICE" | sed 's/^  //')
        WORKTREE_PATH=$(git --git-dir="$WORK_DIR/.git" worktree list --porcelain 2>/dev/null \
            | awk -v branch="$BRANCH_NAME" '
                /^worktree / { path = substr($0, 10) }
                /^branch / { b = $0; sub(/branch refs\/heads\//, "", b); if (b == branch) print path }
            ')

        if [ -z "$WORKTREE_PATH" ]; then
            echo "Could not find worktree path for $BRANCH_NAME"
            sleep 2
            exit 1
        fi

        WORK_DIR="$WORKTREE_PATH"
        SESSION_NAME="$BRANCH_NAME"
    fi
else
    # ─── Standard flow: just pick a name ──────────────────────────

    # Default session name to directory basename
    DEFAULT_NAME=$(basename "$WORK_DIR")

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
fi

# ─── Create session ───────────────────────────────────────────────────

PARENT_CLIENT=$(tmux display-message -p '#{client_name}' 2>/dev/null)
tmux new-session -d -s "$SESSION_NAME" -c "$WORK_DIR"
tmux switch-client -c "$PARENT_CLIENT" -t "$SESSION_NAME"
