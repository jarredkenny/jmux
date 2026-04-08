# Site Visual Polish — Design Spec

Date: 2026-04-06

## Overview

Six visual polish improvements to `site/index.html` that elevate the jmux landing page from functional to crafted. All changes are CSS and inline SVG — no build step, no new files, no external dependencies beyond the existing Tailwind CDN.

**Design direction:** Confident and crafted. Tasteful effects, smooth animations, clear hover feedback. Developer-oriented, not flashy.

**Animation timing:** Smooth and deliberate — 250-300ms transitions throughout.

## 1. Card Hover States

**What:** Lift + shadow effect on all cards across Why, Features, and Ecosystem sections.

**CSS:**
- Shared class `.card-hover` applied to every card element
- `transition: border-color 280ms ease, transform 280ms ease, box-shadow 280ms ease`
- Hover state: `transform: translateY(-3px)`, `border-color: rgba(74, 222, 128, 0.35)`, `box-shadow: 0 8px 24px rgba(0, 0, 0, 0.3)`

**Edge case:** The dashed-border "yours" card in the Ecosystem section gets the lift and shadow but preserves its dashed border style — the `border-color` change does not apply to it.

**Scope:** Why section (3 cards), Features section (4 cards), Ecosystem section (6 cards). 13 elements total.

## 2. Hero Glow

**What:** A static green accent glow behind the hero headline, "statement" intensity.

**Implementation:** CSS pseudo-element on the hero `<section>`:
- Hero section gets `position: relative; overflow: hidden`
- `::before` pseudo-element, absolutely positioned, centered horizontally, vertically aligned with the headline
- `width: 600px; height: 300px; border-radius: 50%`
- `background: rgba(74, 222, 128, 0.15); filter: blur(80px)`
- `pointer-events: none; z-index: 0`
- All hero content gets `position: relative; z-index: 1` to layer above the glow

**No animation** on the glow. Static atmospheric element contained within the hero section.

## 3. Section Backgrounds

**What:** Features and Install CTA sections get the darker `#111520` (`surface`) background. All other sections remain on the default `#171b26` body color.

**Rhythm:** body → body → **surface** (Features) → body (Ecosystem) → **surface** (Install CTA) → footer.

**Implementation:** Add `bg-surface` class to the Features and Install CTA `<section>` elements. No gradients or transitions between sections — the existing `border-t border-border` lines provide clean seams.

## 4. Feature Icons

**What:** Replace the four unicode characters (▎ ⚡ ! ⌨) with outline SVGs inside green-tinted rounded containers.

**Container style:**
- `width: 40px; height: 40px; border-radius: 10px`
- `background: rgba(74, 222, 128, 0.1)`
- `display: flex; align-items: center; justify-content: center`

**Icon style:**
- Inline SVGs, 20x20 viewbox
- `stroke: #4ade80; fill: none; stroke-width: 1.5; stroke-linecap: round; stroke-linejoin: round`

**Icon mapping:**
| Feature | Icon | Description |
|---|---|---|
| Session Sidebar | Sidebar/panels | Two vertical rectangles with divider line |
| Instant Switching | Chevrons-right | Double chevron pointing right |
| Attention Flags | Alert circle | Circle with exclamation mark |
| Bring Your Own Everything | Type/config | T-shape (typography/customization) |

## 5. Scroll Entrance Animations

**What:** Fade-up for section headings, fade-in with stagger for cards. Triggered by IntersectionObserver.

**Heading animation (section titles + subtitles):**
- Initial state: `opacity: 0; transform: translateY(20px)`
- Animated state: `opacity: 1; transform: translateY(0)`
- `transition: opacity 300ms ease, transform 300ms ease`
- Triggers when element enters viewport (threshold ~0.1)

**Card animation (all cards in Why, Features, Ecosystem):**
- Initial state: `opacity: 0`
- Animated state: `opacity: 1`
- `transition: opacity 300ms ease`
- Stagger: each card delays by 80ms relative to the previous one (using `transition-delay` set by the observer or a CSS custom property)

**Implementation:** ~20-line `<script>` at the bottom of `<body>`:
- CSS class `.animate-in` defines the initial hidden state
- IntersectionObserver adds `.visible` class when elements enter the viewport
- `once: true` on the observer — elements animate in once and stay visible
- Stagger is applied via `style="transition-delay: ${index * 80}ms"` set in the observer callback, scoped per parent container so each section's cards stagger independently

**No animation on the hero section** — it's above the fold and should be immediately visible.

## 6. Copy Button

**What:** Replace the `⧉` character with a clipboard SVG icon that transitions to a green checkmark on click.

**Clipboard icon (default state):**
```html
<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
  <rect x="9" y="9" width="13" height="13" rx="2"/>
  <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>
</svg>
```

**Checkmark icon (success state):**
```html
<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#4ade80" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
  <polyline points="20 6 9 17 4 12"/>
</svg>
```

**Behavior:** On click, swap `innerHTML` to checkmark, revert after 1.5s. The existing `navigator.clipboard.writeText()` call stays. The button styling remains: `text-[#52525b] hover:text-[#a1a1aa] transition-colors cursor-pointer`.

**Both install blocks** (hero and Install CTA section) get this treatment. The Install CTA section currently has no copy button — add one.

## Non-Goals

- No changes to copy, layout, information architecture, or responsive behavior
- No new files, build tools, or dependencies
- No changes to the Tailwind config beyond what's already there
- No changes to the hero screenshot or its presentation
- No dark/light mode toggle
