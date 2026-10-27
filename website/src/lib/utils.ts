import { type ClassValue, clsx } from "clsx";
import { extendTailwindMerge } from "tailwind-merge";

/**
 * tailwind-merge 只认识内置的字号刻度（`text-sm`、`text-[13px]`…）。
 * 我们在 `@theme` 里自定义了 `--text-hero` 等令牌，生成的选择器仍是 `text-hero`，
 * 默认会被它当成「文字颜色」和 `text-mist` 判为同一组而互相覆盖
 * （结果就是 `text-eyebrow` 被 `text-green` 挤掉，字号退回 16px）。
 * 这里把自定义字号登记进去，两边才能各归各组。
 */
const twMerge = extendTailwindMerge({
  extend: {
    classGroups: {
      "font-size": [{ text: ["hero", "h2", "h3", "lead", "eyebrow", "small"] }],
    },
  },
});

/** 合并 Tailwind 类名：clsx 负责条件拼接，twMerge 负责消解冲突。 */
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
