// biome-ignore-all lint/correctness/noUndeclaredDependencies: workspace package is resolved by the app build.
import {
  DEFAULT_SMART_SHUFFLE_CONFIG,
  type LullMediaClient,
  type SmartShuffleProfile,
  type SmartShuffleProfileSummary,
} from "@lull/media-sdk";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { expect, test, vi } from "vitest";
import { SmartShuffleApiPanel } from "./smart-shuffle-api-panel";

const builtin: SmartShuffleProfile = {
  id: "builtin:balanced",
  name: "均衡随机",
  builtin: true,
  config: DEFAULT_SMART_SHUFFLE_CONFIG,
};

const user: SmartShuffleProfile = {
  id: "shuffle_profile_user",
  name: "夜航",
  builtin: false,
  config: DEFAULT_SMART_SHUFFLE_CONFIG,
};

const summaries: SmartShuffleProfileSummary[] = [
  { id: builtin.id, name: builtin.name, builtin: true, active: true },
  { id: user.id, name: user.name, builtin: false, active: false },
];

function createClient(): LullMediaClient {
  const saved: SmartShuffleProfile = {
    ...user,
    id: "shuffle_profile_saved",
    name: "深夜",
  };
  return {
    events: { on: () => () => {} },
    player: {
      listShuffleProfiles: vi.fn(async () => summaries),
      getShuffleProfile: vi.fn(async (profileId?: string) =>
        profileId === user.id ? user : builtin,
      ),
      saveShuffleProfile: vi.fn(
        async (input: {
          profileId?: string;
          name: string;
          config: SmartShuffleProfile["config"];
        }) => ({ ...saved, name: input.name, config: input.config }),
      ),
      deleteShuffleProfile: vi.fn(async () => true),
      activateShuffleProfile: vi.fn(async (profileId: string) =>
        profileId === user.id ? user : builtin,
      ),
    },
  } as unknown as LullMediaClient;
}

test("随机播放 API 面板加载激活配置并展示接口清单", async () => {
  const client = createClient();
  render(<SmartShuffleApiPanel client={client} />);

  expect(await screen.findByText(/当前激活/)).toBeDefined();
  expect(screen.getByText("player.listShuffleProfiles()")).toBeDefined();
  await waitFor(() => {
    expect(client.player.listShuffleProfiles).toHaveBeenCalled();
  });
});

test("另存为新配置会写入并激活", async () => {
  const client = createClient();
  render(<SmartShuffleApiPanel client={client} />);
  await screen.findByText(/当前激活/);

  fireEvent.change(screen.getByLabelText("另存名称"), {
    target: { value: "深夜" },
  });
  fireEvent.click(screen.getByRole("button", { name: "另存为新配置" }));

  await waitFor(() => {
    expect(client.player.saveShuffleProfile).toHaveBeenCalledWith({
      name: "深夜",
      config: DEFAULT_SMART_SHUFFLE_CONFIG,
    });
    expect(client.player.activateShuffleProfile).toHaveBeenCalledWith(
      "shuffle_profile_saved",
    );
  });
});

test("读取并激活选中配置", async () => {
  const client = createClient();
  render(<SmartShuffleApiPanel client={client} />);
  await screen.findByText(/当前激活/);

  fireEvent.change(screen.getByLabelText("随机播放配置"), {
    target: { value: user.id },
  });
  fireEvent.click(screen.getByRole("button", { name: "读取选中" }));
  await waitFor(() => {
    expect(client.player.getShuffleProfile).toHaveBeenCalledWith(user.id);
  });

  fireEvent.click(screen.getByRole("button", { name: "激活选中" }));
  await waitFor(() => {
    expect(client.player.activateShuffleProfile).toHaveBeenCalledWith(user.id);
  });
});
