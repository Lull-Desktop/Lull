import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/** 内容卡片（原 `.card`），带一层极淡的顶光渐变 */
export function Card({ className, children }: { className?: string; children: ReactNode }) {
  return (
    <article
      className={cn(
        "relative rounded-card border border-line bg-gradient-to-b from-ghost-2 to-transparent p-6",
        "transition-[border-color,transform] duration-200 hover:-translate-y-0.5 hover:border-line-strong",
        className,
      )}
    >
      {children}
    </article>
  );
}

/** 卡片标题行（原 `.card h3`），可带一个线性图标 */
export function CardTitle({ children }: { children: ReactNode }) {
  return <h3 className="mb-2 flex items-center gap-2.5 text-h3 text-mist">{children}</h3>;
}

/** 卡片正文（原 `.card p`） */
export function CardBody({ children }: { children: ReactNode }) {
  return <p className="m-0 text-[0.92rem] leading-[1.72] text-muted">{children}</p>;
}

/** 卡片角标（原 `.card__tag`） */
export function CardTag({ children }: { children: ReactNode }) {
  return (
    <span className="mt-3.5 inline-block text-[0.72rem] uppercase tracking-[0.08em] text-faint">{children}</span>
  );
}

/** 卡片栅格：三列 / 两列，断点与改造前一致 */
export const grid3 = "grid grid-cols-3 gap-[18px] max-[940px]:grid-cols-2 max-[640px]:grid-cols-1";
export const grid2 = "grid grid-cols-2 gap-[18px] max-[640px]:grid-cols-1";
