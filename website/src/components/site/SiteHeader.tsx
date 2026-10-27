import { container } from "@/components/ui/layout";
import { cn } from "@/lib/utils";
import { asset, navItems, page, repoUrl, siteMeta } from "@/lib/site";

interface SiteHeaderProps {
  /**
   * 当前路径（`Astro.url.pathname` 去掉结尾斜杠）。
   * Astro 的构建期全局在 React 里拿不到，由布局传进来，
   * 避免为了高亮一项而在客户端读 `location`（会先渲染出错的高亮再闪一下）。
   */
  pathname: string;
}

const navLink =
  "rounded-lg px-3 py-2 text-[0.9rem] no-underline transition-colors hover:bg-green/7 hover:text-mist";

export default function SiteHeader({ pathname }: SiteHeaderProps) {
  const isActive = (href: string) => href.replace(/\/+$/, "") === pathname;

  return (
    <header className="sticky top-0 z-40 border-b border-line bg-ink/72 backdrop-blur-[14px] backdrop-saturate-140">
      <div className={cn(container, "flex min-h-16 items-center gap-6 max-[720px]:gap-2.5")}>
        <a
          className="inline-flex items-baseline gap-2.5 text-mist no-underline"
          href={page("/")}
          aria-label={`${siteMeta.name} 首页`}
        >
          <img className="size-[22px] self-center rounded-md" src={asset("favicon.svg")} alt="" width={22} height={22} />
          <span className="font-serif text-[0.9rem] uppercase tracking-[0.42em] text-mist max-[380px]:hidden">
            {siteMeta.name}
          </span>
          <span className="text-[0.78rem] tracking-[0.16em] text-faint max-[720px]:hidden">{siteMeta.nameZh}</span>
        </a>

        <nav
          className={cn(
            "ml-auto flex gap-1 max-[720px]:ml-0 max-[720px]:gap-0.5 max-[720px]:flex-nowrap max-[720px]:overflow-x-auto",
            "[scrollbar-width:none] [&::-webkit-scrollbar]:hidden",
          )}
          aria-label="主导航"
        >
          {navItems.map((item) => (
            <a
              key={item.href}
              href={item.href}
              aria-current={item.external ? undefined : isActive(item.href) ? "page" : undefined}
              className={cn(
                navLink,
                "max-[720px]:whitespace-nowrap max-[720px]:px-2 max-[720px]:text-[0.86rem]",
                item.external && "group inline-flex items-center gap-1",
                !item.external && isActive(item.href) && "bg-green/10 text-mist hover:bg-green/10",
                !item.external && !isActive(item.href) && "text-muted",
              )}
            >
              {item.label}
              {item.external && (
                <span
                  className="text-[0.78em] leading-none text-faint transition-[color,transform] duration-200 group-hover:translate-x-px group-hover:-translate-y-px group-hover:text-green-bright"
                  aria-hidden="true"
                >
                  ↗
                </span>
              )}
            </a>
          ))}
        </nav>

        <a
          className="inline-flex items-center gap-2 rounded-full border border-line px-3 py-1.5 text-[0.86rem] text-muted no-underline transition-colors hover:border-line-strong hover:text-mist max-[720px]:ml-auto max-[720px]:p-2"
          href={repoUrl}
          rel="noopener"
          aria-label="GitHub 仓库"
        >
          <svg className="size-[15px] fill-current" viewBox="0 0 16 16" aria-hidden="true">
            <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82a7.4 7.4 0 0 1 2-.27c.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A7.995 7.995 0 0 0 16 8c0-4.42-3.58-8-8-8Z" />
          </svg>
          <span className="max-[720px]:hidden">GitHub</span>
        </a>
      </div>
    </header>
  );
}
