/**
 * WebGL Shader 编译与 Program 链接（RFC §8.1）。
 *
 * 编译/链接结果是最终判定依据；任何失败都带原始 InfoLog 返回，绝不吞掉。
 */
import { diagnostic, type ShaderDiagnostic } from "./diagnostics";

export type CompileResult =
  | { ok: true; program: WebGLProgram }
  | { ok: false; diagnostic: ShaderDiagnostic };

export type CompileInput = {
  vertexSource: string;
  fragmentSource: string;
  /** 生成源码相对用户源码多出的行数（只用于提示行号偏移）。 */
  lineOffset: number;
};

function readLog(gl: WebGLRenderingContext, shader: WebGLShader): string {
  const log = (gl.getShaderInfoLog(shader) ?? "").trim();
  return log === "" ? "（编译器没有返回日志 / no compiler log）" : log;
}

function compileStage(
  gl: WebGLRenderingContext,
  type: number,
  source: string,
): { ok: true; shader: WebGLShader } | { ok: false; log: string } {
  const shader = gl.createShader(type);
  if (!shader) {
    return {
      ok: false,
      log: "gl.createShader 返回 null / createShader returned null",
    };
  }
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const log = readLog(gl, shader);
    gl.deleteShader(shader);
    return { ok: false, log };
  }
  return { ok: true, shader };
}

export function compileProgram(
  gl: WebGLRenderingContext,
  input: CompileInput,
): CompileResult {
  if (gl.isContextLost?.()) {
    return {
      ok: false,
      diagnostic: diagnostic(
        "context-lost",
        "WebGL 上下文已丢失，暂时无法编译。 / The WebGL context is lost.",
      ),
    };
  }

  const vertex = compileStage(gl, gl.VERTEX_SHADER, input.vertexSource);
  if (!vertex.ok) {
    return {
      ok: false,
      diagnostic: diagnostic(
        "compile-failed",
        "顶点着色器编译失败（运行时模板问题，不是用户源码）。 / The runtime vertex shader failed to compile.",
        vertex.log,
      ),
    };
  }

  const fragment = compileStage(gl, gl.FRAGMENT_SHADER, input.fragmentSource);
  if (!fragment.ok) {
    gl.deleteShader(vertex.shader);
    return {
      ok: false,
      diagnostic: diagnostic(
        "compile-failed",
        "着色器编译失败。 / Shader failed to compile.",
        fragment.log,
        input.lineOffset,
      ),
    };
  }

  const program = gl.createProgram();
  if (!program) {
    gl.deleteShader(vertex.shader);
    gl.deleteShader(fragment.shader);
    return {
      ok: false,
      diagnostic: diagnostic(
        "runtime-error",
        "无法创建 WebGL Program。 / Could not create a WebGL program.",
      ),
    };
  }

  gl.attachShader(program, vertex.shader);
  gl.attachShader(program, fragment.shader);
  gl.linkProgram(program);

  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    const log =
      (gl.getProgramInfoLog(program) ?? "").trim() ||
      "（链接器没有返回日志 / no linker log）";
    gl.deleteProgram(program);
    gl.deleteShader(vertex.shader);
    gl.deleteShader(fragment.shader);
    return {
      ok: false,
      diagnostic: diagnostic(
        "link-failed",
        "Program 链接失败。 / Failed to link the program.",
        log,
        input.lineOffset,
      ),
    };
  }

  // 链接完成后 shader 对象可以释放；Program 会保留已编译代码。
  gl.deleteShader(vertex.shader);
  gl.deleteShader(fragment.shader);

  return { ok: true, program };
}
