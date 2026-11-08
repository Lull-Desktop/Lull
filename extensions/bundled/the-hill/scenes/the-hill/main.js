/**
 * Lull 场景适配层 —— The Hill（community.the-hill）
 *
 * 原壁纸的 `livelyPropertyListener(name, val)` 是顶层函数（Three.js + GLSL 山丘），
 * 适配层只负责把 Lull 参数翻译成同名调用，并在不可用时安静退出。
 *
 * 注意：`bgColor` 会触发原作的 `init()`（重建渲染器与渲染循环），
 * 而宿主会因为窗口尺寸变化频繁重发 frame，所以这里做一次值去重，
 * 避免同一个值反复重建 WebGL 上下文。
 */
import { connectLullScene } from "./vendor/scene-sdk/index.js";

/** Lull 参数 key → 原作 livelyPropertyListener 的 name。 */
const PARAM_ALIASES = {
  "hill-opacity": "hillOpacityFac",
  background: "bgColor",
  "hill-color": "hillColor",
  "font-color": "fontColor",
  "show-time": "timeToggle",
  "show-date": "dateToggle",
  "hour-12": "_12hour",
  "date-us": "mmddyy",
};

/**
 * 已应用过的值，避免同一个值重复下发。
 *
 * `background` 预置成原作的初始清屏色：首次下发若与之一致就不调用 `bgColor`，
 * 否则会白白重建一次渲染循环并再绑一次 window resize。
 * 其它参数不预置——原作 `script.js` 的初始状态与 Lively 面板默认值并不完全一致
 * （例如 `mmddyy` 代码里是 true、面板里是 false；`uopacity` 代码里是 1.0、面板是 0.5），
 * 必须让默认值真正下发一次才能还原壁纸在 Lively 下的外观。
 */
const applied = new Map([["background", "#0e0e0e"]]);

function applyParams(params) {
  if (!params || typeof params !== "object") return;
  const listener = window.livelyPropertyListener;
  if (typeof listener !== "function") return;
  for (const [key, value] of Object.entries(params)) {
    const name = PARAM_ALIASES[key];
    if (!name) continue;
    if (applied.get(key) === value) continue;
    applied.set(key, value);
    listener(name, value);
  }
}

try {
  const scene = await connectLullScene();
  scene.onParams(applyParams);
} catch (error) {
  console.error("[the-hill] 未连接到 Lull 场景宿主：", error);
}
