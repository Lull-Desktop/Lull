// biome-ignore-all lint/correctness/noUndeclaredDependencies: workspace package is resolved by the app build.
/**
 * Noise Preset 管理区块（由白噪音库窗口的「噪音素材库」页签渲染）。
 *
 * 资产侧动作都在这里：保存当前混音、导入/导出 `.lull-noise.json`、收藏、
 * 重命名、删除、缺失轨道映射。「选择预设并应用」在设置窗的白噪音页签，
 * 那边是下拉 + 一键应用，不提供任何保存/导出入口。
 */
"use client";

import type {
  LullMediaClient,
  NoisePresetDetail,
  NoisePresetLoadResult,
  NoisePresetSummary,
} from "@lull/media-sdk";
import { Download, Loader2, Save, Star, Trash2, Upload } from "lucide-react";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { useConfirmDialog } from "@/components/ui/confirm-dialog";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { getMediaClient } from "@/hooks/use-media-client";
import { useLocale } from "@/i18n/locale";
import { m } from "@/paraglide/messages";
import {
  NoisePresetEditor,
  type PresetLeaveGuard,
  type RegisterPresetGuard,
} from "./noise-preset-editor";

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function sourceLabel(source: string): string {
  if (source === "builtin") return "内置";
  if (source === "community") return "社区";
  return "用户";
}

