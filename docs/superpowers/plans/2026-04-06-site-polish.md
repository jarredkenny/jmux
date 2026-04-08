# Site Visual Polish Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add six visual polish improvements to the jmux landing page — card hovers, hero glow, section backgrounds, SVG icons, scroll animations, and copy button upgrade.

**Architecture:** All changes are edits to the single file `site/index.html`. CSS goes in the existing `<style>` block, SVGs replace inline unicode, and a small IntersectionObserver script is added before `</body>`. No new files, no build step.

**Tech Stack:** HTML, CSS, inline SVG, vanilla JS (~20 lines)

---

### Task 1: Add card hover styles

**Files:**
- Modify: `site/index.html:47-54` (existing `<style>` block)
- Modify: `site/index.html:119-134` (Why section cards — 3 cards)
- Modify: `site/index.html:146-169` (Features section cards — 4 cards)
- Modify: `site/index.html:180-218` (Ecosystem section cards — 6 cards)

- [ ] **Step 1: Add `.card-hover` styles to the `<style>` block**

Replace the existing `<style>` block content with:

```css
body {
  background-color: #171b26;
  color: #ffffff;
  -webkit-font-smoothing: antialiased;
  -moz-osx-font-smoothing: grayscale;
}
.card-hover {
  transition: border-color 280ms ease, transform 280ms ease, box-shadow 280ms ease;
}
.card-hover:hover {
  transform: translateY(-3px);
  border-color: rgba(74, 222, 128, 0.35);
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.3);
}
.card-hover-dashed {
  transition: transform 280ms ease, box-shadow 280ms ease;
}
.card-hover-dashed:hover {
  transform: translateY(-3px);
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.3);
}
```

Note: `.card-hover-dashed` is a variant for the "yours" ecosystem card — it lifts and shadows but does not change `border-color`, preserving the dashed border.

- [ ] **Step 2: Add `card-hover` class to all 12 solid-border cards and `card-hover-dashed` to the dashed card**

Why section — add `card-hover` to each of the 3 `<div>` cards (lines 119, 124, 129). Example for first card:

```html
<div class="bg-surface border border-border rounded-xl p-6 card-hover">
```

Features section — add `card-hover` to each of the 4 `<div>` cards (lines 146, 152, 158, 164). Example:

```html
<div class="bg-surface border border-border rounded-xl p-6 card-hover">
```

Ecosystem section — add `card-hover` to the 5 solid-border cards (lines 182, 188, 194, 200, 206). Example:

```html
<div class="bg-surface border border-border rounded-xl p-5 text-center card-hover">
```

The dashed "yours" card (line 212) gets `card-hover-dashed`:

```html
<div class="border border-dashed border-border rounded-xl p-5 text-center card-hover-dashed">
```

- [ ] **Step 3: Verify in browser**

Open `site/index.html` in a browser. Hover over cards in all three sections. Confirm:
- Cards lift 3px and gain a shadow on hover
- Green border tint appears on solid-border cards
- The dashed "yours" card lifts but border stays dashed
- Transition is smooth at ~280ms

- [ ] **Step 4: Commit**

```bash
git add site/index.html
git commit -m "feat(site): add lift + shadow hover states to all cards"
```

---

### Task 2: Add hero glow

**Files:**
- Modify: `site/index.html:47-73` (`<style>` block — add hero glow CSS)
- Modify: `site/index.html:77-98` (hero `<section>` — add class for targeting)

- [ ] **Step 1: Add hero glow CSS to the `<style>` block**

Add after the `.card-hover-dashed:hover` rule:

```css
.hero-glow {
  position: relative;
  overflow: hidden;
}
.hero-glow::before {
  content: '';
  position: absolute;
  top: 50%;
  left: 50%;
  transform: translate(-50%, -50%);
  width: 600px;
  height: 300px;
  border-radius: 50%;
  background: rgba(74, 222, 128, 0.15);
  filter: blur(80px);
  pointer-events: none;
  z-index: 0;
}
.hero-glow > * {
  position: relative;
  z-index: 1;
}
```

