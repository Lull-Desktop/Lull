/**
 * 原生交互测试：右键菜单必须被拦截，组件卸载后恢复默认。
 */
import { render } from "@testing-library/react";
import { expect, test } from "vitest";
import { NativeUiGuard } from "./native-ui-guard";

test("拦截系统右键菜单，卸载后恢复", () => {
  const { unmount } = render(<NativeUiGuard />);

  const blocked = new MouseEvent("contextmenu", {
    bubbles: true,
    cancelable: true,
  });
  document.body.dispatchEvent(blocked);
  expect(blocked.defaultPrevented).toBe(true);

  unmount();
  const restored = new MouseEvent("contextmenu", {
    bubbles: true,
    cancelable: true,
  });
  document.body.dispatchEvent(restored);
  expect(restored.defaultPrevented).toBe(false);
});
