# 官方扩展源码

这里放随安装包分发的官方 Widget 扩展。每个子目录是一个标准 Widget 包源码
（`widget.json` + `index.html` + `src/`），与第三方包格式相同，只是由宿主按
「官方来源」识别：默认启用、可停用不可卸载、随 App 升级、构建期摘要锁。

```text
extensions/official/
  echo/          # P1 自检包：验证官方来源 / 默认授权 / 状态 KV / 主题；发布前删除
  noise/         # P3：白噪音（规划）
  player/        # P4：播放器（规划）
  _shared/       # 官方扩展共享的 React/i18n/媒体 Hub 代码（P2+）
extensions/dist/  # 构建产物（gitignore，保留 .gitkeep 供 bundle.resources 指向）
```

## 命令

```powershell
pnpm extensions:build                 # 构建全部官方扩展 → extensions/dist/<id>/
pnpm extensions:build echo            # 只构建一个
pnpm extensions:dev echo              # Tier 2：Vite dev server（5272），宿主直接加载 HMR
pnpm extensions:watch echo            # Tier 1：监听源码变化并重建；宿主里点「重载」
pnpm extensions:check                 # 边界检查 + 产物/摘要/index 校验（CI）
```

Tier 2 需要在扩展源码目录放 `.lull-dev.json`（点号文件，不进包）：

```json
{ "schemaVersion": 1, "server": "http://127.0.0.1:5272" }
```

宿主只在 **debug 构建**、且地址是 loopback 时加载 dev server；release 会忽略并拒绝挂载
带 `.lull-dev.json` 的目录。`echo` 已带一份示例。

`pnpm dev` 与 `pnpm build` 会自动构建；`extensions/dist` 由 Tauri 作为
`bundle.resources` 打进安装包，便携版由 `pnpm release:package` 一起收进 zip。

## 注意

- 扩展只能依赖 `@lull/widget-sdk` / `@lull/media-sdk`；禁止 `@/`、Tauri IPC、
  localStorage、远程 URL。`pnpm extensions:check` 会扫描源码。
- 构建期写入 `.lull-integrity.json`（`source: declared`），运行时缺锁或摘要不符会拒绝加载。
- `echo` 只是 P1 的链路自检，P3 之前删除；不要把它当正式功能发布。
- 开发模式、HMR、媒体连接 Hub 的设计见
  [`docs/extension-dev-mode.md`](../docs/extension-dev-mode.md)；官方来源与升级语义见
  [`docs/official-extensions.md`](../docs/official-extensions.md)。
