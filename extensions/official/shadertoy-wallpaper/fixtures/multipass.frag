// 多 Pass / Feedback 验收：Buffer A 累加上一帧，Image 读取 Buffer A。
// 默认绑定：BufferA.iChannel0 = 自身上一帧；Image.iChannel0 = BufferA。
//---- Buffer A ----
void mainImage(out vec4 fragColor, in vec2 fragCoord) {
    vec4 previous = texture2D(iChannel0, fragCoord / iResolution.xy);
    fragColor = vec4(min(previous.r + 0.1, 1.0), 0.0, 0.0, 1.0);
}

//---- Image ----
void mainImage(out vec4 fragColor, in vec2 fragCoord) {
    float value = texture2D(iChannel0, vec2(0.5)).r;
    fragColor = vec4(value, value * 0.5, 0.0, 1.0);
}