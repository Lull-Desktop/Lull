# 内容包格式

> 状态：v1 只落地**静态场景包**。主题、声景预设、桌面布局的类型已在 SDK 中预留，但宿主尚未加载。
> 目标：官方内容与社区内容使用同一种格式；内容包不修改 Lull 核心代码。

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
      "capabilities": ["wallpaper.viewport", "wallpaper.canvas", "wallpaper.sync"],
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

- `entry` 必须是 `.html`，相对 `public/content/`，禁止 `..` / 绝对路径 / 反斜杠；
- 只允许 HTML / CSS；iframe 空 `sandbox`，JavaScript 不执行；
- 所有资源使用相对路径；不加载远程脚本、字体或音频；
- 不访问 `window.parent`、Tauri API 或宿主存储；
- 不声明 `wallpaper.sync`：静态包拿不到相位锚点，跨屏（mirror / independent）时各窗口各自播放，相位不保证一致；需要严格跨屏同步请实现内置场景；
- 不依赖构建期工具；一个静态服务器能跑即可。

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
pnpm content:sign                     # 用本机私钥给 catalog.json 的原始字节签名
pnpm content:check                    # 校验清单 + 摘要 + 目录签名（CI 与构建前置都跑这个）
```

实现：[`scripts/validate-content.mjs`](../scripts/validate-content.mjs)、[`scripts/hash-content.mjs`](../scripts/hash-content.mjs)、[`scripts/sign-content.mjs`](../scripts/sign-content.mjs)。检查范围：

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
# 把 my-scene 压缩成 zip（Windows 右键「压缩为 ZIP」即可）
```

> `--bundle` 与随包目录走同一个 `computePackageDigest()`；摘要只覆盖 entry 所在目录，
> 清单本身不在摘要范围内——否则写入 `integrity` 会改变自身字节，摘要永远算不出来。

用户侧安装（v1 已落地）：

| 方式 | 说明 |
| --- | --- |
| 拖拽 | 把 `.zip` 或解压后的文件夹拖到设置窗口，卡片提示「已安装」 |
| 手动放置 | 设置页「内容包 → 内容目录」打开 `%APPDATA%\app.lull.desktop\content\`，放好后点「刷新」 |

安装器（`src-tauri/src/content_package`）按顺序校验，任一步失败都不落盘：

1. **路径安全**：zip 条目拒绝 `..`、绝对路径、反斜杠、符号链接；
2. **体积上限**：单文件 8 MiB、整包 64 MiB、512 个文件；
3. **清单**：`catalog.json` 恰好一条 scene、id 合法、entry 在子目录内且文件存在、`license` 必填；
4. **摘要**：按 §6.1 重算并与 `integrity.digest` 比对（**缺失即拒绝**）；
5. **落地**：通过后才 `rename` 到 `content/<scene-id>/`，并广播 `content-changed` 刷新场景列表。

运行时扫描会**再复核一次摘要**：被改动过的包标记为 `tampered` 并跳过，不会渲染；
手动放置且未声明摘要的包仍可加载，但标记为「未校验」。第三方包没有目录签名，
所以「未校验」是常态，不是错误。

v1 限制：单场景包、不做第三方签名（未签名 = 未校验）、不联网、不做版本更新。
仍缺：在线索引、下载与撤回、作者密钥信任链、多场景包、自动更新。

## 8. 安全边界

- 内容包运行在 `sandbox=""` 的 iframe：不执行 JavaScript，不能调用 Tauri；
- 宿主不执行内容包里的任意 Node/Rust 代码；
- 不把「能加载 HTML」当成「安全插件系统」；
- 安装/更新/签名/权限模型落地前，不开放第三方工具窗口与原生能力。

## 9. 示例

- [`public/content/catalog.json`](../public/content/catalog.json)
- [`public/content/scenes/mist/index.html`](../public/content/scenes/mist/index.html)
- [`src/sdk/scene/manifest.test.ts`](../src/sdk/scene/manifest.test.ts)
