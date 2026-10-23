/**
 * 示例脚本场景：Setting 改参数 → 宿主热更 URL 哈希 → SceneHost 重算帧 →
 * `@lull/scene-sdk` 的 `onFrame` 把新参数送到这里。
 *
 * 构建：pnpm scenes:samples:build
 */
import {
  connectLullScene,
  type SceneFrame,
  syncedDelayMs,
} from "@lull/scene-sdk";

function apply(frame: SceneFrame): void {
  const root = document.documentElement;
  const glow = Number(frame.params.glow ?? 0.5);
  const tint = String(frame.params.tint ?? "#9fc7c2");
  const pulseSeconds = Number(frame.params.pulse ?? 8);
  const blur = Number(frame.params.blur ?? 60);
  const hue = Number(frame.params.hue ?? 0);
  const ring = frame.params.ring !== false;

  root.style.setProperty("--glow", String(glow));
  root.style.setProperty("--tint", tint);
  root.style.setProperty("--pulse", `${pulseSeconds}s`);
  root.style.setProperty("--blur", `${blur}px`);
  root.style.setProperty("--hue", `${hue}deg`);
  root.style.setProperty("--ring-opacity", ring ? "0.8" : "0");
  root.style.setProperty(
    "--sync-delay",
    frame.sync.enabled
      ? `${syncedDelayMs(pulseSeconds * 1000, frame.sync.epochMs)}ms`
      : "0ms",
  );
}

try {
  const scene = await connectLullScene();
  scene.onFrame(apply);
  scene.log(
    `params=${JSON.stringify(scene.params)} layout=${scene.frame?.layout ?? "?"}`,
  );
} catch (error) {
  // 不在壁纸窗口（例如直接用浏览器打开）时静默降级为默认样式。
  console.error("[param-demo] Scene host unavailable", error);
}
