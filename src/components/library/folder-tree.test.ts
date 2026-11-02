import { describe, expect, test } from "vitest";
import { type FolderSource, folderRows } from "./folder-tree";

function folder(
  overrides: Partial<FolderSource> & { id: string },
): FolderSource {
  return { name: overrides.id, ...overrides };
}

describe("folderRows", () => {
  test("父目录排在子目录前，并按层级增加缩进", () => {
    const rows = folderRows([
      folder({ id: "rock", name: "Rock", rootPath: "D:\\Music\\Rock" }),
      folder({ id: "root", name: "Music", rootPath: "D:\\Music" }),
      folder({ id: "live", name: "Live", rootPath: "D:\\Music\\Rock\\Live" }),
    ]);

    expect(rows.map((row) => row.folder.id)).toEqual(["root", "rock", "live"]);
    expect(rows.map((row) => row.depth)).toEqual([0, 1, 2]);
  });

  test("只按整段路径匹配：Pop2 不会被当成 Pop 的子目录", () => {
    const rows = folderRows([
      folder({ id: "pop", name: "Pop", rootPath: "D:\\Music\\Pop" }),
      folder({ id: "pop2", name: "Pop2", rootPath: "D:\\Music\\Pop2" }),
    ]);

    expect(rows.map((row) => row.depth)).toEqual([0, 0]);
  });

  test("忽略分隔符与大小写差异，缺 rootPath 的目录当根目录", () => {
    const rows = folderRows([
      folder({ id: "child", name: "Child", rootPath: "d:/music/child/" }),
      folder({ id: "loose", name: "Loose" }),
      folder({ id: "root", name: "Music", rootPath: "D:\\Music\\" }),
    ]);

    // 缺路径的目录按名称参与排序，落在这批路径之后。
    expect(rows.map((row) => row.folder.id)).toEqual([
      "root",
      "child",
      "loose",
    ]);
    expect(rows.map((row) => row.depth)).toEqual([0, 1, 0]);
  });
});
