# Living World · 森林（示例 Replica 场景）

P2 的只读渲染示例：声明 `game: { id: "community.living-world", role: "replica" }`，
通过 `game.*` postMessage 消息读取快照与生命周期，在 canvas 上绘制植物与水位。

```text
catalog.json                     # 场景包清单（hostApi 2）
scenes/living-world/index.html   # 入口
scenes/living-world/main.js      # 零构建渲染示例
```

- 场景永远拿不到写权限：没有 commitState / command / publishEvent。
- 游戏未运行或场景未绑定时，宿主发送 `game.unavailable`，场景保持静态视觉。
- **这是可选主题**：`examples/games/living-world` 1.1.2 起自带 `replica/`，可直接设为壁纸；
  本场景用于验证“同一游戏世界、可替换视觉层”的 Scene 绑定路径。
- 正式场景请使用 `@lull/game-sdk/scene` 的 `connectLullGameRender()`；本示例为
  了零构建直接实现了同一份协议。
