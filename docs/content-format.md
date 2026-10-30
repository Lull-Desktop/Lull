# 内容包格式

> 状态：v1 落地**静态场景包**与声明 `wallpaper.script` 的**沙箱脚本场景包**。
> 主题、声景预设、桌面布局的类型已在 SDK 中预留，但宿主尚未加载。
> 目标：官方内容与社区内容使用同一种格式；内容包不修改 Lull 核心代码。
>
> 统一安装入口与工具扩展的分发已落地基础版本，见 [扩展中心设计](./extension-center.md)；
> 本文定义的 scene 格式、摘要与签名规则保持不变。

## 1. 内容根目录

随安装包分发的内容位于 `public/content/`，构建时原样复制到 `dist/content/`：

```text
public/content/
  catalog.json          # 内容索引
  scenes/
    mist/
      index.html
      assets/…
```

`catalog.json` 是运行时唯一发现入口；没有登记的目录不会被加载。

## 2. 目录文件

```json
{
  "schemaVersion": 1,
  "scenes": [
    {
      "schemaVersion": 1,
      "type": "scene",
      "id": "community.mist",
      "name": "雾岚",
      "version": "1.0.0",
      "description": "薄雾与远山。",
      "author": "Lull Community",
      "license": "CC-BY-4.0",
      "capabilities": ["wallpaper.viewport", "wallpaper.canvas"],
      "entry": "scenes/mist/index.html",
      "theme": { "background": "#0a1416", "accent": "#9fc7c2" },
      "performance": { "tier": "low", "targetFps": 30 },
      "compatibility": { "hostApi": 1, "platforms": ["windows"] },
      "integrity": {
        "algorithm": "sha256",
        "scope": "package",
        "digest": "f6b86e63434d810099e293bfa74c556542a02fbe96fc7ce97390e0938a608ecb"
      }
    }
  ]
}
```

JSON Schema：[`content/schema/catalog.schema.json`](../content/schema/catalog.schema.json)、[`scene.schema.json`](../content/schema/scene.schema.json)。

## 3. 包结构

### 3.1 场景包（当前支持）

```text
scenes/<name>/
  index.html        # 必需，entry 指向它
  assets/           # 可选；只能相对引用
  LICENSE           # 建议随包附带
  README.md         # 可选，说明玩法与素材来源
```

约束：

- `entry` 必须是 `.html`，相对包根目录，禁止 `..` / 绝对路径 / 反斜杠；
- **静态包**：只允许 HTML / CSS，iframe 空 `sandbox`，JavaScript 不执行；
- **脚本包**：声明 `wallpaper.script`，iframe 使用 `sandbox="allow-scripts"`，脚本通过
  [`@lull/scene-sdk`](../packages/scene-sdk/README.md) 读取参数/几何/同步相位；
  资源协议会下发 nonce CSP，只允许包内资源；
- 所有资源使用相对路径；CSP 默认阻止远程脚本、字体、图片与音频；
- 静态包不访问 `window.parent`；脚本包只通过 Scene SDK 的 postMessage 桥与宿主通信，
  不直接读取宿主 DOM、存储或 Tauri API；
- 声明 `params` 时必须声明 `wallpaper.params`；外部场景使用 `wallpaper.params` 或
  `wallpaper.sync` 时必须同时声明 `wallpaper.script`；静态包不能声明这两项；
- 静态包不依赖构建期工具；脚本包用 esbuild / Vite 打成包内 ESM 即可。

### 3.2 主题 / 声景 / 布局（预留）

`src/sdk/content/manifest.ts` 定义了通用清单：

```ts
type ContentManifest = {
  schemaVersion: 1;
  type: "scene" | "theme" | "sound-preset" | "layout";
  id: string;
  name: string;
  version: string;
  license: string;
  entry?: string;
  capabilities?: string[];
  dependencies?: { id: string; version: string }[];
  hostApi?: string;
};
```

这些类型的加载器尚未实现；不要在文档或发行物中宣称已支持。

## 4. 版本与兼容

| 字段 | 规则 |
| --- | --- |
| `schemaVersion` | 破坏性格式变更才升；当前 `1`，不支持则拒绝 |
| 内容 `version` | 独立语义化版本；同一 id 新版本覆盖旧版本 |
| `compatibility.hostApi` | 场景清单生效：超出当前宿主 API 的场景会被过滤；通用 `ContentManifest.hostApi` 仍为预留 |
| `dependencies` | 预留：内容包之间依赖，首版不解析 |
| `id` | 一经发布不要改名；改名视为新内容 |

宿主读取目录时：

