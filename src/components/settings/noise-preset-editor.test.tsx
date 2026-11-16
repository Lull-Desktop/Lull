import type {
  LullMediaClient,
  NoisePresetDetail,
  NoisePresetUpdatePatch,
} from "@lull/media-sdk";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { useState } from "react";
import { expect, test, vi } from "vitest";
import {
  NoisePresetEditor,
  type PresetLeaveGuard,
} from "./noise-preset-editor";

function detail(): NoisePresetDetail {
  return {
    preset: {
      id: "preset",
      name: "Rain",
      sourceType: "user",
      schemaVersion: 2,
      masterVolume: 0.7,
      favorite: false,
      trackCount: 2,
      createdAt: 1,
      updatedAt: 2,
    },
    tracks: [
      {
        id: "rain",
        assetId: "a",
        expectedName: "Rain track",
        volume: 0.6,
        enabled: true,
        loop: true,
        sortOrder: 0,
        status: "resolved",
        environment: {
          type: "rain",
          intensity: 0.4,
          anchors: [
            { assetId: "a", intensity: 0, assetHash: "hash-a" },
            { assetId: "b", intensity: 1 },
          ],
        },
      },
      {
        id: "wind",
        assetId: "c",
        expectedName: "Wind track",
        volume: 0.5,
        enabled: true,
        loop: true,
        sortOrder: 1,
        status: "resolved",
      },
    ],
  };
}
function setup(initial = detail()) {
  let current = initial;
  let guard: PresetLeaveGuard | null = null;
  const listeners = new Set<
    (event: { topic: string; payload: { presetId: string } }) => void
  >();
  const update = vi.fn(async (_id: string, patch: NoisePresetUpdatePatch) => {
    current = {
      ...current,
      preset: {
        ...current.preset,
        name: patch.name ?? current.preset.name,
        description: patch.description ?? undefined,
        updatedAt: current.preset.updatedAt + 1,
      },
      tracks: current.tracks.map((t) => ({
        ...t,
        environment:
          patch.trackEnvironments?.find((p) => p.presetTrackId === t.id)
            ?.environment ?? t.environment,
      })),
    };
    listeners.forEach((fn) =>
      fn({ topic: "noise.preset.updated", payload: { presetId: "preset" } }),
    );
    return current;
  });
  const get = vi.fn(async () => current);
  const getAsset = vi.fn(async (id: string) => ({
    id,
    name: id,
    status: "available",
  }));
  const forbidden = vi.fn();
  const client = {
    events: {
      on: (listener: typeof listeners extends Set<infer T> ? T : never) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    },
    noise: {
      presets: { updatePreset: update, getPreset: get },
      library: { getAsset },
      session: { getCurrent: forbidden, play: forbidden },
      tracks: { setIntensity: forbidden, configureEnvironment: forbidden },
    },
  } as unknown as LullMediaClient;
  const load = vi.fn(),
    exp = vi.fn(),
    duplicate = vi.fn();
  const editState = vi.fn();
  const register = (next: PresetLeaveGuard | null) => {
    guard = next;
  };
  function Harness() {
    const [value, setValue] = useState(initial);
    return (
      <NoisePresetEditor
        client={client}
        detail={value}
        busy={false}
        onSaved={setValue}
        onLoad={load}
        onExport={exp}
        onDuplicate={duplicate}
        registerGuard={register}
        onEditState={editState}
      />
    );
  }
  render(<Harness />);
  return {
    update,
    get,
    getAsset,
    forbidden,
    load,
    exp,
    duplicate,
    guard: () => guard!(),
    external: (next: NoisePresetDetail) => {
      current = next;
      listeners.forEach((fn) =>
        fn({ topic: "noise.preset.updated", payload: { presetId: "preset" } }),
      );
    },
  };
}
const save = () =>
  screen.getByRole("button", { name: "保存预设" }) as HTMLButtonElement;
const open = () =>
  fireEvent.click(screen.getByRole("button", { name: "编辑环境配置" }));

