# 官网文档区同步说明（2026-10-23）

一次核对的范围：仓库 `docs/*.md`（11 篇）、根 `README.md` 的章节与「文档」表、`website/src/content/docs/`（原 4 篇）、
站点导航（`src/components/SiteHeader.astro` / `SiteFooter.astro`）、文档路由（`src/pages/docs/**`）。

核对结论：**站点文档区原本只覆盖 4/11 篇仓库文档**，且层级是平铺的，没有表达 README 的章节归属。
本次把缺失的 8 篇补齐、引入分组层级、修掉一处悬空路径和三处链接/标题偏差，并加了一个防止再次漂移的校验脚本。

## 一、已更新的页面

| 页面 | 改动 |
| --- | --- |
| `/docs/`（索引） | 由平铺卡片改为按 5 个分组排布；文案从「快速开始、架构、场景 SDK、插件包格式」改为覆盖全部 12 篇；每张卡片标出对应的仓库源文件 |
| `/docs/getting-started/` | 补 `group` / `source`；命令表补指向[参与贡献]与[架构与模块]的入口，新增「接下来」一节按角色分流 |
| `/docs/architecture/` | 「原生桌面宿主」改为站内跳转（原来只给 GitHub 链接），仓库链接保留作深入阅读 |
| `/docs/scene-sdk/` | 页脚「内容包格式」改为站内 `../content-format/`，不再只指向 GitHub |
| `/docs/widget-package/` | 页脚补 `../widget-sdk/`（宿主侧能力与 ACL），并保留包 README 外链 |
| 文档页脚（全部） | 新增「本页对应 `docs/xxx.md` ↗」——页面归属变成可点可查的事实，不再只写在文案里 |
| 站点页脚 | 「场景与插件」→「场景与内容包」（原文案指向 `scene-sdk`，名不副实）；新增「插件与扩展」「贡献指南」两条；「许可说明」由 GitHub 外链改为站内 `/docs/licensing/` |
| 下载页 | 「分发改造版前请先看许可说明」补上站内链接 |

## 二、新增的页面（8 篇）

| 站点页面 | 仓库源文档 | 分组 |
| --- | --- | --- |
| `/docs/widget-sdk/` | `docs/widget-sdk.md` | 扩展开发 |
| `/docs/content-format/` | `docs/content-format.md` | 扩展开发 |
| `/docs/extension-center/` | `docs/extension-center.md` | 扩展中心 |
| `/docs/extension-center-plan/` | `docs/extension-center-plan.md` | 扩展中心 |
| `/docs/native-host/` | `docs/native-host.md` | 架构与运行时 |
| `/docs/i18n-plan/` | `docs/i18n-plan.md` | 架构与运行时 |
| `/docs/contributing/` | `docs/contributing.md` | 项目 |
| `/docs/licensing/` | `docs/licensing.md` | 项目 |

写作口径与既有页面一致：只做导读摘要（命令、表格、边界条件），字段级细节留在原文并在页脚给出链接。
站点页面数由 4 增加到 12，构建产物 17 页。

## 三、删除的页面

**无。** 逐个核对后没有发现「与 `docs/` 冲突或已被取代」的站点页：

- `getting-started` 在 `docs/` 里没有同名文件，但它是 README「开始使用 / 本地开发」两节的站点版，
  下载页、页脚、导航都指向它，删掉会断入口——保留，并在 `scripts/check-docs-sync.mjs` 的
  `SITE_ONLY` 里登记为「站点自有导读页」。
- `widget-package`、`scene-sdk`、`architecture` 均已确认与源文档同期，无需下线。

## 四、修正的位置 / 路径偏差

