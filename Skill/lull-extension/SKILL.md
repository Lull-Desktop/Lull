---
name: lull-extension
description: "Builds extensions for the Lull desktop app: tool widgets (@lull/widget-sdk, sandboxed iframe + postMessage bridge) and wallpaper scene content packages (@lull/scene-sdk, static or script scenes). Covers the whole chain: fetch and compile the latest SDK from packages/ on GitHub, scaffold per the extension standard, validate the manifest and artefacts offline, and pack an installable zip; the skill itself follows the Agent Skills spec and installs into multiple agents with the generic skills CLI. Use when the user wants a Lull plugin / tool window / wallpaper / scene / content package, needs to compile or update widget-sdk / scene-sdk, is debugging why an extension will not install, is rejected by the host, shows a white screen, loses state, ignores parameter changes, or needs the extension packed as a zip."
license: GPL-3.0-or-later
compatibility: "Requires Node.js >= 20 plus a built SDK (lull-ext sdk build); the SDK source comes from a local Lull checkout or from GitHub over the network. git and npm optional. The Lull desktop app is only needed to verify extensions on a real machine. No Rust, Tauri or pnpm required."
metadata:
  version: "0.1.0"
  argument-hint: "sdk build | new widget <dir> | new scene <dir> | vendor <dir> | validate <dir> | pack <dir>"
  agent_created: "true"
---

# Lull extension development

Lull has two **parallel, non-interchangeable** extension contracts. Decide which one you are
writing before anything else:

| Kind | What it is | Where it runs | SDK | Manifest | Artefact |
| --- | --- | --- | --- | --- | --- |
| **widget** (tool) | A standalone small window tool (pomodoro / player / timer / clipboard...) | `sandbox="allow-scripts"` opaque-origin iframe inside a host shell window | `@lull/widget-sdk` | `widget.json` (schemaVersion 2) | `<id>-<version>.lull-widget.zip` |
| **scene** (wallpaper) | A wallpaper-layer content package (static HTML/CSS or script scene) | Wallpaper window iframe (`sandbox=""` or `sandbox="allow-scripts"`) | `@lull/scene-sdk` | `catalog.json` + one scene (schemaVersion 1) | `<id>-<version>.zip` |

Capability vocabulary, digest algorithm, install location and lifecycle all differ. **Never
reuse one for the other.** Classic symptoms of picking wrong: building a tool as a scene (no
window buttons, cannot persist preferences) or a wallpaper as a widget (covers a tool window,
duplicated per monitor).

## When to use / when not to

Use it: creating or modifying a Lull extension, needing SDK build artefacts, debugging an
extension that will not install or shows a blank window, packaging for distribution, or adding
extension capabilities to the host.

Do not use it: editing the Lull app itself (that is `src/` / `src-tauri/`), writing built-in
tools (they use the compile-time contract in `src/sdk/widget`), or building third-party
websites. Those do not follow this standard and forcing it produces wrong conclusions.

## Prerequisites

`lull-ext doctor` prints exactly this list, split into what blocks you and what is optional.
Required items come first; optional ones never stop you from building.

**Required**

| Need | Why |
| --- | --- |
| Node.js >= 20 | compiles the SDK with tsc and runs this CLI |
| A built SDK under `~/.lull-skill/sdk` | `vendor` and `new` copy from it; `validate` checks the package against it |
| Shell with write access to the working directory | the CLI scaffolds files, copies `vendor/`, writes zips |

Getting the SDK needs **one** of:

- a local Lull checkout -> `sdk build --from <dir>` (offline, matches the local code);
- network access to github.com -> plain `sdk build` (sparse clone, needs git);
- an SDK directory produced elsewhere -> `--sdk <dir>` (or `LULL_SDK_DIR`).

**Optional / conditional**

| Need | When |
| --- | --- |
| git | only to clone the SDK or read the local HEAD sha |
| npm | only on the first `sdk build` (installs `typescript` inside the package) |
| network | `npx skills add`, `npm install`, `git clone` |
| Lull desktop app (Windows) | only to install and verify an extension on a real machine |
| Vite / esbuild | only if you want TypeScript, React or Vue; the templates are zero-build |

**Not needed**

- Rust / Tauri toolchain, `pnpm`, or the app's own build dependencies (Next.js). Extensions are
  static web packages; nothing here builds the host.
