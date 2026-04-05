# jmux Landing Page Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a static landing page for jmux — sharp, opinionated, terminal-native dark aesthetic that positions jmux as a parallel development environment for agent-driven development.

**Architecture:** Single HTML file with Tailwind CSS (CDN). No build step, no JS framework. One small inline script for copy-to-clipboard on the install command. Hero screenshot copied from existing `docs/screenshots/hero.png`.

**Tech Stack:** HTML, Tailwind CSS (CDN via `<script src="https://cdn.tailwindcss.com">`), inline Tailwind config for custom colors.

**Spec:** `docs/superpowers/specs/2026-04-05-landing-page-design.md`

---

## File Structure

```
site/
  index.html     — single-page landing site, all sections, Tailwind via CDN
  assets/
    hero.png     — hero screenshot (copied from docs/screenshots/hero.png)
```

No build step. Tailwind CDN with an inline `tailwind.config` block handles custom colors. For production optimization later, swap CDN for Tailwind CLI and a compiled `output.css`.

---

### Task 1: Project Scaffolding

**Files:**
- Create: `site/index.html`
- Create: `site/assets/` (directory)
- Copy: `docs/screenshots/hero.png` → `site/assets/hero.png`

- [ ] **Step 1: Create the site directory and copy the hero image**

```bash
mkdir -p site/assets
cp docs/screenshots/hero.png site/assets/hero.png
```

- [ ] **Step 2: Create the HTML skeleton with Tailwind CDN and custom config**

Create `site/index.html`:

```html
<!DOCTYPE html>
<html lang="en" class="scroll-smooth">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>jmux — Parallel development environment for agent-driven development</title>
  <meta name="description" content="Run 10 coding agents at once. See all of them. A persistent sidebar shows every session, what's running, and what needs your attention — without leaving tmux.">
  <meta property="og:title" content="jmux — Parallel development environment">
  <meta property="og:description" content="Run 10 coding agents at once. See all of them. No Electron. No lock-in. Just your terminal.">
  <meta property="og:type" content="website">
  <script src="https://cdn.tailwindcss.com"></script>
  <script>
    tailwind.config = {
      theme: {
        extend: {
          colors: {
            base: '#171b26',
            surface: '#111520',
            border: '#252b3a',
            accent: '#4ade80',
            'text-primary': '#ffffff',
            'text-secondary': '#a1a1aa',
            'text-muted': '#71717a',
            'text-dim': '#52525b',
          },
          fontFamily: {
            mono: ['ui-monospace', 'SFMono-Regular', 'Menlo', 'Monaco', 'Consolas', 'monospace'],
          },
        },
      },
    }
  </script>
  <style type="text/tailwindcss">
    @layer base {
      body {
        @apply bg-base text-text-primary antialiased;
      }
    }
  </style>
</head>
<body>

  <!-- Sections will be added in subsequent tasks -->

</body>
</html>
```

- [ ] **Step 3: Verify it loads**

