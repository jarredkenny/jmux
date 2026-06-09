# Website Visual Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rebuild `site/index.html` to match the approved "Cool Cyan" redesign mockup, with all feature copy corrected to current product behavior.

**Architecture:** The site stays a single static HTML file with no build step. We replace the Tailwind-CDN + system-font approach with a self-contained `<style>` block (pure CSS using the approved mockup) plus real web fonts (Inter + JetBrains Mono) from Google Fonts. The roaming-spotlight JS is removed; one IntersectionObserver reveal script remains. Production concerns from today's file (meta/OG/favicons/analytics, copy-to-clipboard buttons, real links, asset paths) are preserved.

**Tech Stack:** Static HTML5, hand-authored CSS, Google Fonts CDN, vanilla JS (IntersectionObserver + clipboard). Runtime/preview via any static server or opening the file directly. No bundler, no framework, no new dependencies.

---

## Canonical sources

- **Approved visual target (copy markup/CSS from here):** `.superpowers/brainstorm/61742-1780959187/content/fullpage-v2.html` — the complete, user-approved mockup. It uses bare image filenames (e.g. `hero.png`) and placeholder `href="#"` links because it ran in a sandbox; every task below specifies the exact production adaptations (asset paths under `assets/`, real URLs, copy buttons).
- **Design spec:** `docs/superpowers/specs/2026-06-08-website-visual-redesign-design.md`.
- **File being rebuilt:** `site/index.html` (full rewrite, in place).

### Deviation from spec, intentional
The spec's "keep Tailwind via CDN" line is superseded by the approved mockup, which is **pure CSS with no Tailwind**. We follow the mockup: drop the `https://cdn.tailwindcss.com` script entirely (lighter, no render-blocking CDN, still a single file, still no build). This is the only deliberate departure.

### Asset filename mapping (mockup → production)
| Mockup `src` | Production `src` |
|---|---|
| `hero.png` | `assets/hero.png` |
| `command-palette.png` | `assets/command-palette.png` |
| `diff-panel-split.png` | `assets/diff-panel-split.png` |
| `diff-panel-full.png` | `assets/diff-panel-full.png` |
| `linear-issues.png` | `assets/linear-issues.png` |
| `gitlab-mrs.png` | `assets/gitlab-mrs.png` |
| `ravin.jpg` | `assets/testimonial-ravinwashere.jpg` |
| (add logo) | `assets/logo.svg` |

### Real link targets (replace mockup `href="#"`)
- Nav GitHub + footer GitHub: `https://github.com/jarredkenny/jmux`
- Nav Docs + footer Docs: `https://github.com/jarredkenny/jmux#readme`
- "Getting Started" anywhere: `https://github.com/jarredkenny/jmux/blob/main/docs/getting-started.md`
- hunk: `https://github.com/modem-dev/hunk`
- wtm: `https://github.com/jarredkenny/worktree-manager`
- Linear: `https://linear.app`
- GitLab: `https://about.gitlab.com`
- GitHub (ecosystem card): `https://github.com`
- Ravin testimonial card: `https://x.com/ravinwashere`
- footer npm: `https://www.npmjs.com/package/@jx0/jmux`

### Preview & verification convention (used by every task)
There is no test framework for a static page. Each task verifies two ways:
1. **Visual parity** — open both files in a browser and compare the relevant section:
   - Built file: `open site/index.html` (relative `assets/` paths resolve from disk; the `/favicon…` absolute paths 404 locally but are harmless).
   - Mockup: `open .superpowers/brainstorm/61742-1780959187/content/fullpage-v2.html`
2. **Content assertion** — `rg` greps with an expected result, given per task.

---

## File Structure

- **Modify (full rewrite):** `site/index.html` — the entire page.
- **Reuse (no change):** everything in `site/assets/`, plus `site/favicon*`, `site/site.webmanifest`, `site/apple-touch-icon.png`, `site/web-app-manifest-*.png`.
- No other files change.

We build `site/index.html` top-to-bottom. Task 1 lays down `<head>` + `<style>` + an empty `<body>`. Tasks 2–10 fill the body section by section. Task 11 adds the reveal script + reduced-motion guard. Task 12 is the content-accuracy + asset + HTML-validity gate.

