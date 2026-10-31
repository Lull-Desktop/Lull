/**
 * 引擎侧播放器：在线氛围声与本地音频共用一套传输控制。
 *
 * 它只负责发声、位置与状态，不认识歌单/队列；这些由 Rust Media Service 持有。
 * 隐藏窗口里每 250ms 上报进度，由宿主再按订阅节流转发。
 */
import { AmbientStream } from "./ambient-stream";
import type { AmbientPreset } from "./preset";
import type { EngineEvent, PlaybackSource } from "./protocol";

type Emit = (event: EngineEvent) => void;

export class PlayerEngine {
  private readonly emit: Emit;
  private readonly timer: number;
  private ambient: AmbientStream | null = null;
  private audio: HTMLAudioElement | null = null;
  private source: PlaybackSource | null = null;
  private loadId = "";
  private durationMs: number | null = null;
  private offsetMs = 0;
  private startedAt = 0;
  private playing = false;
  private volume = 0.78;
  private muted = false;
  private ended = false;

  constructor(emit: Emit) {
    this.emit = emit;
    this.timer = window.setInterval(() => this.tick(), 250);
  }

  async load(command: {
    loadId: string;
    source: PlaybackSource;
    positionMs: number;
    durationMs: number | null;
    autoplay: boolean;
  }): Promise<void> {
    this.stopInternal();
    this.loadId = command.loadId;
    this.source = command.source;
    this.durationMs = command.durationMs;
    this.offsetMs = Math.max(0, command.positionMs);
    this.ended = false;

    if (command.source.kind === "ambient") {
      this.emitLoaded();
      if (command.autoplay)
        this.startAmbient(command.source.preset, this.offsetMs);
      else {
        this.playing = false;
        this.emitState("paused");
      }
      return;
    }

    const audio = new Audio();
    audio.preload = "auto";
    audio.src = command.source.url;
    audio.volume = this.effectiveVolume();
    audio.addEventListener("loadedmetadata", () => {
      if (Number.isFinite(audio.duration) && audio.duration > 0) {
        this.durationMs = Math.round(audio.duration * 1000);
      }
      if (this.offsetMs > 0) {
        try {
          audio.currentTime = Math.min(audio.duration, this.offsetMs / 1000);
        } catch {
          // 元数据极端情况下不可 seek；从头播放即可。
        }
      }
      this.emitLoaded();
      if (command.autoplay) {
        void this.playAudio(audio);
      } else {
        this.playing = false;
        this.emitState("paused");
      }
    });
    audio.addEventListener("ended", () => {
      if (this.audio !== audio) return;
      this.playing = false;
      this.ended = true;
      this.offsetMs = this.durationMs ?? 0;
      this.emitState("ended");
    });
    audio.addEventListener("error", () => {
      if (this.audio !== audio) return;
      this.playing = false;
      this.emitError("player.load-failed", "本地音频加载失败");
    });
    this.audio = audio;
    audio.load();
  }

  async play(): Promise<void> {
    if (this.audio) {
      await this.playAudio(this.audio);
      return;
    }
    if (this.source?.kind === "ambient") {
      this.startAmbient(this.source.preset, this.offsetMs);
      this.emitState("playing");
    }
  }

  pause(): void {
    if (this.audio) {
      this.offsetMs = Math.round(this.audio.currentTime * 1000);
      this.audio.pause();
    } else if (this.ambient) {
      this.offsetMs = this.positionMs();
      this.ambient.stop();
    }
    this.playing = false;
    this.emitState("paused");
  }

  stop(): void {
    this.stopInternal();
    this.offsetMs = 0;
  }

