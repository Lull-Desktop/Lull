# Lull 官网

Astro 7 静态站：产品宣传、功能说明、下载入口与文档区。

- 线上地址：<https://lull-desktop.github.io/Lull/>
- 发布流程与仓库设置：见 [`../docs/website.md`](../docs/website.md)

## 本地开发

```bash
pnpm install
pnpm dev        # http://localhost:4321/Lull/
```

需要 **Node >= 22.23.4**（Astro 7 的引擎要求）。

## 构建

```bash
pnpm check      # 类型检查
pnpm build      # 输出到 dist/
pnpm preview    # 预览构建产物
```

## 几条约定

- **站内链接一律走 `src/lib/site.ts` 的 `page()` / `asset()`**。站点部署在
  `/Lull/` 子路径下，手写 `/features/` 在线上会 404。
- **版本号不写死**。`scripts/sync-release.mjs` 在构建前从 `package.json` 与
  GitHub Release 读取，写进 `src/data/release.json`（不入库）。
- **样式只有一个 `src/styles/global.css`**，原生 CSS + 自定义属性，没有 UI 框架。
- **文档在 `src/content/docs/`**，frontmatter 需要 `title`、`description`、`order`。
  这个目录与 Starlight 的约定一致，后续可以整层迁过去。

## 新增一个文档页

1. 在 `src/content/docs/` 加一个 `.md`，frontmatter 写 `title` / `description` / `order`。
2. 侧边栏、`/docs/` 索引、`/docs/<文件名>/` 路由都会自动出现，不用改页面代码。
