// 噪声流动示例：验证 texture() 兼容宏之外的纯数学路径、iMouse 与 iFrame。
float hash(vec2 p) {
  return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123);
}

float noise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(
    mix(hash(i), hash(i + vec2(1.0, 0.0)), u.x),
    mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), u.x),
    u.y
  );
}

void mainImage(out vec4 fragColor, in vec2 fragCoord) {
  vec2 uv = fragCoord / iResolution.xy;
  vec2 flow = uv * 3.5;
  flow.x += iTime * 0.12;
  flow.y += noise(flow + iTime * 0.05);

  float value = noise(flow * 2.0);
  float pointer = iMouse.x < 0.0 ? 0.0 : iMouse.x / iResolution.x;
  vec3 color = mix(
    vec3(0.04, 0.07, 0.12),
    vec3(0.28, 0.62, 0.85),
    clamp(value + pointer * 0.25, 0.0, 1.0)
  );
  fragColor = vec4(color, 1.0);
}