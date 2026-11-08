/**
 * Lull 场景适配层 —— Triangles & Light（community.triangles-light）
 *
 * 原壁纸是 CodePen 单文件产物（FSS + Delaunay + Mousetrap），所有函数都挂在
 * 顶层作用域上（`initialise()` / `onMouseMove()` / `livelyPropertyListener()`），
 * 因此适配层只做三件事：
 *
 * 1. 把 Lull 参数翻成原作的 `livelyPropertyListener(name, value)` 调用；
 * 2. 把 `scene.onPointer` 的样本灌进原作的 `onMouseMove(event)`；
 * 3. 宿主不可用时安静退出，不影响壁纸本身的渲染。
 *
 * 指针语义：`x/y` 是场景绘制坐标系内的 CSS 像素（与 `event.clientX/Y` 同尺度），
 * `inside` 表示光标在桌面层且落在本场景内，`moving` 表示最近约 120ms 内有移动。
 * 协议没有点击/滚轮/按键字段，所以这里只驱动"光斑跟随"。
 */
import { connectLullScene } from "./vendor/scene-sdk/index.js";

/** Lull 参数 key → 原作 livelyPropertyListener 的 name。 */
const PARAM_ALIASES = {
  "mesh-ambient": "meshAmbient",
  "mesh-diffuse": "meshDiffuse",
  "mesh-slices": "meshSlices",
  "light-ambient": "lightAmbient",
  "light-diffuse": "lightDiffuse",
  "light-distance": "lightDistance",
};

/** 鼠标跟随开关（对应原作 space 键切换的 LIGHT.pickedup）。 */
let followPointer = true;
/** 壁纸窗口是否可见；隐藏时不再灌指针样本。 */
let visible = true;

function emitParam(key, value) {
  const name = PARAM_ALIASES[key];
  if (!name) return;
  if (typeof window.livelyPropertyListener === "function") {
    window.livelyPropertyListener(name, value);
  }
}

function setFollowPointer(next) {
  followPointer = next === true;
  const light = window.LIGHT;
  if (light && typeof light === "object") light.pickedup = followPointer;
}

function applyParams(params) {
  if (!params || typeof params !== "object") return;
  if (typeof params["mouse-follow"] === "boolean") {
    setFollowPointer(params["mouse-follow"]);
  }
  for (const [key, value] of Object.entries(params)) {
    if (key === "mouse-follow") continue;
    emitParam(key, value);
  }
}

function feedPointer(pointer) {
  if (!visible || !followPointer) return;
  if (!pointer.inside || !pointer.moving) return;
  if (typeof window.onMouseMove !== "function") return;
  // 原作只读 event.x / event.y，直接喂一个同形状的对象即可。
  window.onMouseMove({ x: pointer.x, y: pointer.y });
}

try {
  const scene = await connectLullScene();
  scene.onParams(applyParams);
  scene.onPointer(feedPointer);
  scene.onVisibility((next) => {
    visible = next === true;
  });
} catch (error) {
  console.error("[triangles-light] 未连接到 Lull 场景宿主：", error);
}
