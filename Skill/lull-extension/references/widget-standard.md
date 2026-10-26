# Tool extension (widget) standard

> Sources of truth: `src-tauri/src/widget_package/manifest.rs` (manifest hard rules),
> `docs/widget-sdk.md` (artefacts and sandbox contract), `packages/widget-sdk/README.md`
> (client API). This is the operational version for creators and AI; if it disagrees with
> the code, the code wins and this file should be fixed.

## 1. A widget = a static site + one manifest

```text
<id>/
  widget.json      # required, schemaVersion 2
  index.html       # the entry, required
  main.js          # optional (inline works too, the host injects a nonce)
  style.css
  assets/
  vendor/          # SDK copy added by this skill (native ESM)
```

Install location: `%APPDATA%\app.lull.desktop\widgets\<id>\` (override with
`LULL_WIDGETS_DIR`).
Load URL: `http://lullwidget.localhost/<id>/<entry>`.
Relative paths only, single-entry HTML, hash routing, no site-root assumptions.

## 2. Manifest field table

```json
{
  "schemaVersion": 2,
  "type": "widget",
  "id": "community-pomodoro",
  "name": "Pomodoro",
  "version": "1.0.0",
  "description": "Focus timer",
  "author": "Lull",
  "license": "MIT",
  "builtin": false,
  "hostApi": 1,
  "entry": "index.html",
  "icon": "assets/icon.png",
  "lifecycle": "background",
  "capabilities": ["widget.ui", "widget.theme", "widget.state", "widget.chrome"],
  "window": {
    "width": 560,
    "height": 680,
    "minWidth": 520,
    "minHeight": 620,
    "resizable": false,
    "transparent": true,
    "chrome": "custom"
  },
  "network": []
}
```

| Field | Required | Rule (violation = rejected) | Code |
| --- | --- | --- | --- |
| `schemaVersion` | yes | fixed `2` | `W-SCHEMA` |
| `type` | yes | fixed `"widget"` | `W-TYPE` |
| `id` | yes | `^[a-z][a-z0-9-]{1,31}$`; equals the install directory name | `W-ID` / `W-ID-DIR` |
| `name` | yes | 1-64 characters | `W-NAME` |
| `version` | yes | `MAJOR.MINOR.PATCH` only (Rust rejects `-alpha`) | `W-VERSION` / `W-VERSION-PRE` |
| `license` | no | SPDX id recommended | `W-LICENSE` |
| `builtin` | no | must be `false` (or omitted) | `W-BUILTIN` |
| `hostApi` | no | `1` (the only value this host accepts) | `W-HOSTAPI` |
| `entry` | yes | package-relative `.html`, <= 128 chars, no `..` / `\` / `%` / absolute path | `W-ENTRY-SAFE` / `W-ENTRY-MISSING` |
| `icon` | no | package-relative `.png/.jpg/.jpeg/.webp`, no path segment starting with `.` | `W-ICON` |
| `lifecycle` | no | `background` (close hides, default) or `suspend` (close destroys) | `W-LIFECYCLE` |
| `capabilities` | yes | non-empty, no duplicates, only the 7 in §3 | `W-CAPS-*` |
| `window.width/height` | yes | 320x240 - 1600x1200 | `W-WINDOW-SIZE` |
| `window.minWidth/minHeight` | no | must not exceed the initial size | `W-WINDOW-MIN` |
| `window.resizable` | no | **must be `false`** (fixed size in v1) | `W-WINDOW-RESIZABLE` |
| `window.transparent` | no | initial transparency, default `true` | - |
| `window.chrome` | no | `host` (default, host draws the bar) / `custom` (self-drawn) | `W-WINDOW-CHROME` |
| `network` | no | `https://` or `http://localhost:<port>`, <= 256 chars, no whitespace/quotes/semicolons | `W-NET-SOURCE` |

`window.chrome: "custom"` <=> `widget.chrome` must be requested; a non-empty `network`
<=> `widget.network` must be requested.