Note: `.hero-glow > *` ensures all direct children (the tagline, headline, paragraph, install block, link) sit above the glow without adding `position: relative; z-index: 1` to each individually.

- [ ] **Step 2: Add `hero-glow` class to the hero section**

Change the hero section opening tag from:

```html
<section class="text-center px-6 md:px-12 pt-20 md:pt-28 pb-10">
```

to:

```html
<section class="text-center px-6 md:px-12 pt-20 md:pt-28 pb-10 hero-glow">
```

- [ ] **Step 3: Verify in browser**

Reload the page. Confirm:
- A soft green glow is visible behind the headline area
- The glow is clearly visible (statement intensity) but not harsh
- Text and the install command block sit cleanly above the glow
- The glow does not overflow into the nav or screenshot sections

- [ ] **Step 4: Commit**

```bash
git add site/index.html
git commit -m "feat(site): add green accent glow behind hero headline"
```

---

### Task 3: Darken Features and Install CTA section backgrounds

**Files:**
- Modify: `site/index.html:138` (Features section opening tag)
- Modify: `site/index.html:222` (Install CTA section opening tag)

- [ ] **Step 1: Add `bg-surface` to the Features section**

Change:

```html
<section class="px-6 md:px-12 py-16 md:py-24 border-t border-border">
```

(the Features section, which contains "Built for the Workflow") to:

```html
<section class="px-6 md:px-12 py-16 md:py-24 border-t border-border bg-surface">
```

- [ ] **Step 2: Add `bg-surface` to the Install CTA section**

Change:

```html
<section id="install" class="px-6 md:px-12 py-16 md:py-24 border-t border-border text-center">
```

to:

```html
<section id="install" class="px-6 md:px-12 py-16 md:py-24 border-t border-border text-center bg-surface">
```

- [ ] **Step 3: Verify in browser**

Reload the page and scroll through. Confirm:
- Features section is visibly darker than Why and Ecosystem sections
- Install CTA section is the same darker shade
- The rhythm is: body → body → dark → body → dark → footer
- Border lines between sections still look clean

- [ ] **Step 4: Commit**

```bash
git add site/index.html
git commit -m "feat(site): darken Features and Install CTA section backgrounds"
```

---

### Task 4: Replace unicode feature icons with SVGs in tinted containers

**Files:**
- Modify: `site/index.html:47-73` (`<style>` block — add icon container style)
- Modify: `site/index.html:146-169` (Features section — replace 4 icon `<div>`s)

- [ ] **Step 1: Add `.icon-container` style to the `<style>` block**

Add after the `.hero-glow > *` rule:

```css
.icon-container {
  width: 40px;
  height: 40px;
  border-radius: 10px;
  background: rgba(74, 222, 128, 0.1);
  display: flex;
  align-items: center;
  justify-content: center;
  margin-bottom: 12px;
}
.icon-container svg {
  width: 20px;
  height: 20px;
  stroke: #4ade80;
  fill: none;
  stroke-width: 1.5;
  stroke-linecap: round;
  stroke-linejoin: round;
}
```

- [ ] **Step 2: Replace Session Sidebar icon**

Replace:

```html
<div class="text-2xl mb-3 text-accent">▎</div>
```

with:

```html
<div class="icon-container"><svg viewBox="0 0 24 24"><rect x="3" y="3" width="7" height="18" rx="1"/><line x1="14" y1="3" x2="14" y2="21"/><rect x="14" y="3" width="7" height="18" rx="1"/></svg></div>
```

- [ ] **Step 3: Replace Instant Switching icon**

Replace:

```html
<div class="text-2xl mb-3">⚡</div>
```

with:

```html
<div class="icon-container"><svg viewBox="0 0 24 24"><polyline points="13 17 18 12 13 7"/><polyline points="6 17 11 12 6 7"/></svg></div>
```

- [ ] **Step 4: Replace Attention Flags icon**

Replace:

```html
<div class="text-2xl mb-3 text-amber-400">!</div>
```

with:

```html
<div class="icon-container"><svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg></div>
```

