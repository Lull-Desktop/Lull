import { Card, CardBody, CardTitle, grid2 } from "@/components/ui/Card";
import { container, section } from "@/components/ui/layout";
import { Code } from "@/components/ui/Text";

/**
 * 首页「隐私和安全」两栏。
 * 正文里有行内代码（配置路径），所以用 ReactNode 直接写在组件里，
 * 不经过「字符串 → 再解析」那一层。
 */
export default function HomePrivacy() {
  return (
    <section className={section}>
      <div className={container}>
        <div className="mb-[clamp(32px,4vw,52px)] max-w-[60ch]">
          <p className="mb-[18px] text-eyebrow font-medium uppercase tracking-[0.32em] text-green">Privacy</p>
          <h2 className="mb-2.5 text-h2 leading-[1.25] text-mist">隐私和安全</h2>
        </div>
        <div className={grid2}>
          <Card>
            <CardTitle>本地优先</CardTitle>
            <CardBody>
              配置写在 <Code>%APPDATA%\app.lull.desktop\display.json</Code>，日志写在 <Code>%TEMP%\lull\</Code>
            </CardBody>
          </Card>
          <Card>
            <CardTitle>网络权限是可选</CardTitle>
            <CardBody>
              用户在设计拓展功能时，有严格的权限管理，只在必要时请求网络权限，不会自动请求
            </CardBody>
          </Card>
        </div>
      </div>
    </section>
  );
}
