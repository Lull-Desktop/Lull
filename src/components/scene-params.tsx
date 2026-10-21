"use client";

import { useEffect, useState } from "react";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
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
