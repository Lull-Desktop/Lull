---
title: Scene SDK(Beta)
description: 这里介绍如何用 Scene SDK 写一个壁纸资源包
order: 3
group: 扩展开发
source: docs/scene-sdk.md
---
>当前仍处于 **Beta 测试阶段**，我们会尽力保持各版本之间的向后兼容性，如有重大变更会提前在社区公告。

目前已落地的能力包括**静态场景包**与声明 `wallpaper.script` 的**沙箱脚本场景包**。
`theme` / `sound-preset` / `layout` 三种类型的清单字段已在 SDK 里预留，但宿主尚未加载，
不要在说明里把它们算成已支持。


## 包结构

随安装包分发的内容位于 `public/content/`，构建时原样复制到 `dist/content/`：

```text
public/content/
  catalog.json          # 内容索引
  scenes/
    mist/
      index.html
      assets/…
```

>没有登记在 `catalog.json` 里的目录不会被加载。

`catalog.json` 是唯一的内容索引，`scenes[]` 里每条描述一个场景包：

## 清单字段

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
      "license": "CC-BY-4.0",
      "capabilities": ["wallpaper.viewport", "wallpaper.canvas"],
      "entry": "scenes/mist/index.html",
      "performance": { "tier": "low", "targetFps": 30 },
      "compatibility": { "hostApi": 1, "platforms": ["windows"] },
      "integrity": { "algorithm": "sha256", "scope": "package", "digest": "…" }
    }
  ]
}
```

一条场景清单必填 `id`、`version`、`license`、`entry`、`capabilities`，通常还要有 `integrity`
（打包时由 `content:hash` 写回；缺失时宿主仍加载但标记为不可校验，安装器则直接拒绝）；
可选 `performance` 与 `compatibility`。JSON Schema 在 `content/schema/`
（`catalog.schema.json`、`scene.schema.json`）。

## 包结构与约束

创作者产出一个**场景包目录**，结构与 `public/content/` 完全同构——这样摘要算法、校验脚本、
安装器三处只认一种格式：

```text
scenes/<name>/
  index.html        # 必需，entry 指向它
  assets/           # 可选，只能相对引用
  LICENSE           # 建议随包附带
  README.md         # 可选
```

- `entry` 必须是 `.html`，相对包根目录，禁止 `..`、绝对路径与反斜杠。
- 声明 `params` 必须同时声明 `wallpaper.params`；外部场景用 `wallpaper.params` / `wallpaper.sync`
  时必须同时声明 `wallpaper.script`。
- 所有资源走相对路径；CSP 默认阻止远程脚本、字体、图片与音频。

包分两档，差别只在「跑不跑脚本」：

- **静态包**：只有 HTML / CSS，iframe 用空 `sandbox`；
- **脚本包**：声明 `wallpaper.script`，iframe 用 `sandbox="allow-scripts"`。

## 静态包：只有 HTML + CSS

静态包在 `sandbox=""` 的 iframe 中运行：

- 不执行 JavaScript；
- 没有 Tauri IPC、没有同源存储；
- 不能声明参数或同步，动态效果只能用 CSS 动画。

适合纯视觉的渐变、粒子（CSS）、缓慢位移一类场景。这是**风险最低**的一档，
装进来也不会有脚本执行。

## 脚本包：接入 SDK

需要参数、几何或跨屏同步时，需要声明 `wallpaper.params`、`wallpaper.sync` 与 `wallpaper.script`，
并在包里打包 `@lull/scene-sdk`：

```ts
import { scene } from "@lull/scene-sdk";

