# Website visual redesign — design

**Date:** 2026-06-08
**Scope:** `site/index.html` (single static file) — full visual + structural redesign, plus a content-accuracy pass to fix feature copy that has drifted from the current code.

## Goal

Lift the marketing site to the premium feel of herdr.dev / cursor.com / getmeasure.com — bigger type, more whitespace, real depth, and layout-level variety — while correcting feature claims that no longer match the product. This is a *redesign*, not a restyle: new layout primitives (orchestration diagram, bento grid) replace the uniform card rows.

Two decisions already locked with the user via the visual-companion mockups:

- **Identity:** dark, with a new **Cool Cyan** accent (off the old terminal green).
- **Toolchain:** stays a single static file, Tailwind via CDN, but pulls in real web fonts. **No build step, no new runtime deps.**

**Approved visual target:** `.superpowers/brainstorm/61742-1780959187/content/fullpage-v2.html` — the complete, user-approved mockup of the redesigned page (all sections, corrected copy, real screenshots). Build `site/index.html` to match it. Earlier exploration mockups in the same dir (`direction-explorer.html`, `hero-layout.html`, `fullpage-concept.html`) are superseded and kept only for history.

## Visual identity

### Color tokens (replace the current green/`surface`/`border` set in the `tailwind.config` block)

| Token | Value | Use |
|---|---|---|
| accent | `#5eead4` | cyan-mint accent (was `#4ade80`) |
| accent-deep | `#06241f` | text on accent fills |
| page | `#06080b` | outermost background, footer |
| base | `#0a0e12` | section bands |
| surface | `#0d1318` | cards, pills |
| elevated | `#0f161c` | nested/hover surfaces |
| border | `rgba(255,255,255,.07)` | hairline borders |
| border-2 | `rgba(255,255,255,.11)` | stronger borders |
| ink | `#e7e9ee` | primary text |
| ink-2 | `#9aa0ac` | secondary text |
| ink-3 | `#5a606c` | muted text |

**Functional colors are product-only.** Activity green `#34d399` and attention/waiting amber `#fbbf24` appear **only inside screenshots and the faux product/terminal mockups**, never as site chrome — this keeps the brand accent distinct from in-product status colors.

### Typography (the single biggest premium lever)

- **Inter** (400–900) for all UI/display. Tight tracking (`-0.03em` to `-0.04em`) on large headings; hero headline ~54px desktop, weight 900.
- **JetBrains Mono** (400–700) for eyebrows, the version chip, install/command pills, `kbd` chips, and code/terminal mockups.
- Loaded via Google Fonts with `<link rel="preconnect">`. Replaces today's system-font stack.

### Depth & motion

- **Delete the roaming-spotlight JS entirely** (the `requestAnimationFrame` cursor-chasing glow loop). Replace with restrained **static** radial glows: one cyan glow top-right in the hero, one faint glow behind the install CTA, one very soft glow behind the orchestration diagram.
- Keep the IntersectionObserver fade-up reveals; refine the stagger/timing.
- Wrap any non-essential motion (diagram, reveals) in `@media (prefers-reduced-motion: reduce)` guards.
- Section rhythm: hairline top-borders + alternating `page`/`base` bands.

## Page structure (top to bottom)

The marquee from the concept mock is **dropped** per user. Final order:

1. **Sticky nav** — translucent, backdrop-blur, hairline bottom border. Brand + mono version chip, subdued links (Features / Ecosystem / Docs), ghost GitHub button, solid cyan Install button.

2. **Hero — asymmetric.** Left: mono eyebrow → big Inter headline → subcopy → install pill → compact social-proof row (overlapping M/R/A avatars + ★★★★★ + "loved by terminal-native devs"). Right: `hero.png` bleeding off the right edge (rounded left corners only) over the static cyan glow. Headline: **"Replace nothing. Orchestrate everything."**

3. **Thesis + orchestration diagram.** Replaces the three flat "Why" cards with one strong visual: a hub-and-spoke diagram — **jmux** at center, wired by cyan connector lines to spokes labelled with the tool *and* its role:
   - `tmux` — your multiplexer
   - `hunk` — your diff viewer
   - `wtm` — your worktrees
   - `Claude / Codex / aider` — your agent
   - `neovim` — your editor
   - `Linear / GitHub / GitLab` — your tracker

   Heading: **"One orchestrator. Your tools stay your tools."** The three original "Why" points (better diff viewer, real worktrees, your terminal) become supporting copy beneath or within the spoke labels.

4. **Features — bento grid** (replaces the uniform 3-col card row). Five tiles in an asymmetric grid:
   - **Session Sidebar** (large 2×2 tile, `hero.png` bleeding into the corner) — every session at a glance: project group, git branch, agent state, pipeline status, linked issue/PR, and live context tokens.
   - **Agent State** (small) — see §"Content corrections"; show the three glyphs.
   - **Instant Switching** (small) — `Ctrl-Shift-Up/Down`, no prefix/menu/mode.
   - **Context & cache visibility** (wide, 2-col) — live context-token occupancy per session plus a cache-warm countdown, read straight from Claude Code's OpenTelemetry — no setup.
   - **Command Palette** (small) — `Ctrl-a p`, fuzzy-search everything.

