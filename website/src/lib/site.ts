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

/**
 * 社区站点（独立的 GitHub Pages 项目页，不在本站 base 下）。
 * 外链不能过 `page()`，否则会被拼成 `/Lull/https://...`。
 */
export const communityUrl = "https://lull-desktop.github.io/Lull-Community/";

/**
 * 文档分组顺序。
 *
 * 和 README 的章节归属对齐：先用（开始使用）→ 再懂（架构与运行时）→ 再做扩展
 * （扩展开发 / 扩展中心）→ 最后是项目治理（项目）。分组名写在每个 md 的
 * frontmatter 里，顺序只在这里定，避免各处各写一套。
 */
export const docGroups = ["开始使用", "架构与运行时", "扩展开发", "扩展中心", "项目"] as const;

/** 仓库内文档的 GitHub 链接，例如 sourceUrl("docs/architecture.md") */
export function sourceUrl(path: string): string {
  return `${repoUrl}/blob/master/${path.replace(/^\/+/, "")}`;
}

/**
 * 按 docGroups 的顺序把文档分组，组内按 order 排序。
 * 未知分组排在最后，避免新加的 md 写错组名就整页消失。
 */
export function groupDocs<T extends { data: { group: string; order: number } }>(entries: T[]) {
  const buckets = new Map<string, T[]>();
  for (const entry of entries) {
    const key = entry.data.group;
    const list = buckets.get(key) ?? [];
    list.push(entry);
    buckets.set(key, list);
  }

  const known: (typeof docGroups)[number][] = [...docGroups];
  const ordered = known.filter((name) => buckets.has(name));
  const unknown = [...buckets.keys()].filter((name) => !(known as string[]).includes(name));

  return [...ordered, ...unknown].map((name) => ({
    name,
    entries: (buckets.get(name) ?? []).sort((a, b) => a.data.order - b.data.order),
  }));
}

export const siteMeta = {
  name: "Lull",
  nameZh: "云栖",
  tagline: "云栖之处，安然入眠",
  description:
    "Lull（云栖）是一款开源的助眠与专注桌面应用：竹影、暮色与极光在桌面上缓缓流动，雨声与远雷在耳边轻轻起伏。断网可用，不推送、不打扰。",
} as const;

export const navItems = [
  { href: page("/features/"), label: "功能", external: false },
  { href: page("/docs/"), label: "文档", external: false },
  { href: page("/download/"), label: "下载", external: false },
  // 站外页面：顶栏里排在下载之后，新标签页打开
  { href: communityUrl, label: "社区", external: true },
] as const;
