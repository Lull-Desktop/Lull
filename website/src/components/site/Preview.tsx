import { asset } from "@/lib/site";
import { cn } from "@/lib/utils";

interface PreviewProps {
  /** public/ 下的图片名，如 `images/scene-bamboo.jpg` */
  file: string;
  alt: string;
  captionLeft: string;
  captionRight: string;
  /** 首屏图给高优先级 */
  priority?: boolean;
  className?: string;
}

/**
 * 桌面截图的相框（原 `.preview` / `.preview__frame`）：
 * 16:9 的容器 + 一层自上而下的薄雾，让场景画面和页面底色衔接。
 */
export default function Preview({ file, alt, captionLeft, captionRight, priority, className }: PreviewProps) {
  return (
    <div className={cn("relative", className)}>
      <div
        className={cn(
          "relative overflow-hidden rounded-shell border border-line-strong bg-ink-1",
          "shadow-[var(--shadow-soft)]",
          "aspect-video",
          "after:pointer-events-none after:absolute after:inset-0 after:content-['']",
          "after:bg-[linear-gradient(180deg,transparent_55%,rgb(6_10_9/0.55)_100%)]",
        )}
      >
        <img
          className="size-full object-cover object-top"
          src={asset(file)}
          alt={alt}
          width={1440}
          height={810}
          fetchPriority={priority ? "high" : undefined}
          loading={priority ? undefined : "lazy"}
        />
      </div>
      <div className="mt-4 flex justify-between gap-3 font-mono text-[0.72rem] tracking-[0.05em] text-faint">
        <span>{captionLeft}</span>
        <span>{captionRight}</span>
      </div>
    </div>
  );
}
