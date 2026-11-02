/**
 * Lull 第三方播放器最小示例。
 *
 * 目的不是做完整播放器，而是验证：
 * - 声明 `provides: music-player` 后能与官方播放器替换；
 * - 只通过 @lull/widget-sdk + @lull/media-sdk 使用宿主媒体服务；
 * - 不需要 Tauri IPC、音频引擎或本地曲库实现。
 */
import type { MediaEvent, PlayerState, QueueState } from "@lull/media-sdk";
import { createWidgetMediaClient } from "@lull/media-sdk/widget";
import { connectLullWidget } from "@lull/widget-sdk";

function element<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`缺少页面元素 #${id}`);
  return node as T;
}

const title = element<HTMLHeadingElement>("track-title");
const artist = element<HTMLParagraphElement>("track-artist");
const status = element<HTMLSpanElement>("status");
const progress = element<HTMLInputElement>("progress");
const elapsed = element<HTMLSpanElement>("elapsed");
const duration = element<HTMLSpanElement>("duration");
const toggle = element<HTMLButtonElement>("toggle");
const previous = element<HTMLButtonElement>("previous");
const next = element<HTMLButtonElement>("next");
const volume = element<HTMLInputElement>("volume");
const mute = element<HTMLButtonElement>("mute");
const queue = element<HTMLSpanElement>("queue");
const error = element<HTMLParagraphElement>("error");

let player: PlayerState | null = null;
let queueState: QueueState | null = null;
let media: ReturnType<typeof createWidgetMediaClient> | null = null;
let busy = false;

function formatMs(value: number | undefined): string {
  if (!value || value < 0) return "0:00";
  const total = Math.floor(value / 1000);
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

function errorText(value: unknown): string {
  if (value instanceof Error) return value.message;
  if (typeof value === "string") return value;
  return "未知错误";
}

function setError(message: string): void {
  error.textContent = message;
}

function statusLabel(state: PlayerState | null): string {
  switch (state?.status) {
    case "playing":
      return "播放中";
    case "paused":
      return "已暂停";
    case "loading":
      return "加载中";
    case "ended":
      return "已结束";
    case "error":
      return "播放错误";
    default:
      return "待播放";
  }
}

function render(): void {
  const track = player?.track;
  title.textContent = track?.title ?? "还没有播放曲目";
  artist.textContent = track?.artists?.join(" / ") || "从曲库选一首开始";
  status.textContent = statusLabel(player);
  status.dataset.state = player?.status ?? "idle";

  const durationMs = player?.durationMs ?? 0;
  const positionMs = player?.positionMs ?? 0;
  progress.value =
    durationMs > 0 ? String((positionMs / durationMs) * 1000) : "0";
  elapsed.textContent = formatMs(positionMs);
  duration.textContent = formatMs(durationMs);

  toggle.textContent = player?.status === "playing" ? "暂停" : "播放";
  toggle.setAttribute(
    "aria-label",
    player?.status === "playing" ? "暂停" : "播放",
  );
  volume.value = String(Math.round((player?.volume ?? 0.8) * 100));
  mute.textContent = player?.muted ? "取消静音" : "静音";
  mute.setAttribute("aria-pressed", String(player?.muted === true));
  queue.textContent =
    queueState && queueState.trackIds.length > 0
      ? `队列 ${queueState.trackIds.length}`
      : "";

  const disabled = busy || media === null;
  toggle.disabled = disabled;
  previous.disabled = disabled;
  next.disabled = disabled;
  progress.disabled = disabled;
  volume.disabled = disabled;
  mute.disabled = disabled;
}

function handleEvent(event: MediaEvent): void {
  if (event.topic === "player.state") {
    player = event.payload as PlayerState;
    render();
    return;
  }
  if (event.topic === "player.progress") {
    const payload = event.payload as {
      positionMs?: number;
      durationMs?: number;
    };
    if (!player) return;
    player = {
      ...player,
      positionMs: payload.positionMs ?? player.positionMs,
      durationMs: payload.durationMs ?? player.durationMs,
    };
    render();
    return;
  }
  if (event.topic === "queue.changed") {
    queueState = event.payload as QueueState;
    render();
  }
}

function requireMedia(): NonNullable<typeof media> {
  if (!media) throw new Error("媒体桥尚未连接");
  return media;
}

async function run(
  action: () => Promise<unknown>,
  failurePrefix: string,
): Promise<void> {
  if (busy) return;
  busy = true;
  setError("");
  render();
  try {
    await action();
  } catch (value) {
    setError(`${failurePrefix}：${errorText(value)}`);
  } finally {
    busy = false;
    render();
  }
}

async function togglePlayback(): Promise<void> {
  const bridge = requireMedia();
  if (!player?.track) {
    const page = await bridge.library.listTracks({ page: 1, pageSize: 1 });
    const first = page.items[0];
    if (!first) {
      throw new Error("曲库为空，请先在设置 → 音乐库添加并扫描文件夹");
    }
    await bridge.player.play(first.id);
    return;
  }
  if (player.status === "playing") {
    await bridge.player.pause();
  } else if (player.status === "paused") {
    await bridge.player.resume();
  } else {
    await bridge.player.play(player.track.id);
  }
}

toggle.addEventListener("click", () => {
  void run(togglePlayback, "播放控制失败");
});

previous.addEventListener("click", () => {
  void run(() => requireMedia().player.previous(), "上一首失败");
});

next.addEventListener("click", () => {
  void run(() => requireMedia().player.next(), "下一首失败");
});

progress.addEventListener("change", () => {
  const durationMs = player?.durationMs ?? 0;
  if (durationMs <= 0) return;
  const target = Math.round((Number(progress.value) / 1000) * durationMs);
  void run(() => requireMedia().player.seek(target), "跳转进度失败");
});

volume.addEventListener("input", () => {
  if (player) {
    player = { ...player, volume: Number(volume.value) / 100 };
    render();
  }
});

volume.addEventListener("change", () => {
  const value = Number(volume.value) / 100;
  void run(() => requireMedia().player.setVolume(value), "调整音量失败");
});

mute.addEventListener("click", () => {
  void run(
    () => requireMedia().player.setMuted(!(player?.muted ?? false)),
    "切换静音失败",
  );
});

async function boot(): Promise<void> {
  try {
    const lull = await connectLullWidget();
    const client = createWidgetMediaClient({
      request: (method, params) =>
        lull.request(method as never, params as never),
      onMediaEvent: (listener) => lull.onMediaEvent(listener),
    });
    const snapshot = await client.connect({
      topics: ["player.state", "player.progress", "queue.changed"],
      progressMs: 500,
    });
    player = snapshot.player ?? (await client.player.getState());
    queueState = snapshot.queue ?? null;
    media = client;
    client.events.on(handleEvent);
    setError("");
    render();
  } catch (value) {
    status.textContent = "连接失败";
    status.dataset.state = "error";
    setError(`播放器初始化失败：${errorText(value)}`);
    render();
  }
}

void boot();
