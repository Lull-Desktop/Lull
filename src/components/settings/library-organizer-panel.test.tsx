import type { MediaRequest, Page, TrackSummary } from "@lull/media-sdk";
import { createMediaClient } from "@lull/media-sdk";
import { createMemoryTransport } from "@lull/media-sdk/testing";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { expect, test, vi } from "vitest";
import { LibraryOrganizerPanel } from "./library-organizer-panel";

const track: TrackSummary = {
  id: "trk_1",
  title: "测试曲目",
  artists: ["Lull"],
  album: "夜",
  genre: "Ambient",
  year: 2026,
  source: "local",
  available: true,
  hasCover: false,
  tags: [],
};

const page: Page<TrackSummary> = {
  items: [track],
  total: 1,
  page: 1,
  pageSize: 100,
  hasMore: false,
};

test("选择曲目并保存元数据/标签", async () => {
  const update = vi.fn(async (_args: unknown) => ({
    ...track,
    title: "新标题",
  }));
  const setTags = vi.fn(async (_args: unknown) => ({ updated: true }));
  const handler = (request: MediaRequest): unknown => {
    switch (`${request.namespace}.${request.method}`) {
      case "library.listTags":
        return [{ id: "tag_1", name: "夜间", trackCount: 1 }];
      case "library.listArtists":
        return [{ id: "art_1", name: "Lull", kind: "group", trackCount: 1 }];
      case "library.listAlbums":
        return [
          {
            id: "alb_1",
            title: "夜",
            kind: "album",
            trackCount: 1,
            hasCover: false,
          },
        ];
      case "library.listSmartPlaylists":
        return [];
      case "library.listTracks":
        return page;
      case "library.updateTrackMetadata":
        return update(request.args);
      case "library.setTrackTags":
        return setTags(request.args);
      default:
        return null;
    }
  };

  const client = createMediaClient({
    transport: createMemoryTransport(handler),
  });
  render(<LibraryOrganizerPanel client={client} />);

  expect(await screen.findByText("曲库整理测试")).toBeDefined();
  const row = await screen.findByRole("button", {
    name: "选择曲目 测试曲目",
  });
  fireEvent.click(row);

  const title = await screen.findByLabelText("标题");
  fireEvent.change(title, { target: { value: "新标题" } });
  fireEvent.click(
    screen.getByRole("button", { name: /保存元数据与标签/ }),
  );

  await waitFor(() => expect(update).toHaveBeenCalledTimes(1));
  expect(setTags).toHaveBeenCalledTimes(1);
  expect(update.mock.calls[0]?.[0]).toMatchObject({
    trackId: "trk_1",
    title: "新标题",
  });
});
