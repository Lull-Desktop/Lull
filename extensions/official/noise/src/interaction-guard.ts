/**
 * 音境窗口的交互护栏：屏蔽框选、原生拖拽与右键菜单。
 *
 * 全部监听都挂在音境根节点（`.root`，即 `.ether-bubbles-root`）上，不注册任何
 * `document` / `window` 级监听，也不写全局样式，因此设置窗、音乐库窗、
 * 播放器窗与宿主页面完全不受影响；组件卸载（或根节点换人）时整体撤销。
 *
 * 护栏只负责「选中」与「原生拖拽」两件事：
 * - 框选文字 / 元素 → `selectstart` 取消默认（CSS 里同时补 `user-select: none`）；
 * - 图片 / 元素被鼠标拖起 → `dragstart` 取消默认（CSS 里同时补 `-webkit-user-drag: none`）；
 * - 右键菜单 → `contextmenu` 取消默认。
 *
 * 泡泡的音量调节走的是 pointer 事件（`pointerdown` / `pointermove` 配合
 * 指针捕获），顶栏拖动窗口走的是根节点上的 `pointerdown` + `startDrag`，
 * 都不经过 `dragstart`，所以手势与窗口拖动不受影响。
 */
import { type RefObject, useEffect } from "react";

/**
 * 仍然需要原生文本选择的控件。
 *
 * 音境当前没有文字输入框，这条规则是为后续在设置浮层里加输入项预留：
 * 整块关闭选中会让改名、全选、粘贴这些键盘操作失效。
 * `select` 的原生下拉不在 DOM 里，不需要单独豁免。
 */
const EDITABLE_SELECTOR = [
  'input:not([type="range"]):not([type="checkbox"]):not([type="radio"])',
  "textarea",
  '[contenteditable="true"]',
].join(",");

/** 事件目标是否落在可编辑的文字控件里（这些位置保留选区与光标行为）。 */
export function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  return target.closest(EDITABLE_SELECTOR) !== null;
}

/**
 * 在指定子树内安装护栏，返回撤销函数。
 *
 * 导出成普通函数而非只给 hook，是为了让节点级行为可以被单测直接覆盖
 * （jsdom 里造 React 树比造两个 div 贵得多）。
 */
export function installInteractionGuard(root: HTMLElement): () => void {
  const onContextMenu = (event: MouseEvent): void => {
    event.preventDefault();
  };

  const onDragStart = (event: DragEvent): void => {
    // 只拦「从本模块内部拖出」的原生拖拽；外部文件拖入不触发此事件。
    event.preventDefault();
  };

  const onSelectStart = (event: Event): void => {
    if (isEditableTarget(event.target)) return;
    event.preventDefault();
  };

  root.addEventListener("contextmenu", onContextMenu);
  root.addEventListener("dragstart", onDragStart);
  root.addEventListener("selectstart", onSelectStart);

  return () => {
    root.removeEventListener("contextmenu", onContextMenu);
    root.removeEventListener("dragstart", onDragStart);
    root.removeEventListener("selectstart", onSelectStart);
  };
}

/** 给音境根节点装上护栏；`ref` 指向包裹整个模块的那个 `div`。 */
export function useInteractionGuard(ref: RefObject<HTMLElement | null>): void {
  useEffect(() => {
    const root = ref.current;
    if (!root) return;
    return installInteractionGuard(root);
  }, [ref]);
}
