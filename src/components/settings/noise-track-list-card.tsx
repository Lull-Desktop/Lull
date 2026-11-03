/**
 * 白噪音音轨管理卡片（Session/Track API）。
 *
 * 从 NoiseApiTestPanel 拆出的音轨 CRUD 卡片：添加内置声景或按 Asset ID
 * 添加音轨，每轨可调音量/启用/loop/顺序/移除。本卡片自管 session 状态：
 * 初始从 `session.getCurrent()` 取，之后靠 `noise.session.changed` 事件
 * 实时同步。媒体连接由白噪音库窗口统一建立，本卡片不 connect/disconnect。
 */
"use client";

import type {
  LullMediaClient,
  NoiseSession,
  NoiseSound,
  NoiseTrack,
} from "@lull/media-sdk";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Label } from "@/components/ui/label";
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

function stateClass(state: string): string {
  if (state === "playing") return "bg-emerald-500/15 text-emerald-700";
  if (state === "paused") return "bg-amber-500/15 text-amber-700";
  return "bg-muted text-muted-foreground";
}

export function NoiseTrackListCard({
  client,
}: {
  /** 由白噪音库窗口传入；连接所有权在窗口。 */
  client: LullMediaClient | null;
}) {
  useLocale();
  const panelId = useId();
  const [session, setSession] = useState<NoiseSession | null>(null);
  const [sounds, setSounds] = useState<NoiseSound[]>([]);
  const [selectedSound, setSelectedSound] = useState("");
  const [assetId, setAssetId] = useState("noise:builtin:rain");
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const mounted = useRef(false);

  const soundId = `${panelId}-sound`;
  const assetInputId = `${panelId}-asset`;

  // 初始加载 session 与内置声景列表。
  useEffect(() => {
    mounted.current = true;
    if (!client) {
      return () => {
        mounted.current = false;
      };
    }
    void Promise.all([
      client.noise.session.getCurrent(),
      client.noise.getSounds(),
    ])
      .then(([nextSession, nextSounds]) => {
        if (!mounted.current) return;
        setSession(nextSession);
        setSounds(nextSounds);
      })
      .catch((reason: unknown) => {
        if (mounted.current) setError(errorText(reason));
      });
    return () => {
      mounted.current = false;
    };
  }, [client]);

  // 订阅 session 变化：音轨增删/改后后端发 noise.session.changed，自动同步。
  useEffect(() => {
    if (!client) return;
    const stop = client.events.on((event) => {
      if (event.topic === "noise.session.changed") {
        setSession(event.payload as NoiseSession);
      }
    });
    return () => stop();
  }, [client]);

  useEffect(() => {
    if (!selectedSound && sounds[0]) setSelectedSound(sounds[0].id);
  }, [selectedSound, sounds]);

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

  const addSelectedSound = useCallback((): void => {
    if (!client || !selectedSound) return;
    void run(`noise.tracks.add ${selectedSound}`, () =>
      client.noise.tracks.add(selectedSound),
    );
  }, [client, run, selectedSound]);

  const addAssetById = useCallback((): void => {
    const id = assetId.trim();
    if (!client || !id) return;
    void run(`noise.tracks.add ${id}`, () => client.noise.tracks.add(id));
  }, [assetId, client, run]);

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base">{m.noise_card_tracks()}</CardTitle>
        <CardDescription>
          add 支持内置 profile 或 Asset ID；每轨音量/开关/loop/顺序/移除都走新
          API。
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4 text-sm">
        {error && <p className="text-sm text-destructive">{error}</p>}
        <div className="flex flex-wrap items-end gap-2">
          <div className="space-y-1">
            <Label htmlFor={soundId}>内置声景</Label>
            <select
              id={soundId}
              value={selectedSound}
              onChange={(event) => setSelectedSound(event.target.value)}
              className="w-48 rounded-md border border-border bg-background px-2 py-1.5 text-sm"
            >
              {sounds.map((sound) => (
                <option key={sound.id} value={sound.id}>
                  {sound.name} · {sound.id}
                </option>
              ))}
            </select>
          </div>
          <Button
            type="button"
            size="sm"
            onClick={addSelectedSound}
            disabled={!client || !selectedSound || busy !== ""}
          >
            添加声景
          </Button>
          <div className="space-y-1">
            <Label htmlFor={assetInputId}>Asset ID</Label>
            <input
              id={assetInputId}
              value={assetId}
              onChange={(event) => setAssetId(event.target.value)}
              className="w-64 rounded-md border border-border bg-background px-2 py-1.5 font-mono text-xs"
            />
          </div>
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={!client || busy !== ""}
            onClick={addAssetById}
          >
            按 Asset ID 添加
          </Button>
        </div>

        <div className="space-y-2">
          {(session?.tracks ?? []).map((track, index) => (
            <div
              key={track.id}
              className="grid gap-3 rounded-lg border border-border/60 p-3 md:grid-cols-[minmax(0,1.2fr)_minmax(10rem,1fr)_auto]"
            >
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <span className="truncate font-medium">
                    {index + 1}. {trackLabel(track)}
                  </span>
                  <span
                    className={`rounded-full px-1.5 py-0.5 text-[10px] ${stateClass(track.state)}`}
                  >
                    {track.state}
                  </span>
                </div>
                <p className="truncate font-mono text-[10px] text-muted-foreground">
                  {track.id} · {track.assetId}
                </p>
                {track.error && (
                  <p className="text-xs text-destructive">
                    {track.error.code}: {track.error.message}
                  </p>
                )}
              </div>
              <div className="space-y-1">
                <div className="flex items-center justify-between text-xs">
                  <span>音量</span>
                  <span>{Math.round(track.volume * 100)}%</span>
                </div>
                <Slider
                  min={0}
                  max={100}
                  step={1}
                  defaultValue={[Math.round(track.volume * 100)]}
                  key={`${track.id}:${track.volume.toFixed(3)}`}
                  thumbLabel={`${trackLabel(track)} volume`}
                  onValueCommit={([value]) => {
                    if (!client) return;
                    void run(
                      `noise.tracks.setVolume ${trackLabel(track)}`,
                      () =>
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
                    aria-label={`${trackLabel(track)} enabled`}
                    checked={track.enabled}
                    onCheckedChange={(next) => {
                      if (!client) return;
                      void run(
                        `noise.tracks.setEnabled ${trackLabel(track)} ${String(next)}`,
                        () => client.noise.tracks.setEnabled(track.id, next),
                      );
                    }}
                  />
                  启用
                </div>
                <div className="flex items-center gap-1 text-xs">
                  <Switch
                    aria-label={`${trackLabel(track)} loop`}
                    checked={track.loop}
                    onCheckedChange={(next) => {
                      if (!client) return;
                      void run(
                        `noise.tracks.setLoop ${trackLabel(track)} ${String(next)}`,
                        () => client.noise.tracks.setLoop(track.id, next),
                      );
                    }}
                  />
                  loop
                </div>
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  disabled={index === 0 || busy !== ""}
                  onClick={() => {
                    if (!client) return;
                    void run(
                      `noise.tracks.reorder ${trackLabel(track)} ↑`,
                      () => client.noise.tracks.reorder(track.id, index - 1),
                    );
                  }}
                >
                  上移
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  disabled={
                    index === (session?.tracks.length ?? 0) - 1 || busy !== ""
                  }
                  onClick={() => {
                    if (!client) return;
                    void run(
                      `noise.tracks.reorder ${trackLabel(track)} ↓`,
                      () => client.noise.tracks.reorder(track.id, index + 1),
                    );
                  }}
                >
                  下移
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  disabled={busy !== ""}
                  onClick={() => {
                    if (!client) return;
                    void run(`noise.tracks.remove ${trackLabel(track)}`, () =>
                      client.noise.tracks.remove(track.id),
                    );
                  }}
                >
                  移除
                </Button>
              </div>
            </div>
          ))}
          {(session?.tracks.length ?? 0) === 0 && (
            <p className="rounded-lg border border-dashed border-border px-3 py-6 text-center text-xs text-muted-foreground">
              当前 Session 没有音轨。添加内置声景或按 Asset ID 添加。
            </p>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
