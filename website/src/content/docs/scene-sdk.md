---
title: 场景与 Scene SDK
description: 写一个能装进 Lull 的场景包：清单字段、静态包与脚本包的区别、参数与同步怎么拿到。
order: 3
group: 扩展开发
source: docs/scene-sdk.md
---

## 内容包长这样

```text
my-scene/
  catalog.json
  scenes/mist/
    index.html
```

`catalog.json` 里登记场景清单：`id`、`version`、`license`、`entry`、`capabilities`，
可选 `performance` 与 `compatibility`。

## 静态包：只有 HTML + CSS

静态包在 `sandbox=""` 的 iframe 中运行：

- 不执行 JavaScript；
- 没有 Tauri IPC、没有同源存储；
- 不能声明参数或同步，动态效果只能用 CSS 动画。

适合纯视觉的渐变、粒子（CSS）、缓慢位移一类场景。这是**风险最低**的一档，
装进来也不会有脚本执行。

## 脚本包：拿到宿主下发的帧

需要参数、几何或跨屏同步时，声明 `wallpaper.params`、`wallpaper.sync` 与 `wallpaper.script`，
并在包里打包 `@lull/scene-sdk`：

```powershell
pnpm scenes:sdk
# 在场景工程里用 esbuild / Vite 把 main.ts 打成包内 main.js
```

```ts
import { scene } from "@lull/scene-sdk";

scene.onFrame((frame) => {
  // frame.params  用户在设置里改的值
  // frame.canvas  这块屏在虚拟桌面里的位置
  // frame.view    当前窗口的可视区域
  // frame.phase   跨屏同步相位
});
```

设置页会按 Manifest 的 `params` 自动渲染控件（带 `min`/`max` 的数字参数渲染成滑条）；
改值后热更壁纸 URL 哈希，再由 `onFrame` 把新参数送到场景，不需要重启壁纸。

## 安全边界

脚本场景运行在 opaque-origin 的 `allow-scripts` iframe 中，只能通过 Scene SDK 桥读取宿主下发的帧：

- 不能访问宿主 DOM；
- 不能调用任意 Tauri IPC 或 Rust 命令；
- 不能调用 Win32。

它**不是**通用插件系统。第三方签名、在线更新与回滚都还没做。

## 打包与安装

```powershell
pnpm content:hash --bundle ./my-scene
pnpm content:hash --bundle ./my-scene --check
pnpm content:pack ./my-scene --out artifacts
```

> 不要用 Windows 自带的 `Compress-Archive`：它可能把 zip 条目写成反斜杠路径，
> Lull 安装器会按安全规则拒绝。`content:pack` 统一写正斜杠与 UTF-8。

打包后在「扩展」页「从文件安装」选择 zip 或直接拖入。安装时会复核清单与整包摘要，
安装过程不执行代码，启用时才授权。

可以直接安装的示例见仓库
[`examples/content/param-demo`](https://github.com/Lull-Desktop/Lull/tree/main/examples/content/param-demo)（参数演示）
与 [`examples/content/three-scene`](https://github.com/Lull-Desktop/Lull/tree/main/examples/content/three-scene)（Three.js WebGL）。

字段级规范：[Scene SDK](https://github.com/Lull-Desktop/Lull/blob/main/docs/scene-sdk.md) ·
[内容包格式](../content-format/)（站内摘要 / 仓库原文）。
