# SDK reference

> Sources of truth: `packages/widget-sdk/README.md`, `packages/scene-sdk/README.md`,
> `packages/*/src/protocol.ts`. Runtime versions come from `lull-ext sdk info`
> (`sdk-manifest.json`); do not assume a version from this document.

## 1. Version matrix

| SDK | Bridge protocol | Host API | Lull | Notes |
| --- | --- | --- | --- | --- |
| `@lull/widget-sdk` 0.2.x | 1 | 1 | 0.1.x | TypeScript rewrite; `setState`/`startDrag` return `void`; `getState` supports generics and fallback |
| `@lull/widget-sdk` 0.1.x | 1 | 1 | 0.1.x | Hand-written JS, no type declarations |
| `@lull/scene-sdk` 0.1.x | 1 | 1 | 0.1.x | Only for `wallpaper.script` scenes |

- During `0.x`, `minor` may bring breaking changes; read the diff before upgrading.
- The bridge protocol `v` only increments on breaking field semantics; afterwards the host
  compatibility layer keeps old plugins running.
- Both packages are **ESM-only** (`"type": "module"`, with `types` conditions). CommonJS
  projects must go through a bundler.

## 2. Artefact location

```text
<out>/                       # lull-ext sdk build --out <out>, default ~/.lull-skill/sdk
  sdk-manifest.json          # source commit / versions / dist digests
  widget-sdk/{package.json,dist,README.md}
  scene-sdk/{package.json,dist,README.md}
```

Key files inside `dist`:

```text
widget-sdk/dist/  index.js|.d.ts  client  errors  protocol  transport  react  vue  testing
scene-sdk/dist/   index.js|.d.ts  client  errors  protocol  sync  transport  testing
```

`dist` is ESM with relative imports only and no bare dependencies in the root entry, so the
whole directory can be copied into `vendor/` and imported as
`./vendor/widget-sdk/index.js` (no import map, no bundler).

## 3. Three ways to consume it

### 3.1 vendor (zero build, default)

```bash
lull-ext vendor ./my-tool              # -> my-tool/vendor/widget-sdk/**
# scene: copies to <bundle>/<entryDir>/vendor/scene-sdk/** and recomputes integrity
```

```js
import { connectLullWidget } from "./vendor/widget-sdk/index.js";
```

Best for vanilla JS plugins and static scenes; the cost is a copy of the SDK inside the
package (roughly 100 KB, counted against the 5 MB budget).

### 3.2 file: dependency (types + unit tests)

```bash
npm i --save-dev file:$HOME/.lull-skill/sdk/widget-sdk
```

`package.json` records a `file:` protocol dependency that esbuild/Vite resolve at build
time. Good for TypeScript projects.

### 3.3 Bundler (React / Vue / single-file output)

```bash
npm i --save-dev file:.../sdk/widget-sdk esbuild
npx esbuild src/main.ts --bundle --format=esm --outfile=dist/main.js --loader:.ts=ts
```

Output requirements: every asset relative in `dist/index.html` (Vite: `base: "./"`),
single-entry HTML, hash routing. Next.js / Nuxt are not officially supported (their output
carries inline bootstrap and absolute paths).

## 4. `@lull/widget-sdk` API

`connectLullWidget(options?)` -> `Promise<LullWidgetClient>` (repeated calls on one page
return the same promise). `options`: `{ transport?, timeoutMs? }` (waits 10 s for `init`).

