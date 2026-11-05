# Living World（示例游戏包）

P1 的最小可运行示例：一个零构建的 Authority iframe + `game.json`。

- 包名：`community.living-world`
- 入口：`authority/index.html`
- 模式：`host-tick`（宿主每 1s 发 tick，游戏不自己跑循环）
- 存档：`{ simulationMs, water, bloom, plants[], lastSettledMs }`

## 运行

1. 把整个目录（或打包后的 zip）通过扩展中心安装为游戏，或在设置页游戏页签里启用。
2. 启动游戏后，隐藏的 `game-authority-*` 窗口会加载 `authority/index.html`。
3. 用 P2 的场景或控制器 Widget 观察/操作；P1 可直接在设置页启动、停止、立即保存。

## 说明

示例直接使用 `docs/game-runtime.md` 定义的宿主壳 ↔ 游戏 iframe 协议，不依赖打包工具；
正式游戏应改用 `@lull/game-sdk`。它刻意不做失败惩罚、签到或倒计时，符合 Ambient Game 定位。
