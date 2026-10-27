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
          <h1 className="mb-2 text-hero leading-[1.25] tracking-[-0.02em] text-mist">文档</h1>
          <p className="max-w-[46ch] text-lead text-body">
            从快速上手开始，依次介绍架构与运行时、场景与扩展内容设计与实现。每篇对应仓库中的一份原始文档，字段级细节请以原文为准。
          </p>
        </div>

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
                    "block rounded-card border border-line px-[22px] py-5 text-body no-underline",
                    "transition-[border-color,transform] duration-200 hover:-translate-y-0.5 hover:border-line-strong hover:text-body",
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
              架构、场景 SDK、插件 SDK、内容格式、扩展中心、原生宿主、多语言、许可说明都在仓库 <Code>docs/</Code>，与代码一起 review、一起发版。
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
              <Code>@lull/scene-sdk</Code> 与 <Code>@lull/widget-sdk</Code> 随仓库构建，产出 <Code>dist</Code> +{" "}
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
