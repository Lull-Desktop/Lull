# Pitfalls and troubleshooting

Organised as "symptom -> check first -> fix". Section 1 is the code lookup (`validate`
prints these codes directly), section 2 is toolchain trouble, section 3 is host behaviour.

## 1. Check codes

### error (the host rejects the package, or it cannot run)

| Code | Meaning | Fix |
| --- | --- | --- |
| `W-SCHEMA` / `S-SCHEMA` | `schemaVersion` is not 2 (widget) / 1 (scene) | Follow the template; other versions are rejected |
| `W-TYPE` / `S-TYPE` | `type` is not `widget` / `scene` | Same |
| `W-ID` | id does not match `^[a-z][a-z0-9-]{1,31}$` | Lowercase letter first, `a-z0-9-` only |
| `S-ID` | scene id does not match `^[a-z0-9][a-z0-9._-]{2,63}$` | Prefer `author.scene` |
| `W-VERSION` / `S-VERSION` | not `MAJOR.MINOR.PATCH` | Three numeric segments |
| `W-ENTRY-SAFE` | entry has `..` / `\` / `%` / absolute path / is not `.html` | Use `index.html` |
| `W-ENTRY-MISSING` / `S-ENTRY-MISSING` | the entry file does not exist | Check case (Windows is case-insensitive, the host URL is not) |
| `S-ENTRY-SAFE` | scene entry is not in a subdirectory, or deeper than 6 | Must look like `scenes/<name>/index.html` |
| `S-SINGLE-SCENE` | `scenes` has more than one entry | v1 allows exactly one |
| `S-UNKNOWN-FIELD` | a misspelled scene field | Unknown fields are rejected, never ignored |
| `W-CAPS-*` | unknown / duplicate capability, or `widget.window` / `widget.native` | Only the 7 allowlisted values |
| `S-CAPS-*` | unknown / duplicate capability, or `params`/`sync` without `script` | Add `wallpaper.script` or drop the declaration |
| `W-CHROME-CAP` | `chrome: "custom"` without `widget.chrome` | Add the capability or go back to `host` |
| `W-NET-CAP` | `network` and `widget.network` are not both present | Add or remove both together |
| `W-NET-SOURCE` | origin is not `https://` / `http://localhost:` | Give the exact origin, no wildcards |
| `W-WINDOW-SIZE` | outside 320x240 - 1600x1200 | Fix the manifest |
| `W-WINDOW-RESIZABLE` | `resizable: true` declared | v1 is fixed size; remove it |
| `W-WINDOW-MIN` | minimum size exceeds the initial size | Lower `minWidth`/`minHeight` |
| `S-LICENSE` | content package without `license` | Add an SPDX id (e.g. `CC-BY-4.0`) |
| `S-STATIC-SCRIPT` | `<script>` inside a static package | Delete it, or declare `wallpaper.script` |
| `S-INTEGRITY-MISMATCH` | digest does not match the content | `lull-ext hash <bundle>` |
| `P-REMOTE` / `P-REMOTE-CSS` | references a remote resource | Ship the asset inside the package; APIs go through `network` + `fetch` |
| `P-ABS-PATH` | `src="/..."` | Use `./` |
| `P-INLINE-HANDLER` | `onclick=` and friends | `addEventListener` |
| `P-TAURI` | imports `@tauri-apps/api` | Use the SDK bridge |
| `P-MODULE-MISSING` | a relative import cannot be resolved | `lull-ext vendor <dir>`, or fix the path |

### warn (installs and runs, but breaks the standard)

| Code | Meaning | Fix |
| --- | --- | --- |
| `W-ID-DIR` | directory name != id | Packaging is fine; manual placement under `widgets` will fail |
| `W-VERSION-PRE` | widget version has `-alpha` | Rust accepts three numeric segments only |
| `W-SIZE` | package > 5 MB | Compress images, drop maps |
| `P-STORAGE` | uses localStorage etc. | Switch to `getState/setState` |
| `P-EVAL` | `eval` / `new Function` | Replace the implementation |
| `P-DARK-SCHEME` | `color-scheme: dark` in a transparent window | Scope dark colors to a local container |
| `P-PARENT` | a scene touches `window.top/parent` | Go through `@lull/scene-sdk` |
| `S-PARAM-DEFAULT-RANGE` | default is outside min/max | The host clamps it, so the UI disagrees with reality |
| `S-COMPAT-FUTURE` | `hostApi` above the current host | Filtered out at the catalog layer |
| `S-CAPS-VIEWPORT` | neither viewport nor canvas | Cannot run in mirror mode |
| `S-NO-SCRIPT-FILE` | `script` declared but no js | Add the script or drop the capability |
| `S-THEME-BG` (info) | no `theme.background` | The first frame may flash white |

