# Stability Probe（P3 稳定性测试游戏）

用于《隐藏 WebView2 / WebGL 稳定性报告》的**单包完整游戏**：同一个
`community.stability-probe-*.lull-game.zip` 同时包含逻辑与可见渲染。

- `authority/`：`runtime.authority: "self-loop"`，权威页自己驱动循环；
  **推进/提交用 `setInterval`，rAF 只负责渲染与帧统计**。隐藏窗口里若 `frames`
  停住而 `commits` 继续，说明 rAF 被挂起；两者都停则整个隐藏 WebView 被暂停；
- `replica/`：壁纸可见的指标墙，只读 `game.*` 消息，画出每屏的
  `displayId / mode / revision / frames / longFrames / contextLost / heap`；
- 首份快照可能是 `{}`；1.0.2 起会合并默认字段，避免 `simulationMs` 为 `NaN`
  导致 `game_state_commit` 的 `u64` 反序列化失败；
- 初始化 WebGL 画布，监听 `webglcontextlost` / `webglcontextrestored`；
- 每秒提交一次 `frames / longFrames / worstFrameMs / avgFrameMs / contextLost / contextRestored / heapUsed`；
- 每 30s 发一次 `probe.stats` 事件，便于用 journal 检查长跑。

## 使用（不再需要单独安装场景）

1. 安装 `examples/games/release/community.stability-probe-1.0.3.lull-game.zip`
   （或把本目录复制到 `%APPDATA%\app.lull.desktop\games\community.stability-probe`），
   在扩展中心启用；
2. 设置页「游戏」里点「设为壁纸」。底层的 `wallpaper_set_game` 会把
   `display.game` 指向本包，壁纸宿主直接加载 `entry.replica`；
3. 两块显示器都会显示指标墙（mirror/span 都走同一份 `entry.replica`）；
4. 跑 2 小时后在设置页点「复制诊断」，并用
   `node scripts/game-stability-report.mjs --out report.md` 采集显示器/实例/journal 事实；
5. 按 [稳定性报告](../../../docs/game-runtime-webview-stability.md) 的阈值填写结论。

> 只测隐藏 Authority 时不必设为壁纸：启动游戏后它会在后台提交统计。
> 需要看画面时再「设为壁纸」，或把 URL 哈希改成 `#...&game=community.stability-probe`。

若启动时报 `authority.not_ready`，先用 `LULL_GAME_AUTHORITY_VISIBLE=1` 重启 Lull，
观察隐藏窗口里的 Console；同时确认 `tauri.conf.json` 的 `frame-src` 包含
`http://lullgame.localhost`（本轮曾因漏配导致所有游戏 10s 超时）。

P3 对照：
- 默认 self-loop 权威窗是 **1×1 visible**（避免跨源 iframe 被当成隐藏页）；
- `LULL_GAME_AUTHORITY_HIDDEN=1` 强制隐藏，复现旧行为；
- `LULL_GAME_AUTHORITY_VISIBLE=1` 显示 320×240 窗口看 Console。
