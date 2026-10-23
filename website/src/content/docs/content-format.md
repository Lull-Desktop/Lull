---
title: 内容包格式
description: catalog.json、包结构、整包摘要与目录签名——官方内容和社区内容共用的一套格式。
order: 6
group: 扩展开发
source: docs/content-format.md
---

## 状态

v1 已落地**静态场景包**与声明 `wallpaper.script` 的**沙箱脚本场景包**。
`theme` / `sound-preset` / `layout` 三种类型的清单字段已在 SDK 里预留，但宿主尚未加载，
不要在说明里把它们算成已支持。

## 内容根目录

随安装包分发的内容位于 `public/content/`，构建时原样复制到 `dist/content/`：

```text
public/content/
  catalog.json          # 内容索引，运行时唯一发现入口
  scenes/
    mist/
      index.html
      assets/…
```

没有登记在 `catalog.json` 里的目录不会被加载。

## 目录文件

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

JSON Schema 在 `content/schema/`（`catalog.schema.json`、`scene.schema.json`）。

## 包结构与约束

```text
scenes/<name>/
  index.html        # 必需，entry 指向它
  assets/           # 可选，只能相对引用
  LICENSE           # 建议随包附带
  README.md         # 可选
```

- `entry` 必须是 `.html`，相对包根目录，禁止 `..`、绝对路径与反斜杠。
- **静态包**：只有 HTML / CSS，iframe 用空 `sandbox`，JavaScript 不执行。
- **脚本包**：声明 `wallpaper.script`，iframe 用 `sandbox="allow-scripts"`，通过
  [`@lull/scene-sdk`](../scene-sdk/) 读参数、几何与同步相位；资源协议下发 nonce CSP，只允许包内资源。
- 声明 `params` 必须同时声明 `wallpaper.params`；外部场景用 `wallpaper.params` / `wallpaper.sync`
  时必须同时声明 `wallpaper.script`。
- 所有资源走相对路径；CSP 默认阻止远程脚本、字体、图片与音频。

## 版本与兼容

| 字段 | 规则 |
| --- | --- |
| `schemaVersion` | 破坏性格式变更才升；当前 `1`，不支持则拒绝 |
| 内容 `version` | 独立语义化版本；同 id 新版本覆盖旧版本 |
| `compatibility.hostApi` | 场景清单生效；超出当前宿主 API 的场景会被过滤 |
| `dependencies` | 预留，首版不解析 |
| `id` | 一经发布不改名，改名视为新内容 |

宿主读取目录时的容错：目录缺失 / 损坏 → 只保留内置场景；单条 manifest 非法 → 只跳过该条；
重复 id → 保留第一条；缺 `integrity` → 仍加载，但标记为不可校验。

## 校验命令

```powershell
pnpm content:hash                     # 重算并写回 integrity
pnpm content:hash --bundle ./my-scene # 重算待分发的独立内容包
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

## 安装器

创作者产出一个**内容包目录**，结构与 `public/content/` 完全同构——这样摘要算法、校验脚本、
安装器三处只认一种格式。安装时按顺序校验，任一步失败都不落盘：

1. **路径安全**：拒绝 `..`、绝对路径、反斜杠、符号链接；
2. **体积上限**：单文件 8 MiB、整包 64 MiB、512 个文件；
3. **清单**：恰好一条 scene、id 合法、entry 在子目录内、`license` 必填；
4. **摘要**：重算并与 `integrity.digest` 比对（缺失即拒绝）；
5. **落地**：通过后才 rename 到 `content/<scene-id>/`，并广播 `content-changed`。

运行时扫描会再复核一次摘要，被改动的包标记为 `tampered` 并跳过。v1 限制：单场景包、
不做第三方签名、不联网；scene 支持同 id 覆盖安装。

> 别用 `Compress-Archive`：它可能把 zip 条目写成反斜杠路径，安装器会以
> `package.unsafe-entry` 拒绝。`content:pack` 统一写正斜杠和 UTF-8。

## 安全边界

静态包不执行 JavaScript、不能调用 Tauri；脚本包跑在 `allow-scripts` 的 opaque-origin iframe 里，
没有同源存储、Cookie 和宿主 DOM 读取权限，只能通过 `window.parent.postMessage` 与宿主桥通信。
「能加载 HTML / 能跑沙箱脚本」不等于「安全插件系统」。

完整字段与校验实现见仓库
[内容包格式](https://github.com/Lull-Desktop/Lull/blob/main/docs/content-format.md)。
