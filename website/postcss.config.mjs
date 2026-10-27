/**
 * 站点不使用 PostCSS 插件：Tailwind v4 通过 `@tailwindcss/vite` 走 Vite 插件层
 * （见 astro.config.mjs 的 vite.plugins），CSS 里只有 `@import "tailwindcss"`，
 * 不需要 postcss 链路。
 *
 * 这个文件必须存在：否则 Vite 会向上找到仓库根的 postcss.config.mjs
 * （那是桌面应用的 Tailwind 配置），在 website 里解析失败并中断构建。
 */
export default {
  plugins: [],
};
