/**
 * Volume Pass 的反馈缓冲：两张 3D 纹理（in / out）+ FBO 逐层渲染。
 *
 * 与 2D 反馈一致的采样语义：`outputTexture()` 在本帧开始前是上一帧结果；
 * `beginFrame()` 交换 in/out 后，本帧逐 slice 写入新的 out。同一 Volume 的
 * `iChannelN` 指向自己时读到上一帧的完整体积。
 *
 * 每帧渲染全部 slice（而不是每次只更新一层）：体积 shader 常用多帧迭代
 * （如距离场传播）收敛，逐层更新会让初始化期出现未收敛的空洞。
 *
 * 必须 half-float（RGBA16F）：体积里常存负的距离值，RGBA8 会把负值截断为 0。
 * 因此需要 WebGL2 + EXT_color_buffer_float，不做 RGBA8 回退。
 */
import type { GlContext } from "./webgl-context";

/** 默认体积边长（体素数）；与 Shadertoy 体积缓冲一致。 */
export const DEFAULT_VOLUME_SIZE = 128;

export type VolumeTarget = {
  /** 体积边长（size × size × size 体素）。 */
  readonly size: number;
  /** 当前可采样的 3D 输出纹理（本帧开始前是上一帧结果）。 */
  outputTexture(): WebGLTexture | null;
  /** 交换 in/out；随后逐 slice 调用 bindSlice 并绘制。 */
  beginFrame(): void;
  /** 把 FBO 绑定到 out 纹理的第 slice 层并设置 viewport。 */
  bindSlice(slice: number): void;
  endFrame(): void;
  dispose(): void;
};

function createVolumeTexture(
  gl: WebGL2RenderingContext,
  size: number,
): WebGLTexture | null {
  const texture = gl.createTexture();
  if (!texture) return null;
  gl.bindTexture(gl.TEXTURE_3D, texture);
  gl.texImage3D(
    gl.TEXTURE_3D,
    0,
    gl.RGBA16F,
    size,
    size,
    size,
    0,
    gl.RGBA,
    gl.HALF_FLOAT,
    null,
  );
  // RGBA16F 在 ES 3.00 核心里可线性过滤（三线性采样体积需要）。
  gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_R, gl.CLAMP_TO_EDGE);
  gl.bindTexture(gl.TEXTURE_3D, null);
  return texture;
}

export function createVolumeTarget(
  context: GlContext,
  size: number,
): VolumeTarget {
  if (context.version !== 2) {
    throw new Error("体积反馈缓冲需要 WebGL2 / Volume feedback needs WebGL2");
  }
  const gl = context.gl as WebGL2RenderingContext;
  if (!gl.getExtension("EXT_color_buffer_float")) {
    throw new Error(
      "缺少 EXT_color_buffer_float，无法渲染到体积纹理 / EXT_color_buffer_float is required for volume render targets",
    );
  }
  const n = Math.max(1, Math.round(size));

  const fbo = gl.createFramebuffer();
  const first = createVolumeTexture(gl, n);
  const second = createVolumeTexture(gl, n);
  if (!fbo || !first || !second) {
    if (fbo) gl.deleteFramebuffer(fbo);
    if (first) gl.deleteTexture(first);
    if (second) gl.deleteTexture(second);
    throw new Error("无法创建体积纹理 / Cannot create volume textures");
  }

  gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
  gl.framebufferTextureLayer(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, first, 0, 0);
  const complete =
    gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE;
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  if (!complete) {
    gl.deleteTexture(first);
    gl.deleteTexture(second);
    gl.deleteFramebuffer(fbo);
    throw new Error("体积 FBO 不完整 / Volume framebuffer is incomplete");
  }

  let out: WebGLTexture | null = first;
  let inTexture: WebGLTexture | null = second;

  return {
    size: n,
    outputTexture() {
      return out;
    },
    beginFrame() {
      const swap = inTexture;
      inTexture = out;
      out = swap;
    },
    bindSlice(slice) {
      if (!out) return;
      gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
      gl.framebufferTextureLayer(
        gl.FRAMEBUFFER,
        gl.COLOR_ATTACHMENT0,
        out,
        0,
        slice,
      );
      gl.viewport(0, 0, n, n);
    },
    endFrame() {
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    },
    dispose() {
      if (out) gl.deleteTexture(out);
      if (inTexture) gl.deleteTexture(inTexture);
      if (fbo) gl.deleteFramebuffer(fbo);
      out = null;
      inTexture = null;
    },
  };
}