---

### Task 1: Head, fonts, and the full CSS foundation

**Files:**
- Modify: `site/index.html` (replace the entire file with the head/style scaffold below + an empty body shell)

- [ ] **Step 1: Replace the whole file with the head + style + empty body shell**

Write `site/index.html` with exactly this content (body sections are added in later tasks at the marked spot):

```html
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>jmux — The agent orchestrator that doesn't replace your tools</title>
  <meta name="description" content="Orchestrate Claude Code, Codex, aider, or any terminal agent — with your diff viewer, your worktree manager, your terminal. No bundled IDE. No lock-in.">
  <link rel="canonical" href="https://jmux.dev">
  <!-- Open Graph -->
  <meta property="og:title" content="jmux — The agent orchestrator that doesn't replace your tools">
  <meta property="og:description" content="Orchestrate Claude Code, Codex, aider, or any terminal agent — with your diff viewer, your worktree manager, your terminal. No bundled IDE. No lock-in.">
  <meta property="og:type" content="website">
  <meta property="og:url" content="https://jmux.dev">
  <meta property="og:site_name" content="jmux">
  <meta property="og:image" content="https://jmux.dev/assets/og-image.png">
  <meta property="og:image:width" content="1200">
  <meta property="og:image:height" content="630">
  <!-- Twitter -->
  <meta name="twitter:card" content="summary_large_image">
  <meta name="twitter:title" content="jmux — The agent orchestrator that doesn't replace your tools">
  <meta name="twitter:description" content="Orchestrate Claude Code, Codex, aider, or any terminal agent — with your diff viewer, your worktree manager, your terminal. No bundled IDE. No lock-in.">
  <meta name="twitter:image" content="https://jmux.dev/assets/og-image.png">
  <link rel="icon" type="image/png" href="/favicon-96x96.png" sizes="96x96">
  <link rel="icon" type="image/svg+xml" href="/favicon.svg">
  <link rel="shortcut icon" href="/favicon.ico">
  <link rel="apple-touch-icon" sizes="180x180" href="/apple-touch-icon.png">
  <meta name="apple-mobile-web-app-title" content="jmux">
  <link rel="manifest" href="/site.webmanifest">
  <!-- Privacy-friendly analytics by Plausible -->
  <script async src="https://plausible.io/js/pa-HkHsYGuslKCEWM2CA6t6j.js"></script>
  <script>
    window.plausible=window.plausible||function(){(plausible.q=plausible.q||[]).push(arguments)},plausible.init=plausible.init||function(i){plausible.o=i||{}};
    plausible.init()
  </script>
  <!-- Web fonts -->
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800;900&family=JetBrains+Mono:wght@400;500;600;700&display=swap" rel="stylesheet">
  <style>
  /* >>> PASTE THE ENTIRE <style> BLOCK FROM fullpage-v2.html HERE (everything between its <style> and </style>, not including the tags) <<< */
  </style>
</head>
<body>
  <!-- BODY SECTIONS ADDED IN TASKS 2–10 -->
</body>
</html>
```

Then open `.superpowers/brainstorm/61742-1780959187/content/fullpage-v2.html`, copy everything **between** its `<style>` and `</style>` tags, and paste it where the `>>> PASTE <<<` comment is, replacing that comment line. Do not alter the CSS.

- [ ] **Step 2: Verify no Tailwind, correct accent token, fonts wired**

Run:
```bash
rg -c "cdn.tailwindcss.com" site/index.html; echo "expect: no matches (grep exits 1)"
rg -q -- "--ac:#5eead4" site/index.html && echo "accent OK"
rg -q "Inter:wght" site/index.html && echo "fonts OK"
```
Expected: the first prints nothing and reports no matches; then `accent OK` and `fonts OK`.

- [ ] **Step 3: Verify it renders as a blank dark page**

Run: `open site/index.html`
Expected: a near-black (`#06080b`) empty page, no console errors, network panel shows the Google Fonts request. (Body is intentionally empty until Task 2.)

- [ ] **Step 4: Commit**

```bash
git add site/index.html
git commit -m "feat(site): new head, web fonts, and CSS foundation for redesign"
```

---

### Task 2: Nav + Hero

