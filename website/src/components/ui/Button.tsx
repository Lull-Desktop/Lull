import { cva, type VariantProps } from "class-variance-authority";
import type { AnchorHTMLAttributes } from "react";
import { cn } from "@/lib/utils";

/**
 * 主按钮 / 幽灵按钮（原 `.btn` 与 `.btn--ghost`、`.btn--sm`）。
 * 站内链接必须已经过 `page()` 补过 base，组件本身不拼路径。
 */
const button = cva(
  [
    "inline-flex items-center gap-2.5 whitespace-nowrap rounded-full border border-transparent",
    "text-[0.92rem] font-semibold tracking-[0.01em] no-underline",
    "transition-[transform,box-shadow,background-color,border-color,color] duration-200",
    "hover:-translate-y-px",
  ],
  {
    variants: {
      variant: {
        solid: "bg-green-bright text-[#08110c] hover:text-[#08110c] hover:shadow-[0_10px_30px_-12px_rgb(200_224_182/0.5)]",
        ghost:
          "border-line-strong bg-transparent font-medium text-mist hover:border-green hover:bg-green/8 hover:text-white hover:shadow-none",
      },
      size: {
        md: "px-[22px] py-3",
        sm: "px-4 py-2 text-[0.84rem]",
      },
    },
    defaultVariants: { variant: "solid", size: "md" },
  },
);

export type ButtonProps = AnchorHTMLAttributes<HTMLAnchorElement> & VariantProps<typeof button>;

export function Button({ className, variant, size, ...props }: ButtonProps) {
  return <a className={cn(button({ variant, size }), className)} {...props} />;
}

/** 按钮行（原 `.btn-row`） */
export const buttonRow = "flex flex-wrap items-center gap-3";
