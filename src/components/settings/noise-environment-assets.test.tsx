import type {
  LullMediaClient,
  NoiseAsset,
  NoiseAssetQuery,
  Page,
} from "@lull/media-sdk";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { expect, test, vi } from "vitest";
import { EnvironmentAssetPicker } from "./noise-environment-assets";

const page = (ids: string[], hasMore = false): Page<NoiseAsset> => ({
  items: ids.map((id) => ({ id, name: id, status: "available" }) as NoiseAsset),
  hasMore,
  total: ids.length,
  page: 1,
  pageSize: 50,
});

test("asset picker pages on demand, debounces search, and retries without losing selection context", async () => {
  const listAssets = vi.fn(async (query?: NoiseAssetQuery) =>
    query?.keyword
      ? page(["searched"])
      : query?.page === 2
        ? page(["second"])
        : page(["first"], true),
  );
  const client = {
    noise: { library: { listAssets, getCategories: vi.fn(async () => []) } },
  } as unknown as LullMediaClient;
  const select = vi.fn();
  render(
    <EnvironmentAssetPicker
      client={client}
      version={0}
      onSelect={select}
      onClose={() => {}}
    />,
  );
  await screen.findByRole("button", { name: "first" });
  expect(listAssets).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByRole("button", { name: "加载更多" }));
  await screen.findByRole("button", { name: "second" });
  expect(listAssets).toHaveBeenLastCalledWith(
    expect.objectContaining({ page: 2, pageSize: 50, status: "available" }),
  );
  const input = screen.getByLabelText("搜索素材名称");
  fireEvent.change(input, { target: { value: "a" } });
  fireEvent.change(input, { target: { value: "ab" } });
  await screen.findByRole("button", { name: "searched" });
  expect(listAssets.mock.calls.filter(([q]) => q?.keyword)).toHaveLength(1);
  expect(listAssets).toHaveBeenLastCalledWith(
    expect.objectContaining({ keyword: "ab", page: 1 }),
  );
  fireEvent.click(screen.getByRole("button", { name: "searched" }));
  expect(select).toHaveBeenCalledWith(
    expect.objectContaining({ id: "searched" }),
  );
});

test("a late response from an earlier query cannot overwrite the new results", async () => {
  let resolveOld: (value: Page<NoiseAsset>) => void = () => {};
  const listAssets = vi.fn((query?: NoiseAssetQuery) =>
    query?.keyword
      ? Promise.resolve(page(["new result"]))
      : new Promise<Page<NoiseAsset>>((r) => {
          resolveOld = r;
        }),
  );
  const client = {
    noise: { library: { listAssets, getCategories: vi.fn(async () => []) } },
  } as unknown as LullMediaClient;
  render(
    <EnvironmentAssetPicker
      client={client}
      version={0}
      onSelect={() => {}}
      onClose={() => {}}
    />,
  );
  fireEvent.change(screen.getByLabelText("搜索素材名称"), {
    target: { value: "new" },
  });
  await screen.findByRole("button", { name: "new result" });
  await act(async () => resolveOld(page(["old result"])));
  expect(screen.queryByRole("button", { name: "old result" })).toBeNull();
});

test("failed page can be retried and library changes restart at page one", async () => {
  const listAssets = vi
    .fn(async () => page(["asset"], true))
    .mockRejectedValueOnce(new Error("offline"));
  const client = {
    noise: { library: { listAssets, getCategories: vi.fn(async () => []) } },
  } as unknown as LullMediaClient;
  const view = render(
    <EnvironmentAssetPicker
      client={client}
      version={0}
      onSelect={() => {}}
      onClose={() => {}}
    />,
  );
  await screen.findByText(/加载失败/);
  fireEvent.click(screen.getByRole("button", { name: "重试" }));
  await screen.findByRole("button", { name: "asset" });
  fireEvent.click(screen.getByRole("button", { name: "加载更多" }));
  await waitFor(() =>
    expect(listAssets).toHaveBeenLastCalledWith(
      expect.objectContaining({ page: 2 }),
    ),
  );
  view.rerender(
    <EnvironmentAssetPicker
      client={client}
      version={1}
      onSelect={() => {}}
      onClose={() => {}}
    />,
  );
  await waitFor(() =>
    expect(listAssets).toHaveBeenLastCalledWith(
      expect.objectContaining({ page: 1 }),
    ),
  );
});
