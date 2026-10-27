import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/** 小标签（原 `.chip` / `.chip--green`），用于版本号与运行环境提示 */
export function Chip({ green, children }: { green?: boolean; children: ReactNode }) {
  return (
    <span
      className={cn(
        "whitespace-nowrap rounded-full border border-line px-[11px] py-1 text-[0.76rem] text-muted",
        green && "border-green/32 bg-green/6 text-green-bright",
      )}
    >
      {children}
    </span>
  );
}
