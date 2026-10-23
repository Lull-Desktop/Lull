---
title: 架构与模块
description: 四层分层、壁纸运行协议，以及为什么原生宿主是核心而不是附属品。
order: 2
group: 架构与运行时
source: docs/architecture.md
---

## 四层

| 层 | 位置 | 职责 |
| --- | --- | --- |
| **Core** | `src-tauri/src/{wallpaper,window_host,config}` + `src/core` | 桌面宿主、显示器拓扑、窗口生命周期、配置、IPC、原生桥 |
| **Extensions** | `src/sdk/*` + `src/scenes` + `src/widgets` + `packages/*-sdk` | 场景清单与目录协议、脚本场景桥、工具窗口能力分层 |
| **Community** | `content/schema` + `public/content` + 校验脚本 + `content_package` | 内容包格式、包摘要、目录签名、本地安装器 |
| **Services** | 计划中 | 内容索引、同步、发布服务；不影响本地核心运行 |

设计理念：方便第三方生态扩展(壁纸内容+Widget插件)

## 壁纸模块

壁纸窗口通过URL哈希与后端进行类型通信：

```text
mode / sync / scene / canvas / view / params
```

- Rust 负责算出每块屏的 canvas 与 view，以及跨屏同步的相位。
- 前端 `SceneHost` 按场景 Manifest 解析默认值、能力与兼容性，再选择内置组件或外部包。
- 脚本场景由 `scene-bridge` 把帧推给 `@lull/scene-sdk` 的 `onFrame((frame) => ...)`。

设置里改参数 → 热更 URL 哈希 → 场景收到新的 `frame.params`，全程不重启壁纸。

## 原生宿主核心

Tauri 的普通窗口挂不进桌面层。Lull 用 `lull_native.dll`（C++）通过 C ABI 完成
WorkerW / Progman 的查找与子窗口挂载，Rust 侧用一个薄 FFI 边界加载它。

与仓库的 [架构说明](https://github.com/Lull-Desktop/Lull/blob/master/docs/architecture.md)

## 前端界面

设置窗、壁纸窗、工具窗共用一个 Next.js 静态导出产物（`dist/`），由 Tauri 以不同窗口
加载不同路由。  
>编译流程 `pnpm build` 会先跑 `prebuild.mjs`：
>校验内容 → 编译 DLL → 清 `dist/.next` → Next 静态导出 → 触碰 `lib.rs` 强制重嵌入。
