import { Button, buttonRow } from "@/components/ui/Button";
import { Chip } from "@/components/ui/Chip";
import { container, section } from "@/components/ui/layout";
import { Eyebrow, Lead } from "@/components/ui/Text";
import { cn } from "@/lib/utils";

export interface DownloadAsset {
  name: string;
  url: string;
  size: string;
  label: string;
  hint?: string;
}

interface DownloadHeroProps {
  version: string;
  published: string;
  primary: DownloadAsset | null;
  others: DownloadAsset[];
  releasesUrl: string;
  notesUrl: string;
  allReleasesUrl: string;
}

/** 下载列表的一行：左侧名称/文件名，右侧体积（等宽字体对齐） */
function DownloadRow({ asset }: { asset: DownloadAsset }) {
  return (
    <a
      className="flex items-center gap-3.5 rounded-xl border border-line bg-white/[0.02] px-4 py-3.5 text-mist no-underline transition-colors hover:border-green hover:bg-green/7 hover:text-white"
      href={asset.url}
      rel="noopener"
    >
      <span className="min-w-0">
        <span className="flex items-center gap-2 text-[0.94rem] font-medium">
          {asset.label}
          {asset.hint && <Chip green>{asset.hint}</Chip>}
        </span>
        <span className="block truncate font-mono text-[0.76rem] text-faint">{asset.name}</span>
      </span>
      <span className="ml-auto font-mono text-[0.78rem] text-faint">{asset.size}</span>
    </a>
  );
}

/**
 * 下载页首屏：主安装包 + 其余产物 + 右侧「运行要求」面板。
 * 版本号与文件名来自 `lib/release.ts`（构建前由 scripts/sync-release.mjs 拉 GitHub Release）。
 */
export default function DownloadHero({
  version,
  published,
  primary,
  others,
  releasesUrl,
  notesUrl,
  allReleasesUrl,
}: DownloadHeroProps) {
  return (
    <section className={section}>
      <div className={container}>
        <div className="grid grid-cols-[minmax(0,1fr)_320px] items-start gap-8 max-[860px]:grid-cols-1">
          <div>
            <Eyebrow>Download</Eyebrow>
            <h1 className="mb-2 text-hero leading-[1.25] tracking-[-0.02em] text-mist">下载 Lull</h1>
            <Lead>
              当前版本 <strong className="text-mist">{version}</strong>
              {published && <span className="text-muted"> · 发布于 {published}</span>}。
              安装包由 CI 从同一份源码构建，文档与站点随版本一起更新。
            </Lead>

            <div className="mt-7 grid gap-2.5">
              {primary ? (
                <DownloadRow asset={primary} />
              ) : (
                <a
                  className="flex items-center gap-3.5 rounded-xl border border-line bg-white/[0.02] px-4 py-3.5 text-mist no-underline transition-colors hover:border-green hover:bg-green/7 hover:text-white"
                  href={releasesUrl}
                  rel="noopener"
                >
                  <span className="min-w-0">
                    <span className="block text-[0.94rem] font-medium">下载</span>
                    <span className="block truncate font-mono text-[0.76rem] text-faint">
                      去 GitHub Release 下载最新版本
                    </span>
                  </span>
                  <span className="ml-auto font-mono text-[0.78rem] text-faint">→</span>
                </a>
              )}

              {others.map((asset) => (
                <DownloadRow key={asset.url} asset={asset} />
              ))}
            </div>

            <div className={cn(buttonRow, "mt-5")}>
              <Button variant="ghost" size="sm" href={notesUrl || releasesUrl} rel="noopener">
                更新说明
              </Button>
              <Button variant="ghost" size="sm" href={allReleasesUrl} rel="noopener">
                所有历史版本
              </Button>
            </div>
          </div>

          <aside className="rounded-card border border-line bg-ghost p-[22px]">
            <h3 className="mb-3.5 text-[0.95rem] leading-[1.25] text-mist">运行要求</h3>
            <ul className="m-0 grid list-none gap-2.5 p-0 text-[0.9rem] text-muted">
              <li className="relative pl-[18px] before:absolute before:top-[0.72em] before:left-0 before:size-[5px] before:rounded-full before:bg-green before:content-['']">
                Windows 10 / 11
              </li>
              <li className="relative pl-[18px] before:absolute before:top-[0.72em] before:left-0 before:size-[5px] before:rounded-full before:bg-green before:content-['']">
                约 20–40 MB 磁盘占用
              </li>
            </ul>
            <p className="mt-4 mb-0 text-[0.86rem] leading-[1.7] text-muted">Lull 目前只支持 Windows</p>
          </aside>
        </div>
      </div>
    </section>
  );
}
