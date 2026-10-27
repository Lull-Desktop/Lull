import FadeContent from "@/components/FadeContent";
import { Card, CardBody, CardTag, CardTitle, grid3 } from "@/components/ui/Card";
import { cn } from "@/lib/utils";

export interface FeatureItem {
  title: string;
  body: string;
  tag?: string;
  /** 图标键名，见下面的 icons 表（线性图标，24×24 描边） */
  icon?: keyof typeof icons;
  /**
   * 正文末尾的行内链接。
   * 页面在 `.astro` 里只能传纯数据，不能传 ReactNode，所以把「链接」和
   * 「链接之后的标点」拆成两个字段，拼出来仍是原来那句话。
   */
  link?: { label: string; href: string };
  after?: string;
}

const icons = {
  layers: "M12 3 3 8l9 5 9-5-9-5Zm-9 9 9 5 9-5M3 16l9 5 9-5",
  wave: "M2 12c2.5 0 2.5-5 5-5s2.5 5 5 5 2.5-5 5-5 2.5 5 5 5",
  hourglass: "M7 3h10M7 21h10M8 3v3.5l4 4 4-4V3M8 21v-3.5l4-4 4 4V21",
  disc: "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18Zm0-6a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z",
  tray: "M3 13h4l1 2h8l1-2h4M6 4h12l3 9v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4l3-9Z",
  puzzle:
    "M10 3v2a2 2 0 1 0 4 0V3h4v4h-2a2 2 0 1 0 0 4h2v4h-4v-2a2 2 0 1 0-4 0v2H6v-4h2a2 2 0 1 0 0-4H6V3h4Z",
} as const;

/** 三列特性卡（原 `.grid-3` + `.card`），支持可选图标与角标 */
export default function FeatureCards({ items, className }: { items: FeatureItem[]; className?: string }) {
  return (
    <FadeContent trigger="scroll" stagger={0.06} duration={0.75} className={cn(grid3, className)} data-fade-content>
      {items.map((item) => (
        <Card key={item.title}>
          <CardTitle>
            {item.icon && (
              <svg
                className="size-[18px] flex-none text-green"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth={1.5}
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                <path d={icons[item.icon]} />
              </svg>
            )}
            {item.title}
          </CardTitle>
          <CardBody>
            {item.body}
            {item.link && (
              <>
                {" "}
                <a
                  className="text-green-bright no-underline transition-colors hover:text-[#eaf6de]"
                  href={item.link.href}
                  rel="noopener"
                >
                  {item.link.label}
                </a>
              </>
            )}
            {item.after}
          </CardBody>
          {item.tag && <CardTag>{item.tag}</CardTag>}
        </Card>
      ))}
    </FadeContent>
  );
}
