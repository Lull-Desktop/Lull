# Three.js 三维光轨（脚本场景示例）

验证 **WebGL（Three.js）场景 + Scene SDK 参数热更**：

```text
Setting 改参数
  → wallpaper_set_scene_params
  → URL 哈希热更
  → SceneHost 重算帧
  → scene.onFrame
  → Three.js 更新材质/相机/粒子
```

## 参数

| 参数 | 类型 | 默认 / 范围 | 效果 |
| --- | --- | --- | --- |
| `speed` | number | 0.35 / 0–1.5 | TorusKnot 旋转速度 |
| `particles` | number | 1600 / 300–5000 | 星尘数量 |
| `tint` | color | `#7fd6c8` | 主色 |
| `wireframe` | boolean | true | 线框 / 实体 |
| `tilt` | number | 18 / -45–45° | 倾角 |

## 构建与打包

```powershell
pnpm scenes:samples:build   # 构建 param-demo 与 three-scene 的 main.js
pnpm scenes:samples:hash    # 重算两个示例的 integrity
pnpm scenes:samples:pack    # 产物：artifacts/demo.three-scene-1.0.0.zip
```

安装：设置 → 扩展 → 从文件安装 `artifacts/demo.three-scene-1.0.0.zip`，
然后在「壁纸」页选择「三维光轨（Three.js）」。调整参数应立即生效。

> Three.js 已随 `main.js` 打包（MIT，见包内 `THIRD_PARTY_NOTICES.md`），
> 不加载远程脚本；场景仍运行在 `sandbox="allow-scripts"` 的 opaque-origin iframe。
