/**
 * Lull 场景适配层 —— Medusae（community.medusae）
 *
 * 原壁纸（Particulate.js + Three.js 软体水母）的交互模型是"点击扰动"：
 *   #container 上 mousedown → 记录 didDrag=false
 *                  mousemove → didDrag=true
 *                  mouseup   → 若 !didDrag 则按当前坐标 nudgeMedusae()
 *
 * Lull 的指针通道只提供移动状态与坐标（没有点击），所以这里把
 * 「指针在场景内移动」映射成一次位置准确的合成点击（mousedown + mouseup，
 * 中间不发 mousemove，因此 didDrag 保持 false，与真人单击等价），
 * 并按 NUDGE_INTERVAL_MS 节流，避免 30Hz 采样把水母抽飞。
 *
 * 音频：原目录缺少 build/static/audio/ 下的 4 个音频文件，
 * index.html 已隐藏 Audio 按钮，app.min.js 的 4 处 loadBuffer 已补空 catch。
 */
import { connectLullScene } from "./vendor/scene-sdk/index.js";

/** 两次合成点击之间的最小间隔。 */
const NUDGE_INTERVAL_MS = 700;

let lastNudgeAt = 0;
let visible = true;

function findTarget() {
  return document.getElementById("container");
}

function dispatchMouse(target, type, x, y) {
  target.dispatchEvent(
    new MouseEvent(type, {
      clientX: x,
      clientY: y,
      bubbles: true,
      cancelable: true,
      view: window,
    }),
  );
}

function nudge(pointer) {
  const target = findTarget();
  if (!target) return;
  const now = performance.now();
  if (now - lastNudgeAt < NUDGE_INTERVAL_MS) return;
  lastNudgeAt = now;
  // 不夹 mousemove：onMouseMove 会把 didDrag 置真，导致 mouseup 不再触发扰动。
  dispatchMouse(target, "mousedown", pointer.x, pointer.y);
  dispatchMouse(target, "mouseup", pointer.x, pointer.y);
}

function feedPointer(pointer) {
  if (!visible) return;
  if (!pointer.inside || !pointer.moving) return;
  nudge(pointer);
}

try {
  const scene = await connectLullScene();
  scene.onPointer(feedPointer);
  scene.onVisibility((next) => {
    visible = next === true;
  });
} catch (error) {
  console.error("[medusae] 未连接到 Lull 场景宿主：", error);
}
