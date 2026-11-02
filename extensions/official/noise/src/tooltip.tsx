/**
 * 白噪音统一的悬停标签（tooltip），与播放器共用同一套视觉与交互。
 *
 * 原生 `title` 由系统绘制在指针右下方，浮层正好压在按钮与指针上；
 * 这里换成自己的浮层：固定定位在按钮正上方居中，只有在顶部空间不足时
 * 才翻到下方，并横向夹在窗口内，避免在停靠栏 / 设置浮层边缘被裁掉。
 */
import type {
  FocusEvent as ReactFocusEvent,
  PointerEvent as ReactPointerEvent,
} from "react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import styles from "./ether-bubbles.module.css";

/** 窗口边缘的透明渐隐带，浮层不要贴到这条线上。 */
const EDGE_PADDING = 10;
/** 标签与按钮之间的空隙。 */
const TIP_GAP = 9;

interface TipAnchor {
  label: string;
  centerX: number;
  top: number;
  bottom: number;
}

interface TipPlacement {
  left: number;
  top: number;
  below: boolean;
}

type TipListener = (anchor: TipAnchor | null) => void;

const listeners = new Set<TipListener>();

function publish(anchor: TipAnchor | null): void {
  for (const listener of listeners) listener(anchor);
}

/**
 * 展开到任意可悬停元素上即可获得顶部居中的标签：
 * `<button {...tip("最小化")} />`。
 *
 * 标签本体由根节点里的 `<TipHost />` 统一渲染，因此不受停靠栏、
 * 设置浮层这些 `overflow: hidden` 容器的裁剪。
 */
export function tip(label: string) {
  const show = (element: HTMLElement): void => {
    const rect = element.getBoundingClientRect();
    publish({
      label,
      centerX: rect.left + rect.width / 2,
      top: rect.top,
      bottom: rect.bottom,
    });
  };
  return {
    onPointerEnter: (event: ReactPointerEvent<HTMLElement>): void => {
      show(event.currentTarget);
    },
    onPointerLeave: (): void => {
      publish(null);
    },
    onFocus: (event: ReactFocusEvent<HTMLElement>): void => {
      // 鼠标点按也会让按钮获得焦点；只保留键盘（:focus-visible）的标签，
      // 否则点完一次按钮标签会一直挂在鼠标旁边。
      if (!event.currentTarget.matches(":focus-visible")) return;
      show(event.currentTarget);
    },
    onBlur: (): void => {
      publish(null);
    },
  };
}

export function TipHost() {
  const [anchor, setAnchor] = useState<TipAnchor | null>(null);
  const [placement, setPlacement] = useState<TipPlacement | null>(null);
  const nodeRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    listeners.add(setAnchor);
    // 窗口尺寸变化、失焦或按下鼠标时立刻收起，避免标签停在旧位置。
    const hide = (): void => {
      publish(null);
    };
    window.addEventListener("resize", hide);
    window.addEventListener("blur", hide);
    document.addEventListener("pointerdown", hide, true);
    return () => {
      listeners.delete(setAnchor);
      window.removeEventListener("resize", hide);
      window.removeEventListener("blur", hide);
      document.removeEventListener("pointerdown", hide, true);
    };
  }, []);

  // 先渲染再量宽高：标签宽度随文案变化，横向居中需要真实尺寸才能夹住边界。
  useLayoutEffect(() => {
    if (!anchor) {
      setPlacement(null);
      return;
    }
    const node = nodeRef.current;
    const width = node?.offsetWidth ?? 0;
    const height = node?.offsetHeight ?? 0;
    const half = width / 2;
    const left = Math.min(
      Math.max(anchor.centerX, half + EDGE_PADDING),
      window.innerWidth - half - EDGE_PADDING,
    );
    const roomAbove = anchor.top - TIP_GAP - height >= EDGE_PADDING;
    setPlacement({
      left,
      top: roomAbove ? anchor.top - TIP_GAP : anchor.bottom + TIP_GAP,
      below: !roomAbove,
    });
  }, [anchor]);

  if (!anchor) return null;

  return (
    <div
      ref={nodeRef}
      className={styles.tip}
      data-below={placement?.below ? "true" : "false"}
      style={{
        left: `${placement?.left ?? anchor.centerX}px`,
        top: `${placement?.top ?? anchor.top}px`,
      }}
      role="tooltip"
    >
      {anchor.label}
    </div>
  );
}
