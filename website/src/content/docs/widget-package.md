---
title: Widget 插件包
description: 用原生 JS、React 或 Vue 写一个工具窗口，装到 Lull 的扩展里。
order: 5
group: 扩展开发
source: docs/widget-package.md
---

## 结构

Widget 是静态包，安装到用户目录后由宿主壳加载：

```text
my-widget/
  manifest.json      # 清单：id、version、入口、能力
  index.html         # 入口页面
  assets/            # 构建产物
```

宿主提供：iframe 外壳、Rust 侧状态 KV、可自绘的窗口顶栏、透明背景。插件本身不碰 Tauri IPC。

## 三种示例

仓库里三个示例插件覆盖三套技术栈，直接对照着改最快：

| 示例 | 技术栈 | 位置 |
| --- | --- | --- |
| `pomodoro-js` | 原生 TypeScript | `examples/widgets/pomodoro-js` |
| `pomodoro-react` | React | `examples/widgets/pomodoro-react` |
| `pomodoro-vue` | Vue | `examples/widgets/pomodoro-vue` |

```powershell
pnpm widgets:sdk              # 构建 @lull/widget-sdk（dist + .d.ts）
pnpm widgets:samples:build    # 构建三个示例
pnpm widgets:samples:install  # 装到本地用户目录
```

## 打包分发

```powershell
pnpm widget:pack examples/widgets/pomodoro-react/dist
```

产物是 `.lull-widget.zip`，用户侧在「扩展」页拖入即可安装。安装只解包并校验清单，
不执行插件代码；启用时才按清单声明的能力授权。

## 能力与边界

- 能力按清单声明分层，默认最小权限；
- 没有宿主 DOM、没有任意 IPC、没有 Win32；
- 状态通过 Rust 侧 KV 持久化，不依赖浏览器存储。

完整清单字段与宿主壳行为见[Widget SDK](../widget-sdk/)（宿主侧能力分层与 ACL）、
[Widget 插件包格式](https://github.com/Lull-Desktop/Lull/blob/main/docs/widget-package.md)
与 [`@lull/widget-sdk` 说明](https://github.com/Lull-Desktop/Lull/blob/main/packages/widget-sdk/README.md)。
