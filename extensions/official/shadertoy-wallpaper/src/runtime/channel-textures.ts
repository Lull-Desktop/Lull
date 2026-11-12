/**
 * Shadertoy 外部输入的占位纹理（RFC §7.1）。
 *
 * 宿主无法提供真实的纹理 / 音频 / 键盘通道，因此这里生成一组确定性的占位输入：
 * - `Noise`：256×256 RGBA 程序化噪声（白噪声，种子固定，跨启动一致）；
 * - `Black`：1×1 黑色。
 *
 * 单 Pass 模式下 `iChannel0` 默认绑定 Noise，其余通道 Black；多 Pass 模式下
 * buffer 通道由反馈缓冲提供，这里只负责非 buffer 来源。
 */

export const CHANNEL_COUNT = 4;
/** 噪声纹理边长；2 的幂，满足 WebGL1 对 REPEAT 的要求。 */
export const NOISE_SIZE = 256;
export const DEFAULT_SAMPLE_RATE = 44_100;
const NOISE_SEED = 0x51ed_270b;

/** `uniform float iChannelTime[4]`：静态纹理没有播放时间。 */
export const CHANNEL_TIMES = new Float32Array(CHANNEL_COUNT);

export type ChannelTexture = {
  texture: WebGLTexture | null;
  width: number;
  height: number;
  /** 3D 纹理的层数（体积边长）；2D 纹理不带此字段。 */
  depth?: number;
  /** 纹理目标；默认 2d。Volume Pass 的输出为 3d。 */
  kind?: "2d" | "3d";
};

export type ChannelTextures = {
  noise: ChannelTexture;
  black: ChannelTexture;
  dispose(): void;
};

function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b_79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  };
}

/** 生成确定性的 RGBA 白噪声；测试与运行时共用同一份实现。 */
export function createNoisePixels(size: number = NOISE_SIZE): Uint8Array {
  const pixels = new Uint8Array(size * size * 4);
  const random = mulberry32(NOISE_SEED);
  for (let index = 0; index < pixels.length; index += 4) {
    pixels[index] = Math.floor(random() * 256);
    pixels[index + 1] = Math.floor(random() * 256);
    pixels[index + 2] = Math.floor(random() * 256);
    pixels[index + 3] = 255;
  }
  return pixels;
}

function uploadTexture(
  gl: WebGLRenderingContext,
  width: number,
  height: number,
  pixels: Uint8Array,
): WebGLTexture | null {
  const texture = gl.createTexture();
  if (!texture) return null;
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.texImage2D(
    gl.TEXTURE_2D,
    0,
    gl.RGBA,
    width,
    height,
    0,
    gl.RGBA,
    gl.UNSIGNED_BYTE,
    pixels,
  );
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.REPEAT);
  return texture;
}

export function createChannelTextures(
  gl: WebGLRenderingContext,
): ChannelTextures {
  const noise = uploadTexture(gl, NOISE_SIZE, NOISE_SIZE, createNoisePixels());
  const black = uploadTexture(gl, 1, 1, new Uint8Array([0, 0, 0, 255]));

  return {
    noise: { texture: noise, width: NOISE_SIZE, height: NOISE_SIZE },
    black: { texture: black, width: 1, height: 1 },
    dispose() {
      if (noise) gl.deleteTexture(noise);
      if (black) gl.deleteTexture(black);
    },
  };
}
