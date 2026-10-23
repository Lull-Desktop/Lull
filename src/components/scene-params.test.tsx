import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, test, vi } from "vitest";
import type { SceneParamDefinition } from "@/sdk/scene";
import { SceneParamFields } from "./scene-params";

const DEFINITIONS = [
  {
    key: "glow",
    type: "number",
    label: "光晕",
    default: 0.5,
    min: 0,
    max: 1,
    step: 0.1,
  },
  {
    key: "offset",
    type: "number",
    label: "偏移",
    default: 0,
  },
  {
    key: "tint",
    type: "color",
    label: "颜色",
    default: "#00ffcc",
  },
  {
    key: "ring",
    type: "boolean",
    label: "光环",
    default: true,
  },
  {
    key: "mode",
    type: "enum",
    label: "模式",
    default: "a",
    options: [
      { value: "a", label: "A" },
      { value: "b", label: "B" },
    ],
  },
] satisfies SceneParamDefinition[];

describe("SceneParamFields", () => {
  test("有 min/max 的 number 参数用滑条，无界参数保留数字输入", () => {
    render(
      <SceneParamFields
        definitions={DEFINITIONS}
        values={{}}
        onChange={vi.fn()}
        onReset={vi.fn()}
      />,
    );

    expect(screen.getByRole("slider", { name: "光晕" })).toBeDefined();
    expect(screen.queryByRole("spinbutton", { name: "光晕" })).toBeNull();
    expect(screen.getByRole("spinbutton", { name: "偏移" })).toBeDefined();
    expect(screen.getByLabelText("颜色")).toHaveProperty("type", "color");
    expect(screen.getByRole("switch", { name: "光环" })).toBeDefined();
    expect(screen.getByRole("combobox", { name: "模式" })).toBeDefined();
  });

  test("滑条键盘操作提交数值，数字输入 blur 提交", () => {
    const onChange = vi.fn();
    render(
      <SceneParamFields
        definitions={DEFINITIONS}
        values={{}}
        onChange={onChange}
        onReset={vi.fn()}
      />,
    );

    const slider = screen.getByRole("slider", { name: "光晕" });
    fireEvent.keyDown(slider, { key: "End" });
    fireEvent.keyUp(slider, { key: "End" });
    expect(onChange).toHaveBeenCalledWith("glow", "1.0");
    expect(slider.getAttribute("aria-valuenow")).toBe("1");

    const offset = screen.getByRole("spinbutton", { name: "偏移" });
    fireEvent.change(offset, { target: { value: "42" } });
    fireEvent.blur(offset);
    expect(onChange).toHaveBeenCalledWith("offset", "42");
  });
});
