/**
 * 站点 URL 工具。
 *
 * GitHub Pages 项目页的根不是 `/`，而是 `/Lull/`（见 astro.config.mjs 的 base）。
 * 所以站内链接**不能**手写 `/features/`，必须过这里的 helper，
 * 否则本地开发正常、线上 404——这是 Astro + Pages 最常见的坑。
 */

/** 末尾不带斜杠的 base："" 或 "/Lull" */
export const base = (import.meta.env.BASE_URL || "/").replace(/\/+$/, "");

/** 站内页面链接，补上 base 与结尾斜杠（trailingSlash: "always"） */
export function page(path: string): string {
  const clean = path.startsWith("/") ? path : `/${path}`;
  const normalized = clean === "/" ? "/" : clean.endsWith("/") ? clean : `${clean}/`;
  return `${base}${normalized}` || "/";
}

/** public/ 下的静态资源，例如 asset("images/scene-bamboo.jpg") */
export function asset(path: string): string {
  return `${base}/${path.replace(/^\/+/, "")}`;
}

/** 仓库相关的外链 */
export const repoUrl = "https://github.com/Lull-Desktop/Lull";
export const releasesUrl = `${repoUrl}/releases`;
export const issuesUrl = `${repoUrl}/issues`;

export const siteMeta = {
  name: "Lull",
  nameZh: "云栖",
  tagline: "云栖之处，安然入眠",
  description:
    "Lull（云栖）是一款开源的助眠与专注桌面应用：竹影、暮色与极光在桌面上缓缓流动，雨声与远雷在耳边轻轻起伏。断网可用，不推送、不打扰。",
} as const;

export const navItems = [
  { href: page("/features/"), label: "功能" },
  { href: page("/docs/"), label: "文档" },
  { href: page("/download/"), label: "下载" },
] as const;