Open `site/index.html` in a browser. Should see a blank Midnight Slate (#171b26) page with no console errors. The Tailwind CDN script should load without issues.

- [ ] **Step 4: Commit**

```bash
git add site/
git commit -m "feat(site): scaffold landing page with Tailwind CDN and custom theme"
```

---

### Task 2: Navigation Bar

**Files:**
- Modify: `site/index.html`

- [ ] **Step 1: Add the navigation bar**

Replace the `<!-- Sections will be added in subsequent tasks -->` comment in `site/index.html` with:

```html
  <!-- Navigation -->
  <nav class="flex items-center justify-between px-6 md:px-12 py-4 border-b border-border">
    <div class="flex items-center gap-2">
      <span class="font-mono text-lg font-bold tracking-tight">jmux</span>
      <span class="text-xs font-mono text-accent bg-accent/10 px-1.5 py-0.5 rounded">v0.4.0</span>
    </div>
    <div class="flex items-center gap-6 text-sm">
      <a href="https://github.com/jarredkenny/jmux#readme" class="text-text-muted hover:text-text-secondary transition-colors hidden sm:block">Docs</a>
      <a href="#ecosystem" class="text-text-muted hover:text-text-secondary transition-colors hidden sm:block">Ecosystem</a>
      <a href="#install" class="text-xs font-medium bg-accent text-[#171b26] px-3.5 py-1.5 rounded-md hover:bg-accent/90 transition-colors">Install</a>
    </div>
  </nav>
```

- [ ] **Step 2: Verify**

Open `site/index.html` in a browser. Should see a minimal nav bar at the top: `jmux` wordmark with green version badge on the left, Docs/Ecosystem links and green Install button on the right. On narrow viewports (<640px), Docs and Ecosystem should hide, leaving just the Install button.

- [ ] **Step 3: Commit**

```bash
git add site/index.html
git commit -m "feat(site): add navigation bar"
```

---

### Task 3: Hero Section

**Files:**
- Modify: `site/index.html`

- [ ] **Step 1: Add the hero section after the nav**

Insert after the closing `</nav>` tag:

```html
  <!-- Hero -->
  <section class="text-center px-6 md:px-12 pt-20 md:pt-28 pb-10">
    <p class="font-mono text-xs md:text-sm text-accent tracking-[0.2em] uppercase mb-4">Parallel Development Environment</p>
    <h1 class="text-3xl md:text-5xl font-extrabold leading-tight max-w-2xl mx-auto mb-6 tracking-tight">
      Run 10 coding agents at once.<br>
      <span class="text-text-muted">See all of them.</span>
    </h1>
    <p class="text-base md:text-lg text-text-secondary max-w-xl mx-auto mb-9 leading-relaxed">
      jmux gives you a persistent overview of every agent session — what's running,
      what's finished, and what needs your attention. No Electron. No lock-in. Just your terminal.
    </p>

    <!-- Install command -->
    <div class="inline-flex items-center gap-3 bg-surface border border-border rounded-lg px-5 py-3 font-mono text-sm">
      <span class="text-accent">$</span>
      <span class="text-text-primary" id="install-cmd">bun install -g @jx0/jmux</span>
      <button onclick="navigator.clipboard.writeText('bun install -g @jx0/jmux');this.textContent='✓';setTimeout(()=>this.textContent='⧉',1500)" class="text-text-dim hover:text-text-secondary transition-colors ml-2 cursor-pointer" title="Copy to clipboard">⧉</button>
    </div>
  </section>

  <!-- Hero Screenshot -->
  <section class="px-6 md:px-12 pb-16 md:pb-24">
    <div class="max-w-4xl mx-auto">
      <img src="assets/hero.png" alt="jmux sidebar with grouped sessions alongside vim and Claude Code" class="w-full rounded-xl border border-border shadow-2xl shadow-black/50">
    </div>
  </section>
```

- [ ] **Step 2: Verify**

Open in browser. Should see:
- Green uppercase eyebrow "PARALLEL DEVELOPMENT ENVIRONMENT"
- Large headline with "See all of them." in muted gray
- Subheadline paragraph
- Inline install command with a copy button (click it — should copy to clipboard and show ✓ briefly)
- Hero screenshot below in a rounded card with border and shadow

- [ ] **Step 3: Commit**

```bash
git add site/index.html
git commit -m "feat(site): add hero section with install command and screenshot"
```

---

### Task 4: Comparison Table Section

**Files:**
- Modify: `site/index.html`

- [ ] **Step 1: Add the comparison table section after the hero screenshot section**

Insert after the hero screenshot `</section>` closing tag:

```html
  <!-- Comparison -->
  <section class="px-6 md:px-12 py-16 md:py-24 border-t border-border">
    <div class="text-center mb-10">
      <p class="font-mono text-xs text-accent tracking-[0.2em] uppercase mb-2">The Difference</p>
      <h2 class="text-2xl md:text-3xl font-bold tracking-tight">
        Run 10 agents in parallel.<br>
        <span class="text-text-muted">Without 10 tabs of Electron.</span>
      </h2>
    </div>

    <div class="max-w-2xl mx-auto overflow-x-auto">
      <table class="w-full text-sm">
        <thead>
          <tr class="border-b border-border">
            <th class="text-left py-3 px-4 text-text-dim font-medium w-1/4"></th>
            <th class="text-left py-3 px-4 text-accent font-semibold font-mono">jmux</th>
            <th class="text-left py-3 px-4 text-text-dim font-medium">GUI Orchestrators</th>
          </tr>
        </thead>
        <tbody class="text-sm">
          <tr class="border-b border-border/50">
            <td class="py-3 px-4 text-text-muted">Size</td>
            <td class="py-3 px-4 text-text-primary font-mono">~0.3 MB</td>
            <td class="py-3 px-4 text-text-muted">100+ MB</td>
          </tr>
          <tr class="border-b border-border/50">
            <td class="py-3 px-4 text-text-muted">Platform</td>
            <td class="py-3 px-4 text-text-primary">Anywhere tmux runs</td>
            <td class="py-3 px-4 text-text-muted">macOS only</td>
          </tr>
          <tr class="border-b border-border/50">
            <td class="py-3 px-4 text-text-muted">Editor</td>
            <td class="py-3 px-4 text-text-primary">Yours</td>
            <td class="py-3 px-4 text-text-muted">Built-in</td>
          </tr>
          <tr class="border-b border-border/50">
            <td class="py-3 px-4 text-text-muted">Agents</td>
            <td class="py-3 px-4 text-text-primary">Any</td>
            <td class="py-3 px-4 text-text-muted">Bundled subset</td>
          </tr>
          <tr class="border-b border-border/50">
            <td class="py-3 px-4 text-text-muted">Lock-in</td>
            <td class="py-3 px-4 text-text-primary">None — it's tmux</td>
            <td class="py-3 px-4 text-text-muted">Proprietary</td>
          </tr>
          <tr>
            <td class="py-3 px-4 text-text-muted">Cost</td>
            <td class="py-3 px-4 text-text-primary">Free, forever</td>
            <td class="py-3 px-4 text-text-muted italic">Free today</td>
          </tr>
        </tbody>
      </table>
    </div>
  </section>
```

- [ ] **Step 2: Verify**

Open in browser. Should see a comparison table centered below the hero. jmux column in white, competitor column in muted gray. "Free today" should be italicized. Table should scroll horizontally on very narrow viewports.

- [ ] **Step 3: Commit**

```bash
git add site/index.html
git commit -m "feat(site): add comparison table section"
```

---

### Task 5: Features Section

**Files:**
- Modify: `site/index.html`

- [ ] **Step 1: Add the features section after the comparison section**

Insert after the comparison `</section>` closing tag:

```html
  <!-- Features -->
  <section class="px-6 md:px-12 py-16 md:py-24 border-t border-border">
    <div class="text-center mb-10">
      <p class="font-mono text-xs text-accent tracking-[0.2em] uppercase mb-2">Built for the Workflow</p>
      <h2 class="text-2xl md:text-3xl font-bold tracking-tight">Everything visible. Nothing in your way.</h2>
    </div>

    <div class="grid grid-cols-1 md:grid-cols-2 gap-5 max-w-3xl mx-auto">

      <div class="bg-surface border border-border rounded-xl p-6">
        <div class="text-2xl mb-3 text-accent">▎</div>
        <h3 class="text-base font-semibold mb-2">Session Sidebar</h3>
        <p class="text-sm text-text-secondary leading-relaxed">Every session at a glance — name, branch, status. Green dot for activity, orange flag when an agent needs review. Sessions auto-group by project.</p>
      </div>

      <div class="bg-surface border border-border rounded-xl p-6">
        <div class="text-2xl mb-3">⚡</div>
        <h3 class="text-base font-semibold mb-2">Instant Switching</h3>
        <p class="text-sm text-text-secondary leading-relaxed">Ctrl-Shift-Up/Down. No prefix, no menu, no mode. Or click the sidebar. Indicators clear only when you actually interact.</p>
      </div>

      <div class="bg-surface border border-border rounded-xl p-6">
        <div class="text-2xl mb-3 text-amber-400">!</div>
        <h3 class="text-base font-semibold mb-2">Attention Flags</h3>
        <p class="text-sm text-text-secondary leading-relaxed">When Claude Code finishes a response, the orange <span class="text-amber-400">!</span> appears. Switch to it, review the work, move on. One command to install hooks for any agent.</p>
      </div>

      <div class="bg-surface border border-border rounded-xl p-6">
        <div class="text-2xl mb-3">⌨</div>
        <h3 class="text-base font-semibold mb-2">Bring Your Own Everything</h3>
        <p class="text-sm text-text-secondary leading-relaxed">Works with your ~/.tmux.conf. Your plugins, your prefix key, your bindings. jmux doesn't replace your tools — it organizes them.</p>
      </div>

    </div>
  </section>
```

- [ ] **Step 2: Verify**

Open in browser. Should see a 2x2 grid of feature cards on desktop, stacking to single column on mobile. Each card has a text icon, headline, and short description. The sidebar icon (▎) should be green, the attention flag (!) should be amber/orange.

- [ ] **Step 3: Commit**

```bash
git add site/index.html
git commit -m "feat(site): add features section with 2x2 grid"
```

---

### Task 6: Ecosystem Section

**Files:**
- Modify: `site/index.html`

- [ ] **Step 1: Add the ecosystem section after the features section**

Insert after the features `</section>` closing tag:

```html
  <!-- Ecosystem -->
  <section id="ecosystem" class="px-6 md:px-12 py-16 md:py-24 border-t border-border">
    <div class="text-center mb-10">
      <p class="font-mono text-xs text-accent tracking-[0.2em] uppercase mb-2">Ecosystem</p>
      <h2 class="text-2xl md:text-3xl font-bold tracking-tight">Your tools. Organized.</h2>
    </div>

    <div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4 max-w-3xl mx-auto">

      <div class="bg-surface border border-border rounded-xl p-5 text-center">
        <div class="font-mono text-lg font-bold mb-1">wtm</div>
        <p class="text-xs text-text-muted mb-2">Git worktree manager</p>
        <p class="text-xs text-text-secondary leading-relaxed">One worktree per agent, one session per branch. Parallel agents on parallel branches.</p>
      </div>

      <div class="bg-surface border border-border rounded-xl p-5 text-center">
        <div class="font-mono text-lg font-bold mb-1">Claude Code</div>
        <p class="text-xs text-text-muted mb-2">AI coding agent</p>
        <p class="text-xs text-text-secondary leading-relaxed">Built-in attention flag support. Know the moment Claude finishes without watching every pane.</p>
      </div>

      <div class="bg-surface border border-border rounded-xl p-5 text-center">
        <div class="font-mono text-lg font-bold mb-1">lazygit</div>
        <p class="text-xs text-text-muted mb-2">Terminal Git UI</p>
        <p class="text-xs text-text-secondary leading-relaxed">Run it in a jmux pane alongside your agent. Full Git workflow without leaving the terminal.</p>
      </div>

      <div class="bg-surface border border-border rounded-xl p-5 text-center">
        <div class="font-mono text-lg font-bold mb-1">gh / glab</div>
        <p class="text-xs text-text-muted mb-2">GitHub &amp; GitLab CLIs</p>
        <p class="text-xs text-text-secondary leading-relaxed">PRs, issues, reviews. Everything stays in the terminal where you're already working.</p>
      </div>

      <div class="bg-surface border border-border rounded-xl p-5 text-center">
        <div class="font-mono text-lg font-bold mb-1">Codex / aider</div>
        <p class="text-xs text-text-muted mb-2">Any coding agent</p>
        <p class="text-xs text-text-secondary leading-relaxed">If it runs in a terminal, it works in jmux. Attention hooks for anything that can trigger a shell command.</p>
      </div>

      <div class="border border-dashed border-border rounded-xl p-5 text-center">
        <div class="font-mono text-lg font-bold mb-1 text-accent">yours</div>
        <p class="text-xs text-text-muted mb-2">Whatever you use</p>
        <p class="text-xs text-text-secondary leading-relaxed">vim, emacs, VS Code, your shell, your scripts. jmux doesn't care. It's tmux underneath.</p>
      </div>

    </div>
  </section>
```

- [ ] **Step 2: Verify**

Open in browser. Should see a 3x2 grid on desktop (3 columns), 2-wide on tablet, single column on mobile. The last card ("yours") should have a dashed border and green title text. All other cards have solid borders and white titles. The `id="ecosystem"` anchor should work with the nav link.

- [ ] **Step 3: Commit**

```bash
git add site/index.html
git commit -m "feat(site): add ecosystem section with 3x2 grid"
```

---

### Task 7: Install CTA and Footer

**Files:**
- Modify: `site/index.html`

- [ ] **Step 1: Add the install CTA and footer after the ecosystem section**

Insert after the ecosystem `</section>` closing tag:

```html
  <!-- Install CTA -->
  <section id="install" class="px-6 md:px-12 py-16 md:py-24 border-t border-border text-center">
    <h2 class="text-2xl md:text-4xl font-extrabold tracking-tight mb-3">Two commands. You're in.</h2>
    <p class="text-sm text-text-muted mb-8">Requires Bun 1.2+, tmux 3.2+, and fzf.</p>

    <div class="max-w-sm mx-auto bg-surface border border-border rounded-xl px-6 py-5 font-mono text-sm text-left">
      <div class="mb-2">
        <span class="text-accent">$</span>
        <span class="text-text-primary"> bun install -g @jx0/jmux</span>
      </div>
      <div>
        <span class="text-accent">$</span>
        <span class="text-text-primary"> jmux</span>
      </div>
    </div>

    <p class="text-xs text-text-dim mt-5">~0.3 MB. Installs in under a second.</p>
  </section>

  <!-- Footer -->
  <footer class="border-t border-border px-6 md:px-12 py-6 flex items-center justify-between text-sm">
    <div class="flex items-center gap-2">
      <span class="font-mono text-sm font-bold">jmux</span>
      <span class="text-text-dim text-xs">MIT License</span>
    </div>
    <div class="flex items-center gap-5">
      <a href="https://github.com/jarredkenny/jmux" class="text-text-muted hover:text-text-secondary transition-colors">GitHub</a>
      <a href="https://www.npmjs.com/package/@jx0/jmux" class="text-text-muted hover:text-text-secondary transition-colors">npm</a>
      <a href="https://github.com/jarredkenny/jmux#readme" class="text-text-muted hover:text-text-secondary transition-colors">Docs</a>
    </div>
  </footer>
```

- [ ] **Step 2: Verify**

Open in browser. Should see:
- "Two commands. You're in." headline centered
- Requirements line in muted text
- Two-line install block in a card
- "~0.3 MB" parting shot below
- Minimal footer with logo, MIT License, and three links
- The `id="install"` anchor should work with the nav Install button

- [ ] **Step 3: Commit**

```bash
git add site/index.html
git commit -m "feat(site): add install CTA and footer"
```

---

### Task 8: Polish and Final Verification

**Files:**
- Modify: `site/index.html` (if needed)
- Modify: `.gitignore` (add `.superpowers/`)

- [ ] **Step 1: Add .superpowers to .gitignore**

Check if `.gitignore` exists and whether `.superpowers/` is already in it. If not, append:

```
.superpowers/
```

- [ ] **Step 2: Full page visual review**

Open `site/index.html` in a browser and scroll through the entire page. Check:
- Nav: logo + badge left, links + button right. Links hide on mobile.
- Hero: eyebrow → headline → subhead → install command → screenshot. All centered.
- Comparison: table readable, jmux column white, competitor column muted. "Free today" italic.
- Features: 2x2 grid on desktop, 1-col on mobile. Icons visible, cards evenly spaced.
- Ecosystem: 3x2 grid on desktop, stacks on mobile. "yours" card dashed with green text.
- CTA: centered headline + install block + parting shot.
- Footer: single line, logo left, links right.
- Smooth scroll from nav links to `#ecosystem` and `#install` anchors works.

- [ ] **Step 3: Test on a narrow viewport**

Resize browser to ~375px width (mobile). Verify:
- Nav collapses to logo + Install button only
- All grids go single-column
- Table scrolls horizontally if needed
- Text sizes are readable
- No horizontal overflow on the page body

- [ ] **Step 4: Commit any polish fixes**

```bash
git add -A site/ .gitignore
git commit -m "feat(site): polish and responsive verification"
```

---

## Completion Checklist

After all tasks, verify these spec requirements are met:

- [ ] Midnight Slate (#171b26) background throughout
- [ ] Surface cards use #111520 with #252b3a borders
- [ ] Green accent (#4ade80) on eyebrows, prompts, CTAs, "yours" card
- [ ] Text hierarchy: white primary → #a1a1aa secondary → #71717a muted → #52525b dim
- [ ] Monospace for: code, install commands, tool names, eyebrow labels, version badge
- [ ] System sans-serif for body text
- [ ] Text character icons only (▎ ⚡ ! ⌨), no icon library
- [ ] Copy-to-clipboard on hero install command works
- [ ] Hero screenshot loads from `site/assets/hero.png`
- [ ] Nav links anchor to `#ecosystem` and `#install` sections
- [ ] Responsive: single-column stacking on mobile, grids on desktop
- [ ] No JS framework, no build step, Tailwind via CDN
- [ ] `site/` directory is self-contained and deployable as a static site
