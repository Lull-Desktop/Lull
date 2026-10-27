import FadeContent from "@/components/FadeContent";
import { container, sectionTight } from "@/components/ui/layout";
import { asset, page } from "@/lib/site";
import { cn } from "@/lib/utils";

export interface Scene {
  file: string;
  name: string;
  note: string;
  alt: string;
}

/**
 * 场景画廊：四张 16:9 截图，滚动进入时逐个淡入（React Bits `FadeContent` 的 stagger）。
 * 悬停放大仍然是纯 CSS（`group-hover`），不需要 JS。
 */
export default function SceneGallery({ scenes }: { scenes: Scene[] }) {
  return (
    <section className={sectionTight}>
      <div className={container}>
        <FadeContent
          trigger="scroll"
          stagger={0.08}
          duration={0.8}
          data-fade-content
          className="grid grid-cols-4 gap-3.5 max-[860px]:grid-cols-2"
        >
          {scenes.map((scene) => (
            <a
              key={scene.file}
              className="group relative block aspect-video overflow-hidden rounded-[14px] border border-line bg-ink-1 no-underline"
              href={page("/features/")}
            >
              <img
                className="size-full object-cover object-top transition-transform duration-[600ms] ease-[cubic-bezier(0.2,0.8,0.2,1)] group-hover:scale-[1.04]"
                src={asset(`images/${scene.file}`)}
                alt={scene.alt}
                width={1440}
                height={900}
                loading="lazy"
                decoding="async"
              />
              <span
                className={cn(
                  "absolute inset-x-0 bottom-0 flex justify-between gap-2 px-3.5 pt-[22px] pb-2.5",
                  "text-[0.8rem] text-mist",
                  "bg-gradient-to-t from-[rgb(4_8_7/0.85)] to-transparent",
                )}
              >
                {scene.name}
                <span className="text-[0.72rem] text-faint">{scene.note}</span>
              </span>
            </a>
          ))}
        </FadeContent>
      </div>
    </section>
  );
}
