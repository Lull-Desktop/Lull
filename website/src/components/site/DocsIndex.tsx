import type { DocGroup } from "@/components/site/DocNav";
import { Card, CardBody, CardTag, CardTitle, grid2 } from "@/components/ui/Card";
import { container, section } from "@/components/ui/layout";
import { Code, TextLink } from "@/components/ui/Text";
import { page } from "@/lib/site";
import { cn } from "@/lib/utils";

interface DocsIndexProps {
  groups: DocGroup[];
  repoUrl: string;
}

/** 文档首页：按 docGroups 分组列出全部文档卡片，底部两块「去哪找原文」的提示 */
export default function DocsIndex({ groups, repoUrl }: DocsIndexProps) {
  return (
    <section className={section}>
      <div className={container}>
        <div className="mb-[clamp(32px,4vw,52px)] max-w-[60ch]">
          <p className="mb-[18px] text-eyebrow font-medium uppercase tracking-[0.32em] text-green">Docs</p>
          <h1 className="mb-4 font-serif text-hero leading-[1.25] font-normal text-mist">文档</h1>
          <p className="max-w-[46ch] text-lead text-body">
            从壁纸、音乐与音境的日常使用开始，再用 SDK 创作自己的桌面体验。本站介绍当前源码，安装包功能以对应 Release 为准。
          </p>
          <p className="mt-4 text-muted">文档以中文为主。<TextLink href={`${repoUrl}/blob/master/docs/en/getting-started.md`} rel="noopener">English quickstart: run from source &amp; build your first Widget ↗</TextLink></p>
        </div>

        <section id="create" className="scroll-mt-24" aria-labelledby="sdk-overview">
          <h2 id="sdk-overview" className="mb-4 text-h2 text-mist">为桌面创作</h2>
          <div className="grid grid-cols-2 gap-3.5 max-[680px]:grid-cols-1">
            {[
              { name: "Scene SDK", body: "交互壁纸与音频响应场景", href: page("/docs/scene-sdk/"), sample: "scenes/audio-demo", label: "音频响应示例" },
              { name: "Widget SDK", body: "浮窗工具与桌面组件", href: page("/docs/widget-sdk/"), sample: "widgets/liquid-pomodoro", label: "液态番茄钟示例（另行安装）" },
              { name: "Media SDK", body: "配合 Widget SDK，制作播放器或音境控制器", href: `${repoUrl}/blob/master/packages/media-sdk/README.md`, sample: "widgets/mini-player", label: "Mini Player 示例" },
              { name: "Game SDK", body: "实验性桌面游戏与渲染适配器", href: page("/docs/game-sdk/"), sample: "games", label: "游戏示例" },
            ].map((sdk) => (
              <Card key={sdk.name}>
                <CardTitle><TextLink href={sdk.href}>{sdk.name}</TextLink></CardTitle>
                <CardBody>{sdk.body}</CardBody>
                <CardTag><TextLink href={`${repoUrl}/tree/master/examples/${sdk.sample}`}>{sdk.label} ↗</TextLink></CardTag>
              </Card>
            ))}
          </div>
          <p className="mt-4 text-sm text-muted">四个 SDK 均为 Experimental，独立演进。版本以各包的 package.json 为准，请与宿主源码匹配使用；不承诺跨版本兼容。音频响应使用 Lull 音频的视觉分析数据，不采集系统声音。</p>
        </section>

        {groups.map((group) => (
          <section key={group.name} className="mt-10 first-of-type:mt-8" aria-labelledby={`doc-group-${group.name}`}>
            <h2
              id={`doc-group-${group.name}`}
              className="mb-3.5 border-b border-line pb-2.5 text-[0.78rem] uppercase tracking-[0.16em] text-faint"
            >
              {group.name}
            </h2>
            <div className="grid grid-cols-2 gap-3.5 max-[680px]:grid-cols-1">
              {group.items.map((item) => (
                <a
                  key={item.id}
                  href={page(`/docs/${item.id}/`)}
                  className={cn(
                    "block rounded-card border border-line bg-ink-1/60 px-6 py-6 text-body no-underline",
                    "transition-[border-color,background-color] duration-200 hover:border-line-strong hover:bg-ink-2/70 hover:text-body",
                  )}
                >
                  <div className="mb-1.5 text-[1rem] text-mist">{item.title}</div>
                  <p className="m-0 text-[0.86rem] text-muted">{item.description}</p>
                  {item.source && <span className="mt-2.5 inline-block font-mono text-[0.74rem] text-faint">{item.source}</span>}
                </a>
              ))}
            </div>
          </section>
        ))}

        <div className={cn(grid2, "mt-9")}>
          <Card>
            <CardTitle>仓库里的原始文档</CardTitle>
            <CardBody>
              架构、SDK、内容格式、扩展中心、原生宿主、多语言与许可说明都在仓库 <Code>docs/</Code>，随代码一起审阅；设计稿与实施计划不代表已发布功能。
            </CardBody>
            <CardTag>
              <TextLink href={`${repoUrl}/tree/master/docs`} rel="noopener">
                打开 docs/ ↗
              </TextLink>
            </CardTag>
          </Card>
          <Card>
            <CardTitle>代码里的类型即文档</CardTitle>
            <CardBody>
              Scene、Widget、Media 与 Game SDK 随仓库构建，产出 <Code>dist</Code> +{" "}
              <Code>.d.ts</Code>。清单字段以 TypeScript 类型与 JSON Schema 为准。
            </CardBody>
            <CardTag>
              <TextLink href={`${repoUrl}/tree/master/packages`} rel="noopener">
                packages/ ↗
              </TextLink>
            </CardTag>
          </Card>
        </div>
      </div>
    </section>
  );
}
