# Carbonyl rendering quirks

Running log of styling gotchas hit while making slop-review render
cleanly inside [Carbonyl](https://github.com/fathyb/carbonyl) (Chromium
that paints into the TTY via U+2584 half-blocks). Each entry: the
symptom, what's actually happening under the hood, and the fix we
landed in `public/carbonyl.css`. Use this as the cheat sheet next
time a styling choice misbehaves in the terminal.

## How carbonyl renders, in one paragraph

Carbonyl runs a chromium fork at a CSS viewport of roughly
`cols * 7 px` wide by `rows * 14 px` tall. Each browser frame is
rasterized to half the terminal's vertical resolution: every
terminal cell encodes two stacked pixels via a U+2584 lower-half
block, with the cell's background paint = the top pixel and the
foreground paint = the bottom pixel. Two consequences fall out of
that, and they explain most of the entries below:

1. **The pixel grid is coarse.** Sub-pixel anti-aliasing on small
   fonts collapses to "either present or not present" in one cell.
   Glyph weights below ~500 and font-sizes below ~13px round to
   blank rows. Low-contrast colors (anything within ~15% of bg)
   collapse to the bg color outright.
2. **There is no real DPR scaling.** Variable-font axes (`opsz`,
   `wght` via `font-variation-settings`) and macOS-only system
   fonts don't resolve. The fallback chain lands on a generic
   `monospace` face that fontconfig has.

## Detection

The launcher (`bin/slop-review.js`) appends `?carbonyl=1` to the
URL it passes carbonyl. The inline script at the top of
`public/index.html` reads the query exactly once at page load and
sets `is-carbonyl` on `<html>` before `app.css` resolves, so the
overrides in `public/carbonyl.css` cascade naturally and there is
no flash of broken styling. The hash-based router preserves the
query across SPA navigation, so a single launch-time flag is
enough; we never UA-sniff at runtime.

