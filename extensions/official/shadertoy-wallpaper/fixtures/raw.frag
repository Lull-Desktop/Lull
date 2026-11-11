// raw fragment 验收：自定义 main()，直接使用 gl_FragCoord 与 iTime。
// 与 Shadertoy Image（mainImage）共用同一套 uniform 与占位通道。
void main() {
    vec2 uv = gl_FragCoord.xy / iResolution.xy;
    vec3 col = 0.5 + 0.5 * cos(iTime + uv.xyx + vec3(0.0, 2.0, 4.0));
    gl_FragColor = vec4(col, 1.0);
}