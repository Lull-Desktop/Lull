/**
 * 着色器壁纸场景入口。
 *
 * 直开页面（没有宿主 init）时保留占位提示，不抛未捕获异常；SceneHost 通过
 * iframe 的 ready 消息判断是否真正可用。
 */
import { connectLullScene } from "@lull/scene-sdk";
import "./scene.css";
import { mountShaderScene } from "./scene/scene-entry";

const scene = mountShaderScene(document);

const onDocumentVisibility = (): void => {
  scene.applyDocumentVisibility(document.visibilityState !== "hidden");
};
document.addEventListener("visibilitychange", onDocumentVisibility);

const teardown = (): void => {
  document.removeEventListener("visibilitychange", onDocumentVisibility);
  scene.destroy();
};
window.addEventListener("pagehide", teardown, { once: true });

void connectLullScene()
  .then((client) => {
    scene.setReporter((level, message) => client.log(message, level));
    client.onFrame((frame) => scene.applyFrame(frame));
    client.onPointer((pointer) => scene.applyPointer(pointer));
    client.onVisibility((visible) => scene.applyVisibility(visible));
  })
  .catch((error: unknown) => {
    scene.showNotice(
      "未连接到 Lull 宿主 / Not connected to Lull",
      "直接打开这个页面时只会看到占位提示；请在 Lull 的壁纸设置中选择「着色器」。\n" +
        "Opened outside Lull: choose the Shadertoy wallpaper in Lull settings to run it.",
    );
    console.warn("[shadertoy-wallpaper] scene bridge unavailable", error);
  });