- [ ] **Step 5: Replace Bring Your Own Everything icon**

Replace:

```html
<div class="text-2xl mb-3">⌨</div>
```

with:

```html
<div class="icon-container"><svg viewBox="0 0 24 24"><path d="M4 7V4h16v3"/><path d="M9 20h6"/><path d="M12 4v16"/></svg></div>
```

- [ ] **Step 6: Verify in browser**

Reload and check the Features section. Confirm:
- All four icons render as green stroked SVGs inside soft green-tinted rounded squares
- Icons are visually consistent in size and color
- The icons are recognizable: panels, chevrons, alert circle, T-shape

- [ ] **Step 7: Commit**

```bash
git add site/index.html
git commit -m "feat(site): replace unicode icons with SVGs in tinted containers"
```

---

### Task 5: Add scroll entrance animations

**Files:**
- Modify: `site/index.html:47-73` (`<style>` block — add animation CSS)
- Modify: `site/index.html` (section headings and cards — add `.animate-in` class)
- Modify: `site/index.html` (before `</body>` — add IntersectionObserver script)

- [ ] **Step 1: Add animation CSS to the `<style>` block**

Add after the `.icon-container svg` rule:

```css
.animate-in {
  opacity: 0;
}
.animate-in.fade-up {
  transform: translateY(20px);
}
.animate-in.visible {
  opacity: 1;
  transform: translateY(0);
  transition: opacity 300ms ease, transform 300ms ease;
}
```

- [ ] **Step 2: Add `animate-in fade-up` class to section headings**

These are the `<div class="text-center mb-10">` wrappers that contain each section's title and subtitle. There are four of them:

Why section heading (contains "Why jmux"):
```html
<div class="text-center mb-10 animate-in fade-up">
```

Features section heading (contains "Built for the Workflow"):
```html
<div class="text-center mb-10 animate-in fade-up">
```

Ecosystem section heading (contains "Run them directly. All of them."):
```html
<div class="text-center mb-10 animate-in fade-up">
```

Install CTA heading — this one is different, it's a direct `<h2>` not wrapped in a div:
```html
<h2 class="text-2xl md:text-4xl font-extrabold tracking-tight mb-3 animate-in fade-up">Two commands. You're in.</h2>
```

- [ ] **Step 3: Add `animate-in` class to all cards**

Add `animate-in` to every card that already has `card-hover` or `card-hover-dashed`. For example in the Why section:

```html
<div class="bg-surface border border-border rounded-xl p-6 card-hover animate-in">
```

13 cards total across Why (3), Features (4), Ecosystem (6).

- [ ] **Step 4: Add IntersectionObserver script before `</body>`**

Insert this script just before the closing `</body>` tag:

```html
<script>
  (function() {
    var observer = new IntersectionObserver(function(entries) {
      entries.forEach(function(entry) {
        if (!entry.isIntersecting) return;
        var el = entry.target;
        if (el.classList.contains('animate-in') && !el.closest('.grid')) {
          el.classList.add('visible');
        } else if (el.classList.contains('animate-in')) {
          var cards = Array.from(el.parentElement.children).filter(function(c) {
            return c.classList.contains('animate-in');
          });
          var i = cards.indexOf(el);
          el.style.transitionDelay = (i * 80) + 'ms';
          el.classList.add('visible');
        }
        observer.unobserve(el);
      });
    }, { threshold: 0.1 });
    document.querySelectorAll('.animate-in').forEach(function(el) {
      observer.observe(el);
    });
  })();
</script>
```

This script:
- Observes all `.animate-in` elements
- Headings (not inside a `.grid`) get `.visible` immediately on intersection
- Cards (inside a `.grid`) get a staggered `transition-delay` based on their index among siblings, then `.visible`
- Each element is unobserved after animating (`once` behavior)

- [ ] **Step 5: Verify in browser**

Reload the page and scroll down slowly. Confirm:
- Section headings fade up into view as you scroll to them
- Cards fade in with a left-to-right stagger within each section
- Hero section is fully visible on load (no animation classes on it)
- Animations fire once and don't replay on scroll back up
- Timing feels smooth (~300ms with 80ms stagger between cards)

