// biome-ignore-all lint/correctness/noUndeclaredDependencies: workspace package
"use client";
import type { LullMediaClient } from "@lull/media-sdk";
import { type SetStateAction, useEffect, useId, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useLocale } from "@/i18n/locale";
import { intensityWeights } from "@/lib/environment-intensity";
import { m } from "@/paraglide/messages";
import {
  EnvironmentAssetPicker,
  useEnvironmentAssets,
} from "./noise-environment-assets";
import {
  anchorErrors,
  type EnvironmentDraft,
  insertAnchor,
  percentValue,
  serializeDraft,
} from "./noise-environment-model";

function typeOptions() {
  return {
    rain: m.env_rain(),
    wind: m.env_wind(),
    water: m.env_water(),
    fire: m.env_fire(),
    snow: m.env_snow(),
    lightning: m.env_lightning(),
    "ambient-light": m.env_ambient_light(),
  };
}
export function environmentTypeLabel(type: string): string {
  return (
    typeOptions()[type as keyof ReturnType<typeof typeOptions>] ??
    m.env_custom({ type })
  );
}

/** Controlled authoring form: only reads the library and never writes playback state. */
export function NoiseEnvironmentForm({
  client,
  draft,
  onChange,
  disabled = false,
  percent,
  onPercentChange,
  onAvailabilityChange,
}: {
  client: LullMediaClient | null;
  draft: EnvironmentDraft;
  onChange: (draft: EnvironmentDraft) => void;
  disabled?: boolean;
  onAvailabilityChange?: (available: boolean) => void;
  percent?: string;
  onPercentChange?: (value: string) => void;
}) {
  useLocale();
  const id = useId();
  const [pickerRow, setPickerRow] = useState<string | null>(null);
  const [version, setVersion] = useState(0);
  const assets = useEnvironmentAssets(
    client,
    draft.anchors.map((a) => a.assetId),
    version,
    true,
  );
  useEffect(
    () =>
      client?.events.on((event) => {
        if (event.topic === "noise.library.changed") setVersion((v) => v + 1);
      }),
    [client],
  );
  const setDraft = (next: SetStateAction<EnvironmentDraft>) =>
    onChange(typeof next === "function" ? next(draft) : next);
  const closePicker = (rowId: string) => {
    setPickerRow(null);
    requestAnimationFrame(() =>
      document.getElementById(`${id}-${rowId}-asset`)?.focus(),
    );
  };
  const available = draft.anchors.every(
    (a) => assets[a.assetId]?.status === "available",
  );
  useEffect(() => {
    onAvailabilityChange?.(available);
  }, [available, onAvailabilityChange]);
  const rows = anchorErrors(draft.anchors);
  const invalidCount = draft.anchors.length < 2 || draft.anchors.length > 8;
  const errorMessages = {
    range: m.env_range_error(),
    asset: m.env_asset_error(),
    duplicate: m.env_duplicate_error(),
    order: m.env_order_error(),
  };
  const value = percent === undefined ? null : percentValue(percent);
  const weights =
    value === null || rows.some(Boolean)
      ? []
      : intensityWeights(
          serializeDraft(draft, value / 100).anchors,
          value / 100,
        );
  return (
    <div className="min-w-0 space-y-3">
      <fieldset disabled={disabled || !client} className="min-w-0 space-y-3">
        <div className="space-y-1">
          <label htmlFor={`${id}-type`} className="font-medium">
            {m.env_type()}
          </label>
          <Select
            value={draft.type}
            onValueChange={(type) => {
              setDraft((previous) => ({ ...previous, type }));
            }}
            disabled={disabled || !client}
          >
            <SelectTrigger id={`${id}-type`} size="sm" className="max-w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {Object.entries(typeOptions()).map(([value, label]) => (
                <SelectItem key={value} value={value}>
                  {label}
                </SelectItem>
              ))}
              {!(draft.type in typeOptions()) && (
                <SelectItem value={draft.type}>
                  {environmentTypeLabel(draft.type)}
                </SelectItem>
              )}
            </SelectContent>
          </Select>
        </div>
        {percent !== undefined && onPercentChange && (
          <div className="space-y-1">
            <label htmlFor={`${id}-initial`} className="text-xs font-medium">
              {m.env_preset_initial()}
            </label>
            <div className="flex flex-wrap items-center gap-2">
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={disabled}
                aria-label={m.env_decrease()}
                onClick={() =>
                  onPercentChange(String(Math.max(0, (value ?? 0) - 5)))
                }
              >
                −
              </Button>
              <input
                id={`${id}-initial`}
                type="number"
                min={0}
                max={100}
                step="any"
                className="h-8 w-24 rounded-md border border-input bg-background px-2"
                disabled={disabled}
                value={percent}
                aria-invalid={value === null}
                aria-describedby={
                  value === null ? `${id}-initial-error` : undefined
                }
                onChange={(e) => onPercentChange(e.target.value)}
              />
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={disabled}
                aria-label={m.env_increase()}
                onClick={() =>
                  onPercentChange(String(Math.min(100, (value ?? 0) + 5)))
                }
              >
                +
              </Button>
            </div>
            {value === null && (
              <p
                id={`${id}-initial-error`}
                role="alert"
                className="text-xs text-destructive"
              >
                {m.env_range_error()}
              </p>
            )}
            <p className="text-xs text-muted-foreground">
              {m.env_preset_hint()}
            </p>
          </div>
        )}
        <h4 className="font-medium">{m.env_anchors()}</h4>
        <p className="text-muted-foreground">{m.env_sort_hint()}</p>
        {draft.anchors.map((anchor, index) => {
          const state = assets[anchor.assetId];
          const rowError = rows[index]
            ? errorMessages[rows[index]]
            : anchor.assetId && state?.status === "missing"
              ? m.env_missing()
              : "";
          const rowId = `${id}-${anchor.rowId}`;
          return (
            <div
              key={anchor.rowId}
              className="min-w-0 space-y-2 rounded-md border border-border p-2"
            >
              <div className="grid min-w-0 gap-2 sm:grid-cols-[7rem_minmax(0,1fr)_auto]">
                <label className="space-y-1" htmlFor={`${rowId}-percent`}>
                  {m.env_percent({ index: index + 1 })}
                  <input
                    id={`${rowId}-percent`}
                    type="number"
                    min={0}
                    max={100}
                    step="any"
                    value={anchor.percent}
                    className="h-8 w-full rounded-md border border-input bg-background px-2"
                    aria-invalid={!!rowError}
                    aria-describedby={rowError ? `${rowId}-error` : undefined}
                    onChange={(e) => {
                      const percent = e.target.value;
                      setDraft((previous) => ({
                        ...previous,
                        anchors: previous.anchors.map((a) =>
                          a.rowId === anchor.rowId ? { ...a, percent } : a,
                        ),
                      }));
                    }}
                  />
                </label>
                <div className="min-w-0 space-y-1">
                  <span>{m.env_asset({ index: index + 1 })}</span>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    className="h-auto min-h-8 w-full justify-start whitespace-normal break-words text-left"
                    id={`${rowId}-asset`}
                    aria-label={m.env_asset({ index: index + 1 })}
                    aria-invalid={!!rowError || state?.status === "failed"}
                    aria-describedby={rowError ? `${rowId}-error` : undefined}
                    aria-expanded={pickerRow === anchor.rowId}
                    onClick={() =>
                      setPickerRow((previous) =>
                        previous === anchor.rowId ? null : anchor.rowId,
                      )
                    }
                  >
                    {state?.asset?.name ??
                      anchor.expectedName ??
                      (anchor.assetId || m.env_pick())}
                  </Button>
                  {anchor.assetId && (!state || state.status === "loading") && (
                    <output>{m.env_loading()}</output>
                  )}
                  {state?.status === "failed" && (
                    <p role="alert">
                      {m.env_load_failed()}{" "}
                      <Button
                        type="button"
                        size="sm"
                        variant="ghost"
                        onClick={() => setVersion((v) => v + 1)}
                      >
                        {m.env_retry()}
                      </Button>
                    </p>
                  )}
                </div>
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  className="self-end"
                  disabled={draft.anchors.length <= 2}
                  onClick={() => {
                    setDraft((previous) => ({
                      ...previous,
                      anchors: previous.anchors.filter(
                        (a) => a.rowId !== anchor.rowId,
                      ),
                    }));
                    setPickerRow(null);
                  }}
                >
                  {m.env_remove({ index: index + 1 })}
                </Button>
              </div>
              {rowError && (
                <p
                  id={`${rowId}-error`}
                  role="alert"
                  className="text-destructive"
                >
                  {rowError}
                </p>
              )}
              {pickerRow === anchor.rowId && client && (
                <EnvironmentAssetPicker
                  client={client}
                  version={version}
                  onClose={() => closePicker(anchor.rowId)}
                  onSelect={(asset) => {
                    setDraft((previous) => ({
                      ...previous,
                      anchors: previous.anchors.map((a) =>
                        a.rowId !== anchor.rowId || a.assetId === asset.id
                          ? a
                          : {
                              rowId: a.rowId,
                              assetId: asset.id,
                              intensity: a.intensity,
                              percent: a.percent,
                            },
                      ),
                    }));
                    closePicker(anchor.rowId);
                  }}
                />
              )}
            </div>
          );
        })}
        {invalidCount && (
          <p role="alert" className="text-destructive">
            {m.env_anchor_count()}
          </p>
        )}
        <div className="flex flex-wrap gap-2">
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={draft.anchors.length >= 8 || rows.some(Boolean)}
            onClick={() => {
              setDraft((previous) => ({
                ...previous,
                anchors: insertAnchor(previous.anchors),
              }));
            }}
          >
            {m.env_add()}
          </Button>
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={draft.anchors.some(
              (a) => percentValue(a.percent) === null,
            )}
            onClick={() => {
              setDraft((previous) => ({
                ...previous,
                anchors: [...previous.anchors].sort(
                  (a, b) => Number(a.percent) - Number(b.percent),
                ),
              }));
            }}
          >
            {m.env_sort()}
          </Button>
        </div>
      </fieldset>
      {percent !== undefined && (
        <details className="text-xs">
          <summary className="cursor-pointer py-2">
            {m.env_preset_weights()}
          </summary>
          <p className="text-muted-foreground">{m.env_preset_weights_hint()}</p>
          {weights.length > 0 &&
            draft.anchors.map((a, index) => (
              <div
                key={a.rowId}
                className="grid min-w-0 grid-cols-[minmax(0,1fr)_auto] gap-2 py-1"
              >
                <span className="break-words">
                  {a.percent}% ·{" "}
                  {assets[a.assetId]?.asset?.name ??
                    a.expectedName ??
                    a.assetId}
                </span>
                <span>{Math.round(weights[index] * 100)}%</span>
                <meter
                  className="col-span-2 w-full"
                  min={0}
                  max={1}
                  value={weights[index]}
                  aria-label={a.expectedName ?? a.assetId}
                />
              </div>
            ))}
        </details>
      )}
    </div>
  );
}