## 2. Toolchain pitfalls

**`npx` cannot run it**
`npx lull-extension-skill` needs the package published; before that use the local directory
`npx --yes ./Skill/lull-extension`, or `node ./Skill/lull-extension/bin/lull-ext.mjs`. npx
asks for confirmation on first use - add `--yes` in scripts.

**`sdk build` hangs or the clone fails**
HTTPS to github.com frequently times out in some networks. Three options: `--from <local
checkout>` (fully offline), `--refresh` to retry, or clone manually first and then use
`--from`. `git ls-remote --tags <repo>` tells you whether the tag exists.

**`No typescript compiler found`**
Neither the package directory nor the repo root has `node_modules/typescript`. Re-running
with network installs it automatically; offline, point `--from` at a checkout that already
has `node_modules`.

**`--offline` fails immediately**
`--offline` only makes sense together with `--from` (no network means no clone). It does not
block the following `npm install`; if dependencies are missing too, run once with network.

**`tsc` reports a pile of "Cannot find module" (Windows)**
This machine cannot create symlinks, so pnpm's default isolated layout silently produces an
empty `node_modules`. Use `pnpm install --config.node-linker=hoisted`, or just let this skill
run `npm install` per package. When running pnpm scripts, add
`--config.verify-deps-before-run=false`, otherwise pnpm reinstalls with the default linker.

**A zip built with `Compress-Archive` will not install**
It writes backslash entry names and the installer rejects the whole package. Use
`lull-ext pack` (forward slashes + UTF-8).

**Editing `main.js` and hitting reload shows no change**
The browser cached the entry. In developer mode add a version query to the reference
(`./main.js?v=2`), or just `pack` and reinstall.

**`pack` says "Cannot read id / version from the manifest"**
The manifest is not valid JSON or a field is missing. Run `validate` first; it names the field.

## 3. Host behaviour pitfalls

**White screen, a wall of CSP errors**
One of: remote resource, inline event handler, `eval`. The host injects a nonce into inline
`<script>` blocks but **never** allows `onclick=` attributes.

**`not-embedded`**
Opening the HTML directly triggers it; so does a blocked handshake inside the host
(protocol mismatch, missing token). The template turns `not-embedded` into "run this inside
Lull".

**Transparent window turns black**
`color-scheme: dark` on `html`/`:root`: WebView2 paints the iframe canvas opaque, so
`background: transparent` no longer shows the desktop. Scope dark colors to a container.

**The window will not drag**
With `chrome: "custom"` you must bind the drag region yourself
(`pointerdown -> startDrag()`), and exclude buttons (`event.target.closest("button")`). With
`chrome: "host"` do not draw a title bar - it collides with the host one.

**Closing the window does not exit**
By design: `close()` hides and the process stays in the tray. To really destroy the window,
declare `lifecycle: "suspend"`.

**The window cannot be resized**
v1 is fixed size; `requestResize` only reports measurements (`applied: false`).

**A revoked capability silently breaks a feature**
Grants are per capability and revocable. Check `has(cap)` at startup and degrade (no audio ->
silent but still timing; no chrome -> fall back to the host bar, stop drawing your own).

**Network still works after revoking it**
CSP only tightens when the page loads; disable and re-enable the plugin for it to take effect.

**Changing a scene param does nothing**
Check three things: the manifest declares both `wallpaper.params` and `wallpaper.script`;
the code subscribes with `onFrame` (it replays once on subscribe); the `params` key matches
what the code reads.

**The scene is installed but missing from settings**
`compatibility.hostApi` is above the host version, or `platforms` excludes `windows` -
filtered at the catalog layer, without an error.

**Installing a new version does not change the wallpaper**
The host rebuilds the iframe from the manifest `version`; an unchanged version means no
rebuild. Bump the version (or uninstall and reinstall).

**Digest mismatch blocks loading**
Content changed without recomputing: `lull-ext hash <bundle>`; the official catalog also
needs `pnpm content:sign` to re-sign.

**`vendor/` at the bundle root 404s after install**
A content package resolves relative paths from the entry directory and the digest only
covers that layer, so `vendor/` must sit next to the entry (`scenes/<name>/vendor/`).
`lull-ext vendor` already places it correctly.

**Vue runtime templates hit a CSP error**
`eval` is blocked; use the compiled build of Vue (precompiled templates), not the runtime
template compiler.
