import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, test, vi } from "vitest";
import type { SceneParamDefinition } from "@/sdk/scene";
import { SCENE_TEXT_PARAM_MAX_CHARS, SceneParamFields } from "./scene-params";

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

const TEXT_DEFINITION: SceneParamDefinition = {
  key: "source",
  type: "text",
  label: "源码",
  default: "",
};

function fakeFile(
  name: string,
  text: string,
  options: { fail?: boolean } = {},
): File {
  const file = new File([text], name, { type: "text/plain" });
  Object.defineProperty(file, "text", {
    configurable: true,
    value: () =>
      options.fail ? Promise.reject(new Error("boom")) : Promise.resolve(text),
  });
  return file;
}

function renderText(values: Record<string, string> = {}, onChange = vi.fn()) {
  render(
    <SceneParamFields
      definitions={[TEXT_DEFINITION]}
      values={values}
      onChange={onChange}
      onReset={vi.fn()}
    />,
  );
  return {
    onChange,
    textarea: screen.getByRole("textbox", {
      name: "源码",
    }) as HTMLTextAreaElement,
  };
}

describe("SceneParamFields text params", () => {
  test("多行文本框保留换行，失焦提交", () => {
    const { onChange, textarea } = renderText();
    expect(textarea.tagName).toBe("TEXTAREA");
    fireEvent.change(textarea, { target: { value: "line 1\nline 2" } });
    expect(textarea.value).toBe("line 1\nline 2");
    expect(onChange).not.toHaveBeenCalled();
    fireEvent.blur(textarea);
    expect(onChange).toHaveBeenCalledWith("source", "line 1\nline 2");
  });

  test("应用按钮与 Ctrl+Enter 提交草稿", () => {
    const { onChange, textarea } = renderText({ source: "old" });
    expect(textarea.value).toBe("old");

    fireEvent.change(textarea, { target: { value: "applied" } });
    fireEvent.click(screen.getByRole("button", { name: "应用" }));
    expect(onChange).toHaveBeenCalledWith("source", "applied");

    fireEvent.change(textarea, { target: { value: "keyboard" } });
    fireEvent.keyDown(textarea, { key: "Enter", ctrlKey: true });
    expect(onChange).toHaveBeenLastCalledWith("source", "keyboard");
  });

  test("从文件载入文本并显示文件名", async () => {
    const { onChange } = renderText();
    const content =
      "void mainImage(out vec4 c, in vec2 p) {\n  c = vec4(1.0);\n}";
    fireEvent.change(screen.getByLabelText("从文件载入"), {
      target: { files: [fakeFile("flow.frag", content)] },
    });
    await waitFor(() =>
      expect(onChange).toHaveBeenCalledWith("source", content),
    );
    expect(screen.getByRole("status").textContent).toContain("flow.frag");
  });

  test("空文件不提交", async () => {
    const { onChange } = renderText();
    fireEvent.change(screen.getByLabelText("从文件载入"), {
      target: { files: [fakeFile("empty.frag", "")] },
    });
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("文件为空");
    expect(onChange).not.toHaveBeenCalled();
  });

  test("超过上限的文件不提交", async () => {
    const { onChange } = renderText();
    fireEvent.change(screen.getByLabelText("从文件载入"), {
      target: {
        files: [
          fakeFile("big.frag", "x".repeat(SCENE_TEXT_PARAM_MAX_CHARS + 1)),
        ],
      },
    });
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("文件太大");
    expect(onChange).not.toHaveBeenCalled();
  });

  test("超大文件在读取前就被拒绝", async () => {
    const { onChange } = renderText();
    const read = vi.fn(() => Promise.resolve("x"));
    const file = fakeFile("huge.frag", "x");
    Object.defineProperty(file, "size", {
      configurable: true,
      value: SCENE_TEXT_PARAM_MAX_CHARS * 4 + 1,
    });
    Object.defineProperty(file, "text", {
      configurable: true,
      value: read,
    });
    fireEvent.change(screen.getByLabelText("从文件载入"), {
      target: { files: [file] },
    });
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("文件太大");
    expect(read).not.toHaveBeenCalled();
    expect(onChange).not.toHaveBeenCalled();
  });

  test("读取失败有提示", async () => {
    const { onChange } = renderText();
    fireEvent.change(screen.getByLabelText("从文件载入"), {
      target: { files: [fakeFile("bad.frag", "x", { fail: true })] },
    });
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("boom");
    expect(onChange).not.toHaveBeenCalled();
  });
});
