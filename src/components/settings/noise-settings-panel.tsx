// biome-ignore-all lint/correctness/noUndeclaredDependencies: workspace package is resolved by the app build.
/**
 * 设置窗「白噪音」页签的核心面板：主音量 / 静音 / 睡眠定时 + 预设下拉 +
 * 应用到当前音轨。会话控件（原白噪音库「噪音测试」的「主音量与睡眠」卡）
 * 置于预设之上。
 *
 * 这里是**使用**侧：只做选择与套用，不做保存当前混音、导入/导出、改名、
 * 删除与缺失轨道映射（那些都在白噪音库窗口的「噪音素材库」页签）。
 *
 * 应用语义 = 用预设整体替换 Session 的音轨（Rust `replace_with_preset`），
 * 不会自动播放；音轨列表靠 `noise.session.changed` 事件自动刷新。
 *
 * 媒体连接由设置页根节点独占，本组件只消费传入的 client。
 */
"use client";

import type {
  LullMediaClient,
  NoisePresetLoadResult,
  NoisePresetSummary,
} from "@lull/media-sdk";
import { useCallback, useEffect, useId, useState } from "react";
import { NoiseSessionControls } from "@/components/settings/noise-session-controls";
import { NoiseSessionTracks } from "@/components/settings/noise-session-tracks";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useLocale } from "@/i18n/locale";
import { m } from "@/paraglide/messages";

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function optionLabel(preset: NoisePresetSummary): string {
  const suffix =
    preset.sourceType === "builtin"
      ? ` · ${m.noise_preset_source_builtin()}`
      : "";
  return `${preset.name}${suffix} · ${m.settings_noise_tracks_count({ count: preset.trackCount })}`;
}

export function NoiseSettingsPanel({
  client,
}: {
  client: LullMediaClient | null;
}) {
  useLocale();
  const selectId = useId();
  const [presets, setPresets] = useState<NoisePresetSummary[]>([]);
  const [presetId, setPresetId] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [version, setVersion] = useState(0);

  const refresh = useCallback(() => setVersion((value) => value + 1), []);

  // 懒加载预设列表；语言切换不影响后端数据，只影响展示。
  // biome-ignore lint/correctness/useExhaustiveDependencies: version 只是手动刷新信号，不进查询参数
  useEffect(() => {
    if (!client) return;
    let alive = true;
    void client.noise.presets
      .listPresets({ page: 1, pageSize: 200 })
      .then((page) => {
        if (!alive) return;
        setPresets(page.items);
        setError("");
        setPresetId((current) =>
          current && page.items.some((item) => item.id === current)
            ? current
            : (page.items[0]?.id ?? ""),
        );
      })
      .catch((reason: unknown) => {
        if (alive) setError(errorText(reason));
      });
    return () => {
      alive = false;
    };
  }, [client, version]);

  // 库窗口里新建/导入/改名/删除预设后，这里下拉要跟着变。
  useEffect(() => {
    if (!client) return;
    const stop = client.events.on((event) => {
      if (event.topic.startsWith("noise.preset.")) refresh();
    });
    return () => stop();
  }, [client, refresh]);

  const applyPreset = useCallback((): void => {
    if (!client || !presetId) return;
    setBusy(true);
    setError("");
    setNotice("");
    void client.noise.presets
      .loadPreset(presetId)
      .then((result: NoisePresetLoadResult) => {
        if (result.missing.length > 0) {
          setNotice(
            m.settings_noise_preset_missing({ count: result.missing.length }),
          );
          return;
        }
        setNotice(
          m.settings_noise_preset_applied({ name: result.preset.name }),
        );
      })
      .catch((reason: unknown) => {
        setError(m.settings_noise_preset_failed({ reason: errorText(reason) }));
      })
      .finally(() => setBusy(false));
  }, [client, presetId]);

  const favorites = presets.filter((preset) => preset.favorite);
  const others = presets.filter((preset) => !preset.favorite);
  const empty = presets.length === 0;

  return (
    <div
      className="flex min-h-0 flex-1 flex-col gap-3"
      data-testid="noise-settings-panel"
    >
      {/* 主音量 / 静音 / 睡眠定时：从白噪音库「噪音测试」迁来，置于预设之上。 */}
      <NoiseSessionControls client={client} />

      <div className="shrink-0 space-y-2">
        <div className="flex flex-wrap items-end gap-2">
          <div className="min-w-0 flex-1 space-y-1.5">
            <Label htmlFor={selectId}>{m.settings_noise_preset_label()}</Label>
            <Select
              value={presetId}
              onValueChange={setPresetId}
              disabled={!client || empty || busy}
            >
              <SelectTrigger
                id={selectId}
                size="sm"
                aria-label={m.settings_noise_preset_label()}
                className="w-full"
              >
                <SelectValue
                  placeholder={
                    empty
                      ? m.settings_noise_preset_empty()
                      : m.settings_noise_preset_placeholder()
                  }
                />
              </SelectTrigger>
              <SelectContent>
                {favorites.length > 0 && (
                  <SelectGroup>
                    <SelectLabel>
                      {m.settings_noise_preset_group_favorites()}
                    </SelectLabel>
                    {favorites.map((preset) => (
                      <SelectItem key={preset.id} value={preset.id}>
                        {optionLabel(preset)}
                      </SelectItem>
                    ))}
                  </SelectGroup>
                )}
                {others.length > 0 && (
                  <SelectGroup>
                    <SelectLabel>
                      {m.settings_noise_preset_group_all()}
                    </SelectLabel>
                    {others.map((preset) => (
                      <SelectItem key={preset.id} value={preset.id}>
                        {optionLabel(preset)}
                      </SelectItem>
                    ))}
                  </SelectGroup>
                )}
              </SelectContent>
            </Select>
          </div>
          <Button
            type="button"
            size="sm"
            disabled={!client || empty || !presetId || busy}
            onClick={applyPreset}
          >
            {m.settings_noise_preset_apply()}
          </Button>
        </div>

        <p className="text-xs text-muted-foreground">
          {m.settings_noise_preset_apply_hint()}
        </p>
        {error && (
          <p role="alert" className="text-xs text-destructive">
            {error}
          </p>
        )}
        {!error && notice && (
          <output className="block text-xs text-emerald-700">{notice}</output>
        )}
      </div>

      <NoiseSessionTracks client={client} />
    </div>
  );
}
