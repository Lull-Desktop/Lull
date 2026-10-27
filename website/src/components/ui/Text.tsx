import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/** 小标题（原 `.eyebrow`）：全大写、宽字距、雾绿 */
export function Eyebrow({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <p className={cn("mb-[18px] text-eyebrow font-medium uppercase tracking-[0.32em] text-green", className)}>
      {children}
    </p>
  );
}

/** 导语（原 `.lead`） */
export function Lead({ children, className }: { children: ReactNode; className?: string }) {
  return <p className={cn("max-w-[46ch] text-lead text-body", className)}>{children}</p>;
}

/** 版块标题组（原 `.section-head`）：限制阅读宽度 + 下方留白 */
export function SectionHead({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn("mb-[clamp(32px,4vw,52px)] max-w-[60ch]", className)}>{children}</div>;
}

/** 正文里的行内链接：雾绿、无下划线，hover 提亮（原全局 `a` 规则） */
export function TextLink({ href, children, ...rest }: { href: string; children: ReactNode } & Record<string, unknown>) {
  return (
    <a href={href} className="text-green-bright no-underline transition-colors hover:text-[#eaf6de]" {...rest}>
      {children}
    </a>
  );
}

/** 行内代码（原全局 `code` 规则，不含 Markdown 正文里的那份） */
export function Code({ children }: { children: ReactNode }) {
  return (
    <code className="rounded-[5px] border border-line bg-green/10 px-[0.42em] py-[0.14em] font-mono text-[0.88em] break-words text-green-bright">
      {children}
    </code>
  );
}
