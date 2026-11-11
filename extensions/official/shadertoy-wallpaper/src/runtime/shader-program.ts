/**
 * Program 句柄：uniform 定位、全屏四边形与绘制/释放。
 *
 * uniform 只在链接成功后解析一次；源码没真正使用的 uniform 位置为 null，
 * 设置时跳过（不报错、不伪造值）。
 */
// biome-ignore-all lint/correctness/useHookAtTopLevel: WebGL 的 gl.useProgram 不是 React Hook

import { UNIFORM_NAMES } from "../adapter/shader-template";
import type { UniformValues } from "../adapter/uniform-adapter";
import {
  CHANNEL_RESOLUTIONS,
  CHANNEL_TIMES,
  DEFAULT_SAMPLE_RATE,
} from "./channel-textures";

export type ProgramHandle = {
  readonly program: WebGLProgram;
  readonly lineOffset: number;
  setUniforms(values: UniformValues): void;
  draw(): void;
  dispose(): void;
};

/** 两个三角形拼成的全屏四边形（TRIANGLE_STRIP 顺序）。 */
export const QUAD_VERTICES = new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]);

const ATTRIBUTE_NAME = "aPosition";
const CHANNEL_SAMPLERS = [
  "iChannel0",
  "iChannel1",
  "iChannel2",
  "iChannel3",
] as const;
const ARRAY_LOCATIONS = ["iChannelResolution[0]", "iChannelTime[0]"] as const;

export function createProgramHandle(
  gl: WebGLRenderingContext,
  program: WebGLProgram,
  lineOffset: number,
): ProgramHandle {
  const buffer = gl.createBuffer();
  if (buffer) {
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, QUAD_VERTICES, gl.STATIC_DRAW);
  }

  const attribute = gl.getAttribLocation(program, ATTRIBUTE_NAME);
  const locations = new Map<string, WebGLUniformLocation | null>();
  for (const name of [...UNIFORM_NAMES, ...ARRAY_LOCATIONS]) {
    locations.set(name, gl.getUniformLocation(program, name));
  }

  let disposed = false;

  const uniform = (name: string): WebGLUniformLocation | null =>
    locations.get(name) ?? null;

  return {
    program,
    lineOffset,
    setUniforms(values) {
      if (disposed) return;
      gl.useProgram(program);
      const resolution = uniform("iResolution");
      if (resolution) {
        gl.uniform3f(resolution, values.resolution[0], values.resolution[1], 1);
      }
      const time = uniform("iTime");
      if (time) gl.uniform1f(time, values.time);
      const timeDelta = uniform("iTimeDelta");
      if (timeDelta) gl.uniform1f(timeDelta, values.timeDelta);
      const frameRate = uniform("iFrameRate");
      if (frameRate) gl.uniform1f(frameRate, values.frameRate);
      const frame = uniform("iFrame");
      if (frame) gl.uniform1i(frame, values.frame);
      const mouse = uniform("iMouse");
      if (mouse) {
        gl.uniform4f(
          mouse,
          values.mouse[0],
          values.mouse[1],
          values.mouse[2],
          values.mouse[3],
        );
      }
      const date = uniform("iDate");
      if (date) {
        gl.uniform4f(
          date,
          values.date[0],
          values.date[1],
          values.date[2],
          values.date[3],
        );
      }
      CHANNEL_SAMPLERS.forEach((name, unit) => {
        const location = uniform(name);
        if (location) gl.uniform1i(location, unit);
      });
      const channelResolution = uniform("iChannelResolution[0]");
      if (channelResolution) {
        gl.uniform3fv(channelResolution, CHANNEL_RESOLUTIONS);
      }
      const channelTime = uniform("iChannelTime[0]");
      if (channelTime) gl.uniform1fv(channelTime, CHANNEL_TIMES);
      const sampleRate = uniform("iSampleRate");
      if (sampleRate) gl.uniform1f(sampleRate, DEFAULT_SAMPLE_RATE);
    },
    draw() {
      if (disposed || attribute < 0) return;
      gl.useProgram(program);
      if (buffer) {
        gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
        gl.enableVertexAttribArray(attribute);
        gl.vertexAttribPointer(attribute, 2, gl.FLOAT, false, 0, 0);
      }
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      if (buffer) gl.deleteBuffer(buffer);
      gl.deleteProgram(program);
    },
  };
}
