//==== Buffer A ====
#version 300 es
// WebGL2/ES3 多 Pass 反馈：Buffer A 用 texelFetch 读取自身上一帧并累加。
void mainImage(out vec4 fragColor, in vec2 fragCoord) {
  vec4 previous = texelFetch(iChannel0, ivec2(fragCoord), 0);
  fragColor = vec4(min(previous.r + 0.01, 1.0), previous.g, previous.b, 1.0);
}

//==== Image ====
#version 300 es
void mainImage(out vec4 fragColor, in vec2 fragCoord) {
  fragColor = texelFetch(iChannel0, ivec2(fragCoord), 0);
}