export function NoisePresetPanel({
  registerGuard: registerWindowGuard,
}: {
  registerGuard?: RegisterPresetGuard;
}) {
  useLocale();
  const { confirm, dialog: confirmDialog } = useConfirmDialog();
  // 同一窗口可能挂载多份面板，表单控件 id 必须实例唯一。
  const formId = useId();
  const [client, setClient] = useState<LullMediaClient | null>(null);
  const [presets, setPresets] = useState<NoisePresetSummary[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [favoriteOnly, setFavoriteOnly] = useState(false);
  const [selected, setSelected] = useState<NoisePresetDetail | null>(null);
  const [loadResult, setLoadResult] = useState<NoisePresetLoadResult | null>(
    null,
  );
  const [saveName, setSaveName] = useState("我的音境混音");
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [version, setVersion] = useState(0);
  const pageSize = 50;

  const refresh = useCallback(() => setVersion((value) => value + 1), []);

  useEffect(() => {
    setClient(getMediaClient());
  }, []);

  // biome-ignore lint/correctness/useExhaustiveDependencies: version 只是手动刷新信号，不进查询参数
  useEffect(() => {
    if (!client) return;
    let alive = true;
    void client.noise.presets
      .listPresets({ favoriteOnly: favoriteOnly || undefined, page, pageSize })
      .then((result) => {
        if (!alive) return;
        setPresets(result.items);
        setTotal(result.total);
        setError("");
      })
      .catch((reason: unknown) => {
        if (alive) setError(errorText(reason));
      });
    return () => {
      alive = false;
    };
  }, [client, favoriteOnly, page, version]);

  const leaveGuard = useRef<PresetLeaveGuard | null>(null);
  const [editorDirty, setEditorDirty] = useState(false);
  const [editorSaving, setEditorSaving] = useState(false);
  const selecting = useRef(0);
  const active = useRef(true);
  const running = useRef(false);
  const asking = useRef(false);
  const registerGuard = useCallback<RegisterPresetGuard>(
    (guard) => {
      leaveGuard.current = guard;
      registerWindowGuard?.(guard);
      if (!guard) {
        setEditorDirty(false);
        setEditorSaving(false);
      }
    },
    [registerWindowGuard],
  );
  const onEditState = useCallback((dirty: boolean, saving: boolean) => {
    setEditorDirty(dirty);
    setEditorSaving(saving);
  }, []);
  const onSaved = useCallback(
    (detail: NoisePresetDetail) => {
      setSelected(detail);
      refresh();
    },
    [refresh],
  );
  const allowLeave = useCallback(async () => {
    if (asking.current || running.current) return false;
    asking.current = true;
    try {
      return await (leaveGuard.current?.() ?? true);
    } finally {
      asking.current = false;
    }
  }, []);
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
      selecting.current++;
    };
  }, []);
  useEffect(
    () =>
      client?.events.on((event) => {
        if (event.topic.startsWith("noise.preset.")) refresh();
      }),
    [client, refresh],
  );

  const run = useCallback(
    async (label: string, action: () => Promise<unknown>): Promise<void> => {
      if (running.current || editorSaving) return;
      if ((label === "save" || label === "import") && !(await allowLeave()))
        return;
      if (!active.current) return;
      running.current = true;
      selecting.current++;
      setBusy(label);
      setError("");
      setNotice("");
      try {
        await action();
        refresh();
      } catch (reason) {
        setError(errorText(reason));
      } finally {
        running.current = false;
        if (active.current) setBusy("");
      }
    },
    [refresh, editorSaving, allowLeave],
  );

  const selectPreset = useCallback(
    (presetId: string): void => {
      if (!client || busy || editorSaving || selected?.preset.id === presetId)
        return;
      const token = ++selecting.current;
      void (async () => {
        if (
          !(await allowLeave()) ||
          token !== selecting.current ||
          !active.current
        )
          return;
        setBusy("select");
        try {
          const detail = await client.noise.presets.getPreset(presetId);
          if (!active.current || token !== selecting.current) return;
          setSelected(detail);
          setLoadResult(null);
          setError("");
        } catch (reason) {
          if (active.current && token === selecting.current)
            setError(errorText(reason));
        } finally {
          if (active.current && token === selecting.current) setBusy("");
        }
      })();
    },
    [client, busy, editorSaving, selected?.preset.id, allowLeave],
  );

  const savePreset = useCallback((): void => {
    if (!client || !saveName.trim()) return;
    void run("save", async () => {
      const detail = await client.noise.presets.savePreset({
        name: saveName.trim(),
      });
      setSelected(detail);
      setLoadResult(null);
      setPage(1);
      setNotice("当前混音已保存为 Preset");
    });
  }, [client, run, saveName]);

  const duplicatePreset = useCallback(() => {
    if (!client || !selected) return;
    void run("duplicate", async () => {
      const suffix = m.env_preset_copy_suffix();
      const name =
        [...selected.preset.name].slice(0, 80 - [...suffix].length).join("") +
        suffix;
      const detail = await client.noise.presets.duplicatePreset(
        selected.preset.id,
        { name },
      );
      if (!active.current) return;
      setSelected(detail);
      setLoadResult(null);
      setPage(1);
      setNotice(m.env_preset_copy_saved());
    });
  }, [client, selected, run]);

  const loadPreset = useCallback(
    (presetId: string): void => {
      if (!client) return;
      void run("load", async () => {
        const result = await client.noise.presets.loadPreset(presetId);
        const detail = await client.noise.presets.getPreset(presetId);
        setSelected(detail);
        setLoadResult(result);
        if (result.missing.length > 0) {
          setNotice(
            `已加载，${result.missing.length} 条轨道缺失，可在下方映射`,
          );
        } else {
          setNotice("Preset 已加载到 Session（未自动播放）");
        }
      });
    },
    [client, run],
  );

  const deletePreset = useCallback(
    (preset: NoisePresetSummary): void => {
      if (!client) return;
      void confirm({
        title: "删除 Preset",
        description: `删除 Preset「${preset.name}」？`,
        confirmLabel: "删除",
        danger: true,
      }).then((ok) => {
        if (!ok) return;
        void run("delete", async () => {
          await client.noise.presets.deletePreset(preset.id);
          if (selected?.preset.id === preset.id) {
            setSelected(null);
            setLoadResult(null);
          }
          setNotice("Preset 已删除");
        });
      });
    },
    [client, confirm, run, selected],
  );

  const toggleFavorite = useCallback(
    (preset: NoisePresetSummary): void => {
      if (!client) return;
      void run("favorite", async () => {
        await client.noise.presets.setPresetFavorite(
          preset.id,
          !preset.favorite,
        );
      });
    },
    [client, run],
  );

  const exportPreset = useCallback(
    (presetId: string): void => {
      if (!client) return;
      void run("export", async () => {
        const result = await client.noise.presets.exportPreset(presetId);
        setNotice(result.fileName ? `已导出 ${result.fileName}` : "已取消导出");
      });
    },
    [client, run],
  );

  const importPreset = useCallback((): void => {
    if (!client) return;
    void run("import", async () => {
      const detail = await client.noise.presets.importPreset();
      if (!detail) {
        setNotice("已取消导入");
        return;
      }
      setSelected(detail);
      setLoadResult(null);
      setPage(1);
      setNotice(`已导入 Preset「${detail.preset.name}」`);
    });
  }, [client, run]);

  const mapTrack = useCallback(
    (
      presetId: string,
      presetTrackId: string,
      assetId: string,
      anchorIndex?: number,
    ): void => {
      if (!client) return;
      void run("map", async () => {
        const detail = await client.noise.presets.mapPresetTrack(
          presetId,
          presetTrackId,
          assetId,
          anchorIndex,
        );
        setSelected(detail);
        setLoadResult((previous) =>
          previous
            ? {
                ...previous,
                missing: previous.missing.filter(
                  (item) =>
                    item.presetTrackId !== presetTrackId ||
                    item.anchorIndex !== anchorIndex,
                ),
              }
            : null,
        );
        setNotice("缺失轨道已映射，请重新加载 Preset 使其进入 Session");
      });
    },
    [client, run],
  );

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle className="text-base">{m.noise_preset_title()}</CardTitle>
          <CardDescription>{m.noise_preset_description()}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex flex-wrap items-center gap-2">
            <input
              className="h-9 min-w-48 flex-1 rounded-md border border-line bg-paper px-3 text-sm"
              value={saveName}
              onChange={(event) => setSaveName(event.target.value)}
              placeholder="新 Preset 名称"
            />
            <Button
              type="button"
              disabled={busy !== "" || editorSaving || !saveName.trim()}
              onClick={savePreset}
            >
              {busy === "save" ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : (
                <Save className="mr-2 h-4 w-4" />
              )}
              保存当前混音
            </Button>
            <Button
              type="button"
              variant="outline"
              disabled={busy !== "" || editorSaving}
              onClick={importPreset}
            >
              <Upload className="mr-2 h-4 w-4" />
              导入 Preset
            </Button>
            <div className="ml-auto flex items-center gap-2 text-sm text-ink-soft">
              <Switch
                id={`${formId}-favorite-only`}
                checked={favoriteOnly}
                onCheckedChange={(checked) => {
                  setPage(1);
                  setFavoriteOnly(checked);
                }}
              />
              <Label htmlFor={`${formId}-favorite-only`}>只看收藏</Label>
            </div>
          </div>

          {error && <p className="text-sm text-red-600">{error}</p>}
          {notice && <p className="text-sm text-emerald-700">{notice}</p>}

          <div className="max-h-72 divide-y divide-line overflow-auto rounded-md border border-line">
            {presets.length === 0 ? (
              <p className="p-6 text-center text-sm text-ink-faint">
                还没有 Preset。
              </p>
            ) : (
              presets.map((preset) => (
                <div
                  key={preset.id}
                  className={`flex items-center gap-2 px-3 py-2 text-sm hover:bg-muted/40 ${
                    selected?.preset.id === preset.id ? "bg-muted/60" : ""
                  }`}
                >
                  <button
                    type="button"
                    disabled={busy !== "" || editorSaving}
                    aria-label={preset.favorite ? "取消收藏" : "收藏"}
                    onClick={(event) => {
                      event.stopPropagation();
                      toggleFavorite(preset);
                    }}
                  >
                    <Star
                      className={`h-4 w-4 ${
                        preset.favorite
                          ? "fill-amber-400 text-amber-500"
                          : "text-ink-faint"
                      }`}
                    />
                  </button>
                  {/* 选中整行：行内还有收藏按钮，所以只有名称区是真正的 button。 */}
                  <button
                    type="button"
                    className="min-w-0 flex-1 text-left"
                    disabled={busy !== "" || editorSaving}
                    aria-pressed={selected?.preset.id === preset.id}
                    onClick={() => selectPreset(preset.id)}
                  >
                    <span className="block truncate font-medium">
                      {preset.name}
                    </span>
                    <span className="block truncate text-xs text-ink-faint">
                      {sourceLabel(preset.sourceType)} · {preset.trackCount}{" "}
                      条轨道
                      {preset.author ? ` · ${preset.author}` : ""}
                    </span>
                  </button>
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    disabled={busy !== "" || editorSaving || editorDirty}
                    onClick={(event) => {
                      event.stopPropagation();
                      if (!editorDirty) loadPreset(preset.id);
                    }}
                  >
                    加载
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    disabled={busy !== "" || editorSaving || editorDirty}
                    onClick={(event) => {
                      event.stopPropagation();
                      if (!editorDirty) exportPreset(preset.id);
                    }}
                  >
                    <Download className="h-4 w-4" />
                  </Button>
                  {preset.sourceType !== "builtin" && (
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      className="text-red-600"
                      disabled={busy !== "" || editorSaving}
                      onClick={(event) => {
                        event.stopPropagation();
                        deletePreset(preset);
                      }}
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  )}
                </div>
              ))
            )}
          </div>
          <div className="flex items-center justify-between text-xs text-ink-soft">
            <span>共 {total} 个 Preset</span>
            <div className="flex items-center gap-2">
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={page <= 1}
                onClick={() => setPage((value) => Math.max(1, value - 1))}
              >
                上一页
              </Button>
              <span>
                {page}/{Math.max(1, Math.ceil(total / pageSize))}
              </span>
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={page >= Math.max(1, Math.ceil(total / pageSize))}
                onClick={() => setPage((value) => value + 1)}
              >
                下一页
              </Button>
            </div>
          </div>
        </CardContent>
      </Card>

      {selected && (
        <NoisePresetEditor
          key={selected.preset.id}
          client={client}
          detail={selected}
          busy={busy !== ""}
          onSaved={onSaved}
          onEditState={onEditState}
          registerGuard={registerGuard}
          onLoad={() => loadPreset(selected.preset.id)}
          onExport={() => exportPreset(selected.preset.id)}
          onDuplicate={duplicatePreset}
          renderMissing={(mappingDisabled) =>
            loadResult &&
            loadResult.missing.length > 0 && (
              <div className="space-y-2">
                <Label>缺失轨道映射</Label>
                {loadResult.missing.map((missing) => (
                  <div
                    key={`${missing.presetTrackId}:${missing.anchorIndex ?? "track"}`}
                    className="rounded-md border border-amber-300 p-2"
                  >
                    <p className="text-sm font-medium">
                      {missing.expectedName}
                    </p>
                    {missing.candidates.length === 0 ? (
                      <p className="text-xs text-ink-faint">
                        没有同名候选，请先导入对应素材。
                      </p>
                    ) : (
                      <div className="mt-1 flex flex-wrap gap-2">
                        {missing.candidates.map((candidate) => (
                          <Button
                            key={candidate.id}
                            type="button"
                            size="sm"
                            variant="outline"
                            disabled={mappingDisabled}
                            onClick={() =>
                              mapTrack(
                                selected.preset.id,
                                missing.presetTrackId,
                                candidate.id,
                                missing.anchorIndex,
                              )
                            }
                          >
                            映射到 {candidate.name}
                          </Button>
                        ))}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )
          }
        />
      )}
      {confirmDialog}
    </div>
  );
}