**Files:**
- Modify: `site/index.html` (replace the `<!-- BODY SECTIONS… -->` comment with the nav + hero)

- [ ] **Step 1: Add nav + hero from the mockup, with production adaptations**

Copy the `<nav>…</nav>` and `<header class="hero">…</header>` blocks from `fullpage-v2.html` into the body. Then apply these exact adaptations:

1. **Remove all `<span class="seclabel">▸ N …</span>` elements** — they exist only for mockup feedback; none ship.
2. **Brand logo (nav and footer later):** change the nav brand to include the logo:
   ```html
   <div class="brand"><img src="assets/logo.svg" alt="" width="26" height="26"> jmux <span class="v">v0.17.0</span></div>
   ```
3. **Nav links → real hrefs:** Features `#features`, Ecosystem `#ecosystem`, Docs `https://github.com/jarredkenny/jmux#readme`, GitHub ghost button `https://github.com/jarredkenny/jmux`, Install `#install`. Add `target="_blank" rel="noopener"` to the external (Docs, GitHub) links.
4. **Hero screenshot:** `src="assets/hero.png"` and keep the descriptive `alt="jmux sidebar with grouped sessions alongside vim and Claude Code"`.
5. **Install pill → working copy-to-clipboard button.** Replace the mockup's `<span class="cp">⧉</span>` with this button (ported from the current site's pattern):
   ```html
   <button onclick="navigator.clipboard.writeText('bun install -g @jx0/jmux');var s=this.innerHTML;this.innerHTML='<svg width=\'15\' height=\'15\' viewBox=\'0 0 24 24\' fill=\'none\' stroke=\'#5eead4\' stroke-width=\'2\' stroke-linecap=\'round\' stroke-linejoin=\'round\'><polyline points=\'20 6 9 17 4 12\'/></svg>';setTimeout(()=>this.innerHTML=s,1500)" class="cp" title="Copy" style="background:none;border:none;cursor:pointer;color:var(--ink3)"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg></button>
   ```

- [ ] **Step 2: Verify hero matches the mockup**

Run: `open site/index.html` and, side by side, `open .superpowers/brainstorm/61742-1780959187/content/fullpage-v2.html`
Expected: identical nav + hero — asymmetric layout, headline "Replace nothing. / Orchestrate everything.", screenshot bleeding off the right, cyan glow, avatar + star proof row. The logo shows in the brand. Clicking the copy button swaps to a check for ~1.5s and puts `bun install -g @jx0/jmux` on the clipboard.

- [ ] **Step 3: Verify no seclabels leaked**

Run: `rg -c "seclabel|▸" site/index.html; echo "expect: no matches"`
Expected: no matches.

- [ ] **Step 4: Commit**

```bash
git add site/index.html
git commit -m "feat(site): nav + asymmetric hero with copy-to-clipboard"
```

---

### Task 3: Thesis + orchestration diagram

**Files:**
- Modify: `site/index.html` (append after the hero)

- [ ] **Step 1: Add the orchestration diagram section**

Copy the `<section class="sec thesis center">…</section>` block from `fullpage-v2.html` (heading "One orchestrator. Your tools stay your tools." + the SVG hub-and-spoke `.diagram`). Adaptations:
1. Remove its `seclabel` span.
2. Leave the node labels exactly as in the mockup (`tmux`, `hunk`, `wtm`, `Claude · Codex · aider`, `neovim`, `Linear · GitHub · GitLab`) — these are accurate per the spec.

- [ ] **Step 2: Verify the diagram renders**

Run: `open site/index.html` (scroll to section 2)
Expected: centered jmux hub node with a cyan glow, six labelled spoke nodes, thin cyan connector lines from center to each node — matching the mockup.

- [ ] **Step 3: Commit**

```bash
git add site/index.html
git commit -m "feat(site): thesis section with orchestration diagram"
```

---

### Task 4: Features bento grid

**Files:**
- Modify: `site/index.html` (append after the diagram)

- [ ] **Step 1: Add the bento section**

