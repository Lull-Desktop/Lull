import { defineCollection } from "astro:content";
import { glob } from "astro/loaders";
import { z } from "astro/zod";

/**
 * 文档集合。
 *
 * 目录刻意选在 `src/content/docs/`——和 Starlight 的约定一致，
 * 以后要把文档区换成 Starlight，只需要搬这一层，页面路径不用动。
 */
const docs = defineCollection({
  loader: glob({ base: "./src/content/docs", pattern: "**/*.md" }),
  schema: z.object({
    title: z.string(),
    description: z.string(),
    /** 侧边栏排序，小的在前 */
    order: z.number().default(99),
    /**
     * 所属分组，对应 README 的章节归属（开始使用 / 架构与运行时 / 扩展开发 / 扩展中心 / 项目）。
     * 分组顺序由 `src/lib/site.ts` 的 `docGroups` 决定，这里只写名字。
     */
    group: z.string().default("扩展开发"),
    /**
     * 对应的仓库源文档（相对仓库根，如 `docs/architecture.md`）。
     * 站点页面与仓库文档保持 1:1，页脚会据此给出原文链接，便于对照与追更。
     * 站点自有的导读页写它取材的文档（如 `README.md`）。
     */
    source: z.string().optional(),
  }),
});

export const collections = { docs };
