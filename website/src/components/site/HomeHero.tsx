import FadeContent from "@/components/FadeContent";
import SplitText from "@/components/SplitText";
import Preview from "@/components/site/Preview";
import { Button, buttonRow } from "@/components/ui/Button";
import { Chip } from "@/components/ui/Chip";
import { container } from "@/components/ui/layout";
import { Eyebrow, Lead } from "@/components/ui/Text";
import { page } from "@/lib/site";
import { cn } from "@/lib/utils";

interface HomeHeroProps {
  version: string;
}

/**
 * 首页首屏。
 *
 * 两个 React Bits 组件在这里替代掉了原来 CSS 里的 `@keyframes rise`：
 * - `SplitText` 逐字升起标题（含 mask，字从遮罩里冒出）；
 * - `FadeContent` 让副文案与预览图错峰淡入。
 * 这个组件是整个站点唯一用 `client:load` 的岛——首屏动画不能等滚动。
 */
export default function HomeHero({ version }: HomeHeroProps) {
  return (
    <section className="relative overflow-hidden pt-[clamp(56px,8vw,104px)] pb-[clamp(48px,7vw,88px)]">
      <div
        className={cn(
          container,
          "grid grid-cols-[minmax(0,1fr)_minmax(0,1.08fr)] items-center gap-[clamp(32px,5vw,64px)]",
          "max-[900px]:grid-cols-1 max-[900px]:gap-9",
        )}
      >
        <div>
          <Eyebrow>开源 · Windows · 本地优先</Eyebrow>

          <h1 className="mb-[18px] text-hero leading-[1.25] font-normal tracking-[-0.02em] text-mist">
            <span className="block">
              <SplitText
                tag="span"
                text="云栖之处"
                splitType="chars"
                effect="rise"
                mask
                staggerFrom="start"
                textAlign="left"
                duration={0.8}
                className="font-[inherit]"
              />
            </span>
            <span className="block">
              <SplitText
                tag="span"
                text="安然入眠"
                splitType="chars"
                effect="rise"
                mask
                staggerFrom="start"
                textAlign="left"
                duration={0.8}
                delay={50}
                className="font-[inherit]"
              />
            </span>
          </h1>

          <FadeContent trigger="mount" delay={0.25} stagger={0.08} duration={0.7} ease="power2.out" data-fade-content>
            <p className="mb-3.5 font-serif text-[clamp(1.05rem,1.7vw,1.22rem)] text-mist">
              一款开源的助眠与专注桌面应用。
            </p>
            <Lead>竹影、暮色、极光，在桌面上缓缓流动；雨、风、海浪、篝火、远雷，在耳边轻轻起伏。</Lead>
            <div className={cn(buttonRow, "mt-[30px]")}>
              <Button href={page("/download/")}>
                下载 Lull
                <span aria-hidden="true">→</span>
              </Button>
              <Button variant="ghost" href={page("/features/")}>
                看看功能
              </Button>
            </div>
            <div className="mt-[26px] flex flex-wrap gap-2">
              <Chip green>v{version}</Chip>
              <Chip>Tauri</Chip>
              <Chip>Web</Chip>
            </div>
          </FadeContent>
        </div>

        <FadeContent trigger="mount" delay={0.1} duration={0.9} className="relative max-[900px]:order-first" data-fade-content>
          <Preview
            file="images/scene-bamboo.jpg"
            alt="Lull 竹影壁纸在桌面上的实际效果"
            captionLeft="竹影 · 官方内置场景"
            captionRight="桌面实机 · 16:9"
            priority
          />
        </FadeContent>
      </div>
    </section>
  );
}