- 目录缺失 / 损坏 / schemaVersion 不支持 → 只保留内置场景，不崩溃；
- 单条 manifest 非法 → **只跳过该条**，其余场景照常加载，设置页列出问题；
- 重复 id → 保留第一条，后续条目跳过并提示；`pnpm content:check` 仍把重复 id 视为发布错误；
- 缺 `integrity` → 仍然加载，但标记为不可校验（官方目录要求必须填写）。

## 5. 许可证与素材

- 每个内容包必须填写 `license`；
- 代码、字体、图标、声音、场景素材的授权分别确认；
- 随包附 `LICENSE` 或 `THIRD_PARTY_NOTICES.md`；
- 不允许把无授权素材打包进官方内容目录；
- 官方内置场景属于应用代码，以 GPL-3.0-or-later 发布；官方内容目录与示例以 CC BY 4.0 发布。

## 6. 校验

```powershell
pnpm content:hash                     # 重算并写回每个包的 integrity 摘要（改了内容包之后）
pnpm content:hash --bundle ./my-scene # 重算独立内容包（创作者打包前用）
pnpm content:pack ./my-scene --out artifacts # 打成可安装 zip（正斜杠 + UTF-8）
pnpm content:sign                     # 用本机私钥给 catalog.json 的原始字节签名
pnpm content:check                    # 校验清单 + 摘要 + 目录签名（CI 与构建前置都跑这个）
```

实现：[`scripts/validate-content.mjs`](../scripts/validate-content.mjs)、[`scripts/hash-content.mjs`](../scripts/hash-content.mjs)、[`scripts/pack-content.mjs`](../scripts/pack-content.mjs)、[`scripts/sign-content.mjs`](../scripts/sign-content.mjs)。检查范围：

1. `catalog.json` 可解析、schemaVersion 正确；
2. 每个 manifest 的必填字段与格式；
3. capability 白名单与唯一 id；
4. `entry` 路径安全且文件存在；
5. `integrity.digest` 与**整个包目录**的实际摘要一致（算法见下）；
6. `catalog.sig.json` 对 `catalog.json` 原始字节的签名有效（公钥在 `public/content/keys/`）。

### 6.1 包摘要

摘要覆盖包目录内的全部文件，而不是只覆盖 entry：

```text
sha256(
  "lull-content-package\0" +
  id + "\0" + version + "\0" +
  Σ(相对路径 + "\0" + 字节数 + "\0" + 文件字节 + "\0")   # 相对路径按 UTF-8 字节序排序
)
```

把 id/version 拌进摘要，防止把 A 包的摘要抄到 B 包；排序保证可复现；包内不允许符号链接，避免"摘要覆盖的字节"与"运行时读到的字节"不一致。

### 6.2 目录签名

- 签名对象是 `catalog.json` 的**原始字节**，不做 JSON 规范化；
- 算法 ECDSA P-256 / SHA-256，签名文件 `public/content/catalog.sig.json`；
- 公钥随包分发（`public/content/keys/<keyId>.jwk.json`），运行时用 WebCrypto 验签；
- 私钥只在本机 `.keys/`（已 gitignore）或 CI secret（`LULL_CONTENT_SIGNING_KEY`）；
- 运行时会拒绝签名不匹配的目录；未签名目录仍可加载，但会在设置页标注"未签名"。

### 6.3 发布者签名（社区包，v2）

目录签名回答「这份 catalog 是否随宿主发布」；发布者签名回答「这个用户包是否由
community 发布、字节有没有被换」。两者算法、对象、信任根都不同，不要混用：

- 包根 `.lull-signature.json`，JSON envelope：`schemaVersion=2`、`algorithm=ed25519`、
  `keyId`、base64 `payload`、base64 64 字节 `signature`；
- `payload` 解码后是规范声明：`kind/slug/id/version/digest/signedBy/releaseSeq/signedAt`，
  **不含 zip**；签名对象是 payload 的原始字节；
- 签名文件不参与包摘要（widget 排除点号路径；scene 摘要只覆盖 entry 目录）；
- 宿主内置 `src-tauri/trust/publisher-keys.json`，验签后重算 digest；
- `invalid` / `mismatch` / `revoked` 始终阻断，`unsigned` / `unknown-key` 默认警告，
  设置页严格模式可把后两者也阻断。

CI 在 `frontend-test.yml` 中执行同一 `pnpm content:check`；Vitest 还会解析随包目录，防止示例与实现漂移。

## 7. 分发与安装

创作者产出的是**一个内容包目录**，结构与 `public/content/` 完全同构
（这样摘要算法、校验脚本、安装器三处只认一种格式）：

```text
my-scene/
  catalog.json                 # { schemaVersion: 1, scenes: [ 单条 scene ] }
  scenes/my-scene/index.html
```

打包：

```powershell
pnpm content:hash --bundle ./my-scene   # 写回 integrity（算法与安装器一致）
pnpm content:pack ./my-scene --out artifacts
```

