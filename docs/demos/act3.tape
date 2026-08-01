# Act 3 — your workflow, and parking.
#
# The parking beat is why this act exists, and it has to *happen* on camera:
# `space` makes a status park, and its sessions collapse into `Parked (n)` while
# the viewer is watching. Opening with them already parked asks for trust the
# footage could simply have earned.

Output act3.mp4

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
# Let the boot settle before pressing anything. Firing the prefix chord straight
# off the warm-up sleep silently did nothing, and because the rest of the tape
# is arrow keys and a space — all harmless at a shell prompt — the take still
# produced eighteen seconds of a static sidebar rather than failing.
Sleep 4s

# Open the workflow screen before recording: the transition is not interesting,
# the screen fully drawn is.
Ctrl+a
Type "W"
Sleep 4s
Show

# Five stages over nineteen tracker statuses, eleven of them mapped to nothing.
Sleep 6s

# Down into the status table: six stage rows and "+ New stage" sit above it,
# then four statuses, which is where "In Code Review" lands.
Down@180ms 10
Sleep 2s

# The beat: park it.
Space
Sleep 3s

# Out to the sidebar, where two sessions have collapsed into `Parked (2)`.
Escape
Sleep 2s

# Land on a live agent for the closing beat. Escaping the workflow screen
# returns to whichever session was current — a bare shell — and the payoff shot
# then spends three quarters of the frame on an empty pane while the one thing
# worth seeing is a single row in the sidebar.
Ctrl+a
Type "p"
Sleep 1200ms
Type "auth"
Sleep 1200ms
Enter
Sleep 7s
