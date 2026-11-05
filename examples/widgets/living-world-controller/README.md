# Living World Controller（示例 Widget）

P1 遗留的控制器示例补齐：读取 `community.living-world` 的快照，发送 `plant.seed` /
`plant.water` 命令，并展示事件与生命周期。

```text
widget.json   # capabilities: game.state.read / game.command.send / game.event.read
index.html
style.css
src/main.ts   # @lull/widget-sdk + @lull/game-sdk/widget，零 Tauri IPC
dist/         # pnpm widgets:samples:build 生成（不入库）
```

```bash
pnpm widgets:samples:build                # 构建全部示例（含 game:sdk）
pnpm widgets:samples:build -- living-world-controller
pnpm extensions:build                     # 打包扩展中心分发的扩展
```

安装：把 `examples/widgets/living-world-controller/dist` 作为 Widget 包安装，
在扩展中心启用并授予声明的 3 个 `game.*` 能力，然后在设置页「游戏」启动
`community.living-world`。权威游戏包见
[`examples/games/living-world`](../../games/living-world/README.md)。
