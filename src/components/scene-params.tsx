"use client";

import { type ChangeEvent, useEffect, useRef, useState } from "react";
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
import { m } from "@/paraglide/messages";
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

/**
 * 多行文本参数（`text`）的宿主上限。
 *
 * 值会随壁纸 URL 哈希下发，两侧都不能无界放大；官方 shader 场景声明同样的
 * 上限（见 `extensions/official/shadertoy-wallpaper/src/source/source-model.ts`），
 * 修改时保持同步。
 */
export const SCENE_TEXT_PARAM_MAX_CHARS = 128 * 1024;

/**
 * 读取前的字节上限：UTF-8 每个字符最多 4 字节，因此字节数超过 4 倍字符上限时
 * 内容一定超限；先拒绝可以避免把超大文件整个读进内存。
 */
const SCENE_TEXT_FILE_MAX_BYTES = SCENE_TEXT_PARAM_MAX_CHARS * 4;

/** 文本类文件的提示过滤器；浏览器仍允许用户切到“所有文件”。 */
const TEXT_FILE_ACCEPT = ".txt,.glsl,.frag,text/plain";

function readFileText(file: File): Promise<string> {
  if (typeof file.text === "function") return file.text();
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error("read failed"));
    reader.onload = () =>
      resolve(typeof reader.result === "string" ? reader.result : "");
    reader.readAsText(file);
  });
}

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

type TextParamFieldProps = {
  definition: SceneParamDefinition;
  /** 面板里正在编辑的草稿。 */
  value: string;
  /** 宿主已保存的值；用于判断是否脏。 */
  committed: string;
  onDraft: (value: string) => void;
  onCommit: (value: string) => void;
};

/**
 * 多行文本参数：textarea + 通用“从文件载入”。
 *
 * 大文本不做逐键提交（会触发整条远程配置/哈希链路），只在应用按钮、失焦或
 * Ctrl/Cmd+Enter 时提交；文件载入成功后立即提交一次。
 */
function TextParamField({
  definition,
  value,
  committed,
  onDraft,
  onCommit,
}: TextParamFieldProps) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [fileName, setFileName] = useState<string | null>(null);
  const [notice, setNotice] = useState<{
    kind: "info" | "error";
    text: string;
  } | null>(null);
  const [busy, setBusy] = useState(false);
  const dirty = value !== committed;

  const tooLarge = (): boolean => {
    if (value.length <= SCENE_TEXT_PARAM_MAX_CHARS) return false;
    setNotice({
      kind: "error",
      text: m.scene_param_text_file_too_large({
        limit: String(Math.round(SCENE_TEXT_PARAM_MAX_CHARS / 1024)),
      }),
    });
    return true;
  };

  const commit = (): void => {
    if (!dirty || busy || tooLarge()) return;
    onCommit(value);
  };

  const handleFile = async (
    event: ChangeEvent<HTMLInputElement>,
  ): Promise<void> => {
    const file = event.target.files?.[0];
    // 清空 value：允许再次选择同一个文件（“重新载入”）。
    event.target.value = "";
    if (!file) return;
    setNotice(null);
    setBusy(true);
    try {
      if (file.size === 0) {
        setNotice({ kind: "error", text: m.scene_param_text_file_empty() });
        return;
      }
      if (file.size > SCENE_TEXT_FILE_MAX_BYTES) {
        setNotice({
          kind: "error",
          text: m.scene_param_text_file_too_large({
            limit: String(Math.round(SCENE_TEXT_PARAM_MAX_CHARS / 1024)),
          }),
        });
        return;
      }
      const text = await readFileText(file);
      if (text.length === 0) {
        setNotice({ kind: "error", text: m.scene_param_text_file_empty() });
        return;
      }
      if (text.length > SCENE_TEXT_PARAM_MAX_CHARS) {
        setNotice({
          kind: "error",
          text: m.scene_param_text_file_too_large({
            limit: String(Math.round(SCENE_TEXT_PARAM_MAX_CHARS / 1024)),
          }),
        });
        return;
      }
      setFileName(file.name);
      setNotice({
        kind: "info",
        text: m.scene_param_text_loaded({
          name: file.name,
          count: String(text.length),
        }),
      });
      onDraft(text);
      onCommit(text);
    } catch (error) {
      setNotice({
        kind: "error",
        text: m.scene_param_text_file_read_failed({
          reason: error instanceof Error ? error.message : String(error),
        }),
      });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-2">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="text-sm text-ink-soft">{definition.label}</div>
          {definition.description && (
            <div className="text-xs text-muted-foreground">
              {definition.description}
            </div>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <button
            type="button"
            className="text-xs text-muted-foreground transition-colors hover:text-ink disabled:opacity-50"
            disabled={busy}
            onClick={() => fileRef.current?.click()}
          >
            {m.scene_param_text_load_file()}
          </button>
          <button
            type="button"
            className="text-xs text-ink-soft transition-colors hover:text-ink disabled:opacity-50"
            disabled={!dirty || busy}
            onClick={commit}
          >
            {m.scene_param_text_apply()}
          </button>
        </div>
      </div>
      <textarea
        aria-label={definition.label}
        className={cn(
          INPUT_CLASS,
          "block h-40 w-full resize-y whitespace-pre font-mono text-xs leading-5",
        )}
        placeholder={m.scene_param_text_placeholder()}
        spellCheck={false}
        value={value}
        onChange={(event) => onDraft(event.target.value)}
        onBlur={commit}
        onKeyDown={(event) => {
          if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
            event.preventDefault();
            commit();
          }
        }}
      />
      <input
        ref={fileRef}
        type="file"
        accept={TEXT_FILE_ACCEPT}
        aria-label={m.scene_param_text_load_file()}
        className="hidden"
        onChange={(event) => void handleFile(event)}
      />
      {notice ? (
        <p
          role={notice.kind === "error" ? "alert" : "status"}
          className={cn(
            "text-xs",
            notice.kind === "error"
              ? "text-destructive"
              : "text-muted-foreground",
          )}
        >
          {notice.text}
        </p>
      ) : fileName ? (
        <p className="text-xs text-muted-foreground">{fileName}</p>
      ) : null}
    </div>
  );
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
        <span className="text-xs font-medium text-ink-soft">
          {m.scene_params_title()}
        </span>
        <button
          type="button"
          className="text-xs text-muted-foreground transition-colors hover:text-ink"
          onClick={() => {
            setDraft(initialDraft(definitions, {}));
            onReset();
          }}
        >
          {m.scene_params_reset()}
        </button>
      </div>
      {definitions.map((definition) => {
        const value = draft[definition.key] ?? "";
        const commit = (next: string): void =>
          update(definition.key, next, true);

        if (definition.type === "text") {
          return (
            <TextParamField
              key={definition.key}
              definition={definition}
              value={value}
              committed={values[definition.key] ?? String(definition.default)}
              onDraft={(next) => update(definition.key, next, false)}
              onCommit={commit}
            />
          );
        }

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
