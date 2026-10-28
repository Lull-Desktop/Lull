"use client";

/**
 * 扩展详情：展示声明/授予/实际生效的能力，并提供逐能力开关。
 *
 * 运行中禁止改权限：撤销 `widget.chrome` 会让自绘窗口失去关闭能力。
 */
import { AlertTriangle, Lock } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Switch } from "@/components/ui/switch";
import { m } from "@/paraglide/messages";
import type { ExtensionInfo } from "@/lib/extensions";
import {
  UNSIGNED_SIGNATURE,
  capabilityLabel,
  capabilityLevel,
  kindLabel,
  signatureLabel,
  signatureVariant,
  statusLabel,
} from "./labels";

type Props = {
  item: ExtensionInfo | null;
  busy: boolean;
  onClose: () => void;
  onToggleCapability: (capability: string, granted: boolean) => void;
};

function statusVariant(
  status: string,
): "secondary" | "outline" | "destructive" {
  if (status === "tampered" || status === "invalid") return "destructive";
  if (status === "unverified" || status === "needs-review") return "outline";
  return "secondary";
}

export function ExtensionDetailSheet({
  item,
  busy,
  onClose,
  onToggleCapability,
}: Props) {
  const signature = item?.signature ?? UNSIGNED_SIGNATURE;
  return (
    <Sheet
      open={item !== null}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <SheetContent side="right" className="w-full sm:max-w-md">
        {item && (
          <>
            <SheetHeader>
              <SheetTitle className="flex flex-wrap items-center gap-2">
                {item.name}
                <Badge variant="outline">{kindLabel(item.kind)}</Badge>
                <Badge variant={statusVariant(item.status)}>
                  {statusLabel(item.status)}
                </Badge>
                {item.dev && (
                  <Badge variant="outline">{m.ext_dev_package()}</Badge>
                )}
              </SheetTitle>
              <SheetDescription>
                {item.id} · {item.version}
                {item.author ? ` · ${item.author}` : ""}
                {item.license ? ` · ${item.license}` : ""}
              </SheetDescription>
            </SheetHeader>

            <div className="flex-1 space-y-5 overflow-y-auto px-4 pb-6">
              {item.description && (
                <p className="text-sm text-muted-foreground">
                  {item.description}
                </p>
              )}

              {item.error && (
                <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-xs">
                  <p className="flex items-center gap-1.5 font-medium text-destructive">
                    <AlertTriangle className="h-3.5 w-3.5" />
                    {item.error.code}
                  </p>
                  <p className="mt-1 text-muted-foreground">
                    {item.error.message}
                  </p>
                  {item.error.detail && (
                    <p className="mt-1 break-all font-mono text-[11px] text-ink-faint">
                      {item.error.detail}
                    </p>
                  )}
                </div>
              )}

              <section className="space-y-2">
                <h3 className="text-xs font-medium text-ink-soft">
                  {m.ext_signature_section()}
                </h3>
                <div className="flex flex-wrap items-center gap-2">
                  <Badge variant={signatureVariant(signature.status)}>
                    {signatureLabel(signature.status)}
                  </Badge>
                  {signature.keyLabel && (
                    <span className="text-xs text-ink-soft">
                      {signature.keyLabel}
                    </span>
                  )}
                </div>
                <dl className="grid grid-cols-[5.5rem_1fr] gap-y-1 text-[11px]">
                  <dt className="text-ink-faint">{m.ext_signature_publisher()}</dt>
                  <dd className="truncate">
                    {signature.keyLabel ?? m.ext_undeclared()}
                  </dd>
                  <dt className="text-ink-faint">keyId</dt>
                  <dd className="truncate font-mono">
                    {signature.keyId ?? "—"}
                  </dd>
                  <dt className="text-ink-faint">
                    {m.ext_signature_fingerprint()}
                  </dt>
                  <dd className="truncate font-mono text-[10px]">
                    {signature.keyFingerprint ?? "—"}
                  </dd>
                  <dt className="text-ink-faint">
                    {m.ext_signature_signed_at()}
                  </dt>
                  <dd>{signature.signedAt ?? "—"}</dd>
                  <dt className="text-ink-faint">
                    {m.ext_signature_release_seq()}
                  </dt>
                  <dd>
                    {signature.releaseSeq
                      ? `#${String(signature.releaseSeq)}`
                      : "—"}
                  </dd>
                  <dt className="text-ink-faint">{m.ext_signature_reason()}</dt>
                  <dd>{signature.reason ?? "—"}</dd>
                </dl>
                {signature.status === "unsigned" && (
                  <p className="text-[11px] text-muted-foreground">
                    {m.ext_signature_unsigned_hint()}
                  </p>
                )}
                {signature.decision === "block" && (
                  <p className="text-[11px] text-destructive">
                    {m.ext_signature_blocked_hint()}
                  </p>
                )}
              </section>

              {item.kind === "widget" && (
                <div className="flex flex-wrap gap-2 text-xs">
                  <Badge variant={item.enabled ? "secondary" : "outline"}>
                    {item.enabled ? m.ext_state_enabled() : m.ext_state_disabled()}
                  </Badge>
                  {item.running && (
                    <Badge variant="secondary">
                      {item.visible
                        ? m.ext_state_running()
                        : m.ext_state_background()}
                    </Badge>
                  )}
                  {item.lifecycle === "suspend" && (
                    <Badge variant="outline">{m.ext_closed_when_ended()}</Badge>
                  )}
                </div>
              )}

              <section className="space-y-2">
                <h3 className="text-xs font-medium text-ink-soft">
                  {m.ext_caps_section()}
                </h3>
                <p className="text-[11px] text-muted-foreground">
                  {m.ext_capabilities_note_short()}
                </p>
                <ul className="space-y-2">
                  {(item.capabilities ?? []).length === 0 && (
                    <li className="text-xs text-muted-foreground">
                      {m.ext_no_capabilities_declared()}
                    </li>
                  )}
                  {(item.capabilities ?? []).map((capability) => {
                    const granted = item.granted?.includes(capability) ?? false;
                    const locked =
                      item.kind !== "widget" ||
                      !item.enabled ||
                      item.running ||
                      busy;
                    return (
                      <li
                        key={capability}
                        className="flex items-center justify-between gap-3 rounded-lg border border-border/60 p-2.5"
                      >
                        <div className="min-w-0">
                          <p className="flex items-center gap-1.5 text-xs text-ink-soft">
                            {capabilityLabel(capability)}
                            <span className="rounded bg-muted px-1 py-0.5 text-[10px] text-muted-foreground">
                              {capabilityLevel(capability)}
                            </span>
                          </p>
                          <p className="truncate font-mono text-[10px] text-ink-faint">
                            {capability}
                          </p>
                        </div>
                        {item.kind === "widget" ? (
                          <Switch
                            aria-label={`${item.name} ${capabilityLabel(capability)}`}
                            checked={granted}
                            disabled={locked}
                            onCheckedChange={(checked) =>
                              onToggleCapability(capability, checked)
                            }
                          />
                        ) : (
                          <Badge variant="secondary">
                            {m.ext_cap_included()}
                          </Badge>
                        )}
                      </li>
                    );
                  })}
                </ul>
                {item.kind === "widget" && item.running && (
                  <p className="flex items-center gap-1 text-[11px] text-muted-foreground">
                    <Lock className="h-3 w-3" />
                    {m.ext_stop_to_edit()}
                  </p>
                )}
              </section>

              {item.kind === "widget" &&
                (item.capabilities ?? []).includes("widget.network") && (
                  <section className="space-y-2">
                    <h3 className="text-xs font-medium text-ink-soft">
                      {m.ext_network_allowlist()}
                    </h3>
                    <p className="text-[11px] text-muted-foreground">
                      {m.ext_network_hint()}
                    </p>
                    <ul className="space-y-1 font-mono text-[11px] text-ink-faint">
                      {(item.network ?? []).length === 0 && (
                        <li>{m.ext_network_none()}</li>
                      )}
                      {(item.network ?? []).map((origin) => (
                        <li key={origin}>{origin}</li>
                      ))}
                    </ul>
                  </section>
                )}
            </div>
          </>
        )}
      </SheetContent>
    </Sheet>
  );
}