| Member | Description |
| --- | --- |
| `id` / `hostApi` / `protocol` | plugin id, host API version, bridge protocol version |
| `window` | `{ width, height, minWidth, minHeight, resizable, transparent, chrome }` |
| `minimizable` / `transparent` / `visible` | current window state; `transparent` follows `setTransparent` |
| `capabilities` / `has(cap)` | granted capabilities (manifest ∩ user consent); unknown caps are always `false` |
| `theme` / `viewport` | theme tokens / content-area size (CSS pixels + dpr) |
| `getState(key, fallback?)` / `setState` / `removeState` | host KV; key `[A-Za-z0-9._-]` 1-64; one value <= 32 KiB, 256 KiB per plugin |
| `requestAudio()` | whether audio was granted |
| `requestResize(w, h)` | v1 only reports measurements (`applied: false`), it does not resize |
| `startDrag()` / `minimize()` / `setTransparent()` | requires `widget.chrome` |
| `close()` | no capability needed; closing hides the window |
| `log(message, level?)` | forwards to the host console with prefix `[plugin:<id>]` |
| `onTheme` / `onViewport` / `onVisibility` | subscribe and **replay the current value immediately**; returns an unsubscribe function |
| `request(method, params)` | call a bridge method directly, typed via `WidgetBridgeMethods` |
| `destroy()` | unsubscribes everything and rejects pending requests; later calls return `disposed` |

Bridge methods: `state.get` / `state.set` / `state.remove` / `audio.request` /
`resize.request` / `window.startDrag` / `window.minimize` / `window.setTransparent` /
`close` / `log`. Every message carries `v: 1`; requests also carry the `token` from `init`.

Errors: `LullWidgetError`, branch on `code` (`not-embedded` / `init-timeout` / `bad-init` /
`timeout` / `host-error` / `disposed`) - **never match on the message text**.

React: `LullProvider` + `useLullState` / `useLullTheme` (`@lull/widget-sdk/react`).
Vue: `createLullPlugin(client)` + `useLullState` (`@lull/widget-sdk/vue`).
Tests: `createInitMessage` / `createMemoryTransport` / `createLullWidgetClient` (`/testing`).

## 5. `@lull/scene-sdk` API

`connectLullScene(options?)` -> `Promise<LullSceneClient>` (singleton). `options`:
`{ transport?, timeoutMs? }`.

| Member | Description |
| --- | --- |
| `id` / `hostApi` / `protocol` | scene id, host API, protocol version |
| `frame` | last frame; `null` before `init` |
| `params` | current params (types restored per manifest); empty object before `init` |
| `visible` | whether the window is currently visible |
| `onFrame(fn)` | subscribe to frames (params/geometry/layout), **immediately replays** the current frame |
| `onParams(fn)` | subscribe to params only, replays immediately |
| `onVisibility(fn)` | subscribe to visibility, replays immediately |
| `log(message, level?)` | forwards to the host console with prefix `[scene:<id>]` |
| `destroy()` | unsubscribes and rejects later calls |

`syncedDelayMs(periodMs, epochMs)` -> negative delay in ms, aligning `animation-delay`
across windows. Do not compute the phase yourself with `Date.now()`.

Errors: `LullSceneError`, `code` in `not-embedded` / `init-timeout` / `bad-init` / `disposed`.

## 6. Building the SDK (what this skill does)

```bash
lull-ext sdk build --from .        # in-repo, uses the working tree
lull-ext sdk build                 # remote main (sparse clone of packages/)
lull-ext sdk build --ref <tag>     # specific ref
lull-ext sdk build --offline --from <dir>   # fully offline
```

Equivalent manual commands (in-repo):

```bash
node ./node_modules/typescript/bin/tsc -p packages/widget-sdk/tsconfig.json
node ./node_modules/typescript/bin/tsc -p packages/scene-sdk/tsconfig.json
```

`pnpm widgets:sdk` / `pnpm scenes:sdk` run the same line, but they need the root
`node_modules` (with all Next/Tauri dependencies).

Note: both `tsconfig.json` files set `declaration + declarationMap + sourceMap`,
`rootDir: src`, `outDir: dist`, `types: []`. `widget-sdk` compiles `src/react.ts` and
`src/vue.ts`, so it must resolve `react` / `vue` types; its devDependencies declare both, so
one `npm install` in that package is enough.

## 7. Behaviour the host does not support (one more time)

- Using `__TAURI_INTERNALS__`: WebView2 injects an init script, but this is not a supported
  API; the ACL only grants this window's state commands.
- Validating with `event.origin`: an opaque origin reports `"null"`.
- Reaching into the host shell through `window.parent.*` from a widget, or driving the
  wallpaper window through `window.top` from a scene.
- Trying to `requestResize` a fixed window, create a second window, or install packages.