test("preset drafts save metadata and environment together without touching the live mix", async () => {
  const h = setup();
  open();
  fireEvent.change(screen.getByLabelText("名称"), {
    target: { value: "New rain" },
  });
  fireEvent.change(screen.getByLabelText("预设初始强度 %"), {
    target: { value: "75" },
  });
  fireEvent.change(screen.getByLabelText("档位 2 强度 %"), {
    target: { value: "90" },
  });
  expect(
    (screen.getByRole("button", { name: "导出文件" }) as HTMLButtonElement)
      .disabled,
  ).toBe(true);
  fireEvent.click(save());
  await screen.findByText("预设已保存；加载到当前混音后生效。");
  expect(h.update).toHaveBeenCalledWith(
    "preset",
    expect.objectContaining({
      name: "New rain",
      expectedUpdatedAt: 2,
      trackEnvironments: [
        {
          presetTrackId: "rain",
          environment: {
            type: "rain",
            intensity: 0.75,
            anchors: [
              { assetId: "a", intensity: 0, assetHash: "hash-a" },
              { assetId: "b", intensity: 0.9 },
            ],
          },
        },
      ],
    }),
  );
  expect(h.forbidden).not.toHaveBeenCalled();
  expect(save().disabled).toBe(true);
  expect(screen.queryByText(/预设已在其他位置修改/)).toBeNull();
});
test("only one track expands, drafts survive switching and cancel restores the preset", async () => {
  setup();
  open();
  fireEvent.change(screen.getByLabelText("预设初始强度 %"), {
    target: { value: "80" },
  });
  fireEvent.click(screen.getByRole("button", { name: "配置环境强度" }));
  expect(screen.getAllByLabelText("预设初始强度 %")).toHaveLength(1);
  expect(
    (screen.getByLabelText("预设初始强度 %") as HTMLInputElement).value,
  ).toBe("50");
  fireEvent.click(screen.getByRole("button", { name: "编辑环境配置" }));
  expect(
    (screen.getByLabelText("预设初始强度 %") as HTMLInputElement).value,
  ).toBe("80");
  fireEvent.click(screen.getByRole("button", { name: "取消修改" }));
  expect(
    (screen.getByLabelText("预设初始强度 %") as HTMLInputElement).value,
  ).toBe("40");
  expect(screen.getByRole("button", { name: "配置环境强度" })).toBeDefined();
});
test("invalid collapsed drafts reopen before save and failed saves retain edits", async () => {
  const h = setup();
  open();
  fireEvent.change(screen.getByLabelText("档位 2 强度 %"), {
    target: { value: "" },
  });
  fireEvent.click(screen.getByRole("button", { name: "收起环境配置" }));
  fireEvent.click(save());
  await screen.findByLabelText("档位 2 强度 %");
  expect(h.update).not.toHaveBeenCalled();
  fireEvent.change(screen.getByLabelText("档位 2 强度 %"), {
    target: { value: "85" },
  });
  h.update.mockRejectedValueOnce(new Error("offline"));
  fireEvent.click(save());
  await screen.findByText("offline");
  expect(
    (screen.getByLabelText("档位 2 强度 %") as HTMLInputElement).value,
  ).toBe("85");
});
test("foreign edits retain dirty drafts and version conflicts block save", async () => {
  const h = setup();
  open();
  fireEvent.change(screen.getByLabelText("预设初始强度 %"), {
    target: { value: "80" },
  });
  const next = detail();
  next.preset.updatedAt = 4;
  next.preset.name = "Foreign";
  act(() => h.external(next));
  await screen.findByText(/预设已在其他位置修改/);
  expect(save().disabled).toBe(true);
  expect(
    (screen.getByLabelText("预设初始强度 %") as HTMLInputElement).value,
  ).toBe("80");
  fireEvent.click(screen.getByRole("button", { name: "重新载入最新配置" }));
  const dialog = await screen.findByRole("dialog");
  fireEvent.click(
    within(dialog).getByRole("button", { name: "重新载入最新配置" }),
  );
  await waitFor(() =>
    expect((screen.getByLabelText("名称") as HTMLInputElement).value).toBe(
      "Foreign",
    ),
  );
});
test("builtins are read-only and request an editable copy without loading", () => {
  const d = detail();
  d.preset.sourceType = "builtin";
  const h = setup(d);
  open();
  expect(
    (screen.getByLabelText("预设初始强度 %") as HTMLInputElement).disabled,
  ).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "创建可编辑副本" }));
  expect(h.duplicate).toHaveBeenCalledOnce();
  expect(h.load).not.toHaveBeenCalled();
  expect(h.update).not.toHaveBeenCalled();
});
test("navigation guard keeps edits on cancel and permits explicit discard", async () => {
  const h = setup();
  fireEvent.change(screen.getByLabelText("名称"), {
    target: { value: "Draft" },
  });
  let result: Promise<boolean>;
  act(() => {
    result = h.guard();
  });
  fireEvent.click(await screen.findByRole("button", { name: "继续编辑" }));
  await expect(result!).resolves.toBe(false);
  act(() => {
    result = h.guard();
  });
  fireEvent.click(
    await screen.findByRole("button", { name: "放弃修改并继续" }),
  );
  await expect(result!).resolves.toBe(true);
  expect(h.update).not.toHaveBeenCalled();
});