  seek(positionMs: number): void {
    const duration = this.durationMs ?? Number.MAX_SAFE_INTEGER;
    const position = Math.min(Math.max(0, Math.round(positionMs)), duration);
    this.offsetMs = position;
    this.ended = false;
    if (this.audio) {
      try {
        this.audio.currentTime = position / 1000;
      } catch {
        // 元数据未就绪时忽略；loadedmetadata 会应用 offset。
      }
      this.emitState(this.playing ? "playing" : "paused");
      return;
    }
    if (this.source?.kind === "ambient") {
      if (this.playing) this.startAmbient(this.source.preset, position);
      else this.emitState("paused");
    }
  }

  setVolume(volume: number, muted: boolean): void {
    this.volume = Number.isFinite(volume)
      ? Math.min(1, Math.max(0, volume))
      : 0;
    this.muted = muted;
    this.ambient?.setVolume(this.muted ? 0 : Math.round(this.volume * 100));
    if (this.audio) this.audio.volume = this.effectiveVolume();
  }

  level(): number {
    if (!this.playing || this.muted) return 0;
    if (this.ambient) return this.ambient.level();
    return Math.min(1, 0.42 * this.volume);
  }

  dispose(): void {
    window.clearInterval(this.timer);
    this.stopInternal();
    this.ambient?.dispose();
    this.ambient = null;
  }

  private effectiveVolume(): number {
    return this.muted ? 0 : this.volume;
  }

  private startAmbient(preset: AmbientPreset, offsetMs: number): void {
    this.ambient ??= new AmbientStream();
    this.ambient.setVolume(this.muted ? 0 : Math.round(this.volume * 100));
    this.ambient.start(preset, offsetMs / 1000);
    this.offsetMs = offsetMs;
    this.startedAt = performance.now();
    this.playing = true;
    this.ended = false;
    this.emitState("playing");
  }

  private async playAudio(audio: HTMLAudioElement): Promise<void> {
    try {
      audio.volume = this.effectiveVolume();
      await audio.play();
      this.playing = true;
      this.ended = false;
      this.startedAt = performance.now();
      this.offsetMs = Math.round(audio.currentTime * 1000);
      this.emitState("playing");
    } catch (error) {
      this.playing = false;
      this.emitError(
        "player.play-failed",
        error instanceof Error ? error.message : "音频播放失败",
      );
    }
  }

  private stopInternal(): void {
    this.playing = false;
    this.ambient?.stop();
    if (this.audio) {
      this.audio.pause();
      this.audio.removeAttribute("src");
      this.audio.load();
      this.audio = null;
    }
  }

  private positionMs(): number {
    if (this.audio) return Math.round(this.audio.currentTime * 1000);
    if (!this.playing && this.offsetMs > 0) return this.offsetMs;
    if (!this.playing) return this.offsetMs;
    const elapsed = performance.now() - this.startedAt;
    const position = this.offsetMs + elapsed;
    return this.durationMs
      ? Math.min(position, this.durationMs)
      : Math.round(position);
  }

  private tick(): void {
    if (!this.playing) return;
    const position = this.positionMs();
    if (this.audio) {
      this.offsetMs = position;
      this.emit({
        type: "player.progress",
        loadId: this.loadId,
        positionMs: position,
      });
      return;
    }
    if (
      !this.ended &&
      this.durationMs !== null &&
      position >= this.durationMs
    ) {
      this.ended = true;
      this.playing = false;
      this.ambient?.stop();
      this.offsetMs = this.durationMs;
      this.emitState("ended");
      return;
    }
    this.emit({
      type: "player.progress",
      loadId: this.loadId,
      positionMs: position,
    });
  }

  private emitLoaded(): void {
    this.emit({
      type: "player.loaded",
      loadId: this.loadId,
      durationMs: this.durationMs,
    });
  }

  private emitState(status: "playing" | "paused" | "ended"): void {
    this.emit({
      type: "player.state",
      loadId: this.loadId,
      status,
      positionMs:
        status === "ended"
          ? (this.durationMs ?? this.positionMs())
          : this.positionMs(),
      durationMs: this.durationMs,
    });
  }

  private emitError(code: string, message: string): void {
    this.emit({ type: "error", scope: "player", code, message });
  }
}