## 3. Capability matrix

| Capability | Kind | What you get | What you must do |
| --- | --- | --- | --- |
| `widget.ui` | declared | UI / CSS / animation inside the iframe | nothing |
| `widget.theme` | soft | `theme.colors.{a,b,c,accentLight,accentDark,onAccentLight,onAccentDark}` | use it; ignoring it still works |
| `widget.state` | hard | host KV: `getState/setState/removeState` | no self-managed storage; keys `[A-Za-z0-9._-]` 1-64; one value <= 32 KiB, 256 KiB total |
| `widget.audio` | soft | `requestAudio()` returns whether it was granted | run silently when denied; never `new AudioContext()` unconditionally |
| `widget.media` | soft | the check before importing local media | do not pretend you can pick files when denied |
| `widget.network` | hard | only the origins in the manifest enter the CSP | keep the allowlist precise, no wildcards |
| `widget.chrome` | hard | `startDrag/minimize/setTransparent` (`close` needs no grant) | with `chrome: "custom"` draw the drag region and buttons yourself |

Not requestable: `widget.window` (create/control windows), `widget.native` (Win32 / native
host). Either one rejects the package at load.

## 4. Artefact rules

1. Single-entry HTML, all assets relative (bundlers: `base: "./"`).
2. Hash routing; never touch `window.top`.
3. No remote scripts/fonts/styles/images; for APIs declare the origin in `network` and use `fetch()`.
4. No `@tauri-apps/api` import (`P-TAURI`).
5. No reliance on `eval` / `new Function` (Vue runtime templates, some hot-reload runtimes).
6. Inline `<script>` gets a host nonce; inline event attributes (`onclick=`) **do not work** -
   use `addEventListener`.
7. Keep a package under 5 MB; drop `.map` files.
8. Opaque origin: no `localStorage` / cookie / IndexedDB / Service Worker / host DOM.

## 5. Runtime contract

```text
window label = widget-<id>
  `- host shell (owns the Tauri IPC)
       |- chrome: host   -> host draws the title bar
       |- chrome: custom -> nothing drawn, the plugin does it
       `- iframe (opaque origin) -> plugin page + @lull/widget-sdk
```

- Handshake: `ready` -> host `init { id, hostApi, capabilities, window, theme, viewport, token }`;
  every later request carries `token` (the host rejects impersonated requests).
- Timeouts: `init` 10 s by default, each request 8 s.
- Close = hide (Alt+F4 too); the process stays in the tray. `suspend` destroys the window.
- `setTransparent(color?)` only changes the WebView background; it does not recreate the
  window or reload the page. Transparent windows have no native shadow on Windows.
- Capability revocation: users can revoke any capability. Revoking `widget.chrome` falls
  back to the host title bar, so your code must tolerate it.

## 6. State and integrity

- State files live on the host side (`.state/<id>.json`); the plugin id is derived from the
  window label, ids inside messages are not trusted.
- Revoking a grant or uninstalling clears state; disabling keeps it. **There is no
  migration** - store a version field and handle old shapes yourself.
- Installation creates a local digest lock `.lull-integrity.json` (a sidecar file excluded
  from the digest and not served by the CSP protocol). If the lock exists and does not
  match, loading is blocked. Algorithm:
  `sha256("lull-widget-package\0"+id+"\0"+version+"\0"+Σ(relPath+"\0"+size+"\0"+bytes+"\0"))`,
  skipping dot-prefixed paths.
- No publisher signatures, no online catalog, no auto-update.

## 7. Minimal acceptance (manual)

- [ ] Install on a real machine; the card shows the right name / version / capabilities
- [ ] The first enable prompts for consent; denying one item degrades gracefully
- [ ] Custom chrome: dragging follows the pointer, minimise goes to tray, state survives reopen
- [ ] Transparent mode shows the desktop through, with no black plate
- [ ] Offline, or with audio denied, nothing blocks or throws
- [ ] Uninstall leaves no directory behind; reinstalling overwrites cleanly
