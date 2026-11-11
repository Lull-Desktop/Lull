// iMouse 验收：十字/圆环跟随光标。
// 光标移出绘制面或桌面后，十字应停在最后位置，而不是跳回左下角。
void mainImage(out vec4 fragColor, in vec2 fragCoord) {
    vec2 uv = fragCoord / iResolution.xy;
    vec3 col = mix(vec3(0.04, 0.07, 0.12), vec3(0.10, 0.16, 0.24), uv.y);

    vec2 d = (fragCoord - iMouse.xy) / iResolution.y;
    float ring = smoothstep(0.012, 0.0, abs(length(d) - 0.08));
    float hLine = smoothstep(0.004, 0.0, abs(d.y)) * step(abs(d.x), 0.10);
    float vLine = smoothstep(0.004, 0.0, abs(d.x)) * step(abs(d.y), 0.10);

    col += vec3(0.45, 0.90, 0.70) * (ring + hLine + vLine);
    fragColor = vec4(col, 1.0);
}