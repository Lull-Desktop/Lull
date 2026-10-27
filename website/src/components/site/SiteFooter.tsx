import { container } from "@/components/ui/layout";
import { issuesUrl, page, releasesUrl, repoUrl, siteMeta } from "@/lib/site";
import { cn } from "@/lib/utils";

const docsOnGitHub = `${repoUrl}/tree/master/docs`;

const columns = [
  {
    title: "产品",
    links: [
      { label: "功能一览", href: page("/features/") },
      { label: "下载安装", href: page("/download/") },
      { label: "更新日志", href: `${repoUrl}/releases` },
    ],
  },
  {
    title: "文档",
    links: [
      { label: "快速开始", href: page("/docs/getting-started/") },
      { label: "架构与模块", href: page("/docs/architecture/") },
      { label: "场景与内容包", href: page("/docs/scene-sdk/") },
      { label: "插件与扩展", href: page("/docs/widget-sdk/") },
      { label: "仓库 docs/", href: docsOnGitHub },
    ],
  },
  {
    title: "参与",
    links: [
      { label: "源码仓库", href: repoUrl },
      { label: "问题与建议", href: issuesUrl },
      { label: "Release", href: releasesUrl },
      { label: "贡献指南", href: page("/docs/contributing/") },
      { label: "许可说明", href: page("/docs/licensing/") },
    ],
  },
];

export default function SiteFooter() {
  return (
    <footer className="mt-[clamp(40px,6vw,80px)] border-t border-line pt-12 pb-10 text-small text-faint">
      <div className={container}>
        <div className="grid grid-cols-[1.6fr_repeat(3,minmax(0,1fr))] gap-8 max-[780px]:grid-cols-2">
          <div>
            <div className="inline-flex items-baseline gap-2.5 text-mist">
              <span className="font-serif text-[0.9rem] uppercase tracking-[0.42em] text-mist">{siteMeta.name}</span>
            </div>
            <p className="mt-3 max-w-[30ch] text-small">开源的助眠与专注桌面应用。壁纸、声景与计时都在本地运行。</p>
            <p className="m-0 text-small">应用 GPL-3.0-or-later · SDK Apache-2.0 · 内容与文档 CC BY 4.0</p>
          </div>

          {columns.map((column) => (
            <div key={column.title}>
              <h4 className="mb-3 text-[0.78rem] uppercase tracking-[0.14em] text-muted">{column.title}</h4>
              <ul className="m-0 grid list-none gap-2 p-0">
                {column.links.map((link) => (
                  <li key={link.href}>
                    <a className="text-muted no-underline transition-colors hover:text-mist" href={link.href}>
                      {link.label}
                    </a>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>

        <div
          className={cn(
            "mt-10 flex flex-wrap justify-between gap-x-6 gap-y-3 border-t border-line pt-5",
            "text-[0.78rem] text-faint",
          )}
        >
          <span>© 2026 Lull contributors · 本站与桌面应用共用同一套版本控制</span>
          <span>Windows 10 / 11</span>
        </div>
      </div>
    </footer>
  );
}
