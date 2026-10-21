/**
 * PostCSS 配置：接入 Tailwind CSS v4 的构建管线。
 * 插件以包名声明，交给 Next/Turbopack 解析其原生依赖。
 */
const config = {
  plugins: ["@tailwindcss/postcss"],
};

export default config;
