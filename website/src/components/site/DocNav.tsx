import { page } from "@/lib/site";
import { cn } from "@/lib/utils";

export interface DocGroup {
  name: string;
  items: { id: string; title: string; description: string; source?: string }[];
}

interface DocNavProps {
  groups: DocGroup[];
  /** 当前路径去掉结尾斜杠 */
  current: string;
  repoUrl: string;
}

/**
 * 文档侧栏（原 `.doc-nav`）。
 * 数据来自 Astro 的 `getCollection`，在 `.astro` 里整理成扁平结构后传进来——
 * 内容集合是构建期 API，React 组件不能自己去读。
 */
export default function DocNav({ groups, current, repoUrl }: DocNavProps) {
  return (
    <nav
      className={cn(
        "sticky top-[88px] grid gap-1 text-[0.9rem]",
        "max-[900px]:static max-[900px]:flex max-[900px]:flex-wrap max-[900px]:gap-2",
        "max-[900px]:border-b max-[900px]:border-line max-[900px]:pb-5",
      )}
      aria-label="文档目录"
    >
      <span className="mb-2 text-[0.74rem] uppercase tracking-[0.16em] text-faint max-[900px]:hidden">文档</span>

      {groups.map((group) => (
        <div key={group.name} className="grid gap-0.5 max-[900px]:contents">
          <span className="px-3 pt-3.5 pb-1 text-[0.7rem] uppercase tracking-[0.14em] text-faint max-[900px]:w-full max-[900px]:px-0 max-[900px]:py-1">
            {group.name}
          </span>
          {group.items.map((item) => {
            const active = current.endsWith(`/docs/${item.id}`);
            return (
              <a
                key={item.id}
                href={page(`/docs/${item.id}/`)}
                aria-current={active ? "page" : undefined}
                className={cn(
                  "rounded-lg border-l-2 border-transparent px-3 py-[7px] no-underline transition-colors",
                  active
                    ? "border-l-green bg-green/8 text-green-bright"
                    : "text-muted hover:bg-green/6 hover:text-mist",
                )}
              >
                {item.title}
              </a>
            );
          })}
        </div>
      ))}

      <a
        className="mt-3.5 text-[0.82rem] text-faint no-underline transition-colors hover:text-mist max-[900px]:mt-0"
        href={`${repoUrl}/tree/master/docs`}
        rel="noopener"
      >
        仓库 docs/ ↗
      </a>
    </nav>
  );
}
