/**
 * Lull 第三方 Noise Mixer 示例。
 *
 * 插件不直接 invoke Tauri：所有调用经 `@lull/widget-sdk` 的 iframe 桥，
 * 宿主壳再带 bridge token 调 Media Service。Rust 按 8 个 Noise capability
 * 与 `.grants.json` 逐方法校验。
 */
import { connectLullWidget, type LullWidgetClient } from "@lull/widget-sdk";
import { createWidgetMediaClient } from "@lull/media-sdk/widget";
import type { NoiseSession, NoiseTrack } from "@lull/media-sdk";

function must<T extends Element>(selector: string): T {
  const node = document.querySelector<T>(selector);
  if (!node) throw new Error(`缺少元素 ${selector}`);
  return node;
}

const els = {
  title: must<HTMLElement>("#title"),
  status: must<HTMLElement>("#status"),
  tracks: must<HTMLElement>("#tracks"),
  toggle: must<HTMLButtonElement>("#toggle"),
  sleep: must<HTMLSelectElement>("#sleep"),
};

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function render(session: NoiseSession): void {
  const sleep =
    session.sleep.timerMinutes > 0
      ? ` · 睡眠 ${session.sleep.timerMinutes} 分钟`
      : "";
  els.status.textContent =
    session.state === "playing"
      ? `播放中 · ${session.tracks.length} 条轨道${sleep}`
      : session.state === "paused"
        ? `已暂停${sleep}`
        : `空闲${sleep}`;
  els.toggle.textContent = session.state === "playing" ? "暂停" : "播放";
  els.toggle.disabled = session.tracks.length === 0;
  els.sleep.value = String(session.sleep.timerMinutes);
  els.tracks.replaceChildren(
    ...session.tracks.map((track: NoiseTrack) => {
      const row = document.createElement("div");
      row.className = "track";
      const label = document.createElement("div");
      const name = document.createElement("strong");
      name.textContent = track.name;
      const meta = document.createElement("small");
      meta.textContent = `${Math.round(track.volume * 100)}% · ${
        track.enabled ? "开启" : "关闭"
      }`;
      label.append(name, meta);
      const button = document.createElement("button");
      button.type = "button";
      button.className = "track-toggle";
      // 按钮展示“当前状态”，而不是“点击后将执行的动作”；否则默认关闭的
      // 远雷会显示“开启”，看起来与其它已开启轨道相反。
      button.textContent = track.enabled ? "开启" : "关闭";
      button.setAttribute("role", "switch");
      button.setAttribute("aria-checked", String(track.enabled));
      button.title = track.enabled ? "点击关闭" : "点击开启";
      button.addEventListener("click", () => {
        void media.noise.tracks
          .setEnabled(track.id, !track.enabled)
          .catch((error: unknown) => {
            els.status.textContent = errorText(error);
          });
      });
      row.append(label, button);
      return row;
    }),
  );
}

const lull = await connectLullWidget();
const media = createWidgetMediaClient({
  request: (method, params) =>
    (lull as LullWidgetClient).request(method as never, params as never),
  onMediaEvent: lull.onMediaEvent,
});

let session: NoiseSession | null = null;
media.events.on((event) => {
  if (event.topic === "noise.session.changed") {
    session = event.payload as NoiseSession;
    render(session);
  }
});

try {
  const snapshot = await media.connect({
    topics: [
      "noise.session.changed",
      "noise.track.added",
      "noise.track.removed",
      "noise.track.updated",
      "noise.volume.changed",
    ],
  });
  session = snapshot.noiseSession;
  if (session) render(session);
} catch (error) {
  els.status.textContent = `连接失败：${errorText(error)}`;
}

els.toggle.addEventListener("click", () => {
  if (!session) return;
  const action =
    session.state === "playing"
      ? media.noise.session.pause()
      : media.noise.session.play();
  void action.catch((error: unknown) => {
    els.status.textContent = errorText(error);
  });
});

els.sleep.addEventListener("change", () => {
  const minutes = Number(els.sleep.value);
  if (!Number.isFinite(minutes)) return;
  void media.noise.session
    .setSleepTimer(minutes)
    .then((next) => {
      session = next;
      render(next);
    })
    .catch((error: unknown) => {
      els.status.textContent = errorText(error);
    });
});

lull.onTheme((theme) => {
  document.documentElement.style.setProperty("--accent", theme.colors.accentLight);
});
