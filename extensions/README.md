# 官方扩展源码

这里放随安装包分发的官方扩展。每个子目录是一个标准扩展包源码，与第三方包格式相同，
只是由宿主按「官方来源」识别：默认启用、随 App 升级、构建期摘要锁定。

- **widget**：`widget.json` + `index.html` + `src/`，运行时是带能力的工具窗口；
- **scene**：`catalog.json` + `index.html` + `src/`，运行时是壁纸场景 iframe。

`player` / `noise` 在清单里声明 `provides`，分别是 `music-player` / `noise-controller`
槽位的默认 Provider；第三方同类扩展可替换它们。规则见
[扩展槽位与 Provider](../docs/extension-slots.md)。

```text
extensions/official/
  noise/         # P3：音境工坊（React + 媒体 SDK）
  player/        # P4：播放器（React + Media Hub 会话）
  bamboo/        # 竹影壁纸（场景包；构建产物 id=lull.bamboo）
  _shared/       # 官方扩展共享的构建期声明（virtual messages 类型等）
extensions/dist/  # 构建产物（gitignore，保留 .gitkeep 供 bundle.resources 指向）
```

## 命令

```powershell
pnpm extensions:build                 # 构建全部官方扩展 → extensions/dist/<id>/
pnpm extensions:build bamboo          # 只构建竹影（也可用产物 id lull.bamboo）
pnpm extensions:dev player            # Tier 2：Vite dev server（仅 widget）
pnpm extensions:mount player          # 把 widget 源码目录写进宿主 dev 配置
pnpm extensions:watch bamboo          # Tier 1：监听源码变化并重建；宿主里切场景重载
pnpm extensions:check                 # 边界检查 + 产物/摘要/index 校验（CI）
```

Tier 2 需要在扩展源码目录放 `.lull-dev.json`（点号文件，不进包）：

```json
{ "schemaVersion": 1, "server": "http://127.0.0.1:5274" }
```

宿主只在 **debug 构建**、且地址是 loopback 时加载 dev server；release 会忽略并拒绝挂载
带 `.lull-dev.json` 的目录。`noise` / `player` 均带示例；**scene 暂不支持 Tier 2**，
用 `extensions:build` / `extensions:watch` 后重载壁纸。

`extensions/dist/<id>` 同时是 debug 宿主的**官方静态包**：即使开发模式开着，只要没有
挂载源码目录，宿主仍会把它识别成官方扩展并加载入口。实机调试播放器时必须
额外执行 `pnpm extensions:mount player`（或通过设置页挂载），让 `devPackages` 指向源码。

`extensions:mount` 写的是本机
`%APPDATA%\app.lull.desktop\extensions.json`（`devMode: true` + `devPackages`）。
写入后需要让宿主重新读取：重启 debug 应用，或在设置里重新打开扩展面板后点卡片「重载」。
如果只开了开发模式但 `devPackages` 为空，播放器仍会加载 `extensions/dist` 的静态产物。

> 开发服务器已设置 `server.cors: true`。插件 iframe 是 `sandbox="allow-scripts"`，
> origin 为 `null`；若去掉该配置，Vite 默认不会回显 `null` origin，模块脚本会被
> 浏览器 CORS 拦截，窗口只显示 DEV 角标而没有内容。

`pnpm dev` 与 `pnpm build` 会自动构建；`extensions/dist` 由 Tauri 作为
`bundle.resources` 打进安装包，便携版由 `pnpm release:package` 一起收进 zip。

## 注意

- 扩展只能依赖 `@lull/widget-sdk` / `@lull/scene-sdk` / `@lull/media-sdk`；禁止 `@/`、Tauri IPC、
  localStorage、远程 URL。`pnpm extensions:check` 会扫描源码。
- widget 构建期写入 `.lull-integrity.json`（`source: declared`）；scene 的整包摘要写进
  `catalog.json` 的 `scenes[0].integrity`。运行时缺锁或摘要不符会拒绝加载。
- `noise` 通过 `virtual:lull-messages` 复用仓库消息表；`m` 只支持 `{name}` 形式的占位符。
- 开发模式、HMR、媒体连接 Hub 的设计见
  [`docs/extension-dev-mode.md`](../docs/extension-dev-mode.md)；官方来源与升级语义见
  [`docs/official-extensions.md`](../docs/official-extensions.md)。