Copy `<section class="sec surf showcase" id="features">…</section>` from `fullpage-v2.html`. Adaptations:
1. Remove its `seclabel` span.
2. Big tile screenshot: `src="assets/hero.png"` with `alt="jmux session sidebar"`.
3. Leave the **Agent State** tile exactly as in the mockup — the three states with glyphs `⏵` (green, RUNNING), `!` (amber, WAITING), `✓` (blue, COMPLETE). These match `src/types.ts` / `src/sidebar.ts`. Do **not** reintroduce the words "attention flag".

- [ ] **Step 2: Verify the bento + corrected copy**

Run: `open site/index.html` (section 3).
Expected: a 3-column bento — large Session Sidebar tile (screenshot bleeding into the lower-right), Agent State tile showing the three colored glyph/labels, Instant Switching, a wide "Context & cache visibility" tile, and Command Palette.

Then assert the corrected copy is present and the stale copy is absent:
```bash
rg -q "Agent State" site/index.html && echo "agent state OK"
rg -q "Context &amp; cache visibility" site/index.html && echo "context copy OK"
rg -i -c "attention flag" site/index.html; echo "expect: no matches here (only allowed later in Ravin's verbatim quote)"
```
Expected: `agent state OK`, `context copy OK`, and no "attention flag" matches yet.

- [ ] **Step 3: Commit**

```bash
git add site/index.html
git commit -m "feat(site): features bento grid with agent-state + context copy"
```

---

### Task 5: Product showcases (×3)

**Files:**
- Modify: `site/index.html` (append after the bento)

- [ ] **Step 1: Add the three showcase sections**

Copy the three `<section class="sec … showcase">` blocks (▸ 4 ·1, ·2, ·3) from `fullpage-v2.html`. Adaptations:
1. Remove `seclabel` spans.
2. Image `src` values → production paths: `assets/command-palette.png`; `assets/diff-panel-split.png` + `assets/diff-panel-full.png`; `assets/linear-issues.png` + `assets/gitlab-mrs.png`. Keep the descriptive `alt` text from the mockup.
3. The `hunk` link in showcase ·2 → `href="https://github.com/modem-dev/hunk" target="_blank" rel="noopener"`.

- [ ] **Step 2: Verify the three showcases**

Run: `open site/index.html` (sections 4·1–4·3).
Expected, matching the mockup: Command Palette (image left/right alternation), Info Panel & Diff (two stacked screenshots, `hunk` is a cyan link), Issue & PR tracking with heading "Linear, GitHub & GitLab / in the terminal." and two stacked screenshots. `kbd` chips (`Ctrl-a p`, `Ctrl-a g`, `[ ]`, `n`, `o`, `s`, `a`) render as mono pills.

Assert the PR-tracking copy mentions all three hosts:
```bash
rg -q "GitHub & GitLab|GitHub &amp; GitLab" site/index.html && echo "hosts OK"
```
Expected: `hosts OK`.

- [ ] **Step 3: Commit**

```bash
git add site/index.html
git commit -m "feat(site): three alternating product showcases"
```

---

### Task 6: Testimonials strip

**Files:**
- Modify: `site/index.html` (append after the showcases)

- [ ] **Step 1: Add the testimonials section**

Copy `<section class="sec surf tst center">…</section>` from `fullpage-v2.html`. Adaptations:
1. Remove `seclabel` span.
2. Ravin avatar image → `src="assets/testimonial-ravinwashere.jpg"`.
3. Wrap Ravin's card in a link to his profile: make the card an `<a href="https://x.com/ravinwashere" target="_blank" rel="noopener" class="tcard" style="text-align:left">…</a>` (replace the `<div class="tcard">` for Ravin only).
4. Ravin's quote contains the phrase "attention flags" — **leave it verbatim**; it is a real quote and the one allowed occurrence of that phrase on the page.

- [ ] **Step 2: Verify testimonials**

Run: `open site/index.html` (section 5).
Expected: three cards (Mouad, Ravin with photo + `@ravinwashere`, Azzeddine "Wow."). Ravin's card is clickable to x.com.

- [ ] **Step 3: Commit**

```bash
git add site/index.html
git commit -m "feat(site): testimonials strip"
```

---

### Task 7: Comparison table

**Files:**
- Modify: `site/index.html` (append after testimonials)

- [ ] **Step 1: Add the comparison section**

