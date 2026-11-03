import {
  DEFAULT_SMART_SHUFFLE_CONFIG,
  type SmartShuffleProfile,
  type SmartShuffleProfileSummary,
} from "@lull/media-sdk";
import { fireEvent, render, screen } from "@testing-library/react";
import { expect, test, vi } from "vitest";
import { SmartShufflePanel } from "./smart-shuffle-panel";

const profiles: SmartShuffleProfileSummary[] = [
  { id: "builtin:balanced", name: "均衡随机", builtin: true, active: true },
  { id: "user:1", name: "夜航", builtin: false, active: false },
];

const builtinProfile: SmartShuffleProfile = {
  id: "builtin:balanced",
  name: "均衡随机",
  builtin: true,
  config: DEFAULT_SMART_SHUFFLE_CONFIG,
};

const userProfile: SmartShuffleProfile = {
  id: "user:1",
  name: "夜航",
  builtin: false,
  config: DEFAULT_SMART_SHUFFLE_CONFIG,
};

function renderPanel(profile: SmartShuffleProfile = userProfile) {
  const onActivate = vi.fn();
  const onChange = vi.fn();
  const onSaveAs = vi.fn();
  const onDelete = vi.fn();
  const onClose = vi.fn();
  const onNotice = vi.fn();
  render(
    <SmartShufflePanel
      profiles={profiles}
      profile={profile}
      config={profile.config}
      onActivate={onActivate}
      onChange={onChange}
      onSaveAs={onSaveAs}
      onDelete={onDelete}
      onClose={onClose}
      onNotice={onNotice}
    />,
  );
  return { onActivate, onChange, onSaveAs, onDelete, onClose, onNotice };
}

test("内置配置只读，用户配置有五个可调滑杆", () => {
  const builtin = renderPanel(builtinProfile);
  const sliders = screen.getAllByRole("slider");
  expect(sliders).toHaveLength(5);
  expect(sliders.every((slider) => (slider as HTMLInputElement).disabled)).toBe(
    true,
  );
  expect(screen.getByText(/内置配置只读/)).toBeTruthy();
  expect(builtin.onChange).not.toHaveBeenCalled();
});

test("用户配置拖动滑杆提交新参数", () => {
  const { onChange } = renderPanel(userProfile);
  const sliders = screen.getAllByRole("slider");
  fireEvent.change(sliders[0], { target: { value: "90" } });
  const next = onChange.mock.calls[0]?.[0];
  expect(next.experience.randomness).toBe(90);
  expect(next.experience.diversity).toBe(50);
  expect(next.audioFeatures).toEqual(
    DEFAULT_SMART_SHUFFLE_CONFIG.audioFeatures,
  );
});

test("配置下拉可以切换，且不再有快捷按钮", () => {
  const { onActivate } = renderPanel(userProfile);
  expect(screen.queryByRole("button", { name: "均衡随机" })).toBeNull();
  fireEvent.change(screen.getByLabelText("智能随机配置"), {
    target: { value: "builtin:balanced" },
  });
  expect(onActivate).toHaveBeenCalledWith("builtin:balanced");
});

test("另存为会提交名称", () => {
  const { onSaveAs } = renderPanel(userProfile);
  fireEvent.click(screen.getByRole("button", { name: "另存为新配置" }));
  fireEvent.change(screen.getByLabelText("新配置名称"), {
    target: { value: " 深夜 " },
  });
  fireEvent.click(screen.getByRole("button", { name: "保存" }));
  expect(onSaveAs).toHaveBeenCalledWith("深夜");
});

test("删除用户配置需要二次确认", () => {
  const { onDelete } = renderPanel(userProfile);
  fireEvent.click(screen.getByRole("button", { name: "删除当前配置" }));
  expect(onDelete).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "确认删除配置" }));
  expect(onDelete).toHaveBeenCalledTimes(1);
});
