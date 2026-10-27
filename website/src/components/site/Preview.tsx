import { asset } from "@/lib/site";
import { cn } from "@/lib/utils";

interface PreviewProps {
  /** public/ 下的图片名，如 `images/scene-bamboo.jpg` */
  file: string;
  alt: string;
  captionLeft: string;
  captionRight: string;
  /** 设置窗口截图是 16:10，不要按 16:9 裁 */
  ui?: boolean;
  /** 首屏图给高优先级 */
  priority?: boolean;
  className?: string;
}

/**
 * 桌面截图的相框（原 `.preview` / `.preview__frame`）：
 * 16:9 或 16:10 的容器 + 一层自上而下的薄雾，让截图和页面底色衔接。
 */
export default function Preview({ file, alt, captionLeft, captionRight, ui, priority, className }: PreviewProps) {
  return (
    <div className={cn("relative", className)}>
      <div
        className={cn(
          "relative overflow-hidden rounded-shell border border-line-strong bg-ink-1",
          "shadow-[var(--shadow-soft),var(--shadow-glow)]",
          ui ? "aspect-[16/10]" : "aspect-video",
          "after:pointer-events-none after:absolute after:inset-0 after:content-['']",
          "after:bg-[linear-gradient(180deg,transparent_55%,rgb(6_10_9/0.55)_100%)]",
        )}
      >
        <img
          className="size-full object-cover object-top"
          src={asset(file)}
          alt={alt}
          width={1440}
          height={ui ? 900 : 810}
          fetchPriority={priority ? "high" : undefined}
          loading={priority ? undefined : "lazy"}
        />
      </div>
      <div className="mt-3 flex justify-between gap-3 text-[0.78rem] text-faint">
        <span>{captionLeft}</span>
        <span>{captionRight}</span>
      </div>
    </div>
  );
}