> **不要用 `Compress-Archive` 或部分 Windows 压缩工具**：它们会把 zip 条目写成
> 反斜杠路径，安装器会以 `package.unsafe-entry: zip 内含反斜杠路径` 拒绝。
> `content:pack` 统一写正斜杠与 UTF-8，并在打包前复核 `integrity`。

> `--bundle` 与随包目录走同一个 `computePackageDigest()`；摘要只覆盖 entry 所在目录，
> 清单本身不在摘要范围内——否则写入 `integrity` 会改变自身字节，摘要永远算不出来。

用户侧安装（v1 已落地）：

| 方式 | 说明 |
| --- | --- |
| 选择文件 | 设置页「内容包 → 选择 zip」，走系统文件对话框；不依赖拖拽，远程会话/受限环境也能用 |
| 拖拽 | 把 `.zip` 或解压后的文件夹拖到设置窗口，卡片提示「已安装」 |
| 手动放置 | 设置页「内容包 → 内容目录」打开 `%APPDATA%\app.lull.desktop\content\`，放好后点「刷新」 |

> 拖拽走的是 Tauri 的原生 drop 事件（前端 HTML5 DnD 被关闭）。拿不到路径的典型情况：
> 从「压缩文件夹」视图里拖内部文件、从虚拟目录（此电脑/库）拖、远程桌面会话。
> 这几种情况请用「选择 zip」。

安装器（`src-tauri/src/content_package`）按顺序校验，任一步失败都不落盘：

1. **路径安全**：zip 条目拒绝 `..`、绝对路径、反斜杠、符号链接；
2. **体积上限**：单文件 8 MiB、整包 64 MiB、512 个文件；
3. **清单**：`catalog.json` 恰好一条 scene、id 合法、entry 在子目录内且文件存在、`license` 必填；
4. **摘要**：按 §6.1 重算并与 `integrity.digest` 比对（**缺失即拒绝**）；
5. **落地**：通过后才 `rename` 到 `content/<scene-id>/`，并广播 `content-changed` 刷新场景列表。

运行时扫描会**再复核一次摘要**：被改动过的包标记为 `tampered` 并跳过，不会渲染；
手动放置且未声明摘要的包仍可加载，但标记为「未校验」。第三方包没有目录签名，
所以「未校验」是常态，不是错误。

v1 限制：单场景包、不做第三方签名（未签名 = 未校验）、不联网。
scene 支持同 id **覆盖安装**（本地手动更新：旧目录备份后替换，壁纸按版本重载）；
仍缺：在线索引、下载与撤回、作者密钥信任链、多场景包、自动更新/回滚。

## 8. 安全边界

- 静态内容包运行在 `sandbox=""` 的 iframe：不执行 JavaScript，不能调用 Tauri；
- 脚本场景运行在 `sandbox="allow-scripts"` 的 opaque-origin iframe：没有同源存储、
  Cookie 或宿主 DOM 读取权限，只能通过 `window.parent.postMessage` 与宿主桥通信；
  内容协议注入 nonce CSP，默认禁止远程资源；
- 场景只能通过 `@lull/scene-sdk` 的桥读取宿主下发的帧，没有写配置、创建窗口或
  调用原生/任意 Rust 命令的入口；
- 宿主不执行内容包里的任意 Node/Rust 代码；
- 不把「能加载 HTML / 能跑沙箱脚本」当成「安全插件系统」；
- WebView2 可能把 Tauri 初始化脚本注入子帧；壁纸窗口的 ACL 只授予只读
  `content_packages` 与事件订阅，这不是受支持的场景 API。

## 9. 示例

- [`public/content/catalog.json`](../public/content/catalog.json)
- [`public/content/scenes/mist/index.html`](../public/content/scenes/mist/index.html)
- [`examples/scenes/demo-fireflies`](../examples/scenes/demo-fireflies) —— 可安装的测试包源码（纯 CSS 壁纸），
  打包后即 `artifacts/demo.fireflies-1.0.0.zip`，用来验证「拖入安装 → 场景出现在下拉里」这条链路
- [`examples/scenes/param-demo`](../examples/scenes/param-demo) —— 声明 `wallpaper.params` +
  `wallpaper.script` 的脚本场景，验证「Setting 改参数 → Scene SDK → 场景实时更新」；
  1.1.0 新增 blur/hue/ring，可配合 1.0.0 验证覆盖更新；打包后即
  `artifacts/demo.param-scene-1.1.0.zip`
- [`examples/scenes/three-scene`](../examples/scenes/three-scene) —— Three.js / WebGL 场景，
  验证大体积 ESM 打包、WebGL 渲染与参数热更；打包后即 `artifacts/demo.three-scene-1.0.0.zip`
- [`src/sdk/scene/manifest.test.ts`](../src/sdk/scene/manifest.test.ts)
