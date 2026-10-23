# 参数演示（脚本场景示例）

验证这条链路：**Setting 参数控件 → `wallpaper_set_scene_params` → URL 哈希热更 →
`SceneHost` 重算帧 → `@lull/scene-sdk` `onFrame` → 外部场景更新 CSS**。

## 文件

```text
param-demo/
  catalog.json                 # demo.param-scene 1.1.0
  scenes/param-demo/
    index.html                 # 场景页面
    main.js                    # 由 src/main.ts 构建（已提交，便于直接安装）
  src/main.ts                  # SDK 用法示例
```

参数：`glow` / `tint` / `pulse`，1.1.0 新增 `blur` / `hue` / `ring`。

## 重新构建

```powershell
pnpm scenes:samples:build     # 构建 main.js（内部先构建 @lull/scene-sdk）
pnpm scenes:samples:hash      # 内容变了必须重算 catalog.json 的 integrity
```

## 安装与更新验证

用仓库的打包器（正斜杠 + UTF-8，安装器只接受这种 zip）：

```powershell
pnpm scenes:samples:pack
# 产物：artifacts/demo.param-scene-1.1.0.zip
```

1. 先安装 1.0.0：`artifacts/demo.param-scene-1.0.0.zip`；
2. 再安装 1.1.0：`artifacts/demo.param-scene-1.1.0.zip`；
3. 设置页会显示「确认更新」，安装后版本变成 1.1.0，壁纸窗按版本重建 iframe；
4. 在「壁纸」页调新增的「光晕模糊 / 色相偏移 / 显示光环」，壁纸应立即变化。

设置 → 扩展 → 从文件安装；安装后在「壁纸」页选择「参数演示（脚本场景）」。

> 该包声明 `wallpaper.script`，运行在 `sandbox="allow-scripts"` 的 opaque-origin iframe。
> 它只能通过 Scene SDK 读取参数与帧，没有 Tauri IPC、宿主 DOM 或原生能力。
