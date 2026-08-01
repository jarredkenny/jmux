# Tape conventions

Every tape in this directory follows the same shape. Read this once instead of
re-deriving it from three near-identical headers.

## The hidden preamble

```
Hide
Type "unset TMUX JMUX; cd <repo>; export PATH=...; clear"
Enter
Type "bun run src/main.ts --demo --live"
Enter
Sleep <warmup>
Show
```

- **`unset TMUX JMUX`** — tapes are often authored from inside jmux. Without
  this, the demo's tmux sees itself nested and the agent hooks inherit a
  `$TMUX` pointing at the wrong server.
- **`Hide` / `Show`** — the boot and the agents' warm-up are real and slow.
  Nothing before `Show` reaches the footage, so the first visible frame is a
  settled fleet rather than forty seconds of a shell prompt.
- **The warm-up is not optional.** `--live` starts real agents; they need to
  reach a state worth filming. Too short and the sidebar is empty grey dots.

## Framing

`1600x900` at `FontSize 13` — 16:9, and wide enough for the 26-column sidebar
plus a readable main area. Narrower than about 1200px and jmux drops the
sidebar entirely (`SIDEBAR_MIN_TERM_COLS`), which removes the subject of the
video.

## What tapes may not do

See `storyboard.md` § "What VHS cannot drive". In short: no escape-sequence
keybindings (`Ctrl-Shift-Up/Down`, `Shift+arrow`) and no mouse. Session
switching goes through the command palette; panel tabs cycle with `[` / `]`.

## Retakes

Live agents make every take different. Tapes therefore hold on states rather
than on exact content, and any shot that depends on an agent having reached a
particular point is given slack rather than a tight `Sleep`. Re-running a tape
is cheap; picking a good take is the actual work.