- The Lull repo itself, unless you want `--from` or expect `doctor`'s repo hint to be green.

Windows notes: quote paths or use forward slashes; every package path must be a
**forward-slash relative path** (zip entries, `entry`, digest paths).

## Invoking the CLI

Below, `lull-ext` means any of these equivalent forms - pick what matches the environment
(**an installed skill has no global command**):

```bash
node .agents/skills/lull-extension/bin/lull-ext.mjs <command>   # project-level, shared by Cursor/Codex etc.
node .claude/skills/lull-extension/bin/lull-ext.mjs <command>   # project-level Claude Code
node ~/.claude/skills/lull-extension/bin/lull-ext.mjs <command> # user-level (-g install)
npx --yes lull-extension-skill <command>                        # published on npm
node ./Skill/lull-extension/bin/lull-ext.mjs <command>          # inside the Lull repo
```

Not sure where it landed: run `npx skills list`; if nothing shows up, use the last form.
Whatever you pick, **run `doctor` first** - it reports node/git/npm/cache/SDK artefacts and
the skill install location.

First-time setup (either one):

```bash
lull-ext sdk build --from .            # inside the Lull repo: compile the working tree
lull-ext sdk build                     # outside: sparse-clone GitHub main, then compile
lull-ext sdk build --ref v0.1.0        # specific tag/branch
```

Artefacts default to `~/.lull-skill/sdk/` (override with `LULL_SKILL_CACHE`) and include
`sdk-manifest.json`, which records the source commit, versions and per-dist digests. With
`--from .` nothing in the repo `dist/` is touched: compilation happens inside the cache, so
the working tree stays clean.

## Workflow

### 1. Pick the kind, write down the requirement

Answer three questions first; they decide every later flag:

1. Does the user want "a window I can operate" or "a layer behind the desktop"? -> widget / scene
2. Is there anything to tune (strength, color, speed)? -> `params` for a scene, a settings UI for a widget
3. Does it need the network? -> a widget declares `https://` origins in `network`; a scene never goes online

### 2. Scaffold

```bash
lull-ext new widget ./my-tool --id my-tool --name "My tool"
lull-ext new widget ./my-tool --chrome host        # use the host title bar, do not self-draw
lull-ext new scene ./mist --id community.mist --name Mist            # script scene (with params)
lull-ext new scene ./mist --id community.mist --name Mist --static   # static package (no script)
```

The generated package **validates out of the box**: valid manifest, relative entry, and a
native-ESM SDK copy under `vendor/` (the browser imports it directly, no bundler). Add
Vite/esbuild later if you want React / Vue / TypeScript - see "three ways to consume it" in
`references/sdk-reference.md`.

Run `lull-ext validate <dir>` right after scaffolding and expect it to be green. If it is red
here, it is a template or environment problem - fix that first instead of writing business
logic on top of a red baseline.

### 3. Implement

- Read `references/widget-standard.md` or `references/scene-standard.md` (the standard) plus
  `references/design-playbook.md` (design and acceptance order).
- Change only `main.js` / `style.css` / `index.html` / the manifest. Never edit `vendor/` -
  that is an SDK copy.
- When unsure, check `references/pitfalls.md` first: white screen, lost state, params not
  applying, transparent window turning black - nine out of ten of these are already written up.

### 4. Validate

```bash
lull-ext validate ./my-tool             # human-readable
lull-ext validate ./my-tool --json      # machine-readable, for AI iteration
lull-ext validate ./my-tool --strict    # warnings fail too (run this before release)
```

Exit codes: 0 = no errors, 1 = errors, 2 = usage error. **An error always means the host will
reject the package or it cannot possibly run** (invalid manifest field, entry escaping the
package, capability overreach, missing relative import, remote asset, inline event handler).
A warning means it installs and runs but breaks the standard (size, color-scheme, localStorage
and friends).

### 5. Pack and install

```bash
lull-ext pack ./my-tool --out ./artifacts    # -> artifacts/my-tool-0.1.0.lull-widget.zip
lull-ext pack ./mist --out ./artifacts       # -> artifacts/community.mist-0.1.0.zip
```

Content packages get their `integrity` **recomputed before packing** (the digest covers the
entry directory). Do not skip it when publishing: a mismatched digest is rejected outright by
the installer.

