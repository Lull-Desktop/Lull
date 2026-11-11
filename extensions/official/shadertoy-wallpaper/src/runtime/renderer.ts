/**
 * Renderer：画布尺寸、Program 安全切换与整帧绘制（RFC §8.3）。
 *
 * 换源码时先在临时 Program 上完成 adapt/compile/link；只有全部成功才替换当前
 * Program；失败时旧 Program 继续渲染（调用方负责展示错误）。
 */
import { adaptRawFragment } from "../adapter/raw-fragment-adapter";
import { adaptShadertoyImage } from "../adapter/shadertoy-image-adapter";
import type { UniformValues } from "../adapter/uniform-adapter";
import {
  detectShaderProfile,
  findExternalInputs,
} from "../source/source-profile";
import {
  type ChannelTextures,
  createChannelTextures,
} from "./channel-textures";
import { diagnostic, type ShaderDiagnostic } from "./diagnostics";
import { compileProgram } from "./shader-compiler";
import { createProgramHandle, type ProgramHandle } from "./shader-program";
import type { GlContext } from "./webgl-context";

export type LoadResult =
  | {
      ok: true;
      lineOffset: number;
      warnings: string[];
      /** 源码引用到的外部输入名（由占位纹理提供）。 */
      channels: string[];
    }
  | { ok: false; diagnostic: ShaderDiagnostic };

export type DrawSizeLike = { width: number; height: number };

export type ShaderRenderer = {
  /** 适配并编译新源码；成功时才替换当前 Program。 */
  load(source: string): LoadResult;
  /** 卸载当前 Program（空源码 / context lost）。 */
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

export function createShaderRenderer(
  options: ShaderRendererOptions,
): ShaderRenderer {
  const { canvas, context } = options;
  const gl = context.gl;
  let handle: ProgramHandle | null = null;
  let channels: ChannelTextures | null = null;
  let size: DrawSizeLike = { width: 1, height: 1 };

  const applySize = (): void => {
    const width = Math.max(1, Math.round(size.width));
    const height = Math.max(1, Math.round(size.height));
    if (canvas.width !== width) canvas.width = width;
    if (canvas.height !== height) canvas.height = height;
    gl.viewport(0, 0, width, height);
  };

  const clear = (): void => {
    applySize();
    gl.clearColor(0, 0, 0, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
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
      const profile = detectShaderProfile(source);
      if (!profile.ok) return { ok: false, diagnostic: profile.diagnostic };
      const channelInputs = findExternalInputs(profile.source);

      const adapted =
        profile.profile === "raw-fragment"
          ? adaptRawFragment(profile.source, {
              derivativesSupported: context.derivativesSupported,
            })
          : adaptShadertoyImage(profile.source, {
              derivativesSupported: context.derivativesSupported,
            });
      if (!adapted.ok) return { ok: false, diagnostic: adapted.diagnostic };

      const compiled = compileProgram(gl, {
        vertexSource: adapted.shader.vertexSource,
        fragmentSource: adapted.shader.fragmentSource,
        lineOffset: adapted.shader.lineOffset,
      });
      if (!compiled.ok) return { ok: false, diagnostic: compiled.diagnostic };

      const next = createProgramHandle(
        gl,
        compiled.program,
        adapted.shader.lineOffset,
      );
      channels ??= createChannelTextures(gl);
      handle?.dispose();
      handle = next;

      gl.disable(gl.DEPTH_TEST);
      gl.disable(gl.BLEND);
      gl.disable(gl.CULL_FACE);
      clear();

      const warnings = [...adapted.shader.warnings];
      if (channelInputs.length > 0) {
        warnings.push(
          `外部输入使用占位值（${channelInputs.join(", ")}）：iChannel0 = 256×256 程序化噪声，iChannel1-3 = 1×1 黑色，iSampleRate = 44100；与原始纹理/音频/键盘通道不等价。`,
        );
      }

      return {
        ok: true,
        lineOffset: adapted.shader.lineOffset,
        warnings,
        channels: channelInputs,
      };
    },
    unload() {
      handle?.dispose();
      handle = null;
      channels?.dispose();
      channels = null;
      clear();
    },
    resize(next) {
      size = next;
      applySize();
    },
    render(values) {
      if (!handle || context.isLost()) return;
      clear();
      channels?.bind();
      handle.setUniforms(values);
      handle.draw();
    },
    hasProgram() {
      return handle !== null;
    },
    dispose() {
      handle?.dispose();
      handle = null;
      channels?.dispose();
      channels = null;
    },
  };
}
