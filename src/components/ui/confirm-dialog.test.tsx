import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, test } from "vitest";
import { useConfirmDialog } from "./confirm-dialog";

function Harness() {
  const { confirm, ask, dialog } = useConfirmDialog();
  const [result, setResult] = useState("init");

  return (
    <div>
      <button
        type="button"
        onClick={() =>
          void confirm({
            title: "移除目录",
            description: "只删除记录，不动磁盘文件。",
            confirmLabel: "移除",
            danger: true,
          }).then((ok) => setResult(`confirm:${ok}`))
        }
      >
        打开确认
      </button>
      <button
        type="button"
        onClick={() =>
          void ask({
            title: "重命名目录",
            confirmLabel: "保存",
            input: { label: "目录名称", defaultValue: "旧名字" },
          }).then((value) => setResult(`ask:${value ?? "null"}`))
        }
      >
        打开输入
      </button>
      <output data-testid="result">{result}</output>
      {dialog}
    </div>
  );
}

describe("useConfirmDialog", () => {
  test("确认返回 true，取消返回 false", async () => {
    render(<Harness />);

    fireEvent.click(screen.getByRole("button", { name: "打开确认" }));
    expect(await screen.findByText("移除目录")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "移除" }));
    await waitFor(() =>
      expect(screen.getByTestId("result").textContent).toBe("confirm:true"),
    );

    fireEvent.click(screen.getByRole("button", { name: "打开确认" }));
    fireEvent.click(await screen.findByRole("button", { name: "取消" }));
    await waitFor(() =>
      expect(screen.getByTestId("result").textContent).toBe("confirm:false"),
    );
  });

  test("输入弹窗预填默认值，确认后返回输入内容", async () => {
    render(<Harness />);

    fireEvent.click(screen.getByRole("button", { name: "打开输入" }));
    const input = (await screen.findByLabelText(
      "目录名称",
    )) as HTMLInputElement;
    expect(input.value).toBe("旧名字");

    fireEvent.change(input, { target: { value: "新名字" } });
    fireEvent.click(screen.getByRole("button", { name: "保存" }));

    await waitFor(() =>
      expect(screen.getByTestId("result").textContent).toBe("ask:新名字"),
    );
  });

  test("输入为空时不能提交", async () => {
    render(<Harness />);

    fireEvent.click(screen.getByRole("button", { name: "打开输入" }));
    const input = (await screen.findByLabelText(
      "目录名称",
    )) as HTMLInputElement;
    fireEvent.change(input, { target: { value: "   " } });

    const submit = screen.getByRole("button", {
      name: "保存",
    }) as HTMLButtonElement;
    expect(submit.disabled).toBe(true);
    expect(screen.getByTestId("result").textContent).toBe("init");
  });
});
