// 最小示例：时间驱动的渐变。用于验证 mainImage 适配与 iTime / iResolution。
void mainImage(out vec4 fragColor, in vec2 fragCoord) {
  vec2 uv = fragCoord / iResolution.xy;
  float wave = 0.5 + 0.5 * sin(iTime * 0.6 + uv.x * 6.28318);
  vec3 color = mix(
    vec3(0.05, 0.09, 0.16),
    vec3(0.36, 0.82, 0.69),
    smoothstep(0.0, 1.0, uv.y * wave)
  );
  fragColor = vec4(color, 1.0);
}