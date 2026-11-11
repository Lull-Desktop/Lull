// 故意失败：mainImage 调用了不存在的函数，用于验证编译错误日志可见且旧画面保留。
void mainImage(out vec4 fragColor, in vec2 fragCoord) {
  vec2 uv = fragCoord / iResolution.xy;
  fragColor = vec4(unknownFunction(uv), 1.0);
}