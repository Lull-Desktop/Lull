# Extension design and development playbook (execution order for AI)

Goal: go from a vague request to an extension that installs, works, and looks designed.
The order is not optional: **kind -> capabilities -> data -> interaction -> visuals ->
implementation -> validation -> real device**. Skipping a step usually comes back later as
"white screen / state lost / nothing responds".

## 1. Clarify (pick a default and keep moving; do not stall)

Only five questions really change the structure. Answer them, decide the rest yourself:

| Question | Impact | Default |
| --- | --- | --- |
| Does the user open it and operate it? | widget vs scene | yes -> widget |
| Does it need to **remember** something (prefs/progress/history)? | `widget.state` and the data model | yes -> one `prefs` object plus one `data` object |
| Does it need its own **window look** (frameless/transparent/custom buttons)? | `window.chrome` | yes -> `custom` + `widget.chrome` |
| Does it need the network? | `network` + `widget.network` | no, unless stated |
| What should the user tune in a wallpaper scene? | `params` | strength / color / speed is enough |

A read-only display tool ("hours left today") does not need `widget.state`. A pure
background scene should request no widget capabilities at all. **Every capability is a
consent prompt**; each extra one costs the user attention.

## 2. Derive features from the capability list

Write the capability list first, then the features - the other order always over-requests:

```text
Feature: pomodoro (25 min focus + chime + remembers last settings)
Caps:    widget.ui (UI), widget.theme (follow theme), widget.state (settings + progress),
         widget.audio (chime), widget.chrome (custom title bar)
Not requested: widget.network (offline), widget.media (no file picking)
Window:  520x640, transparent: true, chrome: "custom"
```

When a feature needs a capability that cannot be requested (a second window, native calls,
arbitrary file access), **change the requirement, do not work around it**: "multiple
windows" becomes "tabs", "read a local file" becomes "a media file the user dropped in +
`widget.media`".

## 3. Data model

- **Few, coarse keys**: `prefs` (user settings), `data` (payload), `ui` (session-only, may
  stay in memory). One round trip per key, so do not split 20 fields into 20 keys.
- **Version it**: `prefs.__v = 1`. On upgrade read the old shape, fill defaults, write the
  new one. There is no migration mechanism; you are it.
- **Size budget**: 32 KiB per value, 256 KiB per plugin. History keeps summaries (time plus
  key metrics), not full text.
- **Defaults are the contract**: always pass a fallback to `getState(key, DEFAULTS)`, so the
  first run and a revoked grant do not crash.

```js
const DEFAULTS = { __v: 1, focus: 25, rest: 5, sound: true };
const prefs = await client.getState("prefs", DEFAULTS);
```

## 4. Interaction skeleton (clickable before pretty)

Build in this order; every step must run:

1. **Connection state**: connecting / connected / failed (`not-embedded` needs an actionable
   message, not a blank page).
2. **Primary action**: one button that produces feedback immediately (start, log, toggle).
3. **Secondary actions**: settings, reset, skip - placed so they do not compete.
4. **Status feedback**: progress, time left, last action time.
5. **Empty state**: what to say when there is no data (never an empty panel).

Keyboard and accessibility: tab order follows visual order; icon-only buttons need
`aria-label`; timers/counters use `aria-live="polite"`; never fake a button with a `div`.

## 5. Visuals

- **Colors come from host tokens only**: `theme.colors.{a,b,c,accentLight,accentDark,onAccentLight,onAccentDark}`.
  Hardcoded colors turn to mud under someone else's theme.
- **Transparency is a backdrop, not a style**: the desktop shows through, so text needs a
  sufficiently opaque plate (`color-mix` at ~88%), otherwise it is unreadable over a busy
  wallpaper.
- **Sizes**: tools start at >= 380x480 (the host minimum is 320x240, too small for title +
  content + buttons). Use a 4px grid, 10-14px radii, 13-14px body text, tabular numerals
  for numbers.
- **At most three layers** (background / card / accent); the accent color goes to the
  primary action and one focal point.
- **Motion**: state transitions <= 200ms; everything must stop under
  `prefers-reduced-motion`.
- **No remote fonts** (CSP blocks them): system font stack plus a locally bundled woff2.

## 6. Designing a wallpaper scene

- **One idea per image**: gradient, particles, geometry or typography - pick one and do it well.
- **3-5 params**, prefer physical quantities with meaningful ranges: `glow 0-1`,
  `breathing period 4-40 s`, `tint #RRGGBB`. Never expose internal knobs like `blur2` or
  `layer3opacity`.
- **The default is the finished piece**: untouched params should already be the best version.
- **No first-frame flash**: `theme.background` must equal the page background.
- **Resident-process discipline**: a wallpaper runs all day. Start at `low` + 30fps; prefer
  CSS animation over per-frame JS; pause when invisible (`onVisibility`).
- **Multi-monitor**: when declaring `wallpaper.canvas`, lay out against `canvas.w/h` and do
  not assume a single screen. If it is not ready, do not declare it - degrade to viewport.

## 7. Anti-patterns

| Anti-pattern | Why it fails | Do instead |
| --- | --- | --- |
| `localStorage` for settings | unavailable in an opaque origin | `widget.state` |
| `new AudioContext()` straight away | throws when audio is not granted | `has("widget.audio") && await requestAudio()` |
| CDN fonts / icon packs | CSP blocks them | bundle SVG / woff2 locally |
| Inline `onclick` | CSP forbids it | `addEventListener` |
| Explanatory paragraphs in the panel | a tool window is not a document | tooltip, or one line in the empty state |
| `Date.now()` phase per frame in a scene | monitors drift apart | `syncedDelayMs` |
| Requesting every capability | scares users, widens the revoke surface | minimal set |
| Hand-editing the SDK inside `dist/` | unreproducible version drift | re-run `sdk build` + `vendor` |
| `<script>` in a static scene | the empty sandbox never runs it | declare `wallpaper.script` or delete it |
| Copying the `examples/widgets/pomodoro-*` build chain | each uses a different bundler setup | this skill's template + vendor |

## 8. Pre-delivery self-check (walk it item by item)

- [ ] `lull-ext validate <dir> --strict` has no errors and no warnings
- [ ] Every capability in the manifest is actually used somewhere in the code
- [ ] Connection failure / denied grant / empty data all have visible copy
- [ ] State survives window close and app restart (widget)
- [ ] Nothing animates endlessly under reduced motion
- [ ] Body text is readable over a transparent window (not floating transparent text)
- [ ] The zip from `pack` was installed once on a real machine, version bumped
- [ ] The in-package README says how to install, how to change things, and what the limits are

## 9. Iteration rhythm

One thing per round; run `validate` at the end of every round:

1. Skeleton runs (connect + one button) -> validate
2. Main loop closes (one full use of the tool) -> validate + real device
3. State and edges (empty, error, revoked grant) -> validate
4. Visual polish (tokens, density, contrast) -> validate + real device
5. Packaging and version (README, license, version) -> pack

Never start with visuals before the skeleton runs: the look of a transparent window in a
disconnected state will mislead you.
