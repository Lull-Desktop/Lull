/**
 * 通用样式工具：合并条件类名并去重 Tailwind 冲突，供 UI 组件统一复用。
 */
import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
