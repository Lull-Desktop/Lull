#version 300 es
// 需要 WebGL2 的视觉 shader：texelFetch / textureSize / 整数数组 / 位运算。
// 运行时会在 WebGL2 上按 GLSL ES 3.00 编译；只有 WebGL1 时会显示明确诊断。
const int[] GLYPH = int[](0x3C, 0x66, 0x6E, 0x76, 0x66, 0x66, 0x3C);

void mainImage(out vec4 fragColor, in vec2 fragCoord) {
  vec2 uv = fragCoord / iResolution.xy;
  ivec2 size = textureSize(iChannel0, 0);
  vec4 noise = texelFetch(iChannel0, ivec2(uv * vec2(size)), 0);

  int row = min(int(uv.y * 7.0), 6);
  int column = min(int(uv.x * 8.0), 7);
  int bit = (GLYPH[row] >> column) & 1;

  vec3 ink = mix(vec3(0.04, 0.07, 0.11), vec3(0.24, 0.92, 0.66), float(bit));
  fragColor = vec4(ink + noise.rgb * 0.08, 1.0);
}