Install: Lull -> Settings -> Extensions -> Install from file (or drag the zip into the window).
Faster during development: enable "Developer mode" at the bottom of the Extensions page, mount
the directory, edit files, then hit "Reload" on the card. Developer mode copies nothing and
locks no digest, so edits take effect immediately.

### 6. Installing the skill (generic Agent Skills standard)

This skill follows the [Agent Skills spec](https://agentskills.io/specification) (`SKILL.md` +
`name`/`description` frontmatter, `name` matches the directory). Installation belongs to the
generic `skills` CLI; this skill ships no installer of its own:

```bash
npx skills add Lull-Desktop/Lull --list                              # see what is there
npx skills add Lull-Desktop/Lull --skill lull-extension -y           # project-level (default)
npx skills add Lull-Desktop/Lull --skill lull-extension --all -g -y  # every agent + user-level
npx skills add Lull-Desktop/Lull --skill lull-extension --copy -y -a claude-code -a cursor
npx skills add ./ --skill lull-extension --copy -y -a claude-code    # from a local clone
```

Locations: Claude Code -> `.claude/skills/lull-extension/`, Cursor / Codex / OpenCode /
Copilot and friends -> `.agents/skills/lull-extension/`; `-g` writes into each agent's user
directory. The whole skill directory (`lib/` `templates/` `references/` `bin/`) is copied, so
the CLI is used via the paths listed above.

Without the `skills` CLI (offline or restricted environments), copy this directory to
`<project>/.agents/skills/lull-extension` by hand - that is equivalent, because the spec only
requires "a directory containing `SKILL.md`" in a location the agent scans.

## Extension standard (hard rules)

Full standard in `references/extension-standard.md`; these are the ones people trip over:

**Shared**

1. Every path inside a package is **relative**, with forward slashes; `entry` forbids `..`,
   backslashes, `%` and absolute paths.
2. No remote resources (CDN scripts/fonts/images); for network access use the manifest
   allowlist plus `fetch()`.
3. No inline event handlers (`onclick=`), always `addEventListener`; inline `<script>` blocks
   are allowed because the host injects a nonce.
4. No `@tauri-apps/api` import, no `localStorage` / cookie / IndexedDB (the iframe is an opaque origin).
5. State lives in host KV, not browser storage; one widget value <= 32 KiB, 256 KiB per plugin.
6. Respect `prefers-reduced-motion`; animation degrades when reduced motion is requested.
7. Keep a package under 5 MB; prefer WebP / SVG and drop sourcemaps.

**widget only**

8. `id` equals the install directory name, `^[a-z][a-z0-9-]{1,31}$`; `version` is
   `MAJOR.MINOR.PATCH` only (no prerelease suffix).
9. `window.chrome: "custom"` requires `widget.chrome` and a self-drawn drag region / minimize /
   close; `window.resizable` must be `false` (v1 is fixed size); size 320x240 - 1600x1200.
10. `network` non-empty <=> `widget.network` requested; `widget.window` / `widget.native` are
    **not requestable**.

**scene only**

11. `catalog.json` holds **exactly one** scene; unknown fields are rejected; `license` is required.
12. Declaring `params` requires `wallpaper.params`; for external packages `wallpaper.params` /
    `wallpaper.sync` also require `wallpaper.script` - without the script bridge the values
    cannot reach the scene.
13. A package without `wallpaper.script` runs in an empty sandbox, so it **must not contain
    `<script>`** (the validator errors on it).
14. `vendor/` for a script scene must sit next to the entry (the digest only covers the entry
    directory; anywhere else means it is not locked).
15. Installing the same id **overwrites**; there is no version comparison and no rollback, so
    verify in developer mode before publishing.

## Input / output contract

