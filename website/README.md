# Lull 官网

Astro 7 静态站：产品宣传、功能说明、下载入口与文档区。

- 线上地址：<https://lull-desktop.github.io/Lull/>
- 发布流程：由 [`.github/workflows/website.yml`](../.github/workflows/website.yml) 决定，见文末「发布」

## 本地开发

```bash
pnpm install
pnpm dev        # http://localhost:4321/Lull/
```

需要 **Node >= 22.23.4**（Astro 7 的引擎要求；CI 里固定用 24）。

## 构建

```bash
pnpm check      # 类型检查 + 文档区与 docs/ 的一致性校验
pnpm docs:check # 只跑文档映射校验
pnpm build      # 输出到 dist/
pnpm preview    # 预览构建产物
```

## 站点结构

| 路径 | 内容 |
| --- | --- |
| `/` | 首页：卖点、场景预览、隐私说明 |
| `/features/` | 功能详解与架构四层 |
| `/download/` | 下载、安装步骤、从源码构建 |
| `/docs/` | 文档索引（按分组列出全部文档页） |
| `/docs/<slug>/` | 单篇文档，slug 与仓库 `docs/<name>.md` 同名 |
| `/404` | 找不到页面 |

## 文档区与仓库文档的对应关系

站点文档是仓库 `docs/*.md` 的**导读版**，一篇文章一个页面，slug 与文件名 1:1：

| 站点页面 | 仓库源文档 | 分组 |
| --- | --- | --- |
| `/docs/getting-started/` | `README.md`（开始使用 / 本地开发） | 开始使用 |
| `/docs/architecture/` | `docs/architecture.md` | 架构与运行时 |
| `/docs/native-host/` | `docs/native-host.md` | 架构与运行时 |
| `/docs/i18n-plan/` | `docs/i18n-plan.md` | 架构与运行时 |
| `/docs/scene-sdk/` | `docs/scene-sdk.md` | 扩展开发 |
| `/docs/widget-sdk/` | `docs/widget-sdk.md` | 扩展开发 |
| `/docs/widget-package/` | `docs/widget-package.md` | 扩展开发 |
| `/docs/content-format/` | `docs/content-format.md` | 扩展开发 |
| `/docs/extension-center/` | `docs/extension-center.md` | 扩展中心 |
| `/docs/extension-center-plan/` | `docs/extension-center-plan.md` | 扩展中心 |
| `/docs/contributing/` | `docs/contributing.md` | 项目 |
| `/docs/licensing/` | `docs/licensing.md` | 项目 |

`packages/*/README.md` 是包自身的使用说明，仍留在仓库（站点在文档页里外链），不单独建页面。
每次同步的差异记录在 [`docs-sync-report.md`](./docs-sync-report.md)。

## 新增或更新一个文档页

1. 在 `src/content/docs/` 加/改一个 `.md`，文件名与 `docs/<name>.md` 保持一致。
2. frontmatter 必须写 `title`、`description`，并写清 `group` 与 `source`：

   ```yaml
   ---
   title: 内容包格式
   description: 一句话说明这页解决什么问题。
   order: 6          # 组内排序，小的在前
   group: 扩展开发    # 开始使用 / 架构与运行时 / 扩展开发 / 扩展中心 / 项目
   source: docs/content-format.md
   ---
   ```

3. 侧边栏、`/docs/` 索引、`/docs/<slug>/` 路由、页脚的原文链接都会自动出现，不用改页面代码。

分组顺序写在 `src/lib/site.ts` 的 `docGroups` 里；组名写错不会让页面消失，但会排到最后一组。

`docs/` 新增文档却没有对应站点页时，`pnpm docs:check`（CI 里由 `pnpm check` 触发）会报缺页，
所以不用担心「加了文档忘了加页面」。站点自有的导读页在 `scripts/check-docs-sync.mjs` 的
`SITE_ONLY` 里登记。

## 几条约定

- **站内链接一律走 `src/lib/site.ts` 的 `page()` / `asset()`**。站点部署在
  `/Lull/` 子路径下，手写 `/features/` 在线上会 404。文档之间的相对链接用 `../<slug>/`
  （目录式输出，`trailingSlash: "always"`）。
- **版本号不写死**。`scripts/sync-release.mjs` 在构建前从根 `package.json` 与 GitHub Release
  读取，写进 `src/data/release.json`（不入库）。
- **样式只有一个 `src/styles/global.css`**，原生 CSS + 自定义属性，没有 UI 框架。
- **文档目录与 Starlight 的约定一致**（`src/content/docs/`），以后要整层迁过去只需搬目录。

## 发布

- 触发：推送到 `master` / `main` 且改到 `website/**`、`package.json`、`src-tauri/tauri.conf.json`
  或工作流本身；另外 Release 发布时重跑，用来刷新下载页元数据。PR 只构建、不部署。
- 流程：`pnpm install --frozen-lockfile` → `sync-release.mjs` → `pnpm check` → `pnpm build`
  → 上传 `website/dist` 为 Pages artifact → `deploy-pages`。
- 仓库设置：Pages 的 Source 选 **GitHub Actions**（不是分支目录）。
- 站点部署在 `/Lull/` 子路径。换自定义域名时改 `astro.config.mjs` 的 `site` / `base`
  （或构建时用 `WEBSITE_SITE` / `WEBSITE_BASE` 覆盖），并在 `public/` 放 `CNAME`。
