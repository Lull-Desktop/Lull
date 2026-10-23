/**
 * 语言层测试：locale 归一化、错误本地化，以及设置页切换语言后的实际渲染。
 *
 * 语言是模块级快照（不是 React 状态），测试之间必须显式复位，
 * 否则前一个用例切到英文会污染后面的断言。
 */
import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import Page from "@/app/(control)/setting/page";
import { localizeError } from "./errors";
import { normalizeLocale, resetLocaleForTest } from "./locale";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(() => Promise.reject(new Error("not in tauri"))),
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: () => Promise.resolve(() => {}),
}));

afterEach(() => {
  window.localStorage.clear();
  resetLocaleForTest();
});

test("normalizeLocale 把地区与字形收敛到受支持语言", () => {
  expect(normalizeLocale("zh-CN")).toBe("zh-CN");
  expect(normalizeLocale("zh")).toBe("zh-CN");
  expect(normalizeLocale("zh-Hans")).toBe("zh-CN");
  // 目前不提供繁体：繁体系统回落到简体，而不是英文。
  expect(normalizeLocale("zh-TW")).toBe("zh-CN");
  expect(normalizeLocale("zh-Hant-HK")).toBe("zh-CN");
  expect(normalizeLocale("en-GB")).toBe("en-US");
  expect(normalizeLocale("ja-JP")).toBeNull();
  expect(normalizeLocale("")).toBeNull();
  expect(normalizeLocale(undefined)).toBeNull();
});

test("localizeError 兼容字符串、结构化错误与未知值", () => {
  expect(localizeError("原始错误")).toBe("原始错误");
  expect(localizeError(new Error("boom"))).toBe("boom");
  expect(
    localizeError({ code: "不存在的键", fallback: "回退文案" }),
  ).toBe("回退文案");
  expect(localizeError({ code: "不存在的键" })).toBe("不存在的键");
  expect(localizeError(42)).toBe("42");
});

test("设置页切到 English 后页签与关于卡片跟着换语言", async () => {
  render(<Page />);

  // 默认渲染基准语言（zh-CN）。
  expect(screen.getByRole("tab", { name: "偏好" })).toBeTruthy();

  fireEvent.click(await screen.findByRole("radio", { name: "English" }));

  expect(await screen.findByRole("tab", { name: "Wallpaper" })).toBeTruthy();
  expect(screen.getByRole("tab", { name: "Preferences" })).toBeTruthy();
  expect(screen.getByText("About Lull")).toBeTruthy();
  // 语言自称不翻译：英文界面下仍然显示「简体中文」。
  expect(screen.getByRole("radio", { name: "简体中文" })).toBeTruthy();

  fireEvent.click(screen.getByRole("radio", { name: "简体中文" }));
  expect(await screen.findByRole("tab", { name: "壁纸" })).toBeTruthy();
});

test("英文界面下设置页的「偏好」页签不残留中文文案", async () => {
  render(<Page />);
  fireEvent.click(await screen.findByRole("radio", { name: "English" }));
  expect(await screen.findByRole("tab", { name: "Wallpaper" })).toBeTruthy();

  // 只看默认页签（偏好）：壁纸与扩展页签按需渲染，各自的文案由对应组件测试覆盖。
  // 语言自称（简体中文 / English）按约定不翻译，比对前先剔除。
  const text = (document.body.textContent ?? "").replaceAll("简体中文", "");
  expect(text).not.toMatch(/[\u4e00-\u9fff]/);
});

test("英文界面下设置页的「偏好」页签不残留中文文案", async () => {
  render(<Page />);
  fireEvent.click(await screen.findByRole("radio", { name: "English" }));
  expect(await screen.findByRole("tab", { name: "Wallpaper" })).toBeTruthy();

  // 只看默认页签（偏好）：壁纸与扩展页签按需渲染，各自的文案由对应组件测试覆盖。
  // 语言自称（简体中文 / English）按约定不翻译，比对前先剔除。
  const text = (document.body.textContent ?? "").replaceAll("简体中文", "");
  expect(text).not.toMatch(/[一-鿿]/);
});
