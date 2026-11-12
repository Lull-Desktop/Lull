/**
 * Renderer：单 Pass / 多 Pass（Common + Volume A-D + Buffer A-D + Image A-D + Image）渲染。
 *
 * 多 Pass 使用 FBO + 双纹理反馈：每个 buffer 的 `iChannelN` 默认指向自己的上一帧，
 * 其余通道按默认约定或 Bindings 分节解析；显示 Pass（Image，或没有 Image 时的
 * 最后一个 Image A-D）渲染到屏幕。
 *
 * Volume Pass 是 3D 纹理（sampler3D，仅 WebGL2 / ES 3.00）：每帧把全部 slice
 * 逐层渲染进 RGBA16F 3D 纹理，双纹理 ping-pong 提供上一帧反馈。
 *
 * 换源码时先完成全部 Pass 的 adapt/compile/link 与 FBO 创建，只有全部成功才替换
 * 当前管线；失败时旧管线继续渲染（调用方负责展示错误）。
 */
import { adaptRawFragment } from "../adapter/raw-fragment-adapter";
import type { ChannelKind } from "../adapter/shader-template";
import { VOLUME_SLICE_UNIFORM } from "../adapter/shader-template";
import { adaptShadertoyImage } from "../adapter/shadertoy-image-adapter";
import { adaptShadertoyVolume } from "../adapter/shadertoy-volume-adapter";
import type { UniformValues } from "../adapter/uniform-adapter";
import {
  type ChannelTarget,
  parsePassSource,
  type ScenePassName,
  type VolumePassName,
} from "../source/pass-source";
import { VOLUME_PROFILE } from "../source/source-model";
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
import {
  createVolumeTarget,
  DEFAULT_VOLUME_SIZE,
  type VolumeTarget,
} from "./volume-target";
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
  volume: VolumeTarget | null;
  /** Volume Pass 的 slice uniform 位置；其他 Pass 为 null。 */
  sliceLocation: WebGLUniformLocation | null;
  channels: ChannelTarget[];
};

function isVolumePass(name: ScenePassName): name is VolumePassName {
  return name.startsWith("Volume");
}

function defaultChannels(
  name: ScenePassName,
  offscreen: ReadonlySet<ScenePassName>,
): ChannelTarget[] {
  if (offscreen.size === 0) {
    // 只有显示 Pass 的“多 Pass”文件，保持单 Pass 的占位习惯。
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
    case "VolumeA":
      return ["VolumeA", "Black", "Black", "Black"];
    case "VolumeB":
      return ["VolumeB", "VolumeA", "Black", "Black"];
    case "VolumeC":
      return ["VolumeC", "VolumeA", "VolumeB", "Black"];
    case "VolumeD":
      return ["VolumeD", "VolumeA", "VolumeB", "VolumeC"];
    case "Image":
    case "ImageA":
    case "ImageB":
    case "ImageC":
    case "ImageD":
      return ["BufferA", "BufferB", "BufferC", "BufferD"];
  }
}

function withPassName(
  name: ScenePassName,
  value: ShaderDiagnostic,
): ShaderDiagnostic {
  return { ...value, message: `[${name}] ${value.message}` };
}

/**
 * 含 Volume 的管线里，2D Pass 若把某通道当 3D 采样却没绑定到 Volume，编译器只会
 * 报 `texture: no matching overloaded function`。这里把这类失败补上一条可操作的
 * 绑定提示，避免用户面对原始日志无从下手。
 */
