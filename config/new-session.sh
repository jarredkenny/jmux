#!/bin/bash
# jmux new session modal — multi-step fzf flow
# Called via: display-popup -E -w 60% -h 70% "config/new-session.sh"

FZF_COLORS="border:#4f565d,header:#b5bcc9,prompt:#9fe8c3,label:#9fe8c3,pointer:#9fe8c3,fg:#6b7280,fg+:#b5bcc9,hl:#fbd4b8,hl+:#fbd4b8"

# ─── Step 1: Session type ─────────────────────────────────────────────

HAS_WTM=false
if command -v wtm &>/dev/null; then
    HAS_WTM=true
fi

if [ "$HAS_WTM" = true ]; then
    SESSION_TYPE=$(printf "New session\nNew worktree session" | fzf \
        --height=100% \
        --layout=reverse \
        --border=rounded \
        --border-label=" New Session " \
        --header="What kind of session?" \
        --header-first \
        --prompt="Type: " \
        --pointer="▸" \
        --no-info \
        --color="$FZF_COLORS")

    [ -z "$SESSION_TYPE" ] && exit 0
else
    SESSION_TYPE="New session"
fi

# ─── Step 2: Session name ─────────────────────────────────────────────

SESSION_NAME=$(echo "" | fzf --print-query \
    --height=100% \
    --layout=reverse \
    --border=rounded \
    --border-label=" Session Name " \
    --header="Enter a name for the session" \
    --header-first \
    --prompt="Name: " \
    --pointer="" \
    --no-info \
    --color="$FZF_COLORS" \
    | head -1)

[ -z "$SESSION_NAME" ] && exit 0

# ─── Step 3: Working directory ─────────────────────────────────────────

if [ "$SESSION_TYPE" = "New session" ]; then
    # Build directory list from existing sessions + common roots
    DIR_LIST=$(tmux list-sessions -F '#{pane_current_path}' 2>/dev/null | sort -u)
    DIR_LIST=$(printf "%s\n%s\n%s\n%s" "$HOME" "$HOME/Code/personal" "$HOME/Code" "$DIR_LIST" | sort -u | grep -v '^$')

    WORK_DIR=$(echo "$DIR_LIST" | fzf \
        --height=100% \
        --layout=reverse \
        --border=rounded \
        --border-label=" Working Directory " \
        --header="Session: $SESSION_NAME" \
        --header-first \
        --prompt="Dir: " \
        --pointer="▸" \
        --no-info \
        --print-query \
        --color="$FZF_COLORS" \
        | tail -1)

    [ -z "$WORK_DIR" ] && exit 0

    # Expand ~ if present
    WORK_DIR="${WORK_DIR/#\~/$HOME}"

    # Create the session
    tmux new-session -d -s "$SESSION_NAME" -c "$WORK_DIR"
    tmux switch-client -t "$SESSION_NAME"
    exit 0
fi

# ─── Worktree flow ─────────────────────────────────────────────────────

if [ "$SESSION_TYPE" = "New worktree session" ]; then

    # Step 3w: Pick a wtm-managed repo
    # Find bare repos (directories containing .git as a file or bare git dirs)
    REPO_DIRS=""
    for dir in "$HOME/Code"/*/ "$HOME/Code"/*/*/; do
        if [ -f "$dir/.git" ] || [ -f "$dir/HEAD" ] && [ -d "$dir/refs" ]; then
            # It's a bare repo or has worktrees
            REPO_DIRS="$REPO_DIRS$dir\n"
        fi
    done

    # Also check common locations for wtm repos
    WTM_REPOS=$(find "$HOME/Code" -maxdepth 3 -name "HEAD" -path "*/.git/*" -o -name "HEAD" -not -path "*/.git/*" 2>/dev/null \
        | sed 's|/HEAD$||; s|/\.git$||' | sort -u | head -20)

    if [ -z "$WTM_REPOS" ]; then
        # Fallback: just list Code directories
        WTM_REPOS=$(find "$HOME/Code" -maxdepth 2 -type d -name ".git" 2>/dev/null | sed 's|/.git$||' | sort)
    fi

    REPO=$(echo "$WTM_REPOS" | fzf \
        --height=100% \
        --layout=reverse \
        --border=rounded \
        --border-label=" Select Repository " \
        --header="Creating worktree session: $SESSION_NAME" \
        --header-first \
        --prompt="Repo: " \
        --pointer="▸" \
        --no-info \
        --color="$FZF_COLORS")

    [ -z "$REPO" ] && exit 0

    # Step 4w: Pick base branch
    cd "$REPO" || exit 1

    BRANCHES=$(git branch -r --format='%(refname:short)' 2>/dev/null | sed 's|origin/||' | sort -u)
    DEFAULT_BRANCH=$(git symbolic-ref refs/remotes/origin/HEAD 2>/dev/null | sed 's|refs/remotes/origin/||')
    [ -z "$DEFAULT_BRANCH" ] && DEFAULT_BRANCH="main"

    BASE_BRANCH=$(echo "$BRANCHES" | fzf \
        --height=100% \
        --layout=reverse \
        --border=rounded \
        --border-label=" Select Base Branch " \
        --header="Repo: $(basename "$REPO") → Worktree: $SESSION_NAME" \
        --header-first \
        --prompt="Branch: " \
        --query="$DEFAULT_BRANCH" \
        --pointer="▸" \
        --color="$FZF_COLORS")

    [ -z "$BASE_BRANCH" ] && exit 0

    # Step 5w: Create worktree and session
    WORKTREE_PATH="$REPO/$SESSION_NAME"

    # Create the worktree
    wtm create --from "$BASE_BRANCH" "$SESSION_NAME" 2>/dev/null

    # Wait for worktree to exist
    for i in $(seq 1 10); do
        [ -d "$WORKTREE_PATH" ] && break
        sleep 0.5
    done

    if [ ! -d "$WORKTREE_PATH" ]; then
        echo "Failed to create worktree at $WORKTREE_PATH"
        sleep 2
        exit 1
    fi

    # Create tmux session in the worktree directory
    tmux new-session -d -s "$SESSION_NAME" -c "$WORKTREE_PATH"
    tmux switch-client -t "$SESSION_NAME"
fi
