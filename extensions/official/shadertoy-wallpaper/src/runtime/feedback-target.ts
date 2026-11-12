/**
 * 多 Pass 的反馈缓冲：FBO + 两张纹理（in / out）。
 *
 * 采样语义与 Shadertoy 一致：读取 `out`（上一帧结果）并在交换后写入另一张纹理；
 * 因此同一 Pass 的 `iChannelN` 指向自己时得到上一帧，其他 Pass 读到它们本帧的最新输出。
 *
 * 优先 half-float，失败时回退 RGBA8；两者都通过 FBO completeness 检查。
 */
import type { GlContext } from "./webgl-context";

export type FeedbackFormat = "half-float" | "rgba8";

export type FeedbackTarget = {
  readonly format: FeedbackFormat;
  readonly width: number;
  readonly height: number;
  /** 当前可采样的输出纹理（本帧开始前是上一帧结果）。 */
  outputTexture(): WebGLTexture | null;
  /** 交换 in/out、绑定 FBO 并设置 viewport；随后即可绘制。 */
  beginDraw(): void;
  endDraw(): void;
  resize(width: number, height: number): void;
  dispose(): void;
};

type FormatSpec = {
  format: FeedbackFormat;
  internalFormat: number;
  type: number;
  linear: boolean;
};

type HalfFloatOes = { HALF_FLOAT_OES: number };

const RGBA8_SPEC: Omit<FormatSpec, "internalFormat" | "type"> = {
  format: "rgba8",
  linear: true,
};

function resolveFormat(gl: WebGLRenderingContext, version: 1 | 2): FormatSpec {
  const rgba8: FormatSpec = {
    ...RGBA8_SPEC,
    internalFormat: gl.RGBA,
    type: gl.UNSIGNED_BYTE,
  };

  if (version === 2) {
    if (!gl.getExtension("EXT_color_buffer_float")) return rgba8;
    const gl2 = gl as WebGL2RenderingContext;
    return {
      format: "half-float",
      internalFormat: gl2.RGBA16F,
      type: gl2.HALF_FLOAT,
      linear: gl.getExtension("OES_texture_float_linear") !== null,
    };
  }

  const half = gl.getExtension("OES_texture_half_float") as HalfFloatOes | null;
  const colorBuffer = gl.getExtension("EXT_color_buffer_half_float");
  if (half && colorBuffer) {
    return {
      format: "half-float",
      internalFormat: gl.RGBA,
      type: half.HALF_FLOAT_OES,
      linear: gl.getExtension("OES_texture_half_float_linear") !== null,
    };
  }
  return rgba8;
}

function createTexture(
  gl: WebGLRenderingContext,
  width: number,
  height: number,
  spec: FormatSpec,
): WebGLTexture | null {
  const texture = gl.createTexture();
  if (!texture) return null;
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.texImage2D(
    gl.TEXTURE_2D,
    0,
    spec.internalFormat,
    width,
    height,
    0,
    gl.RGBA,
    spec.type,
    null,
  );
  const filter = spec.linear ? gl.LINEAR : gl.NEAREST;
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.bindTexture(gl.TEXTURE_2D, null);
  return texture;
}

function tryFormat(
  gl: WebGLRenderingContext,
  width: number,
  height: number,
  spec: FormatSpec,
): { fbo: WebGLFramebuffer; first: WebGLTexture; second: WebGLTexture } | null {
  const fbo = gl.createFramebuffer();
  if (!fbo) return null;
  const first = createTexture(gl, width, height, spec);
  const second = createTexture(gl, width, height, spec);
  if (!first || !second) {
    gl.deleteFramebuffer(fbo);
    if (first) gl.deleteTexture(first);
    if (second) gl.deleteTexture(second);
    return null;
  }

  gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
  gl.framebufferTexture2D(
    gl.FRAMEBUFFER,
    gl.COLOR_ATTACHMENT0,
    gl.TEXTURE_2D,
    first,
    0,
  );
  const complete =
    gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE;
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);

  if (!complete) {
    gl.deleteTexture(first);
    gl.deleteTexture(second);
    gl.deleteFramebuffer(fbo);
    return null;
  }
  return { fbo, first, second };
}

export function createFeedbackTarget(
  context: GlContext,
  width: number,
  height: number,
): FeedbackTarget {
  const gl = context.gl;
  let spec = resolveFormat(gl, context.version);
  let created = tryFormat(gl, width, height, spec);
  if (!created && spec.format !== "rgba8") {
    spec = {
      ...RGBA8_SPEC,
      internalFormat: gl.RGBA,
      type: gl.UNSIGNED_BYTE,
    };
    created = tryFormat(gl, width, height, spec);
  }
  if (!created) {
    throw new Error("无法创建多 Pass 反馈缓冲（FBO 不完整）");
  }

  let size = { width, height };
  let fbo: WebGLFramebuffer | null = created.fbo;
  let out: WebGLTexture | null = created.first;
  let inTexture: WebGLTexture | null = created.second;

  const bindWrite = (): void => {
    if (!fbo) return;
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(
      gl.FRAMEBUFFER,
      gl.COLOR_ATTACHMENT0,
      gl.TEXTURE_2D,
      out,
      0,
    );
    gl.viewport(0, 0, size.width, size.height);
  };

  return {
    get format() {
      return spec.format;
    },
    get width() {
      return size.width;
    },
    get height() {
      return size.height;
    },
    outputTexture() {
      return out;
    },
    beginDraw() {
      const swap = inTexture;
      inTexture = out;
      out = swap;
      bindWrite();
    },
    endDraw() {
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    },
    resize(nextWidth, nextHeight) {
      const w = Math.max(1, Math.round(nextWidth));
      const h = Math.max(1, Math.round(nextHeight));
      if (w === size.width && h === size.height) return;

      const next = tryFormat(gl, w, h, spec);
      if (!next) return;

      if (out) gl.deleteTexture(out);
      if (inTexture) gl.deleteTexture(inTexture);
      if (fbo) gl.deleteFramebuffer(fbo);
      fbo = next.fbo;
      out = next.first;
      inTexture = next.second;
      size = { width: w, height: h };
    },
    dispose() {
      if (out) gl.deleteTexture(out);
      if (inTexture) gl.deleteTexture(inTexture);
      if (fbo) gl.deleteFramebuffer(fbo);
      out = null;
      inTexture = null;
      fbo = null;
    },
  };
}