function withVolumeBindingHint(
  value: ShaderDiagnostic,
  channelTargets: readonly ChannelTarget[],
  offscreen: ReadonlySet<ScenePassName>,
): ShaderDiagnostic {
  const volumes = [...offscreen].filter(isVolumePass);
  if (volumes.length === 0) return value;
  const text = `${value.message} ${value.detail ?? ""}`;
  if (!/texture|sampler|overload|vec3|ivec3/i.test(text)) return value;
  const has2dChannel = channelTargets.some(
    (target) => !isVolumePass(target as ScenePassName),
  );
  if (!has2dChannel) return value;
  const example = volumes[0];
  const hint =
    `提示：本管线含 Volume Pass（${volumes.join("、")}）。若此 Pass 用 vec3 / ivec3 采样某个 iChannel，` +
    `需在 Bindings 中把该通道绑定到 Volume（例如 BufferA.iChannel0 = ${example}）；` +
    `否则该通道按 2D（sampler2D）声明，texture(iChannelN, vec3) 会编译失败。 / ` +
    `Hint: this pipeline has Volume passes; bind any 3D-sampled iChannel to a Volume in Bindings ` +
    `(e.g. BufferA.iChannel0 = ${example}), otherwise it is declared sampler2D.`;
  return { ...value, message: `${value.message}\n${hint}` };
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
    const source = passes.find((pass) => pass.name === target);
    if (source?.volume) {
      const n = source.volume.size;
      return {
        texture: source.volume.outputTexture(),
        width: n,
        height: n,
        depth: n,
        kind: "3d",
      };
    }
    if (!source?.target) return channels.black;
    return {
      texture: source.target.outputTexture(),
      width: source.target.width,
      height: source.target.height,
    };
  };

  const disposePasses = (items: PassRuntime[]): void => {
    for (const pass of items) {
      pass.handle.dispose();
      pass.target?.dispose();
      pass.volume?.dispose();
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

      const offscreen = new Set<ScenePassName>(
        value.passes
          .map((pass) => pass.name)
          .filter((name) => name !== value.displayPass),
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

        const volumePass = isVolumePass(pass.name);
        if (volumePass && profile.profile !== VOLUME_PROFILE) {
          disposePasses(nextPasses);
          return {
            ok: false,
            diagnostic: withPassName(
              pass.name,
              diagnostic(
                "unsupported-entry",
                "Volume 分节必须使用入口 void mainVolume(out vec4 O, vec3 V)。 / Volume sections must use mainVolume(out vec4, in vec3).",
              ),
            ),
          };
        }
        if (!volumePass && profile.profile === VOLUME_PROFILE) {
          disposePasses(nextPasses);
          return {
            ok: false,
            diagnostic: withPassName(
              pass.name,
              diagnostic(
                "unsupported-entry",
                "mainVolume 只能用在 Volume A-D 分节；其他分节请用 mainImage 或 main。 / mainVolume belongs in a Volume A-D section.",
              ),
            ),
          };
        }

        // 通道绑定先于适配确定：绑定到 Volume 的通道要声明为 sampler3D。
        const channelTargets = defaultChannels(pass.name, offscreen);
        const overrides = value.bindings[pass.name];
        if (overrides) {
          for (const [channel, targetName] of Object.entries(overrides)) {
            if (targetName) channelTargets[Number(channel)] = targetName;
          }
        }
        const channelKinds: ChannelKind[] = channelTargets.map((target) =>
          target !== "Noise" && target !== "Black" && isVolumePass(target)
            ? "3d"
            : "2d",
        );
        const has3dChannel = channelKinds.includes("3d");

        // WebGL2 下的 ES1 导数 shader 拿不到 OES_standard_derivatives；
        // textureLod / textureGrad 在 ES1 路径会退化，ES3 才能保留 LOD。
        // sampler3D 通道同样只能走 ES3。其余 ES1 源码仍按原版本编译，避免行为漂移。
        const needsEs3 =
          volumePass ||
          has3dChannel ||
          profile.dialect === 300 ||
          (context.version === 2 &&
            (profile.usesDerivatives || profile.usesTextureLod));
        if (needsEs3 && context.version !== 2) {
          disposePasses(nextPasses);
          if (volumePass) {
            return {
              ok: false,
              diagnostic: withPassName(
                pass.name,
                diagnostic(
                  "unsupported-feature",
                  "Volume Pass 使用 3D 纹理（sampler3D），需要 WebGL2；当前环境只有 WebGL1。 / Volume passes need WebGL2 (sampler3D), but this environment only has WebGL1.",
                  "sampler3D",
                ),
              ),
            };
          }
          const declared = profile.declaredVersion === 300;
          return {
            ok: false,
            diagnostic: withPassName(
              pass.name,
              diagnostic(
                declared ? "unsupported-version" : "unsupported-feature",
                declared
                  ? "源码声明 #version 300 es，需要 WebGL2；当前环境只有 WebGL1。 / #version 300 es needs WebGL2, but this environment only has WebGL1."
                  : "源码使用了 GLSL ES 3.00 特性，需要 WebGL2；当前环境只有 WebGL1。 / This shader uses GLSL ES 3.00 features and needs WebGL2, but this environment only has WebGL1.",
                declared
                  ? "#version 300 es"
                  : profile.es3Features.join(", ") || "GLSL ES 3.00",
              ),
            ),
          };
        }

        const dialect = needsEs3 ? 300 : 100;
        const adapted = volumePass
          ? adaptShadertoyVolume(profile.source, { channelKinds })
          : profile.profile === "raw-fragment"
            ? adaptRawFragment(profile.source, {
                derivativesSupported: context.derivativesSupported,
                dialect,
                channelKinds,
              })
            : adaptShadertoyImage(profile.source, {
                derivativesSupported: context.derivativesSupported,
                dialect,
                channelKinds,
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
            diagnostic: withPassName(
              pass.name,
              withVolumeBindingHint(
                compiled.diagnostic,
                channelTargets,
                offscreen,
              ),
            ),
          };
        }

        const handle = createProgramHandle(
          gl,
          compiled.program,
          adapted.shader.lineOffset,
        );
        let target: FeedbackTarget | null = null;
        let volume: VolumeTarget | null = null;
        let sliceLocation: WebGLUniformLocation | null = null;
        if (pass.name !== value.displayPass) {
          try {
            if (volumePass) {
              volume = createVolumeTarget(
                context,
                value.volumeSizes[pass.name as VolumePassName] ??
                  DEFAULT_VOLUME_SIZE,
              );
              sliceLocation = gl.getUniformLocation(
                compiled.program,
                VOLUME_SLICE_UNIFORM,
              );
            } else {
              target = createFeedbackTarget(context, size.width, size.height);
            }
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

        for (const warning of adapted.shader.warnings) {
          warnings.push(`[${pass.name}] ${warning}`);
        }

        nextPasses.push({
          name: pass.name,
          handle,
          target,
          volume,
          sliceLocation,
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
      if (value.displayPass !== "Image") {
        warnings.push(
          `没有 Image 分节，使用 ${value.displayPass} 作为最终显示 Pass。 / No Image section; ${value.displayPass} is displayed as the final pass.`,
        );
      }
      const volumePasses = nextPasses.filter((pass) => pass.volume !== null);
      if (volumePasses.length > 0) {
        const sizes = volumePasses
          .map((pass) => `${pass.name}=${pass.volume?.size}³`)
          .join(", ");
        warnings.push(
          `Volume Pass 每帧渲染全部 slice（${sizes}），开销较大；可用 Bindings 的 VolumeA.size 调整边长。 / Volume passes render every slice each frame; tune VolumeA.size in Bindings if needed.`,
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
            : `外部输入由 buffer / volume / Noise / Black 通道提供（${names}）；未绑定的外部纹理/音频/键盘不会加载。`,
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
        // Volume 纹理尺寸固定（Bindings 的 size），不随屏幕缩放。
        pass.target?.resize(size.width, size.height);
      }
    },
    render(values) {
      if (passes.length === 0 || context.isLost()) return;
      for (const pass of passes) {
        if (pass.channels.length !== CHANNEL_COUNT) {
          pass.channels.length = CHANNEL_COUNT;
        }
        // 先解析通道（拿到上一帧输出），再交换反馈纹理。
        const bindings = pass.channels.map((target) => resolveChannel(target));
        if (pass.volume) {
          const n = pass.volume.size;
          pass.volume.beginFrame();
          pass.handle.setUniforms(
            { ...values, resolution: [n, n], resolutionZ: n },
            bindings,
          );
          for (let slice = 0; slice < n; slice += 1) {
            pass.volume.bindSlice(slice);
            if (pass.sliceLocation) {
              gl.uniform1f(pass.sliceLocation, slice);
            }
            pass.handle.draw();
          }
          pass.volume.endFrame();
        } else if (pass.target) {
          pass.handle.setUniforms(values, bindings);
          pass.target.beginDraw();
          pass.handle.draw();
          pass.target.endDraw();
        } else {
          pass.handle.setUniforms(values, bindings);
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
