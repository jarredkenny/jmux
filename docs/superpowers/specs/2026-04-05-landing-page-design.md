# jmux Landing Page — Design Spec

**Date:** 2026-04-05
**Approach:** The Manifesto — sharp, opinionated, terminal-native aesthetic
**Audience:** Software engineers and technical users running coding agents in parallel
**Deployment:** Digital Ocean Apps, static site

---

## Tech Stack

- **Plain HTML + Tailwind CSS** (CDN or standalone CLI)
- **shadcn-inspired aesthetic** — dark theme, tight spacing, clean typography
- No JavaScript framework. No build step beyond Tailwind compilation.
- Zero dependencies in production — fits the "we don't need 100MB" ethos

## Visual Identity

- **Background:** Midnight Slate (#171b26) — blue-gray undertone, code editor at night
- **Surface/cards:** #111520 with #252b3a borders
- **Accent:** Green (#4ade80) — used for eyebrow text, prompt characters, CTAs, the "yours" ecosystem card
- **Text:** White (#fff / #e4e4e7) for primary, muted gray (#a1a1aa / #71717a) for secondary, dim (#52525b) for tertiary
- **Typography:** System sans-serif for body, monospace for code, install commands, tool names, and eyebrow labels
- **Icons:** Text characters only (▎ ⚡ ! ⌨) — no icon library

## Page Structure

### 1. Navigation

Minimal top bar:
- Left: `jmux` wordmark (monospace, bold) + version badge (green, monospace, e.g. `v0.4.0`)
- Right: Docs, Ecosystem (text links, muted), Install (green button)

### 2. Hero

- **Eyebrow:** "PARALLEL DEVELOPMENT ENVIRONMENT" — monospace, green, uppercase, letterspaced
- **Headline:** "Run 10 coding agents at once. See all of them." — large (≈46px), bold, white. Second line in muted gray.
- **Subheadline:** "jmux gives you a persistent overview of every agent session — what's running, what's finished, and what needs your attention. No Electron. No lock-in. Just your terminal."
- **Install command:** Inline code block with green `$` prompt, copy-to-clipboard button
  ```
  $ bun install -g @jx0/jmux
  ```
- **Hero image:** `hero.png` screenshot below the install command, in a rounded card with border. Shows sidebar with grouped sessions and agents running.

### 3. Comparison Table

- **Eyebrow:** "THE DIFFERENCE" — green, uppercase
- **Section headline:** "Run 10 agents in parallel. Without 10 tabs of Electron."  — second line muted gray
- **Table:** 6 rows, 3 columns (label, jmux, GUI Orchestrators)
  - Size: ~0.3 MB vs 100+ MB
  - Platform: Anywhere tmux runs vs macOS only
  - Editor: Yours vs Built-in
  - Agents: Any vs Bundled subset
  - Lock-in: None — it's tmux vs Proprietary
  - Cost: Free, forever vs *Free today* (italicized)
- **Styling:** jmux column in white, competitor column in muted gray. No specific competitor names.

### 4. Features

- **Eyebrow:** "BUILT FOR THE WORKFLOW" — green, uppercase
- **Section headline:** "Everything visible. Nothing in your way."
- **2x2 grid** of feature cards on #111520 surface:

| Feature | Icon | Headline | Copy |
|---------|------|----------|------|
| Session Sidebar | ▎ | Session Sidebar | Every session at a glance — name, branch, status. Green dot for activity, orange flag when an agent needs review. Sessions auto-group by project. |
| Instant Switching | ⚡ | Instant Switching | Ctrl-Shift-Up/Down. No prefix, no menu, no mode. Or click the sidebar. Indicators clear only when you actually interact. |
| Attention Flags | ! | Attention Flags | When Claude Code finishes a response, the orange ! appears. Switch to it, review the work, move on. One command to install hooks for any agent. |
| BYOE | ⌨ | Bring Your Own Everything | Works with your ~/.tmux.conf. Your plugins, your prefix key, your bindings. jmux doesn't replace your tools — it organizes them. |

### 5. Ecosystem

- **Eyebrow:** "ECOSYSTEM" — green, uppercase
- **Section headline:** "Your tools. Organized."
- **3x2 grid** of tool cards:

| Tool | Subtitle | Copy |
|------|----------|------|
| wtm | Git worktree manager | One worktree per agent, one session per branch. Parallel agents on parallel branches. |
| Claude Code | AI coding agent | Built-in attention flag support. Know the moment Claude finishes without watching every pane. |
| lazygit | Terminal Git UI | Run it in a jmux pane alongside your agent. Full Git workflow without leaving the terminal. |
| gh / glab | GitHub & GitLab CLIs | PRs, issues, reviews. Everything stays in the terminal where you're already working. |
| Codex / aider | Any coding agent | If it runs in a terminal, it works in jmux. Attention hooks for anything that can trigger a shell command. |
| yours | Whatever you use | vim, emacs, VS Code, your shell, your scripts. jmux doesn't care. It's tmux underneath. |

- The "yours" card uses a dashed border and green text to signal extensibility.

### 6. Install CTA

- **Headline:** "Two commands. You're in." — large, bold, white
- **Requirements:** "Requires Bun 1.2+, tmux 3.2+, and fzf." — small, muted, above the install block
- **Install block:** Two-line code block on #111520 surface
  ```
  $ bun install -g @jx0/jmux
  $ jmux
  ```
- **Parting shot:** "~0.3 MB. Installs in under a second." — small, dim

### 7. Footer

Single line:
- Left: `jmux` wordmark + "MIT License"
- Right: GitHub, npm, Docs links

---

## File Structure

```
site/
  index.html          — single page, all sections
  styles/
    output.css        — compiled Tailwind output
    tailwind.config.js — if using Tailwind CLI
  assets/
    hero.png          — hero screenshot (from docs/screenshots/hero.png)
```

## Responsive Behavior

- **Desktop (>768px):** Full layout as described — 2x2 feature grid, 3x2 ecosystem grid, centered comparison table
- **Mobile (<768px):** Single column stack. Feature cards and ecosystem cards go 1-wide. Comparison table scrolls horizontally or stacks. Nav collapses to logo + hamburger or just logo + Install button.

## Future Upgrades (out of scope for v1)

- Animated terminal recording replacing the static hero screenshot
- Smooth scroll anchoring from nav links
- Analytics (if desired)
