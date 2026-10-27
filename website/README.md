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

### 安装 UI 组件（shadcn / React Bits）

组件不是手写的，走 shadcn 注册表装进 `src/components/<Name>.tsx`：

```bash
pnpm ui:add @react-bits/SplitText-TS-TW    # 等价于 npx shadcn@latest add …
```

注册表已在 `components.json` 里配好（`@react-bits` → `https://reactbits.dev/r/{name}.json`），
所以**只写 `@react-bits/<Name>-TS-TW`**。写成 `@//react-bits/...` 会被当成默认注册表
（`ui.shadcn.com`）下的路径，直接报：

```
The item at https://ui.shadcn.com/r/styles/new-york-v4/@//react-bits/SplitText-TS-TW.json was not found.
```

后缀 `-TS-TW` 表示 TypeScript + Tailwind 变体，本站只装这一种。已安装：`SplitText`、`FadeContent`，
用法与「必须带 `client:*`」的约束见下面「组件与样式」。

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
| `/features/` | 功能详解与四层架构 |
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
| `/docs/i18n-plan/` | `docs/i18n-plan.md` | 架构与运行时 |
| `/docs/scene-sdk/` | `docs/scene-sdk.md`（含已并入的 `docs/content-format.md`） | 扩展开发 |
| `/docs/widget-sdk/` | `docs/widget-sdk.md` | 扩展开发 |
| `/docs/contributing/` | `docs/contributing.md` | 项目 |
| `/docs/licensing/` | `docs/licensing.md` | 项目 |

`docs/` 里还有三篇**站点暂不收录**，原文留在仓库供开发与 review，旧地址在
`astro.config.mjs` 的 `redirects` 里跳到 `/docs/`：

| 仓库源文档 | 不收录的原因 |
| --- | --- |
| `docs/native-host.md` | 原生宿主的内部分层说明，随实现变动 |
| `docs/extension-center.md` | 扩展中心的设计稿，实现稳定前不对外 |
| `docs/extension-center-plan.md` | 实施计划，天然会过期 |

`packages/*/README.md` 是包自身的使用说明，仍留在仓库（站点在文档页里外链），不单独建页面。
每次同步的差异记录在 [`docs-sync-report.md`](./docs-sync-report.md)。

站点页与仓库文档默认 1:1，两种例外都要在脚本里登记，否则 `pnpm check` 会红：

- **合并**（`MERGED_INTO`）：`docs/` 里两篇讲同一件事，站点只建一页、把另一篇的内容并进来
  （`content-format` → `scene-sdk`）。脚本会校验目标页存在、旧页没有残留。
- **暂不收录**（`NOT_ON_SITE`）：原文只留在 `docs/`，站点不建页，必须写原因
  （`native-host`、`extension-center`、`extension-center-plan`）。脚本会校验文件存在、
  站点里没有同名页、原因非空。

两种情况都要在 `astro.config.mjs` 的 `redirects` 里给旧地址一个去处，
否则线上老链接会硬 404。

## 新增或更新一个文档页

