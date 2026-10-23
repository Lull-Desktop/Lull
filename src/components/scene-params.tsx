"use client";

import { useEffect, useState } from "react";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Slider } from "@/components/ui/slider";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";
import type { SceneParamDefinition } from "@/sdk/scene";

type SceneParamFieldsProps = {
  definitions: readonly SceneParamDefinition[];
  values: Readonly<Record<string, string>>;
  onChange: (key: string, value: string) => void;
  onReset: () => void;
};

function initialDraft(
  definitions: readonly SceneParamDefinition[],
  values: Readonly<Record<string, string>>,
): Record<string, string> {
  const draft: Record<string, string> = {};
  for (const definition of definitions) {
    draft[definition.key] =
      values[definition.key] ?? String(definition.default);
  }
  return draft;
}

const INPUT_CLASS =
  "h-8 rounded-lg border border-border bg-background px-2 text-sm text-ink tabular-nums";

type RangedNumberParam = SceneParamDefinition & {
  type: "number";
  min: number;
  max: number;
};

/** 只有同时有 min/max 的 number 参数才用滑条；单边或无界仍用数字输入。 */
function isRangedNumber(def: SceneParamDefinition): def is RangedNumberParam {
  return (
    def.type === "number" &&
    typeof def.min === "number" &&
    typeof def.max === "number" &&
    def.max > def.min
  );
}

function decimalsForStep(step: number): number {
  if (!Number.isFinite(step) || step >= 1) return 0;
  const fraction = String(step).split(".")[1];
  return Math.min(3, fraction?.length ?? 2);
}

function rangeStep(def: RangedNumberParam): number {
  if (def.step !== undefined && def.step > 0) return def.step;
  const span = def.max - def.min;
  if (span <= 2) return 0.01;
  if (span <= 20) return 0.1;
  return 1;
}

function numericDefault(def: RangedNumberParam): number {
  const value = Number(def.default);
  return Number.isFinite(value) ? value : def.min;
}

function clampDraft(
  raw: string,
  min: number,
  max: number,
  fallback: number,
): number {
  const parsed = raw.trim() === "" ? Number.NaN : Number(raw);
  const value = Number.isFinite(parsed) ? parsed : fallback;
  return Math.min(max, Math.max(min, value));
}

function formatNumber(value: number, step: number): string {
  return value.toFixed(decimalsForStep(step));
}

/** 场景参数的通用编辑器：按 Manifest 类型渲染控件，提交时把字符串写回宿主。 */
export function SceneParamFields({
  definitions,
  values,
  onChange,
  onReset,
}: SceneParamFieldsProps) {
  const [draft, setDraft] = useState(() => initialDraft(definitions, values));

  useEffect(() => {
    setDraft(initialDraft(definitions, values));
  }, [definitions, values]);

  if (definitions.length === 0) return null;

  const update = (key: string, value: string, commit: boolean): void => {
    setDraft((current) => ({ ...current, [key]: value }));
    if (commit) onChange(key, value);
  };

  return (
    <div className="space-y-3 rounded-xl border border-border/50 bg-black/5 p-3">
      <div className="flex items-center justify-between">
        <span className="text-xs font-medium text-ink-soft">场景参数</span>
        <button
          type="button"
          className="text-xs text-muted-foreground transition-colors hover:text-ink"
          onClick={() => {
            setDraft(initialDraft(definitions, {}));
            onReset();
          }}
        >
          恢复默认
        </button>
      </div>
      {definitions.map((definition) => {
        const value = draft[definition.key] ?? "";
        const commit = (next: string): void =>
          update(definition.key, next, true);

        if (isRangedNumber(definition)) {
          const step = rangeStep(definition);
          const current = clampDraft(
            value,
            definition.min,
            definition.max,
            numericDefault(definition),
          );
          const commitRange = (next: number[]): void => {
            const nextValue = next[0];
            if (nextValue === undefined) return;
            commit(formatNumber(nextValue, step));
          };
          return (
            <div key={definition.key} className="space-y-2">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="text-sm text-ink-soft">
                    {definition.label}
                  </div>
                  {definition.description && (
                    <div className="text-xs text-muted-foreground">
                      {definition.description}
                    </div>
                  )}
                </div>
                <span className="shrink-0 text-xs font-medium tabular-nums text-ink-soft">
                  {formatNumber(current, step)}
                </span>
              </div>
              <Slider
                thumbLabel={definition.label}
                min={definition.min}
                max={definition.max}
                step={step}
                value={[current]}
                onValueChange={(next) => {
                  const nextValue = next[0];
                  if (nextValue === undefined) return;
                  update(definition.key, formatNumber(nextValue, step), false);
                }}
                onValueCommit={commitRange}
              />
              <div className="flex justify-between text-[10px] tabular-nums text-ink-faint">
                <span>{formatNumber(definition.min, step)}</span>
                <span>{formatNumber(definition.max, step)}</span>
              </div>
            </div>
          );
        }

        return (
          <div
            key={definition.key}
            className="flex items-center justify-between gap-3"
          >
            <div className="min-w-0">
              <div className="text-sm text-ink-soft">{definition.label}</div>
              {definition.description && (
                <div className="truncate text-xs text-muted-foreground">
                  {definition.description}
                </div>
              )}
            </div>
            {definition.type === "boolean" ? (
              <Switch
                aria-label={definition.label}
                checked={value === "true"}
                onCheckedChange={(on) => commit(String(on))}
              />
            ) : definition.type === "enum" ? (
              <Select value={value} onValueChange={commit}>
                <SelectTrigger size="sm" aria-label={definition.label}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {definition.options?.map((option) => (
                    <SelectItem key={option.value} value={option.value}>
                      {option.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            ) : definition.type === "color" ? (
              <input
                type="color"
                aria-label={definition.label}
                className="h-8 w-12 rounded border border-border bg-background"
                value={value}
                onChange={(event) => commit(event.target.value)}
              />
            ) : (
              <input
                type={definition.type === "number" ? "number" : "text"}
                aria-label={definition.label}
                className={cn(
                  INPUT_CLASS,
                  definition.type === "number" && "w-24",
                )}
                min={definition.min}
                max={definition.max}
                step={definition.step}
                value={value}
                onChange={(event) =>
                  update(definition.key, event.target.value, false)
                }
                onBlur={(event) => commit(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    commit((event.target as HTMLInputElement).value);
                  }
                }}
              />
            )}
          </div>
        );
      })}
    </div>
  );
}