| Command | Input | Output (stdout / files) | Failure (exit code 1) |
| --- | --- | --- | --- |
| `sdk build` | `--from <repo>` / `--ref` / `--out` | `<out>/widget-sdk/{package.json,dist}`, `<out>/scene-sdk/...`, `sdk-manifest.json` | no git, clone failed, no tsc and offline, compile error, missing `index.js`/`index.d.ts` |
| `sdk info` | `--out` | manifest JSON | manifest missing |
| `new widget/scene` | target dir + `--id/--name/--static/--chrome` | skeleton files + vendor (when the SDK is built) | invalid id, non-empty dir without `--force` |
| `vendor <dir>` | extension dir + `--sdk` | `<pkg>/vendor/<kind>-sdk/` (scene also recomputes integrity) | no manifest, SDK not built |
| `hash <bundle>` | content bundle dir | `integrity` written back into `catalog.json` | missing `scenes[0]`/`entry`, empty digest directory |
| `validate <dir>` | extension dir + `--json/--strict` | report; JSON with `--json` | any error |
| `pack <dir>` | extension dir + `--out` | `<id>-<version>[-.lull-widget].zip` | validation failed, cannot name the artefact |

## Edge cases (must know)

- **Opened outside the host**: double-clicking `index.html` throws `not-embedded`. That is
  expected; the template renders it as a hint instead of failing silently.
- **Transparent window turns black**: `color-scheme: dark` on `:root` makes WebView2 paint the
  iframe canvas opaque.
- **Closing is not exiting**: `close()` hides the window and the process stays in the tray;
  only `lifecycle: "suspend"` destroys the window.
- **Size is fixed**: v1 windows cannot resize; `requestResize` only reports measurements
  (`applied: false`).
- **Capability revocation**: users can revoke per capability; revoking `widget.chrome` falls
  back to the host title bar, so code must tolerate it.
- **Network tightening needs a reload**: after revoking `widget.network` the current page CSP
  is unchanged until the plugin is disabled and enabled again.
- **SDK drift**: `sdk-manifest.json` records the commit and digests; re-run `vendor` after
  switching SDK builds instead of hand-copying `dist`.
- **Host API mismatch**: an out-of-range `hostApi` is filtered at the catalog layer (a scene
  never appears in settings; a widget refuses to load).
- **Packaging on Windows**: never use `Compress-Archive` - it writes backslash entries and the
  installer rejects the package; use `pack`.
- **Distribution limits**: no publisher signature, no online catalog, no auto-update; the local
  digest lock only proves "the package was not modified".

## Self-check list

Tick every line before release:

- [ ] `lull-ext validate <dir> --strict` is green
- [ ] `sdk build` output matches `vendor/` (re-vendor after any SDK change)
- [ ] widget: `id` equals the directory name; entry is `index.html`; capabilities are the minimal set actually used
- [ ] scene: `params` keys/labels/defaults read like human language; `theme.background` is set (no flash)
- [ ] Empty, loading and error states all have copy - no blank window
- [ ] Keyboard reachable (tab order, `aria-label`), sufficient contrast
- [ ] State survives close/reopen and app restart (widget)
- [ ] Nothing jitters under reduced motion (scenes especially)
- [ ] The zip from `pack` was installed on a real machine, with the version bumped

## Troubleshooting

| Symptom | Check first |
| --- | --- |
| Will not install / installer reports a manifest error | the `W-*` / `S-*` code from `validate`, against the field table in `references/widget-standard.md` |
| White screen, CSP errors in the console | remote asset, inline handler, absolute path (`P-REMOTE` / `P-ABS-PATH`) |
| `not-embedded` | is it opened inside Lull; did the host swap the iframe |
| State not persisted | using localStorage? is the `getState` key valid (`[A-Za-z0-9._-]`, <= 64) |
| Parameter changes do nothing | scene declares both `wallpaper.params` and `wallpaper.script`; code subscribes with `onFrame` |
| Digest mismatch | files changed without recomputing: `lull-ext hash <bundle>` |
| Scene missing from settings | `compatibility.hostApi` / `platforms` filtered it out |
| Window buttons do nothing | with `chrome: "custom"`, is `widget.chrome` requested; are the listeners attached |

## File map

```text
lull-extension/
  SKILL.md                     # this file: triggers, workflow, hard rules
  references/extension-standard.md    # shared standard (IDs + release gates)
  references/widget-standard.md       # tool extension spec (full field table)
  references/scene-standard.md        # wallpaper scene spec (fields, params, digest)
  references/sdk-reference.md         # SDK API, version matrix, three integration paths
  references/design-playbook.md       # requirement -> capability -> params -> UI -> acceptance
  references/pitfalls.md              # pitfalls and troubleshooting detail
  lib/ bin/                    # CLI implementation (sdk / new / vendor / hash / validate / pack)
  templates/                   # templates used when scaffolding
```
