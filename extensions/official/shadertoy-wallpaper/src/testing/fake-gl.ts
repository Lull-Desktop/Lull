/**
 * 测试用 WebGL 假实现：只覆盖运行时实际调用的方法，用于在 jsdom 里验证
 * 编译/链接失败路径、Program 切换与绘制调用，不需要真实 GPU。
 */
import type { GlContext } from "../runtime/webgl-context";

export type FakeGlOptions = {
  /** 顶点与片段都编译失败。 */
  failCompile?: boolean;
  /** 只有片段着色器失败（模拟用户源码错误）。 */
  failFragmentCompile?: boolean;
  failLink?: boolean;
  lost?: boolean;
};

export type FakeGlState = {
  failCompile: boolean;
  failFragmentCompile: boolean;
  failLink: boolean;
  lost: boolean;
  programs: number;
  deletedPrograms: number;
  textures: number;
  deletedTextures: number;
  texImages: { width: number; height: number }[];
  calls: string[];
};

export type FakeGl = {
  gl: WebGLRenderingContext;
  state: FakeGlState;
};

export function createFakeGl(options: FakeGlOptions = {}): FakeGl {
  const state: FakeGlState = {
    failCompile: options.failCompile ?? false,
    failFragmentCompile: options.failFragmentCompile ?? false,
    failLink: options.failLink ?? false,
    lost: options.lost ?? false,
    programs: 0,
    deletedPrograms: 0,
    textures: 0,
    deletedTextures: 0,
    texImages: [],
    calls: [],
  };

  const gl = {
    VERTEX_SHADER: 0x8b31,
    FRAGMENT_SHADER: 0x8b30,
    COMPILE_STATUS: 0x8b81,
    LINK_STATUS: 0x8b82,
    ARRAY_BUFFER: 0x8892,
    STATIC_DRAW: 0x88e4,
    FLOAT: 0x1406,
    TRIANGLE_STRIP: 0x0005,
    COLOR_BUFFER_BIT: 0x4000,
    DEPTH_TEST: 0x0b71,
    BLEND: 0x0be2,
    CULL_FACE: 0x0b44,
    TEXTURE_2D: 0x0de1,
    TEXTURE0: 0x84c0,
    RGBA: 0x1908,
    UNSIGNED_BYTE: 0x1401,
    TEXTURE_MIN_FILTER: 0x2801,
    TEXTURE_MAG_FILTER: 0x2800,
    TEXTURE_WRAP_S: 0x2802,
    TEXTURE_WRAP_T: 0x2803,
    LINEAR: 0x2601,
    REPEAT: 0x2901,
    isContextLost: () => state.lost,
    createShader: (type: number) => ({ kind: "shader", type }),
    shaderSource: () => undefined,
    compileShader: () => undefined,
    getShaderParameter: (shader: { type?: number }) =>
      shader.type === 0x8b30
        ? !(state.failCompile || state.failFragmentCompile)
        : !state.failCompile,
    getShaderInfoLog: () =>
      state.failCompile || state.failFragmentCompile
        ? "ERROR: 0:12: 'unknownFunction' : no matching overloaded function found"
        : "",
    deleteShader: () => undefined,
    createProgram: () => {
      state.programs += 1;
      return { kind: "program", id: state.programs };
    },
    attachShader: () => undefined,
    linkProgram: () => undefined,
    getProgramParameter: () => !state.failLink,
    getProgramInfoLog: () =>
      state.failLink ? "link failed: varying mismatch" : "",
    deleteProgram: () => {
      state.deletedPrograms += 1;
    },
    createBuffer: () => ({ kind: "buffer" }),
    bindBuffer: () => undefined,
    bufferData: () => undefined,
    getAttribLocation: () => 0,
    getUniformLocation: (_program: unknown, name: string) => ({ name }),
    useProgram: () => undefined,
    uniform3f: () => state.calls.push("uniform3f"),
    uniform1f: () => state.calls.push("uniform1f"),
    uniform1i: () => state.calls.push("uniform1i"),
    uniform4f: () => state.calls.push("uniform4f"),
    uniform3fv: () => state.calls.push("uniform3fv"),
    uniform1fv: () => state.calls.push("uniform1fv"),
    createTexture: () => {
      state.textures += 1;
      return { kind: "texture", id: state.textures };
    },
    bindTexture: () => state.calls.push("bindTexture"),
    texImage2D: (
      _target: number,
      _level: number,
      _internalFormat: number,
      width: number,
      height: number,
    ) => {
      state.texImages.push({ width, height });
      state.calls.push("texImage2D");
    },
    texParameteri: () => state.calls.push("texParameteri"),
    activeTexture: () => state.calls.push("activeTexture"),
    deleteTexture: () => {
      state.deletedTextures += 1;
      state.calls.push("deleteTexture");
    },
    enableVertexAttribArray: () => undefined,
    vertexAttribPointer: () => undefined,
    drawArrays: () => state.calls.push("drawArrays"),
    viewport: () => state.calls.push("viewport"),
    clearColor: () => undefined,
    clear: () => undefined,
    disable: () => undefined,
    deleteBuffer: () => undefined,
    getExtension: () => null,
  };

  return { gl: gl as unknown as WebGLRenderingContext, state };
}

export type FakeContext = GlContext & {
  lose(): void;
  restore(): void;
};

export function createFakeContext(
  gl: WebGLRenderingContext,
  options: { derivativesSupported?: boolean; lost?: boolean } = {},
): FakeContext {
  let lost = options.lost ?? false;
  const lostListeners = new Set<() => void>();
  const restoredListeners = new Set<() => void>();

  return {
    gl,
    canvas: { width: 300, height: 150 } as HTMLCanvasElement,
    derivativesSupported: options.derivativesSupported ?? false,
    isLost: () => lost,
    onLost(listener) {
      lostListeners.add(listener);
      return () => lostListeners.delete(listener);
    },
    onRestored(listener) {
      restoredListeners.add(listener);
      return () => restoredListeners.delete(listener);
    },
    destroy() {
      lostListeners.clear();
      restoredListeners.clear();
    },
    lose() {
      lost = true;
      for (const listener of [...lostListeners]) listener();
    },
    restore() {
      lost = false;
      for (const listener of [...restoredListeners]) listener();
    },
  };
}
