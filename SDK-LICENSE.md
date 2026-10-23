# SDK License

Lull uses a split license so that the desktop application stays copyleft while
the scene/widget interfaces remain easy to adopt.

## 1. What is Apache-2.0

The following public SDK sources are licensed under **Apache-2.0**:

- `src/sdk/scene/**`
- `src/sdk/widget/**`
- `src/sdk/content/**`
- `packages/widget-sdk/**`
- `packages/scene-sdk/**`

This includes the manifest types, catalog parser, capability enums and the
public `SceneProps` / `WidgetManifest` contracts.

See [`LICENSES/Apache-2.0.txt`](LICENSES/Apache-2.0.txt).

## 2. What stays GPL-3.0-or-later

The Lull application as a whole — including the Rust host, native DLL, the
Next.js UI, the scene host and the built-in scenes/widgets — is distributed
under **GPL-3.0-or-later**. See [`LICENSE`](LICENSE).

A compiled Lull installer contains both GPL application code and Apache-2.0 SDK
code. The combined distribution is governed by GPL-3.0-or-later; the SDK files
remain available under Apache-2.0 for reuse in other projects.

## 3. Writing a scene or widget

- A static content package under `public/content/` is loaded as a separate,
  sandboxed document. It is not automatically a derivative work of Lull.
- If you copy SDK code into your own package, that code remains Apache-2.0 and
  you must retain its notices.
- You may not use the Lull name or logo in a way that suggests endorsement;
  see [`TRADEMARK.md`](TRADEMARK.md).
- Static content packages are HTML/CSS-only. Packages that declare
  `wallpaper.script` run in an opaque-origin iframe and use
  `@lull/scene-sdk` to receive parameters and frames; the bridge is the only
  supported scene host API.
- Third-party tool windows use `@lull/widget-sdk` in an opaque-origin iframe;
  the postMessage bridge is the only supported widget host API.

## 4. Patent grant

Apache-2.0 includes an express patent grant from contributors. That is one of
the reasons the SDK is not also MIT: it gives downstream tool and plugin
authors clearer patent hygiene.

## 5. Contributions

Contributions to `src/sdk/**` are accepted under Apache-2.0; contributions to
the rest of the application are accepted under GPL-3.0-or-later. By opening a
pull request you confirm you have the right to submit the code under the
license of the files you touch.
