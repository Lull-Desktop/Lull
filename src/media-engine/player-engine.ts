/**
 * 引擎侧播放器：在线氛围声与本地音频共用一套传输控制。
 *
 * 它只负责发声、位置与状态，不认识歌单/队列；这些由 Rust Media Service 持有。
 * 隐藏窗口里每 250ms 上报进度，由宿主再按订阅节流转发。
 *
 * N1 起所有声音进入共享 AudioGraph：本地音频用 MediaElementAudioSource，
 * 内置氛围曲接 musicBus，播放器音量只由 graph 控制。
 */
import { AmbientStream } from "./ambient-stream";
import type { AudioGraph } from "./audio-graph";
import { clamp01 } from "./gain";
import type { AmbientPreset } from "./preset";
import type { EngineEvent, PlaybackSource } from "./protocol";

type Emit = (event: EngineEvent) => void;

export class PlayerEngine {
  private readonly emit: Emit;
  private readonly graph: AudioGraph;
  private readonly timer: number;
  private ambient: AmbientStream | null = null;
  private audio: HTMLAudioElement | null = null;
  private localSource: MediaElementAudioSourceNode | null = null;
  private source: PlaybackSource | null = null;
  private loadId = "";
  private durationMs: number | null = null;
  private offsetMs = 0;
  private startedAt = 0;
  private playing = false;
  private volume = 0.78;
  private muted = false;
  private ended = false;

  constructor(emit: Emit, graph: AudioGraph) {
    this.emit = emit;
    this.graph = graph;
    this.graph.setMusicVolume(this.volume, this.muted);
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
      if (command.autoplay) {
        this.startAmbient(command.source.preset, this.offsetMs);
      } else {
        this.playing = false;
        this.emitState("paused");
      }
      return;
    }

    const audio = new Audio();
    audio.preload = "auto";
    // 本地曲走 Tauri asset protocol；接入 MediaElementAudioSource 时必须让
    // 元素以 CORS 模式取资源，否则 Web Audio 会把跨域媒体输出成静音。
    // Tauri asset protocol 会回 Access-Control-Allow-Origin: <window origin>。
    audio.crossOrigin = "anonymous";
    audio.src = command.source.url;
    audio.volume = this.effectiveVolume();
    try {
      this.graph.ensure();
      this.localSource = this.graph.attachMediaElement(audio);
      audio.volume = 1;
    } catch {
      // Graph 不可用时保留元素直出，随后由宿主上报错误；音量仍可调。
      this.localSource = null;
      audio.volume = this.effectiveVolume();
    }
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
      if (this.playing) {
        this.startAmbient(this.source.preset, position);
      } else {
        this.emitState("paused");
      }
    }
  }

  setVolume(volume: number, muted: boolean): void {
    this.volume = clamp01(volume);
    this.muted = muted;
    this.graph.setMusicVolume(this.volume, this.muted);
    if (this.audio && !this.localSource) {
      this.audio.volume = this.effectiveVolume();
    }
  }

  level(): number {
    if (!this.playing || this.muted) return 0;
    return this.graph.musicLevel();
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

  private startAmbient(preset: AmbientPreset, offsetMs: number): boolean {
    try {
      this.graph.resume();
      this.ambient ??= new AmbientStream(this.graph);
      this.ambient.start(preset, offsetMs / 1000);
    } catch (error) {
      this.playing = false;
      this.emitError(
        "player.audio-graph",
        error instanceof Error ? error.message : "音频图初始化失败",
      );
      return false;
    }
    this.offsetMs = offsetMs;
    this.startedAt = performance.now();
    this.playing = true;
    this.ended = false;
    this.emitState("playing");
    return true;
  }

  private async playAudio(audio: HTMLAudioElement): Promise<void> {
    try {
      this.graph.resume();
      audio.volume = this.localSource ? 1 : this.effectiveVolume();
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
    this.graph.detachMediaElement(this.localSource);
    this.localSource = null;
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
