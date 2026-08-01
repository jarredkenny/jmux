# Act 1 — the fleet, and the grid.
#
# Opens on a session with a live agent, never on a bare shell. The first frame
# has to be the product working; an empty pane at 0:00 is the whole pitch
# undermined before a word of it.
#
# See _common.md for the shared preamble and framing rules.

Output act1.mp4

Set Shell "bash"
Set FontSize 13
Set Width 1600
Set Height 900
Set Padding 0
# 25, and the composition renders at 50 — exactly 2×. An uneven ratio (25 into
# 30) holds every fifth frame twice, which is invisible on a static shot and
# reads as the whole film stuttering under a moving camera. Changing this means
# changing FPS in render/src/Film.tsx to match.
Set Framerate 25

Hide
Type "unset TMUX JMUX; cd /Users/jarred/Code/personal/jmux; export PATH=/Users/jarred/.tools/bun/bin:$HOME/.local/bin:$PATH; clear"
Enter
Sleep 1s
Type "bun run src/main.ts --demo --live"
Enter
Sleep 58s
# Land on the agent that stopped to ask, before recording starts.
Ctrl+a
Type "p"
Sleep 1200ms
Type "auth"
Sleep 1200ms
Enter
Sleep 3s
Show

# A live agent mid-edit, its permission prompt up, and the sidebar calling the
# states beside it.
Sleep 6s

# Into the grid.
Ctrl+a
Type "p"
Sleep 1200ms
Type "Switch to Command"
Sleep 1200ms
Enter
Sleep 1200ms
Enter
Sleep 9s
