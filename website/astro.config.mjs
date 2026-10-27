import { defineConfig } from "astro/config";
import sitemap from "@astrojs/sitemap";
import react from "@astrojs/react";
import tailwindcss from "@tailwindcss/vite";

/**
 * 部署目标默认是 GitHub Pages 项目页：https://lull-desktop.github.io/Lull/
 *
 * - `site` 只写域名，不带仓库名。
 * - `base` 是仓库名（项目页必须设置），Astro 用它拼静态资源与站内链接前缀。
 * - 换成自定义域名时：把 site 改成域名、base 改成 "/"，并在 public/ 放 CNAME。
 *   两处都可以用环境变量覆盖，不必改代码：
 *   WEBSITE_SITE=https://lull.app WEBSITE_BASE=/ pnpm build
 */
const site = process.env.WEBSITE_SITE ?? "https://lull-desktop.github.io";
const base = process.env.WEBSITE_BASE ?? "/Lull";

/** 末尾不带斜杠的 base，用来拼 redirects 的目标（Astro 不会替 redirects 补 base） */
const basePrefix = base.replace(/\/+$/, "");

export default defineConfig({
  site,
  base,
  /**
   * 集成：
   * - `sitemap()` 生成 sitemap-index.xml；
   * - `react()` 只用于**服务端渲染** React 组件（`.astro` 里的外壳与内容管线仍归 Astro）。
   *   页面上仅有 hero 标题与区块入场动效需要水合，其余组件不带 `client:` 指令，产物仍是静态 HTML。
   */
  integrations: [sitemap(), react()],
  /** Tailwind 走 Vite 插件（v4 的官方接法），不用 PostCSS */
  vite: {
    plugins: [tailwindcss()],
  },
  /**
   * 已合并 / 已下线的页面，旧地址仍要能打开。
   *
   * - `content-format` 的独有内容（清单、摘要、签名、安装器）已并入 `scene-sdk`；
   * - `native-host`、`extension-center`、`extension-center-plan` 站点暂不收录
   *   （见 `scripts/check-docs-sync.mjs` 的 `NOT_ON_SITE`），原文只留在仓库 `docs/`。
   *
   * 键写站内路径（Astro 按它生成 dist 里的文件），值必须自己带上 base——
   * 生成的 meta refresh 是原样输出，漏了 base 在 Pages 子路径下会 404。
   */
  redirects: {
    "/docs/content-format": `${basePrefix}/docs/scene-sdk/`,
    "/docs/native-host": `${basePrefix}/docs/`,
    "/docs/extension-center": `${basePrefix}/docs/`,
    "/docs/extension-center-plan": `${basePrefix}/docs/`,
  },
  // 目录式输出：/features/ -> features/index.html，和 GitHub Pages 的路径一致
  trailingSlash: "always",
  build: {
    format: "directory",
    // 页面很少，直接内联小资源，少几个请求
    inlineStylesheets: "auto",
  },
  markdown: {
    shikiConfig: {
      // 文档里的代码块用深色主题，和站点配色一致
      theme: "github-dark-default",
      wrap: true,
    },
  },
  devToolbar: {
    enabled: false,
  },
});
