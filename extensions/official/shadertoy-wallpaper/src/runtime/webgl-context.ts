/**
 * WebGL 上下文生命周期（RFC §8.1 / §8.4）。
 *
 * 优先申请 WebGL2：ES 3.00 源码（texelFetch / 整数运算等）只能在 WebGL2 编译；
 * WebGL2 同样接受 ES 1.00 源码，因此不需要为了兼容旧 shader 保留 WebGL1 首选。
 * 只有环境没有 WebGL2 时才回退 WebGL1（仅 ES 1.00）。
 */
import { diagnostic, type ShaderDiagnostic } from "./diagnostics";

export type GlContext = {
  gl: WebGLRenderingContext;
  canvas: HTMLCanvasElement;
  /** 创建的是 WebGL1 还是 WebGL2 上下文。 */
  version: 1 | 2;
  /**
   * WebGL1 是否支持 OES_standard_derivatives。
   *
   * WebGL2 的导数是核心能力，但 API 不暴露 OES 扩展；这里仍返回 false，迫使
   * renderer 在 WebGL2 下把导数源码交给 ES 3.00 适配器，而不是错误地添加 OES
   * `#extension`。
   */
  derivativesSupported: boolean;
  isLost(): boolean;
  onLost(listener: () => void): () => void;
  onRestored(listener: () => void): () => void;
  destroy(): void;
};

export type CreateContextResult =
  | { ok: true; context: GlContext }
  | { ok: false; diagnostic: ShaderDiagnostic };

/** 壁纸不需要 alpha / 深度 / 模板，省带宽也省显存。 */
export const CONTEXT_ATTRIBUTES: WebGLContextAttributes = {
  alpha: false,
  antialias: false,
  depth: false,
  stencil: false,
  preserveDrawingBuffer: false,
  premultipliedAlpha: false,
  powerPreference: "high-performance",
};

type ContextProbe = {
  gl: WebGLRenderingContext;
  version: 1 | 2;
  derivativesSupported: boolean;
};

export type ContextFactory = (canvas: HTMLCanvasElement) => ContextProbe | null;

function defaultFactory(canvas: HTMLCanvasElement): ContextProbe | null {
  const webgl2 = canvas.getContext("webgl2", CONTEXT_ATTRIBUTES);
  if (webgl2) {
    // WebGL2 不暴露 OES_standard_derivatives（ES 3.00 里是核心能力）；
    // 这里保守地当作「不支持」，让 renderer 把导数源码走 ES3 适配。
    return {
      gl: webgl2 as unknown as WebGLRenderingContext,
      version: 2,
      derivativesSupported: false,
    };
  }
  const webgl1 = canvas.getContext("webgl", CONTEXT_ATTRIBUTES);
  if (webgl1) {
    const gl = webgl1 as WebGLRenderingContext;
    return {
      gl,
      version: 1,
      derivativesSupported:
        gl.getExtension("OES_standard_derivatives") !== null,
    };
  }
  return null;
}

export function createWebglContext(
  canvas: HTMLCanvasElement,
  factory: ContextFactory = defaultFactory,
): CreateContextResult {
  let probe: ContextProbe | null = null;
  try {
    probe = factory(canvas);
  } catch (error) {
    return {
      ok: false,
      diagnostic: diagnostic(
        "webgl-unavailable",
        "创建 WebGL 上下文时抛出异常。 / Creating a WebGL context threw.",
        error instanceof Error ? error.message : String(error),
      ),
    };
  }
  if (!probe) {
    return {
      ok: false,
      diagnostic: diagnostic(
        "webgl-unavailable",
        "当前环境无法创建 WebGL 上下文，着色器壁纸不可用。 / WebGL is unavailable in this environment.",
      ),
    };
  }

  const { gl, version, derivativesSupported } = probe;
  const lostListeners = new Set<() => void>();
  const restoredListeners = new Set<() => void>();
  let lost = false;

  const handleLost = (event: Event): void => {
    // 不 preventDefault 就不会触发 restored；资源已失效但由我们统一重建。
    event.preventDefault();
    lost = true;
    for (const listener of [...lostListeners]) listener();
  };
  const handleRestored = (): void => {
    lost = false;
    for (const listener of [...restoredListeners]) listener();
  };

  canvas.addEventListener("webglcontextlost", handleLost, false);
  canvas.addEventListener("webglcontextrestored", handleRestored, false);

  const loseExtension = gl.getExtension("WEBGL_lose_context") as {
    loseContext(): void;
  } | null;

  const context: GlContext = {
    gl,
    canvas,
    version,
    derivativesSupported,
    isLost() {
      return lost || gl.isContextLost();
    },
    onLost(listener) {
      lostListeners.add(listener);
      return () => lostListeners.delete(listener);
    },
    onRestored(listener) {
      restoredListeners.add(listener);
      return () => restoredListeners.delete(listener);
    },
    destroy() {
      canvas.removeEventListener("webglcontextlost", handleLost, false);
      canvas.removeEventListener("webglcontextrestored", handleRestored, false);
      lostListeners.clear();
      restoredListeners.clear();
      try {
        loseExtension?.loseContext();
      } catch {
        // 上下文已经失效时忽略。
      }
    },
  };
  return { ok: true, context };
}
