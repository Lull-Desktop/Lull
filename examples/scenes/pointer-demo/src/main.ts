/**
 * 鼠标光晕示例：`wallpaper.pointer` 只下发移动状态与本地坐标。
 *
 * 宿主链路：Win32 位置采样 → Tauri 定向事件 → 顶层壁纸页面换算 →
 * `postMessage({type:"pointer"})` → `@lull/scene-sdk` 的 `onPointer`。
 * 没有 click / dblclick 通道，壁纸也保持输入穿透，所以点击照常作用于桌面。
 *
 * 构建：pnpm scenes:samples:build
 */
import { connectLullScene, type ScenePointer } from "@lull/scene-sdk";

function apply(pointer: ScenePointer): void {
  const root = document.documentElement;
  root.style.setProperty("--pointer-x", `${pointer.x}px`);
  root.style.setProperty("--pointer-y", `${pointer.y}px`);
  root.style.setProperty(
    "--halo-opacity",
    pointer.inside ? (pointer.moving ? "0.92" : "0.55") : "0",
  );
  root.style.setProperty("--halo-scale", pointer.moving ? "1" : "0.82");
  root.dataset.pointer = !pointer.inside
    ? "outside"
    : pointer.moving
      ? "moving"
      : "idle";
}

try {
  const scene = await connectLullScene();
  scene.onPointer(apply);
  // 壁纸被隐藏时宿主不会再采样；这里顺手淡出，避免停在最后一次位置。
  scene.onVisibility((visible) => {
    if (!visible) {
      document.documentElement.style.setProperty("--halo-opacity", "0");
    }
  });
} catch (error) {
  // 不在壁纸窗口（例如直接用浏览器打开）时静默降级为静态提示。
  console.error("[pointer-demo] Scene host unavailable", error);
}
