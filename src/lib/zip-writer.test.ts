import { describe, expect, test } from "vitest";
import { createZip } from "../../scripts/zip-writer.mjs";

describe("zip writer", () => {
  test("条目名使用正斜杠，避免 Windows 压缩工具的反斜杠被安装器拒绝", () => {
    const zip = createZip([
      {
        name: "scenes/param-demo/index.html",
        data: Buffer.from("<html></html>"),
      },
      { name: "catalog.json", data: Buffer.from("{}") },
    ]);
    const raw = zip.toString("latin1");
    expect(raw).toContain("scenes/param-demo/index.html");
    expect(raw).not.toContain("scenes\\param-demo\\index.html");
  });

  test("拒绝反斜杠条目", () => {
    expect(() =>
      createZip([
        { name: "scenes\\param-demo\\index.html", data: Buffer.from("x") },
      ]),
    ).toThrow(/反斜杠/);
  });
});