- [ ] **Step 6: Commit**

```bash
git add site/index.html
git commit -m "feat(site): add scroll entrance animations with staggered card fade-in"
```

---

### Task 6: Upgrade copy button to clipboard/checkmark SVG

**Files:**
- Modify: `site/index.html:47-73` (`<style>` block — add copy button styles)
- Modify: `site/index.html:92` (hero install block — replace copy button)
- Modify: `site/index.html:226-235` (Install CTA block — add copy button)

- [ ] **Step 1: Add copy button helper function and styles**

Add to the `<style>` block, after the animation CSS:

```css
.copy-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  color: #52525b;
  transition: color 200ms ease;
  background: none;
  border: none;
  padding: 0;
}
.copy-btn:hover {
  color: #a1a1aa;
}
```

- [ ] **Step 2: Replace the hero copy button**

Replace the entire hero copy button:

```html
<button onclick="navigator.clipboard.writeText('bun install -g @jx0/jmux');this.textContent='✓';setTimeout(()=>this.textContent='⧉',1500)" class="text-[#52525b] hover:text-[#a1a1aa] transition-colors ml-2 cursor-pointer" title="Copy to clipboard">⧉</button>
```

with:

```html
<button onclick="navigator.clipboard.writeText('bun install -g @jx0/jmux');var s=this.innerHTML;this.innerHTML='<svg width=\'16\' height=\'16\' viewBox=\'0 0 24 24\' fill=\'none\' stroke=\'#4ade80\' stroke-width=\'2\' stroke-linecap=\'round\' stroke-linejoin=\'round\'><polyline points=\'20 6 9 17 4 12\'/></svg>';setTimeout(()=>this.innerHTML=s,1500)" class="copy-btn ml-2" title="Copy to clipboard"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg></button>
```

- [ ] **Step 3: Add copy button to the Install CTA block**

The Install CTA code block currently has no copy button. Change the install command block from:

```html
<div class="max-w-sm mx-auto bg-surface border border-border rounded-xl px-6 py-5 font-mono text-sm text-left">
  <div class="mb-2">
    <span class="text-accent">$</span>
    <span class="text-white"> bun install -g @jx0/jmux</span>
  </div>
  <div>
    <span class="text-accent">$</span>
    <span class="text-white"> jmux</span>
  </div>
</div>
```

to:

```html
<div class="max-w-sm mx-auto bg-surface border border-border rounded-xl px-6 py-5 font-mono text-sm text-left relative">
  <button onclick="navigator.clipboard.writeText('bun install -g @jx0/jmux\njmux');var s=this.innerHTML;this.innerHTML='<svg width=\'16\' height=\'16\' viewBox=\'0 0 24 24\' fill=\'none\' stroke=\'#4ade80\' stroke-width=\'2\' stroke-linecap=\'round\' stroke-linejoin=\'round\'><polyline points=\'20 6 9 17 4 12\'/></svg>';setTimeout(()=>this.innerHTML=s,1500)" class="copy-btn absolute top-4 right-4" title="Copy to clipboard"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg></button>
  <div class="mb-2">
    <span class="text-accent">$</span>
    <span class="text-white"> bun install -g @jx0/jmux</span>
  </div>
  <div>
    <span class="text-accent">$</span>
    <span class="text-white"> jmux</span>
  </div>
</div>
```

The copy button is positioned absolutely in the top-right corner of the code block. It copies both commands separated by a newline.

- [ ] **Step 4: Verify in browser**

Reload the page. Test both copy buttons:
- Hero install block: clipboard icon visible, click copies `bun install -g @jx0/jmux`, icon swaps to green checkmark, reverts after 1.5s
- Install CTA block: clipboard icon in top-right corner, click copies both commands, same checkmark behavior
- Hover states work (gray → lighter gray)

- [ ] **Step 5: Commit**

```bash
git add site/index.html
git commit -m "feat(site): upgrade copy buttons with clipboard/checkmark SVG icons"
```
