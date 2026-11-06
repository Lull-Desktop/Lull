"use client";

/**
 * 设置窗壁纸页签里的「媒体壁纸」面板。
 *
 * 只在场景为 `lull.video` 时由 WallpaperPanel 渲染；配置写入走
 * `media_config_set` / `media_activate`，壁纸窗口通过 `media-config-changed` 热更。
 */
import { type ReactNode, useCallback, useEffect, useState } from "react";
import { MediaDiagnostics } from "@/components/settings/media-diagnostics";
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
import { Switch } from "@/components/ui/switch";
import {
  activateMediaAsset,
  getMediaConfig,
  getMediaStats,
  listMediaAssets,
  pickMediaAsset,
  removeMediaAsset,
  resyncMediaPlayback,
  setMediaConfig,
} from "@/core/media/media-api";
import { onMediaConfigChanged } from "@/core/media/media-events";
import { onMediaQuality } from "@/core/media/media-quality";
import type {
  HardwareDecode,
  MediaAsset,
  MediaConfig,
  MediaConfigView,
  MediaFit,
  MediaPlaybackQuality,
  MediaPosition,
  MediaShare,
  MediaStats,
} from "@/core/media/types";
import { useLocale } from "@/i18n/locale";
import { m } from "@/paraglide/messages";

