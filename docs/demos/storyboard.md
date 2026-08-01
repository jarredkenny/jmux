# jmux demo video — storyboard

Production document for the walkthrough and the README loops.

**As built:** six shots cut from three recorded acts, ~24.6 seconds at 50fps, no
captions, no end card, looping. The video is flat — every tilt and push happens
on the page in CSS, driven from `hero-camera.json`.

It *is* the hero. The rotating stack of stills it replaced showed four
screenshots of the product; this shows the product, running, at ~730 CSS px —
wide enough that the panes read as real work rather than as texture. The README
loops still carry the close-ups. The tapes record the raw acts; `render/src/Film.tsx` is the cut. This
file is the argument behind both.

Footage comes from the three tapes here, run against `jmux --demo --live`, so a
retake is `./build.sh --record` rather than a recording session. Each tape hides
a ~55s warm-up while real agents reach a filmable state, then records.

Because the agents are live, no two takes match. Shots are therefore composed to
survive that — they hold on *states* the fleet reliably reaches (something
running, something waiting, something done), never on a particular agent saying
a particular thing.

## The pitch, in one line

Kicking off five agents is easy. Keeping track of them is the hard part.

Everything below serves that sentence. Act 1 states the problem and shows the
answer; Act 2 shows the loop that fills the fleet; Act 3 shows you bending it to
how you actually work.

## Format

| | Walkthrough | Loops |
| --- | --- | --- |
| Where | the hero, `site/index.html` | README feature sections |
| Length | ~24.6s, looping | 5–9s each |
| Audio | none. No captions either — see below | none |
| Output | `hero.mp4` + `hero-camera.json` | `fleet.gif`, `ticket.gif`, `flow.gif` |

## The cut

Seven shots. The order builds understanding without a word: many agents at once
→ one agent up close → where the work comes from → how you bend it to your own
process → what that does to your sidebar.

| # | Shot | Camera |
| --- | --- | --- |
| 1 | The Command Center grid, five agents live | arrives slanted, springs flat |
| 2 | One agent mid-edit, sidebar states beside it | push toward the sidebar |
| 3 | The agent's diff beside its ticket | leans the other way, drifts |
| 4 | Nineteen statuses on one screen | leans back on X, settles |
| 5 | Marking a status (1.8×) | slow push into the table |
| 6 | `Parked (2)`, beside a working agent | rises, springs, pushes low-left |

## Rules the cut is held to

- **Never open on a bare shell.** Every act lands on a session with a live agent
  before recording starts. An empty pane at 0:00 undoes the pitch before a word
  of it.
- **No text.** Labels over a UI demo make the product look like it needs
  explaining, and they compete with the only thing worth watching. An earlier
  cut carried five; what they were doing — pointing at the part of the screen
  that matters — the camera does instead. The end card is the one exception,
  because a demo still has to say what it is and how to get it.
- **The camera never fully stops.** Terminal content only changes when a
  character does, so a settled camera is a frozen picture — one shot measured 27
  identical frames out of 29, which is what "choppy" actually looks like. Every
  shot keeps a slow scale drift under whatever else it is doing, and `Shot`
  enforces a floor so a new shot cannot opt out by accident.
- **The composition renders at an integer multiple of the tapes' framerate.**
  25fps footage in a 30fps timeline holds every fifth frame twice; that is
  invisible on a still and reads as the whole film stuttering under a moving
  camera. 50 is exactly 2×.
- **One transition, everywhere.** Every boundary is the same slide-up. Mixing
  fades, wipes and flips made each cut announce itself differently and turned the
  film into a tour of transitions; one consistent move reads as a single camera
  travelling through screens.
- **It loops, so the opening shot cannot have an entrance.** The film ends inside
  a slide back into shot 1, which makes its first frame also its last. Shot 1
  used to arrive on a spring from a 15° slant; that left the seam measuring 13
  where a hard cut measures 15–40. The slant moved to shot 2, and the seam is now
  2.3 — indistinguishable from ordinary motion.
- **No two consecutive shots move the same way.** Seven push-ins and seven
  crossfades is one idea repeated seven times; by the third the viewer sees the
  effect rather than the product. Shots arrive slanted, lean back, drift or rise,
  and the transitions are chosen per boundary rather than defaulted.
- **Every act must move.** Two takes shipped as finished video before
  `check-motion.py` existed: a dropped prefix chord left one act as eighteen
  static seconds, and another sat on a single frame with a first-to-last
  difference of 0.03. The build now refuses footage that never changes.
- **Parking has to happen on camera.** Arriving at an already-parked sidebar
  asks for trust the footage could simply have earned.
- **No dead holds.** Boot and the agents' warm-up are hidden; nothing sits on a
  static frame longer than it takes to read.

---

## Loops

Cut from the same footage, silent and uncaptioned — the README heading above each
one supplies the context a burned-in label would only repeat.

| File | Source | Shows | Length |
| --- | --- | --- | --- |
| `fleet.gif` | Act 1 | the Command Center grid, five agents live | 8s |
| `ticket.gif` | Act 2 | the agent's diff beside the issue it came from | 9s |
| `flow.gif` | Act 3 | a status marked parked; the sidebar collapses | 8s |

## What VHS cannot drive

Verified by experiment, not assumed. These are properties of the recorder, and
they bound what the footage can contain.

- **Escape-sequence keybindings are unreachable.** VHS's manual allows modifiers
  only as `Ctrl [+Alt][+Shift]+<char>`, so `Ctrl+Shift+Down` is not expressible.
  Sending the raw bytes instead fails too: VHS feeds characters to its terminal
  one at a time, and `input-router.ts:356` matches `data === "\x1b[1;6A"` on the
  whole chunk, so a split sequence never matches — the trailing `B` leaks to the
  shell. This rules out `Ctrl-Shift-Up/Down` (session switching) and the glass
  `Shift+arrow` tile navigation.

  **Tapes use `Ctrl-a p` (command palette) to switch sessions.** This is not a
  workaround with a cost: the palette is a real feature, and a viewer can see
  what is happening, which a bare keychord doesn't convey. Captions must
  describe the palette, not a binding the footage doesn't show.

- **`Ctrl-a <key>` does work.** The soft prefix intercept survives VHS's timing —
  `Ctrl-a g`, `Ctrl-a W`, `Ctrl-a o` all confirmed.

- **No mouse.** VHS has no pointer input, so anything reachable only by click
  (dragging the sidebar border, the ghost-row click path) cannot be filmed.
  Ghost rows are still reachable by keyboard.

## Production notes

- **Terminal size**: 1600×900 (16:9), `FontSize 13`. The sidebar needs ≥26 cols
  plus main; below that jmux hides the sidebar and the video loses its subject.
- **Captions** are rendered by `captions.py`, not `drawtext` — the ffmpeg in
  common use here is built without libfreetype. See that file for the three
  typographic rules the cut is held to.
- **No kitty graphics under VHS.** VHS renders through xterm.js, which never
  answers the capability probe, so inline images stay links — jmux's designed
  fallback. The images feature therefore **cannot** be shown in these loops; it
  keeps the still screenshot in the README.
- **Live agents**: only the sessions on camera run real Claude. The rest carry
  seeded state written through the same tmux options a real agent writes.
- **Retakes**: `vhs hero.tape`. Live agents mean takes differ; the tape waits on
  screen state so it stays in sync, but expect to pick a good take.
