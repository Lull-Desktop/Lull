import { defineConfig } from "astro/config";
import sitemap from "@astrojs/sitemap";

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

export default defineConfig({
  site,
  base,
  integrations: [sitemap()],
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
