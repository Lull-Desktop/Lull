import FadeContent from "@/components/FadeContent";
import { Button, buttonRow } from "@/components/ui/Button";
import { container } from "@/components/ui/layout";
import { Eyebrow } from "@/components/ui/Text";
import { cn } from "@/lib/utils";

export interface CtaAction {
  label: string;
  href: string;
  variant?: "solid" | "ghost";
  external?: boolean;
}

interface CtaBannerProps {
  eyebrow?: string;
  title: string;
  body: string;
  actions: CtaAction[];
}

/** 版块底部的大号行动区（原 `.cta`），双色径向光晕 + 墨色底 */
export default function CtaBanner({ eyebrow, title, body, actions }: CtaBannerProps) {
  return (
    <section className="py-section-tight">
      <div className={container}>
        <FadeContent trigger="scroll" duration={0.8} data-fade-content>
          <div
            className={cn(
              "relative grid grid-cols-[minmax(0,1.4fr)_auto] items-center gap-7 overflow-hidden",
              "rounded-shell border border-line-strong bg-ink-1 p-[clamp(32px,5vw,56px)]",
              "max-[780px]:grid-cols-1",
              "bg-[radial-gradient(90%_120%_at_12%_0%,rgb(159_191_150/0.14),transparent_60%),radial-gradient(70%_120%_at_95%_100%,rgb(224_168_120/0.12),transparent_60%)]",
            )}
          >
            <div>
              {eyebrow && <Eyebrow>{eyebrow}</Eyebrow>}
              <h2 className="mb-2.5 text-h2 leading-[1.25] text-mist">{title}</h2>
              <p className="m-0 max-w-[52ch] text-muted">{body}</p>
            </div>
            <div className={buttonRow}>
              {actions.map((action) => (
                <Button
                  key={action.href}
                  href={action.href}
                  variant={action.variant ?? "solid"}
                  {...(action.external ? { rel: "noopener" } : {})}
                >
                  {action.label}
                </Button>
              ))}
            </div>
          </div>
        </FadeContent>
      </div>
    </section>
  );
}