| 问题 | 原状 | 处理 |
| --- | --- | --- |
| 悬空引用 | `website/README.md` 写「发布流程与仓库设置：见 `../docs/website.md`」，该文件从未进过仓库（`git log --all -- docs/website.md` 无记录；建站时它只是本地未提交文件，后来丢失） | 删除该引用，把发布流程（触发条件、构建步骤、Pages 设置、`site`/`base`）内联进 `website/README.md`，事实源指向 `.github/workflows/website.yml`。这也和根 README「官网与自动发布 → `website/README.md`」的归属一致，不需要再造 `docs/website.md` |
| 层级缺失 | 12 篇文档平铺在侧栏，与 README「架构 → 场景 → 插件 → 内容 → 扩展中心 → 原生宿主 → 多语言 → 贡献 → 许可」的顺序和归属都看不出来 | 引入 `group` 字段 + `docGroups`（开始使用 / 架构与运行时 / 扩展开发 / 扩展中心 / 项目），侧栏与索引都按组呈现，组内仍按 `order` 排序 |
| 页面归属不可查 | 页面上没有「这篇对应仓库哪个文件」的线索 | 新增 `source` 字段，页脚渲染成 `docs/xxx.md ↗`；索引卡片也标出源文件 |
| 站点路径规则未落地 | `website/README.md` 只给了 `page()` / `asset()` 约定，没写文档间相对链接怎么写，容易在线上 404 | README 补上「文档间用 `../<slug>/`（目录式输出 + `trailingSlash: always`）」 |
| 标题与分组撞名 | 页面 `扩展中心` 与分组 `扩展中心` 同名，卡片读起来像重复 | 页面标题改为「扩展中心设计」，与源文档标题「扩展中心（Extension Center）设计」对齐 |
| 索引页描述过期 | `docs/index.astro` 的 description 只提 4 个主题 | 改为覆盖全部 12 篇的内容概述，篇数与分组数由集合实时算出，不再写死 |

## 五、为防止再次漂移加的东西

- `website/scripts/check-docs-sync.mjs`：比对 `docs/*.md` 与 `src/content/docs/*.md`，
  缺页、多页、`source` 指向不存在的文件都会退出码 1。
- `website/package.json` 的 `check` 改为 `astro check && node scripts/check-docs-sync.mjs`，
  CI 的 `website.yml` 跑的就是 `pnpm check`，所以「加了文档忘了加页面」会直接把构建打红。

## 六、验证结果

```text
astro check        0 errors / 0 warnings / 0 hints（17 个 Astro 文件）
astro build        17 page(s) built；/docs/ 下 12 篇
check-docs-sync    11 篇仓库文档 ↔ 12 个站点页面，一致
站内链接扫描        17 个 HTML 中所有 /Lull/* 的 href/src 均能落到实际文件，无 404
```

## 七、仍未解决的不一致

| # | 不一致 | 原因 | 建议 |
| --- | --- | --- | --- |
| 1 | **Node.js 版本**：根 `README.md` 与 `docs/contributing.md` 写 24，`.node-version` 实际是 `22` | 文档与版本文件各改一次忘了同步；CI 里应用侧读 `.node-version`（22），官网工作流显式用 24 并在注释里说明「比根目录的 22 更严格」 | 站点两处（快速开始、参与贡献）按实际文件写 22。需要文档侧定调：要么把 README/contributing 改成 22，要么把 `.node-version` 提到 24 并重跑前端测试 |
| 2 | `packages/scene-sdk/README.md`、`packages/widget-sdk/README.md` 没有站点页 | README 的「场景开发 / 插件开发」两行同时指向 `docs/` 与 `packages/`，但包说明跟包版本走，复制到站点会变成第三份需要维护的副本 | 维持外链。若以后要在站内做「SDK 参考」，应由包 README 单源生成，而不是手写 |
| 3 | `getting-started` 在 `docs/` 里没有对应文件 | 它是 README 使用章节的站点版，属于站点自有内容 | 已在 `SITE_ONLY` 登记。若希望严格 1:1，需要先在 `docs/` 建 `getting-started.md`，再把站点页改成引用 |
| 4 | `extension-center-plan` 的「当前进度（2026-10-23）」是时间快照 | 实施计划天然会过期，M5「部分」、M6「🟡」这类状态随开发推进变化 | 站点保留该表但标题明确写「实施计划」；里程碑推进时同步更新，无法自动比对 |
| 5 | 站点文档是导读，不是全文镜像 | 有意为之：站内维护全量副本必然与 `docs/` 漂移，字段级内容留在仓库 | 正文措辞不做自动 diff；能自动守住的只有「页面存在且指向正确源文件」 |
| 6 | 根 README 的目录结构注释写 `docs/ # 架构、SDK、内容格式、原生宿主、贡献指南`，没提扩展中心、多语言、许可 | README 自身描述滞后，与 `docs/` 实际内容（11 篇）不符 | 一行字的事，属 README 侧待补；站点已按实际文件列全 |
| 7 | 站点只有中文，应用支持 `zh-CN` / `en-US` | 官网没有做 i18n，属于产品决策而非文档结构问题 | 如要做英文站，需先定内容归属（英文文档从哪来），否则会多出一套无人维护的翻译 |

