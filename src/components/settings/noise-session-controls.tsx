/**
 * 设置窗「白噪音」页签的主音量、静音与睡眠定时。
 *
 * 从白噪音库「噪音测试」页签的「主音量与睡眠」卡迁来，交互保持一致：
 * 主音量滑杆拖动时只改本地显示、松手才写回；静音开关即时生效（乐观更新）；
 * 睡眠定时先选分钟数，点「应用」才写回。睡眠到点会暂停 Session（保留
 * 静音偏好），可用播放恢复。
 *
 * 媒体连接由设置页根节点独占，本组件只消费传入的 client，并靠
 * `noise.session.changed` 事件同步状态。
 */
"use client";

import type { LullMediaClient, NoiseSession } from "@lull/media-sdk";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Slider } from "@/components/ui/slider";
import { Switch } from "@/components/ui/switch";
import { useLocale } from "@/i18n/locale";
import { m } from "@/paraglide/messages";

const SLEEP_OPTIONS = [0, 1, 5, 15, 30, 60];

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function NoiseSessionControls({
  client,
}: {
  /** 由所在窗口的媒体连接提供；为 null 时控件只做本地展示。 */
  client: LullMediaClient | null;
}) {
  useLocale();
  const rootId = useId();
  const [master, setMaster] = useState(75);
  const [muted, setMuted] = useState(false);
  const [sleepMinutes, setSleepMinutes] = useState(0);
  const [error, setError] = useState("");
  const draggingMaster = useRef(false);
  const mounted = useRef(false);

  // 与原「主音量与睡眠」卡一致：事件/快照只在没在拖主音量时覆盖滑杆值，
  // 静音与睡眠定时始终以后端 Session 为准。
  const applySession = useCallback((next: NoiseSession): void => {
    if (!draggingMaster.current) {
      setMaster(Math.round(next.masterVolume * 100));
    }
    setMuted(next.muted);
    setSleepMinutes(next.sleep.timerMinutes);
  }, []);

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
        if (mounted.current) applySession(next);
      })
      .catch((reason: unknown) => {
        if (mounted.current) setError(errorText(reason));
      });
    return () => {
      mounted.current = false;
    };
  }, [applySession, client]);

  useEffect(() => {
    if (!client) return;
    const stop = client.events.on((event) => {
      if (event.topic === "noise.session.changed") {
        applySession(event.payload as NoiseSession);
      }
    });
    return () => stop();
  }, [applySession, client]);

  const run = useCallback(
    (action: () => Promise<unknown>): void => {
      if (!client) return;
      setError("");
      void (async () => {
        try {
          await action();
        } catch (reason) {
          if (mounted.current) setError(errorText(reason));
        }
      })();
    },
    [client],
  );

  const setSessionMaster = useCallback(
    (value: number): void => {
      if (!client) return;
      run(() => client.noise.session.setMasterVolume(value / 100));
    },
    [client, run],
  );

  const setSessionMuted = useCallback(
    (next: boolean): void => {
      if (!client) return;
      setMuted(next);
      run(() => client.noise.session.setMuted(next));
    },
    [client, run],
  );

  const applySleep = useCallback((): void => {
    if (!client) return;
    run(() => client.noise.session.setSleepTimer(sleepMinutes));
  }, [client, run, sleepMinutes]);

  const masterId = `${rootId}-master`;
  const mutedId = `${rootId}-muted`;
  const sleepId = `${rootId}-sleep`;

  return (
    <section
      className="shrink-0 space-y-3"
      data-testid="noise-session-controls"
    >
      <h3 className="text-sm font-semibold">
        {m.settings_noise_session_title()}
      </h3>

      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <Label htmlFor={masterId}>{m.settings_noise_master_label()}</Label>
          <span className="text-xs text-muted-foreground">{master}%</span>
        </div>
        <Slider
          id={masterId}
          min={0}
          max={100}
          step={1}
          value={[master]}
          thumbLabel={m.settings_noise_master_label()}
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
          <Label htmlFor={mutedId}>{m.settings_noise_muted_label()}</Label>
          <p className="text-xs text-muted-foreground">
            {m.settings_noise_muted_hint()}
          </p>
        </div>
        <Switch
          id={mutedId}
          aria-label={m.settings_noise_muted_label()}
          checked={muted}
          onCheckedChange={setSessionMuted}
        />
      </div>

      <div className="flex items-end gap-2">
        <div className="space-y-1">
          <Label htmlFor={sleepId}>{m.settings_noise_sleep_label()}</Label>
          <select
            id={sleepId}
            aria-label={m.settings_noise_sleep_label()}
            value={sleepMinutes}
            onChange={(event) => setSleepMinutes(Number(event.target.value))}
            className="w-36 rounded-md border border-border bg-background px-2 py-1.5 text-sm"
          >
            {SLEEP_OPTIONS.map((minutes) => (
              <option key={minutes} value={minutes}>
                {minutes === 0
                  ? m.settings_noise_sleep_off()
                  : m.settings_noise_sleep_minutes({ count: minutes })}
              </option>
            ))}
          </select>
        </div>
        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={applySleep}
          aria-label={m.settings_noise_sleep_apply_aria()}
        >
          {m.settings_noise_sleep_apply()}
        </Button>
      </div>

      {error && (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      )}
    </section>
  );
}