If you ever need a JS-side probe instead (e.g. for a feature that
isn't CSS-only), use `document.documentElement.classList.contains('is-carbonyl')`.

## Quirks

### 0. Default line-height inflates button heights

**Symptom:** the Split/Inline toggle and the prev/next nav pill
look like tall pills with their text glued near the top and a
visibly empty band of background below.

**Why:** `body` sets `line-height: 1.55`. Buttons inherit that,
so a 13px font becomes ~20px of vertical content area. Plus the
4-6px padding the base styles already specify, plus the base
nav-btn's hard-coded 26px height: in real chromium the math works
out fine because the text is centered in the line-box. After
carbonyl quantizes 28-32 CSS px down to 2-3 terminal rows, the
glyph keeps its centered position inside the line-box but the
extra background rows below it become a chunky padding-bottom.

**Fix:** add `line-height: 1.2` to every `.is-carbonyl button`
as a baseline (keeps a tiny bit of breathing room for modal /
CTA buttons that have larger padding), then drop further to
`line-height: 1` for the toggle and nav-pill rules where we
want the tightest fit. Also drop the hard-coded 26x26 sizing on
`.diff-nav-btn` (`height: auto` + small explicit padding) so
the pill collapses to one glyph-row tall.

The global rule catches the harder-to-reach buttons too: the
inline-comment CTA strip (Cancel / Copy lines / Add comment),
the comment editor footer (Cancel / Add comment), the modal
actions footer used by every modal (Generate / Cancel etc., and
the Generate overview modal's CLI-picker), and any future
button that doesn't get its own override.

### 1. Small labels disappear under the downsample

**Symptom:** the prev/next nav pill renders as gray pills with
*no* "1 of 2" counter or `‹ ›` chevrons inside; `Wrap` / `Line #`
checkboxes render their checkbox squares but the text labels next
to them are missing entirely.

**Why:** the base styles use 10-11px for the pill counter and 12px
for the toggle labels, paired with `var(--fg-soft)` /
`var(--fg-muted)` which sit close to the surface bg. Carbonyl's
quantization can't keep the glyphs apart from the bg at that size
and contrast.

**Fix:** bump every label that has to remain readable to 13px+,
font-weight 500+, and `var(--ink)` color. See the `.diff-nav-btn`,
`.diff-position`, `.diff-wrap-toggle`, `.overview-nav-slot` blocks
in `carbonyl.css`.

### 2. Variable-font axes don't render

**Symptom:** `.diff-headline` (the commit title) looks fine in a
real browser thanks to its optical-size + softness axes; in
carbonyl it falls back to a thin face with weak strokes that
sometimes don't render at all on narrow viewports.

**Why:** the carbonyl chromium build doesn't have access to any of
the fonts in the project's display-font stack (ui-sans-serif, SF,
etc.), and the variation-settings axes don't apply to the generic
fallback it picks. The default weight comes through too thin.

**Fix:** pin `.diff-headline` to plain monospace at 14px / weight
600 / `var(--ink)`.

### 3. Mobile breakpoint always fires, hiding desktop chrome

**Symptom:** the Split / Inline view toggle, the `.diff-nav-btn[data-first]`
and `[data-last]` bookend buttons, and other "desktop-only" chrome
disappear in carbonyl even on a wide terminal.

**Why:** `cols * 7 px` is below 768 for any practical terminal
width, so `@media (max-width: 768px)` always matches. Every base
rule scoped to that breakpoint that hides desktop chrome (toggle,
bookend chevrons, etc.) fires unconditionally in carbonyl.

**Fix:** re-show the chrome we want back in `.is-carbonyl` rules.
For the view-mode toggle inside `.diff-review-banner.is-summary`,
restore `.diff-view-toggle { display: inline-flex }` and bump
font-size + weight on the inner buttons so the labels survive
the downsample. Earlier we instead hid the whole banner to clear
its empty 46px strip; that's no longer needed once the toggle is
shown, because the banner has real content again.

**Watch out:** chromium rejects nested `:has()`, so we can't write
"hide the banner only when its inner toggle is also hidden" in
pure CSS. If a future banner variant grows truly empty content,
scope it with an additional class (e.g. `.is-filter`) and override
the display rule for that variant.

### 4. `color-mix(..., X%, transparent)` decays to invisible

**Symptom:** subtle background washes (selection highlights, info
boxes) that read clearly in a browser come out as plain bg in
carbonyl. Concrete case: `.diff-add` / `.diff-del` use
`color-mix(in srgb, var(--lane-*) 12%, transparent)` to tint
added/removed rows. In carbonyl those rows render identical to
context, so the only diff cue left is the `+` / `-` marker
column, which makes whole-line scans for "what changed here"
impossible.

**Why:** a 5-15% mix against a high-luminance neutral falls inside
the per-cell quantization step, so the cell paints as the
underlying surface.

**Fix:** hardcode solid hex tints in `carbonyl.css`. Two softer
fixes were tried first and neither held up: bumping the
percentage to 30% kept the wash transparent, and rewriting as
`color-mix(... 30%, var(--card))` (mix against an opaque var
instead of `transparent`) ALSO downsampled to bg. Carbonyl
appears to flatten any subtle wash on a wide row, regardless of
whether the source is technically opaque. The only thing that
read was literal hex (`#c8edd1` light-mode green, `#f7c8c8`
light-mode red, with `prefers-color-scheme: dark` overrides for
the dark theme). The intra-line highlights (`.diff-intra-add` /
`.diff-intra-del`) get bumped a notch harder so within-line diffs
still pop against the now-saturated row wash.

The takeaway is broader than the diff rows: for any wash that
has to survive carbonyl, skip `color-mix` entirely and just
write the hex. `rgba(..., a)` is probably also safer than
`color-mix` but hasn't been needed yet.

### 5. Static elements lose their text after a heavy repaint

**Symptom:** the install banner and diff header render correctly
on initial paint, but after the user scrolls the diff body far
enough (≈50+ `j` steps), the text inside both collapses to
nothing. The nav pill, sha, headline, meta, `Wrap` / `Line #`
toggles, and `Overview →` link all turn into empty borders.

**Why:** same root cause as the keymap hint quirk one section
down: carbonyl's text emitter drops inline runs inside
`position: static` containers when something forces a heavy
repaint. Long scrolls trigger the `.diff-file-head.is-stuck`
class flip (via the IntersectionObserver in `diff.js`), which
seems to be the repaint trigger in this codebase. The top-of-
page elements (banner + diff-head) are statically positioned and
fall out of the emit cycle.

**Fix:** promote both to `position: sticky; top: 0` in
`carbonyl.css`. That gives each its own paint layer, which keeps
the inline glyphs alive across repaints. Visual position is
unchanged (top: 0 anchors at the same y as static), and the
sticky behavior is only a difference when the page scrolls,
which it doesn't (the diff body is the scroller, not the page).

**Watch out:** keep this rule scoped to `.is-carbonyl` so a
real browser at narrow widths (where the diff page already has
its own sticky-file-heads choreography) doesn't gain an extra
pinned banner.

### 6. Nested inline-flex runs drop all glyphs after the first

**Symptom:** the `<j>` key in the keymap hint footer renders, but
`k`, `move`, `c comment`, and everything else after it is silently
dropped. Same thing with the `Split / Inline` view-toggle in the
review banner: only the first label paints.

**Why:** the carbonyl chromium fork emits at most one text-run
per inline-flow box that is part of a `position: static`
container. The hint markup,
`<span class="diff-keymap-item"><kbd>j</kbd><kbd>k</kbd>
<span class="diff-keymap-label">move</span></span>` repeated 6
times, is a chain of inline-flex containers; the emitter sees the
first run and stops. CSS-only mitigations bottom out: increasing
font-size, swapping the chip for plain inline text,
white-space:nowrap over the whole bar, even hiding the real
children and using a `::before content:` string, all produce the
same single-glyph render. Removing `position: static` (the
default for the hint footer's flex layout) by promoting the bar
to `position: fixed` was the trick that finally let the row of
inline glyphs emit fully.

**Fix:** two parts. `carbonyl.css` pins the hint footer to
`position: fixed; bottom: 0` so it gets its own paint layer.
`carbonyl-key-shim.js` registers a MutationObserver that, in
`is-carbonyl` mode, flattens the nested kbd/label markup into a
single inline fragment after every slop re-render. Each key gets
a `<span class="cb-key">` wrapper so the accent color survives;
labels stay as plain text. The shim is a no-op in a real browser
because `isCarbonyl()` short-circuits.

**Watch out:** the `position: fixed` lifts the hint out of the
diff-page flex column, so the diff body no longer reserves space
for it. In a real browser at narrow viewports that would overlap
the last diff line; the carbonyl gate (`.is-carbonyl ...`) keeps
this contained to the terminal render where the trade is worth
it.

### 7. `position: fixed; bottom: 0` lands one row above the terminal bottom

**Symptom:** the keymap-hint footer styled with
`position: fixed; bottom: 0` renders one terminal row above the
actual bottom of the carbonyl pane. A stray row of diff content
shows up underneath it as the user scrolls (the diff body's last
visible row is emitted into that row even though it's been
visually clipped by overflow:auto / padding-bottom in real
chromium). Padding-bottom on .diff-body, max-height on main,
overflow:hidden on .diff-page, even `clip-path: inset(...)` all
fail to stop carbonyl from emitting that bottom-most row.

**Why:** two things at once. (a) Carbonyl's CSS viewport seems
to round down by one terminal row at non-multiple heights, so
`bottom: 0` resolves to the second-to-last row. (b) Carbonyl
emits text from rows that real chromium would clip; the diff
body's overflow:auto doesn't keep its last row from being
rendered into a terminal cell even when CSS says it's hidden.

**Fix:** keep the hint at `position: fixed; bottom: 0` but make
it two terminal rows tall (`height: 28px`) and push its text to
the bottom row via `padding: 14px 8px 0` (one full row of
padding-top). The hint's box still spans rows N-1 and N, the
text lands in row N (the actual terminal bottom), and the hint's
own `bg-deep` background covers row N-1. The diff-body row that
carbonyl emits into "the row before the hint" lands behind the
hint's padding, which reads as the hint's own quiet background
strip rather than a stray code line.

### 8. `font-size: 0` doesn't actually hide glyphs

**Symptom:** to replace the `▲` glyph in `.diff-expand-btn` with
a text label `[e]`, the obvious recipe is set `font-size: 0` on
the button and put `content: "[e]"` on `::before` at 13px. Real
chromium renders just `[e]`. Carbonyl renders `[e]▲`.

**Why:** carbonyl seems to round any non-empty text node up to
one rendered terminal cell, regardless of CSS font-size. It
treats the text node as "present" and emits its glyph at the
cell's natural size.

**Fix:** use `color: transparent` on the button (with
`::before { color: var(--accent) }` for the visible replacement
label). The glyph still emits, but at the same color as the
background, so it disappears under quantization. Don't try
`text-indent: -9999px` here either: it broke the whole carbonyl
render in one experiment, possibly because the negative offset
interacts badly with the terminal cell grid.

### 9. Decorative SVG icons render as blurry smudges

**Symptom (anticipated, not yet hit in this checkout):** any
inline `<svg>` smaller than ~24px square renders as a single muddy
half-cell.

**Why:** the SVG rasterizes at chromium's native DPR, then gets
downsampled to a couple of half-cells. Anti-aliasing has nothing
left to work with.

**Fix recipe:** when adding a new icon, either swap to a Unicode
glyph (preferred, picks up the current font color and renders
cleanly at cell-aligned positions) or guard the SVG with
`.is-carbonyl ... { display: none; }` plus a textual fallback.

### 10. Arrow keys arrive with `e.key === ''` (and no keypress to rehydrate)

**Symptom:** inside the thread modal, Left/Right arrow keys don't step
between threads the way they do in a browser. More broadly, any binding
that switches on `e.key === 'ArrowLeft'` / `'ArrowRight'` never fires in
carbonyl.

**Why:** carbonyl's chromium fork forwards arrow keys with
`windows_key_code` populated (so `e.keyCode` is 37-40) but leaves
`e.key === ''`. Unlike printable keys, arrows emit no `keypress` event, so
the keydown-swallow + keypress-rehydrate path in `carbonyl-key-shim.js`
(which recovers `e.key` for ordinary keys) can't reach them. The keydown
lands on the page with an empty `key`, and every `e.key`-based binding misses.

**Fix:** in `carbonyl-key-shim.js`, a capture-phase keydown handler maps the
arrow key codes (37-40) back to `ArrowLeft` / `ArrowUp` / `ArrowRight` /
`ArrowDown` and re-dispatches a synthetic keydown carrying the proper
`e.key`. A handler's `preventDefault` is mirrored onto the original so native
scroll is suppressed only when something consumed the arrow. In a real
browser arrow keydowns always carry `e.key`, so the path is a no-op there.

**Watch out:** Shift+Arrow (the diff page's commit nav) still can't work in
carbonyl because the fork strips Shift entirely, so that nav stays on the
« / » header buttons. Only plain arrows are recovered here.

## Iteration loop

When tweaking carbonyl styling:

1. Run the slop server (`slop-review --carbonyl` or just `node
   bin/slop-review.js` and open carbonyl yourself).
2. In a parallel tmux session, spawn a fresh carbonyl pointed at
   `http://localhost:<port>/?carbonyl=1`. Don't reuse the main
   pane; you want a controlled width.
3. Capture the rendered output:
   ```bash
   tmux capture-pane -e -p -t <session>:0 \
     | ~/.cache/terminal-screenshot/venv/bin/python \
       ~/code/skills/skills/terminal-screenshot/scripts/ansi2png.py \
       /tmp/snap.png
   ```
   (the python venv is provisioned the first time you run the
   `terminal-screenshot` skill; reuse it.)
4. Diff against a same-viewport browser snapshot:
   ```bash
   npx playwright screenshot --viewport-size=693,994 \
     http://localhost:<port>/ /tmp/snap-browser.png
   ```
5. Iterate. Carbonyl doesn't auto-reload; kill and respawn the
   tmux session after each CSS change.