Copy `<section class="sec cmp center">…</section>` from `fullpage-v2.html`. Adaptations:
1. Remove `seclabel` span.
2. Keep the corrected row labels exactly as in the mockup: "Agent run states (running / waiting / complete)", "Issue & PR/MR tracking", "Context & cache visibility". Do not reintroduce "attention flags", "MR tracking" (alone), or "Cache cost visibility".

- [ ] **Step 2: Verify corrected rows**

Run:
```bash
rg -q "Agent run states" site/index.html && echo "row1 OK"
rg -q "Issue &amp; PR/MR tracking" site/index.html && echo "row2 OK"
rg -q "Context &amp; cache visibility" site/index.html && echo "row3 OK"
rg -c "Cache cost visibility|attention flags" site/index.html; echo "expect: no matches"
```
Expected: `row1 OK`, `row2 OK`, `row3 OK`, and no matches for the stale strings (Ravin's quote uses "attention flags" but lives in Task 6's section; if this grep matches 1, confirm it is only Ravin's quote — it should not be in the comparison table).

Then `open site/index.html` (section 6): jmux column has a faint cyan wash + accent header, cyan checks, muted crosses/`Manual`/`Extension`/`Bundled`.

- [ ] **Step 3: Commit**

```bash
git add site/index.html
git commit -m "feat(site): comparison table with corrected feature rows"
```

---

### Task 8: Agent Control CLI band

**Files:**
- Modify: `site/index.html` (append after comparison)

- [ ] **Step 1: Add the CLI band**

Copy `<section class="sec surf cliband center">…</section>` from `fullpage-v2.html`. Adaptations:
1. Remove `seclabel` span.
2. Keep the terminal body verbatim — it uses the **accurate** JSON shapes (`run-claude` → `{"session":…,"pane":"%12","command_dispatched":true}`, `session list` → `{"sessions":[…]}`, `pane capture` → `{"target":…,"content":…}`). Do **not** reintroduce any `"attention":true` output.

- [ ] **Step 2: Verify accurate JSON**

Run: `rg -c '"attention":' site/index.html; echo "expect: no matches"`
Expected: no matches.
Then `open site/index.html` (section 7): a full-width terminal window with the cyan-accented commands and dimmed JSON output.

- [ ] **Step 3: Commit**

```bash
git add site/index.html
git commit -m "feat(site): agent control CLI band with accurate JSON output"
```

---

### Task 9: Ecosystem grid

**Files:**
- Modify: `site/index.html` (append after CLI band)

- [ ] **Step 1: Add the ecosystem section**

Copy `<section class="sec eco center" id="ecosystem">…</section>` from `fullpage-v2.html`. Adaptations:
1. Remove `seclabel` span.
2. Wrap each tool name in its real link (`target="_blank" rel="noopener"`): hunk → `https://github.com/modem-dev/hunk`, wtm → `https://github.com/jarredkenny/worktree-manager`, Linear → `https://linear.app`, GitHub → `https://github.com`, GitLab → `https://about.gitlab.com`. (Claude Code, lazygit, and the dashed "yours" card need no link.)
3. Keep the new **GitHub** card with its `NEW` badge.

- [ ] **Step 2: Verify ecosystem + GitHub card**

Run: `rg -q "GitHub" site/index.html && rg -q "class=\"new\"" site/index.html && echo "github card OK"`
Expected: `github card OK`.
Then `open site/index.html` (section 8): 8 cards incl. GitHub (with NEW badge) and the dashed "yours" tile; tool names are links.

- [ ] **Step 3: Commit**

```bash
git add site/index.html
git commit -m "feat(site): ecosystem grid with GitHub adapter card"
```

---

### Task 10: Install CTA + footer

**Files:**
- Modify: `site/index.html` (append after ecosystem)

- [ ] **Step 1: Add the CTA and footer**

Copy `<section class="sec cta" id="install">…</section>` and `<footer>…</footer>` from `fullpage-v2.html`. Adaptations:
1. Remove `seclabel` spans.
2. **CTA copy button:** add a copy-to-clipboard button to the `.cmd` block (top-right) that copies both commands. Insert inside the `<div class="cmd">`, before the command lines:
   ```html
   <button onclick="navigator.clipboard.writeText('bun install -g @jx0/jmux\njmux');var s=this.innerHTML;this.innerHTML='<svg width=\'16\' height=\'16\' viewBox=\'0 0 24 24\' fill=\'none\' stroke=\'#5eead4\' stroke-width=\'2\' stroke-linecap=\'round\' stroke-linejoin=\'round\'><polyline points=\'20 6 9 17 4 12\'/></svg>';setTimeout(()=>this.innerHTML=s,1500)" title="Copy" style="position:absolute;top:16px;right:16px;background:none;border:none;cursor:pointer;color:var(--ink3)"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg></button>
   ```
   Ensure `.cmd` is positioned for the absolute button: confirm the CSS `.cmd{ … }` includes `position:relative;` (it is `position:relative` via `z-index:2` only — add `position:relative;` to the `.cmd` rule in the `<style>` block if not present).
3. **Footer links → real hrefs** (`target="_blank" rel="noopener"`): GitHub `https://github.com/jarredkenny/jmux`, npm `https://www.npmjs.com/package/@jx0/jmux`, Docs `https://github.com/jarredkenny/jmux#readme`.

- [ ] **Step 2: Verify CTA + footer**

Run: `open site/index.html` (section 9 + footer).
Expected: big "Two commands. You're in." heading with glow, the two-command block with a working copy button (copies both lines), and a hairline footer with three working links.

- [ ] **Step 3: Commit**

```bash
git add site/index.html
git commit -m "feat(site): install CTA with copy button + footer"
```

---

### Task 11: Reveal animations, reduced-motion, no spotlight

**Files:**
- Modify: `site/index.html` (add reveal classes + a single `<script>` before `</body>`; confirm CSS guards)

- [ ] **Step 1: Add `animate-in` reveal classes to section headers**

For each major section's heading/intro block and each card/tile/row, add the class `animate-in` (and on grouped children, the stagger is handled by JS). At minimum add `class="animate-in"` to: each section's eyebrow+`<h2>` wrapper, each bento `.tile`, each `.showrow .txt`, each `.tcard`, each `.ecocard`. Keep it light — headers and cards only.

- [ ] **Step 2: Add the reveal CSS to the `<style>` block**

Append to the `<style>` block:
```css
.animate-in{ opacity:0; transform:translateY(18px); }
.animate-in.visible{ opacity:1; transform:none; transition:opacity .5s ease, transform .5s ease; }
@media (prefers-reduced-motion: reduce){
  .animate-in{ opacity:1; transform:none; transition:none; }
  *{ scroll-behavior:auto !important; }
}
```

- [ ] **Step 3: Add the IntersectionObserver script before `</body>`**

```html
<script>
  (function () {
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (!entry.isIntersecting) return;
        var el = entry.target;
        var siblings = Array.prototype.filter.call(
          el.parentElement.children,
          function (c) { return c.classList.contains('animate-in'); }
        );
        var i = siblings.indexOf(el);
        el.style.transitionDelay = (i > 0 ? i * 70 : 0) + 'ms';
        el.classList.add('visible');
        io.unobserve(el);
      });
    }, { threshold: 0.12 });
    document.querySelectorAll('.animate-in').forEach(function (el) { io.observe(el); });
  })();
</script>
```

- [ ] **Step 4: Verify reveals + no roaming spotlight**

Run:
```bash
rg -c "spotlight|requestAnimationFrame|makeSpotlight" site/index.html; echo "expect: no matches"
rg -q "IntersectionObserver" site/index.html && echo "reveal OK"
```
Expected: no spotlight/rAF matches; `reveal OK`.
Then `open site/index.html`: sections fade/slide up as they scroll into view. Toggle OS "Reduce Motion" (macOS: System Settings → Accessibility → Display → Reduce motion) and reload — everything is visible immediately with no animation.

- [ ] **Step 5: Commit**

```bash
git add site/index.html
git commit -m "feat(site): scroll reveals + reduced-motion, remove roaming spotlight"
```

---

### Task 12: Accuracy, asset, and validity gate

**Files:**
- Modify: `site/index.html` (only if a check fails)

- [ ] **Step 1: Run the full content-accuracy assertion**

```bash
echo "--- stale strings (each must report NO matches) ---"
rg -c "cdn.tailwindcss.com" site/index.html
rg -c "#4ade80" site/index.html
rg -c '"attention":' site/index.html
rg -c "Cache cost visibility" site/index.html
rg -c "Attention Flags" site/index.html
rg -c "spotlight" site/index.html
echo "--- required strings (each must report a match) ---"
rg -c -- "--ac:#5eead4" site/index.html
rg -c "Agent State" site/index.html
rg -c "Agent run states" site/index.html
rg -c "Context &amp; cache visibility" site/index.html
rg -c "GitHub" site/index.html
rg -c "Inter:wght" site/index.html
```
Expected: every "stale" grep reports `0` (or no output). Every "required" grep reports `≥1`. Note: "attention flags" still appears **once** in Ravin's verbatim quote — that is allowed; `rg -c "Attention Flags"` (capitalized feature title) must be `0`.

- [ ] **Step 2: Verify every referenced asset exists**

```bash
for f in $(rg -o 'assets/[A-Za-z0-9_./-]+' site/index.html | sort -u); do
  [ -f "site/$f" ] && echo "ok  $f" || echo "MISSING $f";
done
```
Expected: every line starts with `ok`. Any `MISSING` is a broken `src`/`href` to fix.

- [ ] **Step 3: Verify HTML is well-formed**

Run:
```bash
bunx --yes node-html-parser --version >/dev/null 2>&1 || true
bun -e 'const s=await Bun.file("site/index.html").text(); const open=(s.match(/<section/g)||[]).length, close=(s.match(/<\/section>/g)||[]).length; if(open!==close){console.error("section tag mismatch",open,close);process.exit(1)} const b=(s.match(/<body/g)||[]).length, eb=(s.match(/<\/body>/g)||[]).length; if(b!==1||eb!==1){console.error("body tags off");process.exit(1)} console.log("structure OK: sections",open)'
```
Expected: `structure OK: sections N` (N matches the number of `<section>` blocks). A mismatch means an unbalanced tag from a copy/paste — fix it.

- [ ] **Step 4: Full-page visual parity pass**

Run both and scroll the entire page top-to-bottom in each, comparing every section:
```bash
open site/index.html
open .superpowers/brainstorm/61742-1780959187/content/fullpage-v2.html
```
Expected: the built page is visually equivalent to the approved mockup (allowing for the real screenshots/links/logo and the absolute-favicon 404s that only occur on `file://`). Check mobile too: narrow the window to ~420px — hero stacks, bento collapses to one column, showcases stack, ecosystem/testimonials go single-column.

- [ ] **Step 5: Commit any fixes**

```bash
git add site/index.html
git commit -m "fix(site): accuracy, asset, and validity gate corrections"
```
(If no fixes were needed, skip this commit.)

---

## Self-Review (completed by plan author)

**Spec coverage:** Identity/tokens → Task 1. Typography → Task 1. Static glows + remove spotlight → Tasks 1 (CSS) & 11. Hero (asymmetric) → Task 2. Orchestration diagram → Task 3. Bento → Task 4. Showcases ×3 → Task 5. Testimonials strip → Task 6. Comparison (corrected rows) → Task 7. CLI band (accurate JSON) → Task 8. Ecosystem + GitHub → Task 9. CTA + footer → Task 10. Reveals + reduced-motion → Task 11. All six content corrections → Tasks 4, 5, 7, 8, 9 + gate in Task 12. Single-file/no-build → honored throughout. Accessibility (alt text, reduced-motion) → Tasks 2/4/5 (alt) + 11. Every spec section maps to a task.

**Placeholder scan:** No TBD/TODO. "Copy from fullpage-v2.html" references a committed, pinned file with exact per-task adaptations listed — not an unspecified placeholder. Every JS snippet (copy buttons, reveal observer) and every CSS addition is given in full.

**Type/string consistency:** CSS custom props (`--ac`, `--ink3`, etc.) used in injected snippets match the token names defined by the pasted `<style>` block in Task 1. Accent hex `#5eead4` is consistent across copy-button SVGs, CSS, and the Task 12 grep. Asset paths and link URLs are defined once in the mapping tables and reused verbatim.