5. **Product showcase — 3 alternating full-bleed rows** (big screenshots, generous spacing):
   - **Command Palette** (`command-palette.png`) — `Ctrl-a p`.
   - **Info Panel / Diff** (`diff-panel-split.png`, `diff-panel-full.png`) — `Ctrl-a g`, tabbed side panel powered by `hunk`; split mode while agents work, full-screen for review; `[` `]` cycle tabs.
   - **Issue & PR/MR tracking** (`linear-issues.png`, `gitlab-mrs.png`) — Linear issues + GitHub/GitLab PRs/MRs in tabbed views; select an issue and press `n` to spin a worktree, session, and agent with the issue context.

6. **Testimonials strip** — compact 3-up row preserving the existing quotes (Mouad; Ravin `@ravinwashere`; Azzeddine), verbatim. Replaces the floating hero cards.

7. **Comparison** — same data as today, recomposed as a rounded hairline card with the **jmux column highlighted** in a faint cyan wash + accent header. Cyan checks, muted crosses. (See corrected rows in §"Content corrections".)

8. **Agent Control CLI** — full-width terminal showcase band. `jmux ctl` example, recolored to cyan. **Use a current-accurate JSON shape** (see §"Content corrections").

9. **Ecosystem** — card grid including a new **GitHub** card alongside hunk, wtm, Claude Code, Linear, GitLab, lazygit, Codex/aider, and the dashed **"yours"** tile.

10. **Install CTA** — large bold heading ("Two commands. You're in."), restyled two-command block, faint glow. Requires Bun 1.3.8+ and tmux 3.2+, ~0.3 MB.

11. **Footer** — hairline, muted, refined. jmux · MIT · GitHub / npm / Docs.

## Content corrections (drift from current code — must be fixed during redesign)

Verified against `src/types.ts`, `src/sidebar.ts`, `src/session-view.ts`, `src/adapters/`, `src/cli/`.

1. **"Attention flags" → "Agent state."** The boolean attention flag is gone. The model is now three explicit states (`src/types.ts:115` — `"running" | "waiting" | "complete"`), rendered in the sidebar as:
   - **RUNNING** — `⏵` (U+23F5), green
   - **WAITING** — `!`, bold orange (the orange `!` survives, but now means *waiting*, e.g. awaiting a permission grant — not a generic "needs review")
   - **COMPLETE** — `✓` (U+2713), blue/dim

   Detection: a four-hook Claude Code block (`UserPromptSubmit`/`PermissionRequest`/`PreToolUse`/`Stop`) writes tmux user options, with OTEL `api_request`/`tool_result` hints closing the WAITING→RUNNING gap. The Features card titled "Attention Flags" becomes **"Agent State"**; the sidebar card's "orange flag when an agent needs review" becomes "agent state — running, waiting, complete."

2. **"Cache Timers" → "Context & cache visibility."** `contextTokens` replaced `costUsd`/`lastTool` on the session row (`src/session-view.ts:198`, `src/sidebar.ts`). The sidebar now shows live **context-token occupancy** (`42k`, `1.5M`) plus a unified timer that falls back cache-countdown → agent-state-elapsed → OTEL-elapsed. Copy must lead with context-token visibility and not over-promise the exact green/yellow/red cache thresholds as the only behavior.

3. **Code hosts: add GitHub.** `src/adapters/registry.ts` supports `gitlab`, `github`, and `linear`. PR/MR tracking now covers **GitHub *and* GitLab** (GitHub PR id `owner/repo#N`, `#42` glyph; GitLab `!42`). Linear remains issues-only. Every "Linear and GitLab" claim becomes **"Linear (issues) and GitHub/GitLab (PRs/MRs)."** Pipeline glyphs: `✓` passed, `⟳` running, `✗` failed, `○` pending, `—` canceled.

4. **Comparison table row edits:**
   - "Agent status & attention flags" → **"Agent run states (running / waiting / complete)."**
   - "Issue & MR tracking" → **"Issue & PR/MR tracking."**
   - "Cache cost visibility" → **"Context & cache visibility."**

5. **Agent Control CLI JSON must be accurate.** `jmux ctl session info` returns `{id, name, activity, attached, windows, path, windows_detail}` — **no `attention` field** (removed). The current site mockup's `{"name":"fix-auth","attention":true,...}` is stale. Reframe the example around accurate output, e.g. dispatch via `run-claude` (`{"session":...,"pane":"%12","command_dispatched":true}`), `session list`/`info`, and `pane capture`.

6. **New features worth surfacing** (optional, low-risk): the optional per-window **git branch row** in the toolbar (`windowBranches: true`) can get a one-line mention in the Sidebar/toolbar copy; context tokens are covered by correction #2.

Claims confirmed **still accurate** (leave as-is): version `v0.17.0`, `bun install -g @jx0/jmux`, `Ctrl-a p` palette, `Ctrl-a g` panel, `jmux ctl run-claude` example shape.

## Implementation notes

- One file: `site/index.html`. Update the inline `tailwind.config` color tokens, add the Google Fonts `<link>`, rework section markup/classes, remove the spotlight `<script>` block, keep/refine the IntersectionObserver block.
- Reuse existing assets in `site/assets/` (hero, command-palette, diff-panel-split/full, linear-issues, gitlab-mrs, cache-timers, settings, logo). No new screenshots required; an updated `cache-timers.png`/context screenshot is a nice-to-have, not a blocker.
- Keep it accessible: real `alt` text, sufficient contrast on `ink-2`/`ink-3`, `prefers-reduced-motion` honored.
- No information-architecture change beyond: hero recomposed, "Why" → diagram, features → bento, testimonials relocated to a strip, GitHub added.

## Out of scope

- No build tooling, bundler, or framework migration.
- No copywriting overhaul beyond the corrections above and tightening visibly long lines.
- No changes to product code, assets pipeline, or deployment.