# 追加：`content-format` 并入 `scene-sdk`（2026-10-24）

`/docs/content-format/` 与 `/docs/scene-sdk/` 讲的是同一件事——一个场景包长什么样、怎么打包、怎么装。
两页开头是同一段状态说明，包结构、静态/脚本包、安全边界、`Compress-Archive` 警告四处近乎逐句重复，
读者要在两页之间来回对照才知道「清单字段在哪、SDK 怎么用」。

处理：以 `scene-sdk` 为唯一入口，把 `content-format` 的独有内容并进去，站点不再保留后者。

## 保留的内容

- 从 `scene-sdk` 保留：静态包 / 脚本包的分界与适用场景、`pnpm scenes:sdk` 与 `onFrame` 用法、
  设置页按 `params` 自动渲染控件与热更、脚本包的能力边界（无宿主 DOM / Tauri IPC / Win32）。
- 从 `content-format` 保留：`public/content/` 与 `dist/content/` 目录约定、`catalog.json` 完整示例与
  JSON Schema 位置、`entry` / `params` / `wallpaper.script` 的声明约束、版本与兼容约定表、
  宿主读取目录的容错、`content:hash|pack|sign|check` 四条命令、包摘要算法、目录签名（ECDSA P-256）、
  安装器五步校验与 v1 限制、体积上限与非签名目录的处理。

## 删掉的重复

- 两页完全相同的开头三行（已落地能力、`theme`/`sound-preset`/`layout` 预留、Beta 提示）——只留一份；
- 「包结构」写了两遍（`scene-sdk` 的 `my-scene/catalog.json/scenes/mist` 与 `content-format` 的
  `public/content/` 目录树）——合成一节「目录结构与 catalog.json」，创作者侧结构并入「包结构与约束」；
- 静态包 / 脚本包的 sandbox 差异、`Compress-Archive` 警告、安装时复核摘要——各留一处；
- 安全边界两段合并，去掉「不能访问宿主 DOM」的重复表述。

## 同步改动的位置

| 位置 | 改动 |
| --- | --- |
| `src/content/docs/scene-sdk.md` | 重写为合并版，`order` 3（接管被删页的槽位）、`description` 覆盖打包与安装 |
| `src/content/docs/content-format.md` | 删除（内容已并入） |
| `astro.config.mjs` | `redirects`：`/docs/content-format` → `${base}/docs/scene-sdk/`。**目标必须自己带 base**，Astro 不会替 redirects 补 |
| `scripts/check-docs-sync.mjs` | 新增 `MERGED_INTO`（`content-format` → `scene-sdk`）：不再要求单独建页，并校验目标页存在、旧页无残留 |
| `src/content/docs/getting-started.md` | 「想做场景」一行去掉指向旧页的链接 |
| `src/pages/docs/index.astro` | 索引 description 的「场景与插件开发、内容包格式」改为「场景包与插件开发」 |
| `README.md` | 映射表删掉 `content-format` 行、补合并登记说明；frontmatter 示例改用 `widget-sdk` |

侧栏、`/docs/` 索引、文档卡片都由集合自动生成，删页后自动消失，无需改页面代码。

## 验证

```text
astro check        0 errors / 0 warnings / 0 hints（18 个文件）
astro build        13 page(s)；/docs/ 下 8 篇 + 1 个重定向页
check-docs-sync    content-format 不再算缺页；仅剩 native-host、extension-center-plan 两篇缺页（本次之前就缺）
站内链接扫描        14 个 HTML、300 条 /Lull/* 链接全部落地，无残留指向 content-format
sitemap           不含 /docs/content-format/（Astro 不把重定向页写进 sitemap）
```