1. 在 `src/content/docs/` 加/改一个 `.md`，文件名与 `docs/<name>.md` 保持一致。
2. frontmatter 必须写 `title`、`description`，并写清 `group` 与 `source`：

   ```yaml
   ---
   title: Widget SDK
   description: 一句话说明这页解决什么问题。
   order: 5          # 组内排序，小的在前
   group: 扩展开发    # 开始使用 / 架构与运行时 / 扩展开发 / 扩展中心 / 项目
   source: docs/widget-sdk.md
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
- **样式统一走 Tailwind**：令牌在 `global.css` 的 `@theme`，标记里只写工具类，
  组件复用靠 `components/ui/*`，详见上面「组件与样式」。
- **`.astro` 管外壳、`.tsx` 管内容**：`getCollection` / `render()` / `Astro.url` / `<slot>`
  进不了 React，别把页面骨架搬进 `.tsx`。
- **文档目录与 Starlight 的约定一致**（`src/content/docs/`），以后要整层迁过去只需搬目录。

## 组件与样式

Astro 负责外壳，React 负责内容组件，Tailwind 负责全部样式。

```
src/
  pages/*.astro            路由与 frontmatter（必须留在 Astro：文件路由 + 构建期数据）
  layouts/*.astro          <html>/<head>/<slot> 组合（必须留在 Astro）
  components/
    site/*.tsx             页面级组件：SiteHeader / HomeHero / DownloadHero / DocNav …
    ui/*.tsx               原子件：Button / Card / Chip / Text（Eyebrow、Lead、TextLink、Code）
    ui/layout.ts           共享工具类字符串：container / section / section-tight
    SplitText.tsx          React Bits（shadcn 注册表安装，勿手改）
    FadeContent.tsx        React Bits（同上）
  styles/global.css        Tailwind 入口：@theme 令牌 + base 层 + `.prose`
```

**分工边界**：`getCollection`、`render()`、`Astro.url`、`<slot>`、页面文件都只能在 `.astro` 里。
`.astro` 页面只给 React 组件传**可序列化的数据 props**，不要给它传 children——children 会被
Astro 渲染成静态 HTML 再塞进组件，`<astro-slot>` 包裹会破坏布局。

**样式规则**：

- 色值、字体、圆角、容器宽度、阴影只写在 `global.css` 的 `@theme` 里，页面用 `bg-ink`、
  `text-mist`、`rounded-card`、`max-w-site`、`py-section` 这类工具类，不再手写 hex 或像素。
- 重复出现的组合收进 `components/ui/*.tsx`，不新造 CSS 类名。
- 只有两处允许写 CSS：`@layer base`（body 背景光晕、选中色、焦点环、减少动效）与
  `.prose`（Markdown 正文的标签由 Astro 生成，挂不上工具类）。
- 自定义字号令牌（`--text-hero` 等）要在 `src/lib/utils.ts` 的 `extendTailwindMerge` 里登记，
  否则 `tailwind-merge` 会把 `text-hero` 和 `text-mist` 当成同一组、互相覆盖。

**动画组件**：站点只有两个动效面，都用 React Bits 实现，原先的 CSS `@keyframes rise` 已删除。

| 场景 | 组件 | 水合指令 |
| --- | --- | --- |
| 首屏标题逐字升起 | `SplitText`（effect="rise" + mask） | `client:load`（首屏不能等滚动） |
| 区块 / 卡片滚动入场 | `FadeContent`（stagger） | `client:visible` |

> `FadeContent` 会先给容器挂 `invisible`，靠 JS 点亮。**凡是包含它的组件都必须带
> `client:*` 指令**，否则内容永远不可见；同时要给容器加 `data-fade-content`，
> `BaseLayout` 的 `<noscript>` 靠这个属性做无 JS 兜底。

**文档页仍然是零 JS**：`/docs/*` 上没有 `client:` 指令，产物里没有 `<script>`。

## 加一个 React Bits 组件

```bash
cd website
pnpm ui:add @react-bits/<Name>-TS-TW    # 组件名从注册表里查，见「安装 UI 组件」
```

组件落到 `src/components/<Name>.tsx`，样式走 Tailwind 变体（后缀 `-TS-TW`）。
也可以接 shadcn MCP（`npx shadcn@latest mcp`）让 AI 直接搜索并安装：见仓库根
`components.json` 的 `registries` 字段与 `~/.workbuddy/mcp.json` 里的 `shadcn` 服务。

## 发布

- 触发：推送到 `master` / `main` 且改到 `website/**`、`package.json`、`src-tauri/tauri.conf.json`
  或工作流本身；另外 Release 发布时重跑，用来刷新下载页元数据。PR 只构建、不部署。
- 流程：`pnpm install --frozen-lockfile` → `sync-release.mjs` → `pnpm check` → `pnpm build`
  → 上传 `website/dist` 为 Pages artifact → `deploy-pages`。
- 仓库设置：Pages 的 Source 选 **GitHub Actions**（不是分支目录）。
- 站点部署在 `/Lull/` 子路径。换自定义域名时改 `astro.config.mjs` 的 `site` / `base`
  （或构建时用 `WEBSITE_SITE` / `WEBSITE_BASE` 覆盖），并在 `public/` 放 `CNAME`。
