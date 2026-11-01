/**
 * 白噪音 API 手工验收面板。
 *
 * 这是开发调试组件，不是正式 Mixer：它同时驱动 N2 的
 * `noise.session.* / noise.tracks.*` 与旧 5 层 `noise.*` 兼容门面，
 * 并展示 snapshot、事件与实时 level，方便确认两套 API 是否指向同一个
 * 运行时 Session。
 */
"use client";

import type {
  LullMediaClient,
  MediaOutput,
  NoiseSession,
  NoiseSound,
  NoiseState,
  NoiseTrack,
  PlaybackSnapshot,
} from "@lull/media-sdk";
import { Wind } from "lucide-react";
import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
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
import { getMediaClient } from "@/hooks/use-media-client";

type LogEntry = {
  id: number;
  at: number;
  label: string;
  data: unknown;
};

const SUBSCRIBED_TOPICS = [
  "noise.state",
  "noise.session.changed",
  "noise.session.state-changed",
  "noise.track.added",
  "noise.track.removed",
  "noise.track.updated",
  "noise.track.state-changed",
  "noise.volume.changed",
  "noise.level",
  "output.changed",
];

const SLEEP_OPTIONS = [0, 1, 5, 15, 30, 60];

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function json(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function trackLabel(track: NoiseTrack): string {
  return track.name || track.assetId || track.id;
}

function stateClass(state: string): string {
  if (state === "playing") return "bg-emerald-500/15 text-emerald-700";
  if (state === "paused") return "bg-amber-500/15 text-amber-700";
  return "bg-muted text-muted-foreground";
}

export function NoiseApiTestPanel() {
  const panelId = useId();
  const [client, setClient] = useState<LullMediaClient | null>(null);
  const [session, setSession] = useState<NoiseSession | null>(null);
  const [legacy, setLegacy] = useState<NoiseState | null>(null);
  const [sounds, setSounds] = useState<NoiseSound[]>([]);
  const [output, setOutput] = useState<MediaOutput | null>(null);
  const [snapshot, setSnapshot] = useState<PlaybackSnapshot | null>(null);
  const [selectedSound, setSelectedSound] = useState("");
  const [assetId, setAssetId] = useState("noise:builtin:rain");
  const [sleepMinutes, setSleepMinutes] = useState(0);
  const [master, setMaster] = useState(75);
  const [muted, setMuted] = useState(false);
  const [level, setLevel] = useState(0);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [log, setLog] = useState<LogEntry[]>([]);
  const logSeq = useRef(0);
  const draggingMaster = useRef(false);
  const mounted = useRef(false);

  const push = useCallback((label: string, data: unknown): void => {
    const id = logSeq.current + 1;
    logSeq.current = id;
    setLog((previous) =>
      [{ id, at: Date.now(), label, data }, ...previous].slice(0, 80),
    );
  }, []);

  const applySession = useCallback((next: NoiseSession): void => {
    setSession(next);
    if (!draggingMaster.current) {
      setMaster(Math.round(next.masterVolume * 100));
    }
    setMuted(next.muted);
    setSleepMinutes(next.sleep.timerMinutes);
  }, []);

  const applySnapshot = useCallback(
    (next: PlaybackSnapshot): void => {
      setSnapshot(next);
      applySession(next.noiseSession);
      setLegacy(next.noise);
      setOutput(next.output);
    },
    [applySession],
  );

  const refresh = useCallback(async (): Promise<void> => {
    if (!client) return;
    const [nextSession, nextLegacy, nextOutput, nextSounds] = await Promise.all(
      [
        client.noise.session.getCurrent(),
        client.noise.getState(),
        client.system.getOutput(),
        client.noise.getSounds(),
      ],
    );
    if (!mounted.current) return;
    applySession(nextSession);
    setLegacy(nextLegacy);
    setOutput(nextOutput);
    setSounds(nextSounds);
  }, [applySession, client]);

  useEffect(() => {
    mounted.current = true;
    const media = getMediaClient();
    if (!media) {
      setError("Media client 尚未初始化");
      return () => {
        mounted.current = false;
      };
    }
    setClient(media);
    const stop = media.events.on((event) => {
      if (event.topic === "noise.level") {
        const payload = event.payload as { noise?: number };
        setLevel(payload.noise ?? 0);
        return;
      }
      push(`event ${event.topic}`, {
        revision: event.revision,
        eventId: event.eventId,
        payload: event.payload,
      });
      if (event.topic === "noise.state") {
        setLegacy(event.payload as NoiseState);
      } else if (event.topic === "noise.session.changed") {
        applySession(event.payload as NoiseSession);
      } else if (event.topic === "output.changed") {
        setOutput(event.payload as MediaOutput);
      }
    });
    void media
      .connect({ topics: SUBSCRIBED_TOPICS, levels: true })
      .then((next) => {
        if (mounted.current) applySnapshot(next);
      })
      .catch((reason: unknown) => {
        if (mounted.current) setError(errorText(reason));
      });
    return () => {
      mounted.current = false;
      stop();
      void media.disconnect();
    };
  }, [applySession, applySnapshot, push]);

  useEffect(() => {
    if (client) {
      void refresh().catch((reason: unknown) => {
        if (mounted.current) setError(errorText(reason));
      });
    }
  }, [client, refresh]);

  useEffect(() => {
    if (!selectedSound && sounds[0]) setSelectedSound(sounds[0].id);
  }, [selectedSound, sounds]);

  const run = useCallback(
    async (
      label: string,
      action: () => Promise<unknown>,
      refreshAfter = true,
    ): Promise<void> => {
      if (!client) return;
      setBusy(label);
      setError("");
      try {
        const result = await action();
        push(label, result ?? { ok: true });
        if (refreshAfter) await refresh();
      } catch (reason) {
        const message = errorText(reason);
        setError(message);
        push(`${label} ❌`, { error: message });
        try {
          await refresh();
        } catch {
          // 原始错误优先，刷新失败不覆盖。
        }
      } finally {
        if (mounted.current) setBusy("");
      }
    },
    [client, push, refresh],
  );

  const reconnect = useCallback((): void => {
    if (!client) return;
    void run(
      "media_connect",
      () =>
        client
          .connect({ topics: SUBSCRIBED_TOPICS, levels: true })
          .then((next) => {
            applySnapshot(next);
            return {
              revision: next.revision,
              noiseRevision: next.noise.revision,
              sessionRevision: next.noiseSession.revision,
            };
          }),
      false,
    );
  }, [applySnapshot, client, run]);

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

  const setSessionMaster = useCallback(
    (value: number): void => {
      if (!client) return;
      void run(
        `noise.session.setMasterVolume ${(value / 100).toFixed(2)}`,
        () => client.noise.session.setMasterVolume(value / 100),
        false,
      );
    },
    [client, run],
  );

  const setSessionMuted = useCallback(
    (next: boolean): void => {
      if (!client) return;
      setMuted(next);
      void run(
        `noise.session.setMuted ${String(next)}`,
        () => client.noise.session.setMuted(next),
        false,
      );
    },
    [client, run],
  );

  const applySleep = useCallback((): void => {
    if (!client) return;
    void run(
      `noise.session.setSleepTimer ${sleepMinutes}`,
      () => client.noise.session.setSleepTimer(sleepMinutes),
      false,
    );
  }, [client, run, sleepMinutes]);

  const restoreSound = useCallback((): void => {
    if (!client) return;
    void run("恢复声音", async () => {
      if (session?.muted) {
        await client.noise.session.setMuted(false);
      }
      if (session && session.state !== "playing") {
        await client.noise.session.play();
      }
      return { muted: false, state: "playing" };
    });
  }, [client, run, session]);

  const legacyLayer = useCallback(
    (soundId: string) =>
      legacy?.layers.find((layer) => layer.soundId === soundId) ?? null,
    [legacy],
  );

  const summary = useMemo(() => {
    if (!session) return "未连接";
    return `${session.state} · ${session.tracks.length} tracks · rev ${session.revision}`;
  }, [session]);

  const masterId = `${panelId}-master`;
  const mutedId = `${panelId}-muted`;
  const sleepId = `${panelId}-sleep`;
  const soundId = `${panelId}-sound`;
  const assetInputId = `${panelId}-asset`;

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Card className="lg:col-span-2">
        <CardHeader className="flex-row items-start justify-between gap-3">
          <div>
            <CardTitle className="flex items-center gap-2 text-base">
              <Wind className="h-5 w-5 text-bamboo" aria-hidden="true" />
              白噪音 API 调试
            </CardTitle>
            <CardDescription>
              驱动 N2 Session/Track 与旧 5 层兼容 API，并检查
              snapshot、事件和实时电平。
            </CardDescription>
          </div>
          <div className="flex flex-wrap justify-end gap-2">
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => {
                void refresh().catch((reason: unknown) =>
                  setError(errorText(reason)),
                );
              }}
            >
              刷新
            </Button>
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={reconnect}
            >
              重连并取快照
            </Button>
          </div>
        </CardHeader>
        <CardContent className="flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
          <span
            className={`rounded-full px-2 py-0.5 ${stateClass(session?.state ?? "idle")}`}
          >
            {session
              ? `${session.state}${session.muted ? " · muted" : ""}`
              : "no session"}
          </span>
          <span>{summary}</span>
          <span>
            legacy active: {legacy?.active ? "true" : "false"} · rev{" "}
            {legacy?.revision ?? "—"}
          </span>
          <span>
            output:{" "}
            {output
              ? `${output.volume.toFixed(2)}${output.muted ? " / muted" : ""}`
              : "—"}
          </span>
          <span className="flex items-center gap-2">
            level
            <span className="h-1.5 w-24 overflow-hidden rounded-full bg-muted">
              <span
                className="block h-full bg-bamboo transition-[width]"
                style={{ width: `${Math.min(100, Math.max(0, level * 100))}%` }}
              />
            </span>
            {(level * 100).toFixed(0)}%
          </span>
          {busy && <span>执行中：{busy}</span>}
        </CardContent>
      </Card>

      {error && (
        <div className="rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive lg:col-span-2">
          错误：{error}
        </div>
      )}

      {session?.muted && (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-sm text-amber-800 lg:col-span-2">
          <span>
            当前 Session 已静音。睡眠定时到点会暂停 Session；若原本 muted 为
            true，解除静音后才能恢复声音。
          </span>
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={restoreSound}
          >
            解除静音并播放
          </Button>
        </div>
      )}

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Session 控制</CardTitle>
          <CardDescription>
            create 会清空音轨；空 Session 上 play 应返回 noise.session.empty。
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3 text-sm">
          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => {
                if (!client) return;
                void run("noise.session.create", () =>
                  client.noise.session.create(),
                );
              }}
            >
              新建
            </Button>
            <Button
              type="button"
              size="sm"
              onClick={() => {
                if (!client) return;
                void run("noise.session.play", () =>
                  client.noise.session.play(),
                );
              }}
            >
              播放
            </Button>
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => {
                if (!client) return;
                void run("noise.session.pause", () =>
                  client.noise.session.pause(),
                );
              }}
            >
              暂停
            </Button>
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => {
                if (!client) return;
                void run("noise.session.stop", () =>
                  client.noise.session.stop(),
                );
              }}
            >
              停止
            </Button>
          </div>
          <div className="grid gap-2 rounded-lg bg-muted/40 p-3 text-xs">
            <span>id: {session?.id ?? "—"}</span>
            <span>state: {session?.state ?? "—"}</span>
            <span>
              sleep: {session?.sleep.timerMinutes ?? 0} min
              {session?.sleep.endsAt
                ? ` · ends ${new Date(session.sleep.endsAt).toLocaleTimeString()}`
                : ""}
            </span>
            <span>
              revision: session {session?.revision ?? "—"} / legacy{" "}
              {legacy?.revision ?? "—"}
            </span>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">主音量与睡眠</CardTitle>
          <CardDescription>
            睡眠到点会暂停 Session（保留 muted 偏好），可用播放恢复。
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4 text-sm">
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <Label htmlFor={masterId}>Session master</Label>
              <span className="text-xs text-muted-foreground">
                {master}% · legacy {(legacy?.master ?? 0).toFixed(2)}
              </span>
            </div>
            <Slider
              id={masterId}
              min={0}
              max={100}
              step={1}
              value={[master]}
              thumbLabel="Session master volume"
              onValueChange={([value]) => {
                draggingMaster.current = true;
                setMaster(value ?? 0);
              }}
              onValueCommit={([value]) => {
                draggingMaster.current = false;
                setSessionMaster(value ?? 0);
              }}
            />
          </div>
          <div className="flex items-center justify-between gap-3">
            <div>
              <Label htmlFor={mutedId}>Muted</Label>
              <p className="text-xs text-muted-foreground">
                睡眠到点会暂停 Session；muted 保持原值。
              </p>
            </div>
            <Switch
              id={mutedId}
              checked={muted}
              onCheckedChange={setSessionMuted}
            />
          </div>
          <div className="flex items-end gap-2">
            <div className="space-y-1">
              <Label htmlFor={sleepId}>睡眠定时（分钟）</Label>
              <select
                id={sleepId}
                value={sleepMinutes}
                onChange={(event) =>
                  setSleepMinutes(Number(event.target.value))
                }
                className="w-36 rounded-md border border-border bg-background px-2 py-1.5 text-sm"
              >
                {SLEEP_OPTIONS.map((minutes) => (
                  <option key={minutes} value={minutes}>
                    {minutes === 0 ? "关闭" : `${minutes} 分钟`}
                  </option>
                ))}
              </select>
            </div>
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={applySleep}
            >
              应用
            </Button>
          </div>
        </CardContent>
      </Card>

      <Card className="lg:col-span-2">
        <CardHeader className="pb-3">
          <CardTitle className="text-base">音轨（Session/Track API）</CardTitle>
          <CardDescription>
            add 支持内置 profile 或 Asset ID；每轨音量/开关/loop/顺序/移除都走新
            API。
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4 text-sm">
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
              disabled={!selectedSound}
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
                        false,
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
                          false,
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
                          false,
                        );
                      }}
                    />
                    loop
                  </div>
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    disabled={index === 0}
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
                    disabled={index === (session?.tracks.length ?? 0) - 1}
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

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">旧 5 层兼容 API</CardTitle>
          <CardDescription>
            noise.* 应映射到同一个 Session；这里修改后新 API 的音轨也会变化。
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3 text-sm">
          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => {
                if (!client) return;
                void run(
                  "noise.getState",
                  async () => {
                    const state = await client.noise.getState();
                    setLegacy(state);
                    return state;
                  },
                  false,
                );
              }}
            >
              getState
            </Button>
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => {
                if (!client) return;
                void run(
                  "noise.getSounds",
                  async () => {
                    const list = await client.noise.getSounds();
                    setSounds(list);
                    return list;
                  },
                  false,
                );
              }}
            >
              getSounds
            </Button>
            <Button
              type="button"
              size="sm"
              onClick={() => {
                if (!client) return;
                void run("noise.activate", () => client.noise.activate());
              }}
            >
              activate
            </Button>
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => {
                if (!client) return;
                void run("noise.reset", () => client.noise.reset());
              }}
            >
              reset
            </Button>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              onClick={() => {
                if (!client) return;
                void run("noise.setMaster 0.5", () =>
                  client.noise.setMaster(0.5),
                );
              }}
            >
              setMaster 0.5
            </Button>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              onClick={() => {
                if (!client) return;
                const next = !(legacy?.muted ?? false);
                void run(`noise.setMuted ${String(next)}`, () =>
                  client.noise.setMuted(next),
                );
              }}
            >
              切换 muted
            </Button>
          </div>

          <div className="space-y-2">
            {sounds.map((sound) => {
              const layer = legacyLayer(sound.id);
              return (
                <div
                  key={sound.id}
                  className="grid grid-cols-[minmax(5rem,1fr)_minmax(8rem,1.5fr)_auto] items-center gap-2"
                >
                  <span className="truncate text-xs">
                    {sound.name}
                    <span className="ml-1 font-mono text-[10px] text-muted-foreground">
                      {sound.id}
                    </span>
                  </span>
                  <Slider
                    min={0}
                    max={100}
                    step={1}
                    defaultValue={[Math.round((layer?.volume ?? 0) * 100)]}
                    key={`${sound.id}:${(layer?.volume ?? 0).toFixed(3)}`}
                    thumbLabel={`${sound.name} legacy volume`}
                    onValueCommit={([value]) => {
                      if (!client) return;
                      void run(
                        `noise.setLayer ${sound.id} volume`,
                        () =>
                          client.noise.setLayer(sound.id, {
                            volume: (value ?? 0) / 100,
                          }),
                        false,
                      );
                    }}
                  />
                  <div className="flex items-center gap-1 text-xs">
                    <Switch
                      aria-label={`${sound.name} legacy enabled`}
                      checked={layer?.enabled ?? false}
                      onCheckedChange={(next) => {
                        if (!client) return;
                        void run(
                          `noise.setLayer ${sound.id} enabled ${String(next)}`,
                          () =>
                            client.noise.setLayer(sound.id, { enabled: next }),
                          false,
                        );
                      }}
                    />
                    启用
                  </div>
                </div>
              );
            })}
            {sounds.length === 0 && (
              <p className="text-xs text-muted-foreground">
                尚未读取到 sounds；先点击 getSounds。
              </p>
            )}
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Snapshot / 原始状态</CardTitle>
          <CardDescription>
            顶层 revision 是各 domain 最大值；这里分别显示
            player/noise/session。
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-2 text-xs">
          {snapshot ? (
            <div className="grid grid-cols-2 gap-1 rounded-lg bg-muted/40 p-3">
              <span>top revision</span>
              <span className="font-mono">{snapshot.revision}</span>
              <span>player status</span>
              <span className="font-mono">{snapshot.player.status}</span>
              <span>noise revision</span>
              <span className="font-mono">{snapshot.noise.revision}</span>
              <span>session revision</span>
              <span className="font-mono">
                {snapshot.noiseSession.revision}
              </span>
              <span>session state</span>
              <span className="font-mono">{snapshot.noiseSession.state}</span>
              <span>output</span>
              <span className="font-mono">
                {snapshot.output.volume.toFixed(2)}
                {snapshot.output.muted ? " / muted" : ""}
              </span>
            </div>
          ) : (
            <p className="text-muted-foreground">尚未取得 snapshot。</p>
          )}
          <details className="rounded-lg border border-border/60 p-2">
            <summary className="cursor-pointer text-muted-foreground">
              展开 raw JSON
            </summary>
            <pre className="mt-2 max-h-72 overflow-auto whitespace-pre-wrap break-all font-mono text-[10px]">
              {snapshot ? json(snapshot) : "—"}
            </pre>
          </details>
          <details className="rounded-lg border border-border/60 p-2">
            <summary className="cursor-pointer text-muted-foreground">
              展开 Session / legacy
            </summary>
            <pre className="mt-2 max-h-72 overflow-auto whitespace-pre-wrap break-all font-mono text-[10px]">
              {json({ session, legacy })}
            </pre>
          </details>
        </CardContent>
      </Card>

      <Card className="lg:col-span-2">
        <CardHeader className="flex-row items-center justify-between pb-3">
          <div>
            <CardTitle className="text-base">API / 事件日志</CardTitle>
            <CardDescription>
              noise.level 只更新电平，不写入日志以免刷屏。
            </CardDescription>
          </div>
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => setLog([])}
          >
            清空日志
          </Button>
        </CardHeader>
        <CardContent className="max-h-80 space-y-2 overflow-y-auto">
          {log.length === 0 && (
            <p className="text-xs text-muted-foreground">暂无日志</p>
          )}
          {log.map((entry) => (
            <details
              key={entry.id}
              className="rounded-lg border border-border/60 px-3 py-2 text-xs"
            >
              <summary className="flex cursor-pointer flex-wrap items-center gap-2">
                <span className="font-mono text-[10px] text-muted-foreground">
                  {new Date(entry.at).toLocaleTimeString()}
                </span>
                <span>{entry.label}</span>
              </summary>
              <pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap break-all font-mono text-[10px] text-muted-foreground">
                {json(entry.data)}
              </pre>
            </details>
          ))}
        </CardContent>
      </Card>
    </div>
  );
}
