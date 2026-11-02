# Mini Player（第三方播放器示例）

一个刻意做小的 `music-player` Provider，用来验证 Lull 的官方模块替换与 Slot 互斥：

- `widget.json` 声明 `provides: [{ "slot": "music-player", "version": 1 }]`；
- 只通过 `@lull/widget-sdk` + `@lull/media-sdk/widget` 访问宿主；
- 不创建音频引擎、不读写本地文件、不调用 Tauri IPC；
- 支持播放 / 暂停、上一首 / 下一首、进度、音量、静音，并在没有曲目时自动取曲库第一首。

> 这是测试/示例包，不是官方播放器；没有签名，也没有完整的曲库、队列与封面 UI。

## 构建与安装

```powershell
# 只构建这个示例
pnpm widgets:samples:build mini-player

# 只安装到 %APPDATA%\app.lull.desktop\widgets\community-mini-player\
pnpm widgets:samples:install mini-player
```

安装后打开 **设置 → 扩展**：

1. 点「刷新」，找到 **Mini Player (Example)**；
2. 点「启用」，确认 `widget.media` / `media.player.*` / `media.queue.read` / `media.library.read` 能力；
3. 到顶部的「功能槽位 → 音乐播放器」点「切换实现」；
4. 选择 **Mini Player (Example)**，点「使用并打开」。

它应当替换官方播放器窗口，但**不会停止**当前音乐；音乐状态由宿主 Media Service 保留。

## 替换与互斥测试清单

- [ ] 官方播放器正在运行，切换到 Mini Player：官方窗口停止，Mini Player 打开，音乐继续。
- [ ] 从 Mini Player 切回官方：Mini Player 窗口停止，官方窗口打开，音乐继续。
- [ ] 关闭 Mini Player 窗口：只是隐藏，功能槽位仍属于 Mini Player；托盘再次打开它。
- [ ] 点「结束运行」：Mini Player 窗口销毁，功能槽位保留选择；再次打开正常。
- [ ] 停用 Mini Player：窗口销毁，槽位显示「不可用」，不会自动切回官方；重新启用后恢复。
- [ ] 卸载正在运行的 Mini Player：窗口被清理，槽位回退/清空，不自动播放。
- [ ] 音乐与白噪音同时运行：切换播放器不影响白噪音 Session。
- [ ] 重启 Lull：Mini Player 的选择保留，但不自动开窗、不自动播放。
- [ ] 在 Mini Player 未选中时，扩展卡片不应直接「打开」它——只能通过「使用」进入槽位。

## 打包成 ZIP（可选）

```powershell
node scripts/pack-widget.mjs examples/widgets/mini-player/dist
```

产物是可安装的 `.lull-widget.zip`，也可以在设置页用「从文件安装」导入。