scene.onFrame((frame) => {
  // frame.params  用户在设置里改的值
  // frame.canvas  这块屏在虚拟桌面里的位置
  // frame.view    当前窗口的可视区域
  // frame.phase   跨屏同步相位
});
```

设置页会按清单的 `params` 自动渲染控件（带 `min`/`max` 的数字参数渲染成滑条）；
改值后热更壁纸 URL 哈希，再由 `onFrame` 把新参数送到场景，不需要重启壁纸。

脚本包的资源协议会额外下发 nonce CSP，只允许包内资源。

## 版本与兼容约定

| 字段 | 规则 |
| --- | --- |
| `schemaVersion` | 破坏性格式变更才升；当前 `1`，不支持则拒绝 |
| 场景 `version` | 独立语义化版本；同 id 新版本覆盖旧版本 |
| `compatibility.hostApi` | 场景清单生效；超出当前宿主 API 的场景会被过滤 |
| `dependencies` | 预留，首版不解析 |
| `id` | 一经发布不改名，改名视为新内容 |

宿主读取目录时的容错：目录缺失 / 损坏 → 只保留内置场景；单条清单非法 → 只跳过该条；
重复 id → 保留第一条；缺 `integrity` → 仍加载，但标记为不可校验。

## 开发工具

```powershell
pnpm content:hash                     # 重算并写回 integrity
pnpm content:hash --bundle ./my-scene # 重算待分发的独立场景包
pnpm content:pack ./my-scene --out artifacts
pnpm content:sign                     # 给 catalog.json 原始字节签名
pnpm content:check                    # 清单 + 摘要 + 目录签名，CI 与构建前置都跑
```

### 包摘要

摘要覆盖包目录内的**全部文件**，不是只覆盖 entry：

```text
sha256(
  "lull-content-package\0" +
  id + "\0" + version + "\0" +
  Σ(相对路径 + "\0" + 字节数 + "\0" + 文件字节 + "\0")
)
```

把 id / version 拌进摘要防止张冠李戴，路径按 UTF-8 字节序排序保证可复现；
包内不允许符号链接，避免「摘要覆盖的字节」和「运行时读到的字节」不一致。

### 目录签名

签名对象是 `catalog.json` 的原始字节（不做 JSON 规范化），算法 ECDSA P-256 / SHA-256，
签名文件 `public/content/catalog.sig.json`，公钥随包分发、运行时用 WebCrypto 验签。
私钥只在本机 `.keys/`（gitignore）或 CI secret 里。签名不匹配的目录会被拒绝加载，
未签名目录仍可加载，但设置页会标注「未签名」。

## 打包与安装

```powershell
pnpm content:hash --bundle ./my-scene
pnpm content:hash --bundle ./my-scene --check
pnpm content:pack ./my-scene --out artifacts
```

打包后在「扩展」页「从文件安装」选择 zip 或直接拖入。安装时按顺序校验，任一步失败都不落盘：

1. **路径安全**：拒绝 `..`、绝对路径、反斜杠、符号链接；
2. **体积上限**：单文件 8 MiB、整包 64 MiB、512 个文件；
3. **清单**：恰好一条 scene、id 合法、entry 在子目录内、`license` 必填；
4. **摘要**：重算并与 `integrity.digest` 比对（缺失即拒绝）；
5. **落地**：通过后才 rename 到 `content/<scene-id>/`，并广播 `content-changed`。

安装过程不执行代码，启用时才授权。运行时扫描会再复核一次摘要，被改动的包标记为
`tampered` 并跳过。v1 限制：单场景包、不做第三方签名、不联网；scene 支持同 id 覆盖安装。

> 别用 `Compress-Archive`：它可能把 zip 条目写成反斜杠路径，安装器会以
> `package.unsafe-entry` 拒绝。`content:pack` 统一写正斜杠和 UTF-8。

## 安全边界

静态包不执行 JavaScript、不能调用 Tauri；脚本包跑在 opaque-origin 的 `allow-scripts` iframe 里，
没有同源存储、Cookie，只能通过 `window.parent.postMessage` 与宿主桥通信，因此：

- 读不到宿主 DOM；
- 不能调用任意 Tauri IPC 或 Rust 命令；
- 不能调用 Win32。

「能加载 HTML / 能跑沙箱脚本」不等于「安全插件系统」。它**不是**通用插件系统：
第三方签名、在线更新与回滚都还没做。

## 参考

- 可直接安装的示例：[`examples/scenes/param-demo`](https://github.com/Lull-Desktop/Lull/tree/master/examples/scenes/param-demo)（参数演示）、
  [`examples/scenes/three-scene`](https://github.com/Lull-Desktop/Lull/tree/master/examples/scenes/three-scene)（Three.js WebGL）。
- 字段级规范：[Scene SDK](https://github.com/Lull-Desktop/Lull/blob/master/docs/scene-sdk.md) ·
  [内容包格式](https://github.com/Lull-Desktop/Lull/blob/master/docs/content-format.md)（清单、摘要、签名与安装器的完整定义）。
