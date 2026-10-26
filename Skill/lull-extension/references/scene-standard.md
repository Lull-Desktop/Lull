# Wallpaper scene (content package) standard

> Sources of truth: `src-tauri/src/content_package/manifest.rs` (hard rules),
> `src/sdk/scene/manifest.ts` (field-level schema), `docs/scene-sdk.md` (runtime and
> frames), `docs/content-format.md` (field details).
> If this text disagrees with the code, the code wins and this file should be fixed.

## 1. The install unit is one content root

```text
<bundle>/
  catalog.json                 # { schemaVersion: 1, scenes: [ exactly one scene ] }
  scenes/<name>/
    index.html                 # entry, must live in a subdirectory
    main.js                    # script scenes only
    vendor/scene-sdk/          # script scenes only; must sit next to the entry (the digest covers this layer)
    assets/
```

Install location: `%APPDATA%\app.lull.desktop\content\<package>\` - structurally identical
to the official `public/content/`.
`catalog.json` deliberately sits outside the entry directory: the digest only covers the
entry directory, so writing the integrity back cannot change the bytes being hashed.

## 2. catalog.json

```json
{
  "schemaVersion": 1,
  "scenes": [
    {
      "schemaVersion": 1,
      "type": "scene",
      "id": "community.mist",
      "name": "Mist",
      "version": "1.0.0",
      "description": "Thin fog over distant hills.",
      "author": "Lull Community",
      "license": "CC-BY-4.0",
      "capabilities": ["wallpaper.viewport", "wallpaper.canvas", "wallpaper.params", "wallpaper.script"],
      "entry": "scenes/mist/index.html",
      "theme": { "background": "#0a1416", "accent": "#9fc7c2" },
      "params": [
        { "key": "glow", "type": "number", "label": "Glow strength", "default": 0.5, "min": 0, "max": 1, "step": 0.05 },
        { "key": "tint", "type": "color", "label": "Glow color", "default": "#9fc7c2" }
      ],
      "performance": { "tier": "low", "targetFps": 30 },
      "compatibility": { "hostApi": 1, "platforms": ["windows"] },
      "integrity": { "algorithm": "sha256", "scope": "package", "digest": "<64 hex>" }
    }
  ]
}
```

Hard rules:

- `catalog.schemaVersion` = 1; `scenes` holds **exactly one** entry (v1 installer limit).
- The single scene has `schemaVersion` = 1 and `type` = `"scene"`.
- **Unknown fields are rejected** (catch typos early); only the keys above are allowed.

| Field | Required | Rule | Code |
| --- | --- | --- | --- |
| `id` | yes | `^[a-z0-9][a-z0-9._-]{2,63}$`, `author.scene` recommended | `S-ID` |
| `name` | yes | <= 80 characters | `S-NAME` / `S-NAME-LEN` |
| `version` | yes | semver | `S-VERSION` |
| `license` | yes | non-empty (SPDX id or name) | `S-LICENSE` |
| `capabilities` | yes | non-empty, no duplicates, allowlist | `S-CAPS-*` |
| `entry` | yes | relative `.html`, **at least two segments**, depth <= 6, no `..`/`\`/`%`/NUL, must exist and must not escape the root | `S-ENTRY-*` |
| `description` / `author` | no | display only | - |
| `theme.background` | no | `#RRGGBB`, prevents a first-frame flash | `S-THEME-COLOR` |
| `theme.accent` | no | `#RRGGBB`, used by the catalog and settings | `S-THEME-COLOR` |
| `params` | no | see §4 | `S-PARAM-*` |
| `performance.tier` | no | `low` / `medium` / `high` | `S-PERF-TIER` |
| `performance.targetFps` | no | integer 1-240 | `S-PERF-FPS` |
| `compatibility.hostApi` | no | positive integer, current host `SCENE_HOST_API = 1` | `S-COMPAT-HOSTAPI` |
| `compatibility.maxHostApi` | no | >= `hostApi` | `S-COMPAT-MAX` |
| `compatibility.platforms` | no | `windows` / `macos` / `linux`, non-empty, unique | `S-COMPAT-PLATFORM` |
| `integrity` | official catalog only | `{algorithm:"sha256", scope:"package", digest:64 hex}` | `S-INTEGRITY-*` |

## 3. Capabilities

| Capability | Meaning | Host behaviour |
| --- | --- | --- |
| `wallpaper.viewport` | can fill a single viewport | required for mirror/independent; without it (and without canvas) the scene cannot run |
| `wallpaper.canvas` | supports shared canvas coordinates across screens | without it, span mode degrades to viewport |
| `wallpaper.sync` | can align animation phase to absolute time | without it `frame.sync.enabled` is always false; external packages also need `wallpaper.script` |
| `wallpaper.params` | accepts manifest parameters | required when `params` is declared; external packages also need `wallpaper.script` |
| `wallpaper.script` | may execute JS in a `sandbox="allow-scripts"` iframe | external packages only; without it the package loads as static (empty sandbox) |

A scene whose `compatibility.hostApi` exceeds the host, or whose platform does not match, is
filtered out at the catalog layer - it simply does not appear in settings (not an error).

## 4. params

