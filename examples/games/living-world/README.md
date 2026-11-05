# Living World（示例游戏包）

P1/P4 的最小可运行示例：一个零构建的**单包完整游戏**，同时包含逻辑与可见渲染。

- 包名：`community.living-world`
- 入口：`authority/index.html`（隐藏窗口，host-tick 提交）、`replica/index.html`（壁纸可见渲染）
- 模式：`host-tick`（宿主每 1s 发 tick，游戏不自己跑循环）
- 存档：`{ simulationMs, water, bloom, plants[], lastSettledMs }`

## 运行

1. 把整个目录（或 `community.living-world-1.1.2.lull-game.zip`）通过扩展中心安装为游戏，或在设置页游戏页签里启用。
2. 设置页「游戏」点「设为壁纸」：壁纸宿主直接加载包内 `replica/index.html`，不需要安装场景。
3. 启动游戏后，隐藏的 `game-authority-*` 窗口会加载 `authority/index.html`；植物随时间生长，可通过控制器 Widget 或设置页操作。
4. 也可以继续安装 `examples/scenes/living-world`，把场景当作可选主题；场景与包内 replica 共用同一套 `game.*` 只读桥。

## 说明

示例直接使用 `docs/game-runtime.md` 定义的宿主壳 ↔ 游戏 iframe 协议，不依赖打包工具；
正式游戏应改用 `@lull/game-sdk`。它刻意不做失败惩罚、签到或倒计时，符合 Ambient Game 定位。
