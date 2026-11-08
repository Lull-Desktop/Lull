/**
 * Lull 场景适配层 —— Parallax.js（community.parallax-js）
 *
 * 壁纸本体是 DOM 多层 PNG + CSS3 transform，位移由 `vendor/jquery.parallax.js`
 * 计算：插件在 `enable()` 里监听 `window` 的 `mousemove`，读 `clientX/clientY`
 * 相对窗口中心归一化成输入向量，再按 `data-depth`、`data-scalar-x/y`、
 * `data-friction-x/y` 逐层位移。
 *
 * 壁纸窗口是鼠标穿透的（WS_EX_TRANSPARENT），原生 mousemove 永远不会触发，
 * 所以这里把 Lull 的 `scene.onPointer` 样本重新派发成同页面的合成 mousemove：
 * 事件只在本 iframe 内部流转，不触碰桌面输入。30Hz 采样 + 插件自带的
 * friction 平滑足以避免跳帧，不需要额外补间。
 */
import { connectLullScene } from "./vendor/scene-sdk/index.js";

let visible = true;

function forward(pointer) {
  if (!visible) return;
  window.dispatchEvent(
    new MouseEvent("mousemove", {
      clientX: pointer.x,
      clientY: pointer.y,
      bubbles: false,
      cancelable: false,
      view: window,
    }),
  );
}

try {
  const scene = await connectLullScene();
  scene.onPointer(forward);
  scene.onVisibility((next) => {
    visible = next === true;
  });
} catch (error) {
  console.error("[parallax-js] 未连接到 Lull 场景宿主：", error);
}