```json
{ "key": "glow", "type": "number", "label": "Glow strength",
  "description": "0 is off, 1 is brightest.", "default": 0.5, "min": 0, "max": 1, "step": 0.05 }
```

Every rule below is enforced:

- `key`: `^[a-z][a-z0-9._-]{0,31}$`, unique per scene; `label` non-empty; `default` required.
- Types: `number` (finite) / `boolean` / `string` / `color` (`#RRGGBB`) / `enum` (non-empty
  `options`; `default` must hit one of `options.value`; option values unique).
- `min`/`max`/`step` apply to **number only**; `min <= max`, `step > 0`.
- `options` applies to **enum only**; unknown fields are rejected.
- A number with both `min` and `max` renders as a slider; otherwise a numeric input.
- Changing a parameter writes config, hot-updates the wallpaper URL hash, `SceneHost`
  recomputes the frame and the bridge pushes `frame` - no wallpaper restart.

## 5. Static vs script packages

| Dimension | Static (no `wallpaper.script`) | Script (`wallpaper.script`) |
| --- | --- | --- |
| iframe sandbox | `""` (no script executes at all) | `allow-scripts` (no `allow-same-origin`) |
| Geometry | pure CSS (`100%` / `vw` / `vh`) | `frame.viewport` / `frame.canvas` / `frame.view` |
| Params | **cannot be declared** (validator rejects) | via `frame.params` |
| Sync phase | **cannot be declared** (validator rejects) | `syncedDelayMs(period, frame.sync.epochMs)` |
| Animation | `@keyframes` | `requestAnimationFrame` / WebGL allowed |
| Weight | keep it tiny (the first frame is everything) | watch CPU/GPU; set a realistic `performance.targetFps` |

A `<script>` inside a static package is an **error** (`S-STATIC-SCRIPT`): it never runs and
only misleads readers.

## 6. Runtime frame

```ts
type SceneFrame = {
  mode: "mirror" | "independent" | "span";
  layout: "viewport" | "canvas";
  sync: { enabled: boolean; epochMs: number };
  viewport: { w: number; h: number; dpr: number };   // CSS pixels
  canvas: { x, y, w, h } | null;                     // physical pixels, non-null only in span
  view: { x, y, w, h } | null;                       // current monitor rect (physical pixels)
  dpr: number;
  params: Record<string, string | number | boolean>;
  reducedMotion: boolean;
  performance: { tier: "low" | "medium" | "high"; targetFps?: number } | null;
};
```

- `layout: "viewport"` -> fill the window; `layout: "canvas"` -> you sit inside a canvas
  container (already offset by `view`), so lay out against `canvas.w/h` and never assume the
  window size.
- `sync` is only enabled when the scene declares `wallpaper.sync` and the mode needs it;
  **build a negative `animation-delay` with `syncedDelayMs`**, never `Date.now()`.
- `reducedMotion: true` -> stop continuous animation (CSS media query + JS guard).
- Parameter change chain: Settings -> Rust writes config -> URL hash hot-update ->
  `SceneHost` recomputes -> bridge pushes `frame`.

## 7. Digest and installation

Digest algorithm (identical to `scripts/content-digest.mjs`):

```text
sha256("lull-content-package\0" + id + "\0" + version + "\0" +
       Σ(relPath + "\0" + size + "\0" + bytes + "\0"))   // relPath sorted by UTF-8 bytes
```

- Covers the **entry directory** (`scenes/<name>/**`), excludes `catalog.json` and
  everything else at the bundle root. Therefore `vendor/`, images and `main.js` must live
  inside the entry directory, otherwise they are not locked.
- Symlinks are rejected (the digest must cover the bytes the runtime reads).
- Recompute after any content change: `lull-ext hash <bundle>` (`pack` does it for you).
- Installing the same id again **overwrites** (backup then replace) and the wallpaper
  rebuilds the iframe per `version`. There is **no version comparison, no rollback and no
  downgrade protection**.
- The official catalog additionally signs `catalog.json` bytes with `catalog.sig.json`;
  third-party packages have no signature, so the digest only proves "the package was not
  modified", not where it came from.

## 8. Security boundary

Allowed: CSS/JS animation, Canvas/WebGL, reading `frame.params` and geometry, writing to the
host console through the bridge.

Forbidden: host DOM, arbitrary Tauri IPC, native calls, writing config, creating windows,
installing other packages, microphone/filesystem/network access. Remote scripts, fonts,
images and audio are blocked by CSP (`script-src` allows only the package origin plus a
nonce, `connect-src` only the package itself).

> Loading an HTML package or running sandboxed script is not a full plugin permission
> system. Scenes have no entry point for writing config, opening windows, calling native
> code or installing packages - do not design features that assume they exist.

## 9. Minimal acceptance (manual)

- [ ] Appears on the Wallpaper page with correct name / version / license / source
- [ ] mirror / independent / span all render without cropping or offset errors
- [ ] Param controls appear and apply immediately (script scenes); static packages show none
- [ ] No white flash on the first frame (`theme.background` set)
- [ ] Animation stops under reduced motion
- [ ] No tearing across monitors (when `wallpaper.canvas` is declared)
- [ ] Reinstalling the same id bumps the version and rebuilds the wallpaper
