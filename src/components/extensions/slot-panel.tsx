"use client";

/**
 * 功能槽位面板：每个 Slot 只显示一个当前实现，并提供切换、打开、结束。
 *
 * 选择与运行由 Rust 的 Slot 事务完成；这里只负责触发和展示，不自行判断互斥。
 */
import { Loader2, Settings2 } from "lucide-react";
import { useCallback, useMemo, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import {
  activateSlot,
  applySlotProvider,
  closeExtension,
  deactivateSlot,
  type SlotInfo,
  type SlotProviderInfo,
  type SlotStatus,
  toExtensionFailure,
} from "@/lib/extensions";
import { m } from "@/paraglide/messages";

const SLOT_STATUS_LABELS: Record<SlotStatus, () => string> = {
  empty: m.slot_status_empty,
  stopped: m.slot_status_stopped,
  starting: m.slot_status_starting,
  active: m.slot_status_active,
  switching: m.slot_status_switching,
  unavailable: m.slot_status_unavailable,
  failed: m.slot_status_failed,
};

export function slotStatusLabel(status: SlotStatus): string {
  return SLOT_STATUS_LABELS[status]();
}

export function slotStatusVariant(
  status: SlotStatus,
): "secondary" | "outline" | "destructive" {
  if (status === "failed") return "destructive";
  if (
    status === "unavailable" ||
    status === "starting" ||
    status === "switching"
  ) {
    return "outline";
  }
  return "secondary";
}

function selectedProvider(slot: SlotInfo): SlotProviderInfo | undefined {
  return slot.selected
    ? slot.providers.find((provider) => provider.id === slot.selected)
    : undefined;
}

function canOpen(slot: SlotInfo): boolean {
  const provider = selectedProvider(slot);
  return Boolean(provider?.eligible);
}

function providerNote(provider: SlotProviderInfo): string | null {
  if (!provider.eligible) {
    return provider.reason ?? m.slot_provider_ineligible();
  }
  if (!provider.enabled) return m.slot_provider_disabled();
  return null;
}

type Props = {
  slots: SlotInfo[] | null;
  busy: boolean;
  onChanged: () => Promise<void>;
  onMessage: (message: string) => void;
};

export function SlotPanel({ slots, busy, onChanged, onMessage }: Props) {
  const [picker, setPicker] = useState<SlotInfo | null>(null);
  const [pickerError, setPickerError] = useState("");
  const [pending, setPending] = useState(false);
  const disabled = busy || pending;

  const selectedPicker = useMemo(() => {
    if (!picker) return null;
    return slots?.find((slot) => slot.id === picker.id) ?? picker;
  }, [picker, slots]);

  const run = useCallback(
    async (action: () => Promise<unknown>, success: string): Promise<void> => {
      setPending(true);
      try {
        await action();
        onMessage(success);
        await onChanged();
      } catch (error) {
        onMessage(toExtensionFailure(error).message);
        await onChanged();
      } finally {
        setPending(false);
      }
    },
    [onChanged, onMessage],
  );

  const applyProvider = useCallback(
    async (slot: SlotInfo, provider: SlotProviderInfo): Promise<void> => {
      setPending(true);
      try {
        await applySlotProvider(slot.id, provider.id);
        setPickerError("");
        onMessage(m.slot_status_active());
        setPicker(null);
        await onChanged();
      } catch (error) {
        const message = toExtensionFailure(error).message;
        setPickerError(message);
        onMessage(message);
        await onChanged();
      } finally {
        setPending(false);
      }
    },
    [onChanged, onMessage],
  );

  if (slots === null) {
    return (
      <section className="space-y-2" data-testid="slot-panel">
        <h3 className="text-sm font-medium text-ink-soft">
          {m.slot_section_title()}
        </h3>
        <p className="text-xs text-muted-foreground">{m.ext_loading()}</p>
      </section>
    );
  }

  return (
    <section className="space-y-3" data-testid="slot-panel">
      <div className="space-y-1">
        <h3 className="text-sm font-medium text-ink-soft">
          {m.slot_section_title()}
        </h3>
        <p className="text-xs text-muted-foreground">
          {m.slot_section_description()}
        </p>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        {slots.map((slot) => {
          const provider = selectedProvider(slot);
          const active = slot.status === "active";
          return (
            <article
              key={slot.id}
              className="space-y-2 rounded-xl border border-border/60 p-3"
              data-testid={`slot-${slot.id}`}
            >
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex min-w-0 items-center gap-2">
                  <span className="truncate text-sm text-ink-soft">
                    {slot.name}
                  </span>
                  <Badge variant={slotStatusVariant(slot.status)}>
                    {slotStatusLabel(slot.status)}
                  </Badge>
                </div>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={disabled}
                  onClick={() => {
                    setPickerError("");
                    setPicker(slot);
                  }}
                  className="gap-1.5"
                >
                  <Settings2 className="h-3.5 w-3.5" />
                  {m.slot_action_switch()}
                </Button>
              </div>

              <div className="space-y-0.5">
                <p className="text-[11px] text-ink-faint">{m.slot_current()}</p>
                <p className="truncate text-xs text-ink-soft">
                  {provider
                    ? `${provider.name} ${provider.version}`
                    : (slot.selected ?? m.slot_not_selected())}
                  {slot.selected && slot.defaultProvider === slot.selected && (
                    <span className="ml-1.5 text-[10px] text-ink-faint">
                      {m.slot_default()}
                    </span>
                  )}
                </p>
              </div>

              {slot.error && (
                <p className="text-[11px] text-destructive">
                  {slot.error.code}：{slot.error.message}
                </p>
              )}
              {slot.status === "unavailable" && provider?.reason && (
                <p className="text-[11px] text-muted-foreground">
                  {m.slot_unavailable_hint({ reason: provider.reason })}
                </p>
              )}

              <div className="flex flex-wrap items-center gap-2">
                {active ? (
                  <>
                    <Button
                      type="button"
                      size="sm"
                      disabled={disabled}
                      onClick={() =>
                        void run(
                          () => activateSlot(slot.id),
                          m.slot_action_open(),
                        )
                      }
                    >
                      {m.slot_action_open()}
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      disabled={disabled || !slot.selected}
                      onClick={() =>
                        void run(
                          () => closeExtension(slot.selected ?? ""),
                          m.slot_action_close(),
                        )
                      }
                    >
                      {m.slot_action_close()}
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      disabled={disabled}
                      onClick={() =>
                        void run(
                          () => deactivateSlot(slot.id),
                          m.slot_action_stop(),
                        )
                      }
                    >
                      {m.slot_action_stop()}
                    </Button>
                  </>
                ) : (
                  <Button
                    type="button"
                    size="sm"
                    disabled={disabled || !canOpen(slot)}
                    onClick={() =>
                      void run(
                        () => activateSlot(slot.id),
                        m.slot_action_open(),
                      )
                    }
                  >
                    {slot.status === "failed"
                      ? m.slot_action_retry()
                      : m.slot_action_open()}
                  </Button>
                )}
              </div>
              {slot.status !== "active" && !slot.selected && (
                <p className="text-[11px] text-muted-foreground">
                  {m.slot_empty_hint()}
                </p>
              )}
            </article>
          );
        })}
      </div>

      <Sheet
        open={picker !== null}
        onOpenChange={(open) => {
          if (!open) setPicker(null);
        }}
      >
        <SheetContent side="right" className="w-full sm:max-w-md">
          {selectedPicker && (
            <>
              <SheetHeader>
                <SheetTitle>
                  {m.slot_switch_title({ slot: selectedPicker.name })}
                </SheetTitle>
                <SheetDescription>
                  {m.slot_switch_description()}
                </SheetDescription>
              </SheetHeader>
              <div className="flex-1 space-y-2 overflow-y-auto px-4 pb-4">
                {selectedPicker.providers.length === 0 && (
                  <p className="rounded-lg border border-dashed border-border/70 p-4 text-xs text-muted-foreground">
                    {m.slot_no_candidates()}
                  </p>
                )}
                {selectedPicker.providers.map((provider) => {
                  const note = providerNote(provider);
                  const current = selectedPicker.selected === provider.id;
                  return (
                    <article
                      key={provider.id}
                      className="space-y-1.5 rounded-xl border border-border/60 p-3"
                    >
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="text-sm text-ink-soft">
                          {provider.name}
                        </span>
                        <span className="text-[10px] text-ink-faint">
                          {provider.version} · {provider.id}
                        </span>
                        {provider.origin === "bundled" && (
                          <Badge variant="secondary">
                            {m.slot_provider_official()}
                          </Badge>
                        )}
                        {provider.origin === "dev" && (
                          <Badge variant="outline">
                            {m.slot_provider_dev()}
                          </Badge>
                        )}
                        {current && (
                          <Badge variant="outline">{m.slot_current()}</Badge>
                        )}
                        {!provider.eligible && (
                          <Badge variant="destructive">
                            {m.slot_provider_ineligible()}
                          </Badge>
                        )}
                      </div>
                      {note && (
                        <p className="text-[11px] text-muted-foreground">
                          {note}
                        </p>
                      )}
                      <div className="flex justify-end">
                        <Button
                          type="button"
                          size="sm"
                          disabled={disabled || !provider.eligible}
                          onClick={() =>
                            void applyProvider(selectedPicker, provider)
                          }
                        >
                          {pending ? (
                            <Loader2 className="h-3.5 w-3.5 animate-spin" />
                          ) : (
                            m.slot_switch_confirm()
                          )}
                        </Button>
                      </div>
                    </article>
                  );
                })}
                {pickerError && (
                  <p className="text-xs text-destructive">{pickerError}</p>
                )}
                <p className="text-[11px] text-muted-foreground">
                  {m.slot_playback_note()}
                </p>
              </div>
            </>
          )}
        </SheetContent>
      </Sheet>
    </section>
  );
}
