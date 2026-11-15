# Get started with Lull

[Project overview](../../README.md) · [中文开发参考](../guides/development.zh-CN.md)

Choose a path: [run the desktop app](#run-the-desktop-app) to work on Lull itself, or [build your first widget](#build-your-first-widget) to create an extension. Extension packaging does not require Rust, Visual Studio, or a running desktop app; testing the result in Lull requires Windows.

## Get the source

Install Git and Node.js 22, then open PowerShell:

```powershell
git clone https://github.com/Lull-Desktop/Lull.git
cd Lull
```

Run the remaining commands from this repository root unless a step says otherwise. If targeting an installed release, check out its tag before building SDKs. APIs in the default branch may be newer than the released app.

## Run the desktop app

### Prerequisites

| Dependency | Requirement |
| --- | --- |
| Windows | Windows 10 / 11, x64, with Explorer running |
| Node.js | 22, as specified in [`.node-version`](../../.node-version) |
| pnpm | Use the exact `packageManager` value in [`package.json`](../../package.json) |
| Rust | Install rustup; [`rust-toolchain.toml`](../../rust-toolchain.toml) selects `stable-x86_64-pc-windows-msvc` |
| Visual Studio Build Tools | Desktop development with C++, including a Windows SDK |
| Git for Windows | Git Bash, including `bash` and `cygpath` |
| WebView2 | Microsoft Edge WebView2 Runtime |

For a pnpm installation matching the checkout:

```powershell
$lullPackageManager = (Get-Content package.json -Raw | ConvertFrom-Json).packageManager
npm install --global $lullPackageManager
pnpm install --frozen-lockfile
```

Build the native host DLL, then start Tauri:

```powershell
& "C:\Program Files\Git\bin\bash.exe" src-tauri/native/build-shim.sh
pnpm dev
```

Adjust the Git Bash path if Git is installed elsewhere. Rebuild the DLL after changing `src-tauri/native/`. Tauri's development hook compiles translations and bundled extensions, then starts the Next.js frontend.

**Expected result:** Settings opens. Debug builds do not attach wallpaper windows by default. You can set the interface language to English under Preferences. Closing Settings hides it; use the tray's Exit action to stop the app, then stop the development command with Ctrl+C if it is still running.

### Check real desktop attachment

Install Python with Pillow, or put `uv` on PATH so the acceptance script can provide Pillow:

```powershell
pnpm test-mode
```

This builds the native DLL, starts the app, checks wallpaper attachment / hit testing / animation, and exits. It temporarily changes the live desktop. For a manual inspection window:

```powershell
pnpm test-mode -SkipVerify -HoldSeconds 30
```

The optional native video backend is separate from normal setup. Follow [Media Runtime (中文)](../media-runtime.md) before using `-NativeMedia`; ordinary development and release builds use HTML video playback.

### Build installers

```powershell
pnpm build
pnpm release:package
```

The build hook prepares translations, content checks, bundled extensions, the native DLL, and the exported frontend. Release packaging collects installers, a portable archive, and checksums under `artifacts/release/`.

## Build your first widget

This path uses the CLI included in the repository. No global `lull-ext` command or agent skill installation is needed. Node.js and the checkout are sufficient to start; if TypeScript is missing, the SDK builder uses npm to install package-level build dependencies. It writes SDK build output under `packages/*/dist/` and copies the results to the selected output directory.

### 1. Build SDKs matching your checkout

```powershell
node Skill/lull-extension/bin/lull-ext.mjs sdk build --from . --out ./artifacts/extension-sdk
```

This builds Widget and Scene SDKs, checks their ESM exports, and records source and package versions in `artifacts/extension-sdk/sdk-manifest.json`. Media and Game SDKs have separate build commands in the repository.

### 2. Generate, validate, and package

Use a new or empty target directory. The following commands keep generated files under the ignored `artifacts/` directory:

```powershell
node Skill/lull-extension/bin/lull-ext.mjs new widget ./artifacts/hello-lull --id hello-lull --name "Hello Lull" --sdk ./artifacts/extension-sdk
node Skill/lull-extension/bin/lull-ext.mjs validate ./artifacts/hello-lull --strict
node Skill/lull-extension/bin/lull-ext.mjs pack ./artifacts/hello-lull --out ./artifacts/extension-packages
```

**Expected result:** `artifacts/extension-packages/hello-lull-0.1.0.lull-widget.zip`. The generated package includes `widget.json`, an HTML entry point, local JavaScript / styles, and a vendored Widget SDK. No bundler or CDN is required for this template.

### 3. Install and try it

1. Start the Lull app built from this checkout, or a compatible installed release.
2. Open **Settings → Extensions**, choose the file installation action, and select the ZIP above. In Chinese these entries are **设置 → 扩展 → 从文件安装**.
3. Review the package summary and requested capabilities, then install it.
4. Enable **Hello Lull**, approve its declared capabilities, and open its window from the extension list.
5. Try the template's controls and reopen the window to check its saved state.

Installation and enabling are separate actions. A successful package validation does not replace testing inside the host: the standalone browser cannot provide the widget bridge.

### 4. Make it yours

Edit the generated HTML, JavaScript, and CSS, then validate and pack again. Set the author, description, and license in `widget.json` before sharing it. The template starts with `MIT`; retain the vendored SDK's Apache-2.0 notices.

When installing an update to the same widget ID, increase `widget.json`'s version, for example from `0.1.0` to `0.1.1`. The extension center rejects same-version updates and downgrades. Failed updates attempt to restore the old package; check the error if recovery fails. For repeated development without packaging each change, see [directory mounting and dev servers (中文)](../extension-dev-mode.md).

### Next examples

| Goal | Example / reference |
| --- | --- |
| React, Vue, or plain JavaScript tool | [`examples/widgets/`](../../examples/widgets) and [Widget SDK (中文)](../widget-sdk.md) |
| Replace the music player | [Mini Player (中文)](../../examples/widgets/mini-player/README.md), using Widget and Media SDKs |
| Make a wallpaper react to audio | [Audio demo (中文)](../../examples/scenes/audio-demo/README.md), using Scene SDK and `wallpaper.audio` on host API 5 |
| Create a desktop game | [Game examples (中文)](../../examples/games/README.md), with Canvas / Phaser / PixiJS / Three.js adapters |
| Use an AI agent to help author extensions | [Optional skill and CLI guide (中文)](../../Skill/lull-extension/README.md) |

## Troubleshooting

| Symptom | Check |
| --- | --- |
| `bash` / `cygpath` or native build tools are missing | Check the Git Bash path and the Visual Studio C++ workload with Windows SDK; run the native build command before `pnpm dev`. |
| `Cannot find module` after dependency installation | Check the Node / pnpm versions and installation output. On affected Windows setups, retry with `pnpm install --frozen-lockfile --config.node-linker=hoisted`. |
| Settings opens but no wallpaper appears in debug mode | This is the default; use the desktop acceptance flow above. |
| A widget cannot connect when opened as a normal HTML page | Install and enable its ZIP in Lull; the SDK bridge requires the host. |
| An extension update is rejected | Check the ID, increasing package version, declared capabilities, and compatibility with the installed host. |

Application log: `%TEMP%\lull\app.log`. Native host log: `%TEMP%\lull_wallpaper.log`. Display configuration: `%APPDATA%\app.lull.desktop\display.json`.

## Before opening a pull request

- Keep the change focused; describe the behavior, motivation, and validation performed.
- For frontend or SDK changes, run `pnpm test` and `pnpm lint`; include `pnpm typecheck` when changing TypeScript contracts. `pnpm check` runs the broader frontend / content / SDK checks.
- For Rust changes, run `cargo test --manifest-path src-tauri/Cargo.toml`. Native desktop-host changes also require `pnpm test-mode` and logs or screenshots from Windows.
- For extensions, validate, package, install, and test inside Lull. Do not commit generated bundles, SDK `dist/`, dependencies, or DLLs.
- Use DCO sign-off: `git commit -s`. Contributions follow the license of the files being changed; no CLA is required by the current contribution guide.
- Report security issues privately through the repository's Security Advisories / private vulnerability reporting flow, as described in [SECURITY.md (中文)](../../SECURITY.md).

The detailed [contribution guide](../contributing.md), [architecture](../architecture.md), and most SDK guides are currently in Chinese. The [website project (中文)](../../website/README.md) has a separate dependency setup; its Node requirement is not the application's `.node-version`.
