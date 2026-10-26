# Extension standard (general rules)

> This document defines what counts as a valid Lull extension. The two companion
> documents (`widget-standard.md` / `scene-standard.md`) cover per-kind fields; shared
> constraints, versioning and release gates live here.
> The source of truth is always the code: `src-tauri/src/widget_package/`,
> `src-tauri/src/content_package/`, `src/sdk/{widget,scene}/`. If this text disagrees
> with the code, the code wins.

## 1. Two contracts, not one subset of the other

| Dimension | widget (tool) | scene (wallpaper) |
| --- | --- | --- |
| Manifest | `widget.json`, schemaVersion **2** | `catalog.json` + one scene, schemaVersion **1** |
| Install location | `%APPDATA%\app.lull.desktop\widgets\<id>\` | `%APPDATA%\app.lull.desktop\content\<pkg>\` |
| iframe | `allow-scripts`, opaque origin | `""` (static) or `allow-scripts` (script) |
| Host capabilities | postMessage bridge + capability grants (7) | frames and params only (5 capabilities, read-only) |
| State | host Rust KV | none (scenes do not persist anything) |
| Integrity | `.lull-integrity.json` digest lock | `integrity` inside `catalog.json` (+ official catalog signature) |
| Lifecycle | enable / disable / uninstall; close = hide | install / uninstall; loaded by wallpaper mode |
| SDK | `@lull/widget-sdk` | `@lull/scene-sdk` |
| Artefact | `<id>-<version>.lull-widget.zip` | `<id>-<version>.zip` |

### Decision tree

```text
Does the user open and operate it? -- yes -> widget
   |-- needs to remember preferences/progress? -> widget.state
   |-- needs its own window look (frameless/transparent)? -> window.chrome = "custom" + widget.chrome
   `-- needs to reach an API? -> network allowlist + widget.network
Does it sit behind the desktop and stay quiet? -- yes -> scene
   |-- user should tune strength/color/speed? -> wallpaper.params + wallpaper.script
   |-- should span multiple monitors? -> wallpaper.canvas
   `-- pure CSS light and shadow is enough? -> static package (no script capability)
Both? -> split into two extensions; never mix manifest kinds in one package
```

## 2. Shared hard constraints

| ID | Constraint | If violated | Check code |
| --- | --- | --- | --- |
| E-01 | Package paths are relative and forward-slash; `entry` never escapes | Install rejected / 404 | `W-ENTRY-*` `S-ENTRY-*` |
| E-02 | No remote resources (CDN, fonts, images) | CSP blocks it, white screen | `P-REMOTE` |
| E-03 | No inline event handlers | CSP blocks the binding | `P-INLINE-HANDLER` |
| E-04 | No `@tauri-apps/api`, no `__TAURI_INTERNALS__` | Undefined behaviour (unsupported API) | `P-TAURI` |
| E-05 | No localStorage / cookie / IndexedDB (opaque origin) | Runtime throws or silently fails | `P-STORAGE` |
| E-06 | No dependency on `eval` / `new Function` | Blocked under host CSP | `P-EVAL` |
| E-07 | Keep a package under 5 MB, drop sourcemaps | Slow install/load, host limits | `W-SIZE` |
| E-08 | Respect `prefers-reduced-motion` | Accessibility failure | manual |
| E-09 | No invented near-synonym field names | scene rejects; widget silently ignores | `S-UNKNOWN-FIELD` |
| E-10 | `license` must be declared (mandatory for content packages) | Cannot distribute legally | `S-LICENSE` |

## 3. Versions and compatibility

- **Three independent versions**: package `version` (yours), `hostApi` (host API),
  `protocol` (bridge protocol). Upgrading the SDK only changes how you call the bridge;
  it does not change the host API.
- Current values: `WIDGET_HOST_API = 1`, `SCENE_HOST_API = 1`, `WIDGET_PROTOCOL = 1`,
  `SCENE_PROTOCOL = 1`, widget `schemaVersion = 2`, scene/catalog `schemaVersion = 1`.
- `schemaVersion` only increments for breaking field changes; new optional fields do **not**
  bump it.
- A host that meets an unsupported schemaVersion rejects that package (for scenes it skips
  just that entry) instead of crashing.
- `compatibility.hostApi` (scene) declares the minimum host; `maxHostApi` the maximum.
  Widgets only have `hostApi` (currently `1`).
- Upgrades overwrite the same id. There is no rollback, no downgrade protection and no
  auto-update. **Verify in developer mode before publishing**, and bump the manifest
  version (otherwise the host will not rebuild the iframe).

## 4. Naming and directories

- widget id: `^[a-z][a-z0-9-]{1,31}$`, and the install directory must match. Prefer
  `author-feature`, e.g. `community-pomodoro`.
- scene id: `^[a-z0-9][a-z0-9._-]{2,63}$`, prefer `author.scene`, e.g. `community.mist`.
  **Never change a published id** (a rename is a new scene).
- The scene directory name need not equal the id (`scenes/mist/` may hold
  `community.mist`); `entry` is the only source of truth.
- Never ship `node_modules/` inside a package (bundled output is fine, dependency trees
  are not).

## 5. Release gate (before packing)

1. `lull-ext validate <dir> --strict` is fully green (0 errors, 0 warnings).
2. Walk the manifest fields against section 1: id / version / entry / capabilities /
   window / network.
3. Minimal capabilities: request nothing you do not use. Every extra capability is an
   extra consent prompt and one more thing the user can revoke.
4. Real-device acceptance: the checklist in `widget-standard.md §7` or `scene-standard.md §9`.
5. Install the zip produced by `pack` once (not "it should install").
6. The version is bumped and carries no prerelease suffix (the widget Rust check accepts
   three numeric segments only).

## 6. Things that pass validation but users will complain about

- A 320x240 window: legal per manifest, but the title plus content plus buttons do not fit.
  Tools should start at >= 380x480.
- Fully transparent with no border: it looks like floating text and has no obvious drag
  region. Keep at least a visible bar or border.
- A scene burning 100% CPU: `performance.targetFps: 60` while a full-screen gradient is
  repainted every frame. Wallpapers run all day; start at `low` + 30fps.
- Technical param names: `blur2`, `p1`. Users see `label`, so write human words
  ("Glow blur (px)").
- Too many state keys: one round trip per key, dozens of keys make the window open slowly.
  Merge into a single prefs object.

## 7. Licensing

| Scope | License |
| --- | --- |
| `src/sdk/widget|scene/**`, `packages/*-sdk/**` | Apache-2.0 (`SDK-LICENSE.md`) |
| Built-in scenes `src/scenes/**`, the app itself | GPL-3.0-or-later |
| Official content examples `public/content/**` | CC BY 4.0 (`CONTENT-LICENSE.md`) |
| Third-party extensions | Author's choice, but the manifest `license` field is required |

Do not copy built-in tools or built-in scenes when writing a third-party extension. Those
run on the compile-time contract (`src/sdk/widget`, `src/scenes/**`, same-origin
`localStorage`, resizable windows that can switch sides); third-party code runs on the
sandbox contract. Copying gets you a pile of "why does this API not exist".
