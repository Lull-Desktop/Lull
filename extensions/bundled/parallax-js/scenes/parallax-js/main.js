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
 *
 * 多屏语义（与 Triangles & Light 一致）：宿主把同一份桌面坐标发给每扇壁纸窗，
 * 顶层页面换算成本屏本地坐标并标记 `inside`。这里只转发 `inside && moving`
 * 的样本——光标在别的屏幕（或别的应用窗口）上时，本屏视差停在最后位置，
 * 不会跟着另一屏的鼠标一起漂移。
 */
import { connectLullScene } from "./vendor/scene-sdk/index.js";

let visible = true;

function forward(pointer) {
  // 只响应落在本屏绘制面内且正在移动的样本：复制/独立模式下 inside=false
  // 表示光标在别的屏幕上，转发它会让两屏视差跟着同一个鼠标一起动。
  if (!visible || !pointer.inside || !pointer.moving) return;
  // 插件只读 clientX/clientY，不附带 view 等冗余字段
  //（jsdom 测试环境也无法通过 view 的 Window 品牌校验）。
  window.dispatchEvent(
    new MouseEvent("mousemove", {
      clientX: pointer.x,
      clientY: pointer.y,
      bubbles: false,
      cancelable: false,
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
