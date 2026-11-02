/**
 * 竹影官方场景入口：建立 Scene SDK 连接，把帧交给 DOM 状态层。
 *
 * 直接打开页面（没有宿主 init）时只保留静态画面与时钟，不抛未捕获错误；
 * SceneHost 会通过 iframe 的 ready 消息判断是否真正可用。
 */
import { connectLullScene } from "@lull/scene-sdk";
import { applySceneFrame, startClock } from "./scene";

startClock(document);

void connectLullScene()
  .then((scene) => {
    scene.onFrame((frame) => applySceneFrame(document, frame));
  })
  .catch((error: unknown) => {
    console.warn("[scene:lull.bamboo] 未连接宿主，保留静态画面", error);
  });
