/**
 * Renderer：单 Pass / 多 Pass（Common + Buffer A-D + Image）渲染。
 *
 * 多 Pass 使用 FBO + 双纹理反馈：每个 buffer 的 `iChannelN` 默认指向自己的上一帧，
 * 其余通道按默认约定或 Bindings 分节解析；Image 渲染到屏幕。
 *
 * 换源码时先完成全部 Pass 的 adapt/compile/link 与 FBO 创建，只有全部成功才替换
 * 当前管线；失败时旧管线继续渲染（调用方负责展示错误）。
 */
import { adaptRawFragment } from "../adapter/raw-fragment-adapter";
import { adaptShadertoyImage } from "../adapter/shadertoy-image-adapter";
import type { UniformValues } from "../adapter/uniform-adapter";
import {
  type ChannelTarget,
  parsePassSource,
  type ScenePassName,
} from "../source/pass-source";
import {
  detectShaderProfile,
  findExternalInputs,
} from "../source/source-profile";
import {
  CHANNEL_COUNT,
  type ChannelTexture,
  type ChannelTextures,
  createChannelTextures,
} from "./channel-textures";
import { diagnostic, type ShaderDiagnostic } from "./diagnostics";
import { createFeedbackTarget, type FeedbackTarget } from "./feedback-target";
import { compileProgram } from "./shader-compiler";
import { createProgramHandle, type ProgramHandle } from "./shader-program";
import type { GlContext } from "./webgl-context";

export type LoadResult =
  | {
      ok: true;
      lineOffset: number;
      warnings: string[];
      /** 源码引用到的外部输入名（由 buffer / 占位通道提供）。 */
      channels: string[];
      /** 实际渲染的 Pass 顺序。 */
      passes: ScenePassName[];
    }
  | { ok: false; diagnostic: ShaderDiagnostic };

export type DrawSizeLike = { width: number; height: number };

export type ShaderRenderer = {
  /** 适配并编译新源码；成功时才替换当前管线。 */
  load(source: string): LoadResult;
  /** 卸载当前管线（空源码 / context lost）。 */
  unload(): void;
  resize(size: DrawSizeLike): void;
  render(values: UniformValues): void;
  hasProgram(): boolean;
  dispose(): void;
};

export type ShaderRendererOptions = {
  canvas: HTMLCanvasElement;
  context: GlContext;
};

type PassRuntime = {
  name: ScenePassName;
  handle: ProgramHandle;
  target: FeedbackTarget | null;
  channels: ChannelTarget[];
};

function defaultChannels(
  name: ScenePassName,
  bufferNames: ReadonlySet<ScenePassName>,
): ChannelTarget[] {
  if (bufferNames.size === 0) {
    // 只有 Image 的“多 Pass”文件，保持单 Pass 的占位习惯。
    return ["Noise", "Black", "Black", "Black"];
  }
  switch (name) {
    case "BufferA":
      return ["BufferA", "Black", "Black", "Black"];
    case "BufferB":
      return ["BufferB", "BufferA", "Black", "Black"];
    case "BufferC":
      return ["BufferC", "BufferA", "BufferB", "Black"];
    case "BufferD":
      return ["BufferD", "BufferA", "BufferB", "BufferC"];
    case "Image":
      return ["BufferA", "BufferB", "BufferC", "BufferD"];
  }
}

function withPassName(
  name: ScenePassName,
  value: ShaderDiagnostic,
): ShaderDiagnostic {
  return { ...value, message: `[${name}] ${value.message}` };
}

