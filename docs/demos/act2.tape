# Act 2 — the ticket, beside the work.
# See _common.md for the shared preamble and framing rules.

Output act2.mp4

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
Sleep 4s
# Open the panel in the preamble, where a swallowed keystroke can be given time
# rather than filmed. `Ctrl-a g` is not reliable once a pane has an interactive
# widget up — an agent asking a multiple-choice question ate it outright — so it
# is never the on-camera beat.
Ctrl+a
Type "p"
Sleep 1200ms
Type "auth"
Sleep 1200ms
Enter
Sleep 3s
Ctrl+a
Type "g"
Sleep 4s
Show

# The agent's diff, with the ticket beside it.
Sleep 5s

# Switch sessions. The whole main area repaints and the panel follows — motion
# this act can rely on, because it comes from jmux rather than from whatever an
# agent happens to be doing.
Ctrl+a
Type "p"
Sleep 1200ms
Type "chart"
Sleep 1200ms
Enter
Sleep 7s
