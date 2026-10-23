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
  }),
});

export const collections = { docs };