function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function MediaPanel() {
  useLocale();
  const [view, setView] = useState<MediaConfigView | null>(null);
  const [assets, setAssets] = useState<MediaAsset[]>([]);
  const [stats, setStats] = useState<MediaStats | null>(null);
  const [quality, setQuality] = useState<
    ReadonlyMap<string, MediaPlaybackQuality>
  >(() => new Map());
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async (): Promise<void> => {
    const [config, list, mediaStats] = await Promise.all([
      getMediaConfig(),
      listMediaAssets(),
      getMediaStats(),
    ]);
    setView(config);
    setAssets(list);
    setStats(mediaStats);
  }, []);

  useEffect(() => {
    void refresh();
    return onMediaConfigChanged(() => {
      void refresh();
    });
  }, [refresh]);

  useEffect(
    () =>
      onMediaQuality((sample) => {
        setQuality((current) => {
          const next = new Map(current);
          next.set(sample.label, sample);
          return next;
        });
      }),
    [],
  );

  const update = useCallback(
    (patch: Partial<MediaConfig>): void => {
      if (!view) return;
      const next = { ...view.config, ...patch };
      setView({ ...view, config: next });
      setBusy(true);
      setMediaConfig(next)
        .then((updated) => {
          setView(updated);
          setError(null);
          return getMediaStats().then(setStats);
        })
        .catch((reason: unknown) => {
          setError(m.media_save_failed({ reason: reasonOf(reason) }));
        })
        .finally(() => setBusy(false));
    },
    [view],
  );

  const pick = useCallback((): void => {
    setBusy(true);
    pickMediaAsset()
      .then(async (asset) => {
        if (!asset) return;
        const updated = await activateMediaAsset(asset.id);
        setView(updated);
        setError(null);
        await refresh();
      })
      .catch((reason: unknown) => {
        setError(m.media_pick_failed({ reason: reasonOf(reason) }));
      })
      .finally(() => setBusy(false));
  }, [refresh]);

  const activate = useCallback((assetId: string): void => {
    if (!assetId) return;
    setBusy(true);
    activateMediaAsset(assetId)
      .then((updated) => {
        setView(updated);
        setError(null);
        return getMediaStats().then(setStats);
      })
      .catch((reason: unknown) => {
        setError(m.media_activate_failed({ reason: reasonOf(reason) }));
      })
      .finally(() => setBusy(false));
  }, []);

  const remove = useCallback((): void => {
    const assetId = view?.config.assetId;
    if (!assetId) return;
    setBusy(true);
    removeMediaAsset(assetId)
      .then(async () => {
        await refresh();
        setError(null);
      })
      .catch((reason: unknown) => {
        setError(m.media_remove_failed({ reason: reasonOf(reason) }));
      })
      .finally(() => setBusy(false));
  }, [refresh, view?.config.assetId]);

  const resync = useCallback((): void => {
    if (!view?.config.assetId) return;
    setBusy(true);
    setNotice(null);
    resyncMediaPlayback(0)
      .then(async () => {
        setError(null);
        setNotice(m.media_resync_done());
        await refresh();
      })
      .catch((reason: unknown) => {
        setError(m.media_resync_failed({ reason: reasonOf(reason) }));
      })
      .finally(() => setBusy(false));
  }, [refresh, view?.config.assetId]);

  if (!view) {
    return (
      <p className="text-xs text-muted-foreground">{m.media_not_running()}</p>
    );
  }

  const config = view.config;
  const selected = assets.find((asset) => asset.id === config.assetId);
  const isImage = selected?.kind === "image";
  const images = assets.filter((asset) => asset.kind === "image");
  const videos = assets.filter((asset) => asset.kind !== "image");
  // 能力探测只说明“可以尝试原生”，不代表当前 attach 成功；标签必须以实际
  // session/surface backend 为准，避免出现“原生纹理共享 + 原生 0/回退 1”。
  const session =
    stats?.sessionViews.find((item) => item.assetId === config.assetId) ??
    stats?.sessionViews[0];
  const hasNativeSurface =
    session?.surfaces.some((surface) => surface.backend === "native-texture") ??
    session?.backend === "native-texture";
  const hasHtmlSurface =
    session?.surfaces.some((surface) => surface.backend === "html-video") ??
    session?.backend === "html-video";
  const backendLabel = isImage
    ? m.media_backend_image()
    : hasNativeSurface && hasHtmlSurface
      ? m.media_backend_mixed()
      : hasNativeSurface
        ? m.media_backend_native()
        : hasHtmlSurface
          ? m.media_backend_html()
          : view.capabilities.nativeTextureStream
            ? m.media_backend_native()
            : m.media_backend_html();
  const backendReason = isImage
    ? null
    : (session?.lastError ?? view.capabilities.reason);

  const qualitySamples = [...quality.values()].filter(
    (sample) => sample.total > 0,
  );
  const qualityFrames = qualitySamples.reduce(
    (sum, sample) => sum + sample.total,
    0,
  );
  const qualityDropped = qualitySamples.reduce(
    (sum, sample) => sum + sample.dropped,
    0,
  );

  const assetOption = (asset: MediaAsset): ReactNode => (
    <SelectItem key={asset.id} value={asset.id}>
      {asset.name}
      {asset.available ? "" : " (!)"}
    </SelectItem>
  );

  return (
    <div className="space-y-3 border-t border-border/50 pt-4">
      <div>
        <p className="text-sm font-medium text-ink-soft">{m.media_title()}</p>
        <p className="mt-1 text-xs text-muted-foreground">
          {m.media_description()}
        </p>
      </div>

      <div className="space-y-2">
        <Label className="text-ink-soft">{m.media_asset()}</Label>
        <div className="flex items-center gap-2">
          <Select
            value={config.assetId ?? ""}
            onValueChange={activate}
            disabled={busy || assets.length === 0}
          >
            <SelectTrigger size="sm" className="min-w-0 flex-1">
              <SelectValue placeholder={m.media_asset_empty()} />
            </SelectTrigger>
            <SelectContent>
              {images.length > 0 ? (
                <SelectGroup>
                  <SelectLabel>{m.media_kind_image()}</SelectLabel>
                  {images.map(assetOption)}
                </SelectGroup>
              ) : null}
              {videos.length > 0 ? (
                <SelectGroup>
                  <SelectLabel>{m.media_kind_video()}</SelectLabel>
                  {videos.map(assetOption)}
                </SelectGroup>
              ) : null}
            </SelectContent>
          </Select>
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={busy}
            onClick={pick}
          >
            {m.media_asset_pick()}
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={busy || !config.assetId}
            onClick={remove}
          >
            {m.media_asset_remove()}
          </Button>
        </div>
        {selected && !selected.available ? (
          <p className="text-xs text-destructive">{m.media_asset_missing()}</p>
        ) : null}
      </div>

      {/*
        随素材类型增减的一整块（图片只有填充/对齐，视频还多循环、帧率、硬件解码、
        共享），再加诊断表格。滚动交给设置页（壁纸页签整页滚动），这里不再自带
        滚动条，避免嵌套滚动。
      */}
      <div className="space-y-3">
        <div className="grid gap-2 sm:grid-cols-2">
          {!isImage ? (
            <div className="flex items-center justify-between gap-3">
              <Label className="text-ink-soft">{m.media_loop()}</Label>
              <Switch
                checked={config.loop}
                disabled={busy}
                onCheckedChange={(loop) => update({ loop })}
              />
            </div>
          ) : null}
          <div className="flex items-center justify-between gap-3">
            <Label className="text-ink-soft">{m.media_fit()}</Label>
            <Select
              value={config.fit}
              onValueChange={(value) => update({ fit: value as MediaFit })}
              disabled={busy}
            >
              <SelectTrigger size="sm" className="w-32">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="cover">{m.media_fit_cover()}</SelectItem>
                <SelectItem value="contain">{m.media_fit_contain()}</SelectItem>
                <SelectItem value="fill">{m.media_fit_fill()}</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="flex items-center justify-between gap-3">
            <Label className="text-ink-soft">{m.media_position()}</Label>
            <Select
              value={config.position}
              onValueChange={(value) =>
                update({ position: value as MediaPosition })
              }
              disabled={busy}
            >
              <SelectTrigger size="sm" className="w-32">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="center">
                  {m.media_position_center()}
                </SelectItem>
                <SelectItem value="top">{m.media_position_top()}</SelectItem>
                <SelectItem value="bottom">
                  {m.media_position_bottom()}
                </SelectItem>
                <SelectItem value="left">{m.media_position_left()}</SelectItem>
                <SelectItem value="right">
                  {m.media_position_right()}
                </SelectItem>
              </SelectContent>
            </Select>
          </div>
          {!isImage ? (
            <div className="flex items-center justify-between gap-3">
              <Label className="text-ink-soft">{m.media_fps()}</Label>
              <Select
                value={String(config.preferredFps)}
                onValueChange={(value) =>
                  update({ preferredFps: Number(value) as 24 | 30 | 60 })
                }
                disabled={busy}
              >
                <SelectTrigger size="sm" className="w-32">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="24">24</SelectItem>
                  <SelectItem value="30">30</SelectItem>
                  <SelectItem value="60">60</SelectItem>
                </SelectContent>
              </Select>
            </div>
          ) : null}
          {!isImage ? (
            <div className="flex items-center justify-between gap-3">
              <Label className="text-ink-soft">{m.media_hardware()}</Label>
              <Select
                value={config.hardwareDecode}
                onValueChange={(value) =>
                  update({ hardwareDecode: value as HardwareDecode })
                }
                disabled={busy}
              >
                <SelectTrigger size="sm" className="w-32">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="auto">
                    {m.media_hardware_auto()}
                  </SelectItem>
                  <SelectItem value="required">
                    {m.media_hardware_required()}
                  </SelectItem>
                  <SelectItem value="disabled">
                    {m.media_hardware_disabled()}
                  </SelectItem>
                </SelectContent>
              </Select>
            </div>
          ) : null}
          {!isImage ? (
            <div className="flex items-center justify-between gap-3">
              <Label className="text-ink-soft">{m.media_share()}</Label>
              <Select
                value={config.share}
                onValueChange={(value) =>
                  update({ share: value as MediaShare })
                }
                disabled={busy}
              >
                <SelectTrigger size="sm" className="w-32">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="auto">{m.media_share_auto()}</SelectItem>
                  <SelectItem value="shared">
                    {m.media_share_shared()}
                  </SelectItem>
                  <SelectItem value="independent">
                    {m.media_share_independent()}
                  </SelectItem>
                </SelectContent>
              </Select>
            </div>
          ) : null}
        </div>

        <p className="text-xs text-muted-foreground">
          {backendLabel}
          {backendReason
            ? ` · ${m.media_fallback_reason({ reason: backendReason })}`
            : ""}
        </p>
        {error ? <p className="text-xs text-destructive">{error}</p> : null}
        {qualitySamples.length > 0 ? (
          <p className="text-xs text-muted-foreground">
            {m.media_quality({
              dropped: qualityDropped,
              total: qualityFrames,
              screens: qualitySamples.length,
            })}
          </p>
        ) : null}
        <div className="flex items-center justify-between gap-3 border-t border-border/60 pt-3">
          <div>
            <p className="text-sm font-medium text-ink-soft">
              {m.media_resync()}
            </p>
            <p className="mt-1 text-xs text-muted-foreground">
              {m.media_resync_hint()}
            </p>
          </div>
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={busy || isImage || !config.assetId}
            onClick={resync}
          >
            {m.media_resync()}
          </Button>
        </div>
        {notice ? (
          <p className="text-xs text-muted-foreground">{notice}</p>
        ) : null}
        <MediaDiagnostics stats={stats} />
      </div>
    </div>
  );
}
