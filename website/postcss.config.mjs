/**
 * 站点不使用 Tailwind，也不需要任何 PostCSS 插件。
 *
 * 这个文件必须存在：否则 Vite 会向上找到仓库根的 postcss.config.mjs
 * （那是桌面应用的 Tailwind 配置），在 website 里解析失败并中断构建。
 */
export default {
  plugins: [],
};
