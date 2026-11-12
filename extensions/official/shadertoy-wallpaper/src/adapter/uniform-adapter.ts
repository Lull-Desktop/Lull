/**
 * Uniform 适配（RFC §7.1）：把运行时状态映射成 Shadertoy Image 的 uniform 值。
 *
 * 只提供真实语义：没有点击状态时 `iMouse.zw` 恒为 -1；`iDate` 用真实本地时间。
 */

export type UniformValues = {
  resolution: readonly [number, number];
  /** iResolution.z；2D Pass 为 1，Volume Pass 为体积边长。默认 1。 */
  resolutionZ?: number;
  time: number;
  timeDelta: number;
  frame: number;
  frameRate: number;
  mouse: readonly [number, number, number, number];
  date: readonly [number, number, number, number];
};

export function dateUniform(
  now: Date = new Date(),
): [number, number, number, number] {
  const seconds =
    now.getHours() * 3600 +
    now.getMinutes() * 60 +
    now.getSeconds() +
    now.getMilliseconds() / 1000;
  return [now.getFullYear(), now.getMonth(), now.getDate(), seconds];
}

export type BuildUniformsInput = {
  width: number;
  height: number;
  time: number;
  timeDelta: number;
  frame: number;
  frameRate: number;
  mouse: readonly [number, number, number, number];
  now?: Date;
};

export function buildUniforms(input: BuildUniformsInput): UniformValues {
  return {
    resolution: [input.width, input.height],
    time: input.time,
    timeDelta: input.timeDelta,
    frame: input.frame,
    frameRate: input.frameRate,
    mouse: input.mouse,
    date: dateUniform(input.now),
  };
}
