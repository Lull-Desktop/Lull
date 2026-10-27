import { Code, TextLink } from "@/components/ui/Text";

interface DocFooterProps {
  /** 对应仓库源文档路径，如 `docs/architecture.md` */
  source?: string;
  /** 该源文档在 GitHub 上的绝对地址（Astro 侧用 sourceUrl() 算好传进来） */
  sourceHref?: string;
  issuesUrl: string;
  docsTreeUrl: string;
}

/** 文档页脚：一句「以仓库为准」+ 原文链接 + 提 issue */
export default function DocFooter({ source, sourceHref, issuesUrl, docsTreeUrl }: DocFooterProps) {
  return (
    <div className="mt-14 flex flex-wrap justify-between gap-3 border-t border-line pt-5 text-[0.84rem] text-faint">
      <span>
        文档随版本一起更新，完整说明见仓库{" "}
        <a
          className="text-green-bright no-underline transition-colors hover:text-[#eaf6de]"
          href={docsTreeUrl}
          rel="noopener"
        >
          <Code>docs/</Code>
        </a>
        {source && sourceHref && (
          <>
            {" · "}本页对应{" "}
            <TextLink href={sourceHref} rel="noopener">
              {source} ↗
            </TextLink>
          </>
        )}
      </span>
      <a className="text-green-bright no-underline transition-colors hover:text-[#eaf6de]" href={issuesUrl} rel="noopener">
        发现错误？提个 issue
      </a>
    </div>
  );
}
