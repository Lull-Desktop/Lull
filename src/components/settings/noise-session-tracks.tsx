// biome-ignore-all lint/correctness/noUndeclaredDependencies: workspace package is resolved by the app build.
/**
 * 当前白噪音混音的音轨列表（Session/Track API）。
 *
 * 逐轨：音量、启用、loop、上移/下移、移除。加素材统一走白噪音库窗口
 * 素材行的「添加到音轨」，这里不再提供添加入口。
 *
 * 媒体连接由所在窗口统一建立（设置窗根节点 / 白噪音库窗口根节点），
 * 本组件只订阅 `noise.session.changed` 与调用 API，不 connect/disconnect。
 */
"use client";

import type {
  LullMediaClient,
  NoiseSession,
  NoiseTrack,
} from "@lull/media-sdk";
import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Slider } from "@/components/ui/slider";
import { Switch } from "@/components/ui/switch";
import { useLocale } from "@/i18n/locale";
import { m } from "@/paraglide/messages";

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function trackLabel(track: NoiseTrack): string {
  return track.name || track.assetId || track.id;
}

/** 轨道状态文案与配色；未知状态按停止处理。 */
function statePresentation(state: string): {
  label: string;
  className: string;
} {
  if (state === "playing") {
    return {
      label: m.noise_track_state_playing(),
      className: "bg-emerald-500/15 text-emerald-700",
    };
  }
  if (state === "paused") {
    return {
      label: m.noise_track_state_paused(),
      className: "bg-amber-500/15 text-amber-700",
    };
  }
  return {
    label: m.noise_track_state_stopped(),
    className: "bg-muted text-muted-foreground",
  };
}

export function NoiseSessionTracks({
  client,
}: {
  /** 由所在窗口的媒体连接提供；为 null 时只渲染空态。 */
  client: LullMediaClient | null;
}) {
  useLocale();
  const [session, setSession] = useState<NoiseSession | null>(null);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const mounted = useRef(false);

  // 初始拉一次当前 session；之后靠事件同步。
  useEffect(() => {
    mounted.current = true;
    if (!client) {
      return () => {
        mounted.current = false;
      };
    }
    void client.noise.session
      .getCurrent()
      .then((next) => {
        if (mounted.current) setSession(next);
      })
      .catch((reason: unknown) => {
        if (mounted.current) setError(errorText(reason));
      });
    return () => {
      mounted.current = false;
    };
  }, [client]);

  // 音轨增删改（含应用预设时的整体替换）后端都会发 noise.session.changed。
  useEffect(() => {
    if (!client) return;
    const stop = client.events.on((event) => {
      if (event.topic === "noise.session.changed") {
        setSession(event.payload as NoiseSession);
      }
    });
    return () => stop();
  }, [client]);

  const run = useCallback(
    async (label: string, action: () => Promise<unknown>): Promise<void> => {
      if (!client) return;
      setBusy(label);
      setError("");
      try {
        await action();
      } catch (reason) {
        if (mounted.current) setError(errorText(reason));
      } finally {
        if (mounted.current) setBusy("");
      }
    },
    [client],
  );

  const tracks = session?.tracks ?? [];

  return (
    <section
      className="flex min-h-0 flex-1 flex-col gap-2"
      data-testid="noise-session-tracks"
    >
      <div className="flex shrink-0 items-center justify-between">
        <h3 className="text-sm font-semibold">
          {m.settings_noise_tracks_title()}
        </h3>
        <span className="text-xs text-muted-foreground">
          {m.settings_noise_tracks_count({ count: tracks.length })}
        </span>
      </div>

      {error && (
        <p role="alert" className="shrink-0 text-xs text-destructive">
          {error}
        </p>
      )}

      <div className="min-h-0 flex-1 space-y-2 overflow-y-auto">
        {tracks.length === 0 ? (
          <p className="rounded-lg border border-dashed border-border px-3 py-4 text-center text-xs text-muted-foreground">
            {m.noise_track_empty()}
          </p>
        ) : (
          tracks.map((track, index) => {
            const label = trackLabel(track);
            const state = statePresentation(track.state);
            return (
              <div
                key={track.id}
                className="grid gap-2 rounded-lg border border-border/60 p-2 md:grid-cols-[minmax(0,1.2fr)_minmax(9rem,1fr)_auto]"
              >
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="truncate text-sm font-medium">
                      {index + 1}. {label}
                    </span>
                    <span
                      className={`shrink-0 rounded-full px-1.5 py-0.5 text-[10px] ${state.className}`}
                    >
                      {state.label}
                    </span>
                  </div>
                  {track.error && (
                    <p className="text-xs text-destructive">
                      {track.error.code}: {track.error.message}
                    </p>
                  )}
                </div>

                <div className="space-y-1">
                  <div className="flex items-center justify-between text-xs">
                    <span>{m.noise_track_volume()}</span>
                    <span>{Math.round(track.volume * 100)}%</span>
                  </div>
                  <Slider
                    min={0}
                    max={100}
                    step={1}
                    defaultValue={[Math.round(track.volume * 100)]}
                    key={`${track.id}:${track.volume.toFixed(3)}`}
                    thumbLabel={m.noise_track_volume_aria({ name: label })}
                    onValueCommit={([value]) => {
                      if (!client) return;
                      void run(`noise.tracks.setVolume ${label}`, () =>
                        client.noise.tracks.setVolume(
                          track.id,
                          (value ?? 0) / 100,
                        ),
                      );
                    }}
                  />
                </div>

                <div className="flex flex-wrap items-center justify-end gap-2">
                  <div className="flex items-center gap-1 text-xs">
                    <Switch
                      aria-label={m.noise_track_enabled_aria({ name: label })}
                      checked={track.enabled}
                      onCheckedChange={(next) => {
                        if (!client) return;
                        void run(
                          `noise.tracks.setEnabled ${label} ${String(next)}`,
                          () => client.noise.tracks.setEnabled(track.id, next),
                        );
                      }}
                    />
                    {m.noise_track_enabled()}
                  </div>
                  <div className="flex items-center gap-1 text-xs">
                    <Switch
                      aria-label={m.noise_track_loop_aria({ name: label })}
                      checked={track.loop}
                      onCheckedChange={(next) => {
                        if (!client) return;
                        void run(
                          `noise.tracks.setLoop ${label} ${String(next)}`,
                          () => client.noise.tracks.setLoop(track.id, next),
                        );
                      }}
                    />
                    {m.noise_track_loop()}
                  </div>
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    disabled={index === 0 || busy !== ""}
                    onClick={() => {
                      if (!client) return;
                      void run(`noise.tracks.reorder ${label} ↑`, () =>
                        client.noise.tracks.reorder(track.id, index - 1),
                      );
                    }}
                  >
                    {m.noise_track_move_up()}
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    disabled={index === tracks.length - 1 || busy !== ""}
                    onClick={() => {
                      if (!client) return;
                      void run(`noise.tracks.reorder ${label} ↓`, () =>
                        client.noise.tracks.reorder(track.id, index + 1),
                      );
                    }}
                  >
                    {m.noise_track_move_down()}
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    disabled={busy !== ""}
                    onClick={() => {
                      if (!client) return;
                      void run(`noise.tracks.remove ${label}`, () =>
                        client.noise.tracks.remove(track.id),
                      );
                    }}
                  >
                    {m.noise_track_remove()}
                  </Button>
                </div>
              </div>
            );
          })
        )}
      </div>
    </section>
  );
}
