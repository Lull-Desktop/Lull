/**
 * 白噪音 API 手工验收面板。
 *
 * 这是开发调试组件，不是正式 Mixer：它同时驱动 N2 的
 * `noise.session.* / noise.tracks.*` 与旧 5 层 `noise.*` 兼容门面，
 * 并展示 snapshot、事件与实时 level，方便确认两套 API 是否指向同一个
 * 运行时 Session。媒体连接由白噪音库窗口统一建立，本面板不 connect/disconnect。
 */
"use client";

import type {
  LullMediaClient,
  MediaOutput,
  NoiseSession,
  NoiseSound,
  NoiseState,
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

type LogEntry = {
  id: number;
  at: number;
  label: string;
  data: unknown;
};

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

function stateClass(state: string): string {
  if (state === "playing") return "bg-emerald-500/15 text-emerald-700";
  if (state === "paused") return "bg-amber-500/15 text-amber-700";
  return "bg-muted text-muted-foreground";
}

export function NoiseApiTestPanel({
  client,
  snapshot,
  onReconnect,
}: {
  /** 由白噪音库窗口传入；连接所有权在窗口。 */
  client: LullMediaClient | null;
  /** 窗口根节点 connect 返回的快照。 */
  snapshot: PlaybackSnapshot | null;
  /** 重新建立窗口级订阅并返回新快照；未提供时禁用“重连”按钮。 */
  onReconnect?: () => Promise<PlaybackSnapshot | null>;
}) {
  const panelId = useId();
  const [session, setSession] = useState<NoiseSession | null>(null);
  const [legacy, setLegacy] = useState<NoiseState | null>(null);
  const [sounds, setSounds] = useState<NoiseSound[]>([]);
  const [output, setOutput] = useState<MediaOutput | null>(null);
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
    if (!client) {
      return () => {
        mounted.current = false;
      };
    }
    const stop = client.events.on((event) => {
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
    return () => {
      mounted.current = false;
      stop();
    };
  }, [applySession, client, push]);

  // 窗口根节点连接完成后把快照灌进面板；面板不再自己发起连接。
  useEffect(() => {
    if (snapshot) applySnapshot(snapshot);
  }, [applySnapshot, snapshot]);

  useEffect(() => {
    if (client) {
      void refresh().catch((reason: unknown) => {
        if (mounted.current) setError(errorText(reason));
      });
    }
  }, [client, refresh]);

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
    if (!client || !onReconnect) return;
    void run(
      "media_connect",
      () =>
        onReconnect().then((next) => {
          if (!next) return { connected: false };
          return {
            revision: next.revision,
            noiseRevision: next.noise.revision,
            sessionRevision: next.noiseSession.revision,
          };
        }),
      false,
    );
  }, [client, onReconnect, run]);

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
              disabled={!client || !onReconnect}
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