export function createShaderRenderer(
  options: ShaderRendererOptions,
): ShaderRenderer {
  const { canvas, context } = options;
  const gl = context.gl;
  let passes: PassRuntime[] = [];
  let channels: ChannelTextures | null = null;
  let size: DrawSizeLike = { width: 1, height: 1 };

  const applySize = (): void => {
    const width = Math.max(1, Math.round(size.width));
    const height = Math.max(1, Math.round(size.height));
    if (canvas.width !== width) canvas.width = width;
    if (canvas.height !== height) canvas.height = height;
    gl.viewport(0, 0, width, height);
  };

  const clearScreen = (): void => {
    applySize();
    gl.clearColor(0, 0, 0, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
  };

  const resolveChannel = (target: ChannelTarget): ChannelTexture | null => {
    if (!channels) return null;
    if (target === "Noise") return channels.noise;
    if (target === "Black") return channels.black;
    const feedback = passes.find((pass) => pass.name === target)?.target;
    if (!feedback) return channels.black;
    return {
      texture: feedback.outputTexture(),
      width: feedback.width,
      height: feedback.height,
    };
  };

  const disposePasses = (items: PassRuntime[]): void => {
    for (const pass of items) {
      pass.handle.dispose();
      pass.target?.dispose();
    }
  };

  return {
    load(source) {
      if (context.isLost()) {
        return {
          ok: false,
          diagnostic: diagnostic(
            "context-lost",
            "WebGL 上下文已丢失，无法加载新着色器。 / The WebGL context is lost.",
          ),
        };
      }

      const parsed = parsePassSource(source);
      if (!parsed.ok) return { ok: false, diagnostic: parsed.diagnostic };
      const value = parsed.value;

      const bufferNames = new Set<ScenePassName>(
        value.passes
          .map((pass) => pass.name)
          .filter((name) => name !== "Image"),
      );
      const nextPasses: PassRuntime[] = [];
      const warnings: string[] = [];
      const usedChannels = new Set<string>();
      let firstLineOffset = 0;

      for (const pass of value.passes) {
        const combined = value.common
          ? `${value.common}\n\n${pass.source}`
          : pass.source;
        for (const name of findExternalInputs(combined)) {
          usedChannels.add(name);
        }

        const profile = detectShaderProfile(combined);
        if (!profile.ok) {
          disposePasses(nextPasses);
          return {
            ok: false,
            diagnostic: withPassName(pass.name, profile.diagnostic),
          };
        }

        const adapted =
          profile.profile === "raw-fragment"
            ? adaptRawFragment(profile.source, {
                derivativesSupported: context.derivativesSupported,
              })
            : adaptShadertoyImage(profile.source, {
                derivativesSupported: context.derivativesSupported,
              });
        if (!adapted.ok) {
          disposePasses(nextPasses);
          return {
            ok: false,
            diagnostic: withPassName(pass.name, adapted.diagnostic),
          };
        }

        const compiled = compileProgram(gl, {
          vertexSource: adapted.shader.vertexSource,
          fragmentSource: adapted.shader.fragmentSource,
          lineOffset: adapted.shader.lineOffset,
        });
        if (!compiled.ok) {
          disposePasses(nextPasses);
          return {
            ok: false,
            diagnostic: withPassName(pass.name, compiled.diagnostic),
          };
        }

        const handle = createProgramHandle(
          gl,
          compiled.program,
          adapted.shader.lineOffset,
        );
        let target: FeedbackTarget | null = null;
        if (pass.name !== "Image") {
          try {
            target = createFeedbackTarget(context, size.width, size.height);
          } catch (error) {
            handle.dispose();
            disposePasses(nextPasses);
            return {
              ok: false,
              diagnostic: withPassName(
                pass.name,
                diagnostic(
                  "webgl-unavailable",
                  `无法创建 ${pass.name} 的反馈缓冲。 / Cannot create the ${pass.name} feedback target.`,
                  error instanceof Error ? error.message : String(error),
                ),
              ),
            };
          }
        }

        const channelTargets = defaultChannels(pass.name, bufferNames);
        const overrides = value.bindings[pass.name];
        if (overrides) {
          for (const [channel, targetName] of Object.entries(overrides)) {
            if (targetName) channelTargets[Number(channel)] = targetName;
          }
        }

        for (const warning of adapted.shader.warnings) {
          warnings.push(`[${pass.name}] ${warning}`);
        }

        nextPasses.push({
          name: pass.name,
          handle,
          target,
          channels: channelTargets,
        });
        if (firstLineOffset === 0) firstLineOffset = adapted.shader.lineOffset;
      }

      channels ??= createChannelTextures(gl);
      const hasFeedback = nextPasses.some((pass) => pass.target !== null);
      if (
        hasFeedback &&
        nextPasses.some((pass) => pass.target?.format === "rgba8")
      ) {
        warnings.push(
          "多 Pass 反馈缓冲回退为 RGBA8，长时间反馈可能出现精度/色带。 / Multipass feedback fell back to RGBA8.",
        );
      }

      const previous = passes;
      passes = nextPasses;
      disposePasses(previous);
      applySize();

      if (usedChannels.size > 0) {
        const names = [...usedChannels].join(", ");
        warnings.push(
          value.mode === "single"
            ? `外部输入使用占位值（${names}）：iChannel0 = 256×256 程序化噪声，iChannel1-3 = 1×1 黑色，iSampleRate = 44100；与原始纹理/音频/键盘通道不等价。`
            : `外部输入由 buffer / Noise / Black 通道提供（${names}）；未绑定的外部纹理/音频/键盘不会加载。`,
        );
      }

      gl.disable(gl.DEPTH_TEST);
      gl.disable(gl.BLEND);
      gl.disable(gl.CULL_FACE);
      clearScreen();

      return {
        ok: true,
        lineOffset: firstLineOffset,
        warnings,
        channels: [...usedChannels],
        passes: passes.map((pass) => pass.name),
      };
    },
    unload() {
      disposePasses(passes);
      passes = [];
      channels?.dispose();
      channels = null;
      clearScreen();
    },
    resize(next) {
      size = next;
      applySize();
      for (const pass of passes) {
        pass.target?.resize(size.width, size.height);
      }
    },
    render(values) {
      if (passes.length === 0 || context.isLost()) return;
      for (const pass of passes) {
        if (pass.channels.length !== CHANNEL_COUNT) {
          pass.channels.length = CHANNEL_COUNT;
        }
        const bindings = pass.channels.map((target) => resolveChannel(target));
        pass.handle.setUniforms(values, bindings);
        if (pass.target) {
          pass.target.beginDraw();
          pass.handle.draw();
          pass.target.endDraw();
        } else {
          clearScreen();
          pass.handle.draw();
        }
      }
    },
    hasProgram() {
      return passes.length > 0;
    },
    dispose() {
      disposePasses(passes);
      passes = [];
      channels?.dispose();
      channels = null;
    },
  };
}
