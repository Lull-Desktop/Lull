// iChannel 占位验收：iChannel0 是 256×256 程序化噪声，iChannel1-3 是黑色。
// 画面应显示绿色噪声；若 iChannel 未被绑定会整块变黑。
void mainImage(out vec4 fragColor, in vec2 fragCoord) {
    vec2 uv = fragCoord / iResolution.xy;
    vec2 tile = vec2(3.0, 3.0 * iResolution.y / iResolution.x);
    float noise = texture2D(iChannel0, uv * tile).r;
    float second = texture2D(iChannel1, uv).r;

    vec3 col = mix(vec3(0.02, 0.05, 0.08), vec3(0.32, 0.82, 0.62), noise);
    col += second * 0.2;
    fragColor = vec4(col, 1.0);
}