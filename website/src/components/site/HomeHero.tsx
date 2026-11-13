import { Button, buttonRow } from "@/components/ui/Button";
import { container } from "@/components/ui/layout";
import { asset, page } from "@/lib/site";
import { cn } from "@/lib/utils";

export default function HomeHero({ version }: { version: string }) {
  return (
    <section className="relative overflow-hidden pt-[clamp(64px,8vw,112px)] pb-[clamp(76px,9vw,128px)]">
      <div className={cn(container, "relative grid grid-cols-[minmax(0,.9fr)_minmax(0,1.1fr)] items-center gap-[clamp(44px,6vw,84px)] max-[900px]:grid-cols-1")}>
        <div className="relative z-10">
          <p className="mb-7 inline-flex items-center gap-3 text-[0.72rem] font-semibold tracking-[0.17em] text-green">
            <span className="size-2 rounded-full bg-green" aria-hidden="true" /> WINDOWS 桌面创意空间
          </p>
          <h1 className="mb-7 font-serif text-[clamp(2rem,9vw,3rem)] leading-[1.2] font-normal tracking-[-0.035em] text-mist min-[901px]:text-[clamp(2.15rem,3.7vw,3.5rem)]">
            让桌面，<br /><span className="whitespace-nowrap">拥有自己的<span className="text-green">世界。</span></span>
          </h1>
          <p className="max-w-[32rem] text-[clamp(1.04rem,1.5vw,1.18rem)] leading-[1.9] text-body">
            Lull 云栖是一款开源 Windows 桌面应用。让动态壁纸、桌面游戏和 Web 组件，组成只属于你的沉浸空间。
          </p>
          <div className={cn(buttonRow, "mt-9")}>
            <Button href={page("/download/")}>下载 Lull <span aria-hidden="true">↗</span></Button>
            <Button variant="ghost" href={page("/features/")}>探索功能 <span aria-hidden="true">→</span></Button>
          </div>
          <p className="mt-7 text-[0.78rem] tracking-[0.04em] text-muted">Windows 10 / 11 · 开源 · 本地优先 <span className="mx-2 text-faint">/</span> v{version}</p>
        </div>

        <div className="relative pb-12 max-[560px]:pb-10">
          <div className="absolute -top-8 -right-10 h-64 w-64 rounded-full bg-green/10 blur-[90px]" aria-hidden="true" />
          <div className="relative overflow-hidden rounded-shell border border-line-strong bg-ink-1 shadow-soft">
            <div className="flex items-center justify-between border-b border-line px-4 py-3 text-[0.65rem] tracking-[0.18em] text-muted">
              <span className="inline-flex items-center gap-1.5" aria-hidden="true"><span className="size-1.5 rounded-full bg-green/70"/><span className="size-1.5 rounded-full bg-green/40"/><span className="size-1.5 rounded-full bg-green/20"/></span>
              <span>YOUR DESKTOP, REIMAGINED</span><span>01 / 03</span>
            </div>
            <img className="aspect-video w-full object-cover" src={asset("images/scene-bamboo.jpg")} alt="Lull 官方竹影动态壁纸实机画面" width={1440} height={810} fetchPriority="high" />
            <div className="flex items-center justify-between gap-3 px-4 py-3 text-[0.7rem] text-muted"><span>竹影 · 官方壁纸实机画面</span><span className="font-mono">LULL / SCENE 01</span></div>
          </div>
          <div className="absolute right-[-1rem] bottom-0 w-[42%] overflow-hidden rounded-card border border-line-strong bg-ink-1 shadow-soft max-[480px]:right-0 max-[480px]:w-[46%]">
            <img className="aspect-[1.7] w-full object-cover" src={asset("images/desktop-world-concept.svg")} alt="漂浮岛屿桌面游戏概念示意" width={1000} height={700} />
            <div className="flex items-center justify-between gap-1 px-3 py-2 text-[0.65rem] text-body"><span>桌面世界</span><span className="text-muted">概念示意</span></div>
          </div>
        </div>
      </div>
    </section>
  );
}
