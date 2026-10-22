import { generateKeyPairSync, sign, webcrypto } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { ContentCatalogError, loadContentSceneEntries } from "./catalog";

const CATALOG_URL = "/content/catalog.json";
const SIGNATURE_URL = "/content/catalog.sig.json";
const KEY_URL = "/content/keys/lull-official-1.jwk.json";

const { privateKey, publicKey } = generateKeyPairSync("ec", {
  namedCurve: "P-256",
});
const publicJwk = publicKey.export({ format: "jwk" });

function signPayload(payload: string): string {
  return sign("sha256", Buffer.from(payload, "utf8"), {
    key: privateKey,
    dsaEncoding: "ieee-p1363",
  }).toString("base64");
}

function signatureFile(payload: string): string {
  return JSON.stringify({
    schemaVersion: 1,
    algorithm: "ECDSA-P256-SHA256",
    keyId: "lull-official-1",
    signature: signPayload(payload),
  });
}

function scene(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1,
    type: "scene",
    id: "community.mist",
    name: "雾岚",
    version: "1.0.0",
    license: "CC-BY-4.0",
    capabilities: ["wallpaper.viewport"],
    entry: "scenes/mist/index.html",
    integrity: {
      algorithm: "sha256",
      scope: "package",
      digest: "a".repeat(64),
    },
    ...overrides,
  };
}

function catalogJson(scenes: unknown[]): string {
  return `${JSON.stringify({ schemaVersion: 1, scenes }, null, 2)}\n`;
}

type Route = { body: string; status?: number };

function makeResponse(body: string, status: number): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: () => Promise.resolve(body),
    json: () => Promise.resolve(JSON.parse(body)),
  } as unknown as Response;
}

function fetcherFor(routes: Record<string, Route>): typeof fetch {
  return ((input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : String(input);
    const route = routes[url];
    if (!route) return Promise.resolve(makeResponse("", 404));
    return Promise.resolve(makeResponse(route.body, route.status ?? 200));
  }) as typeof fetch;
}

beforeEach(() => {
  // jsdom 的 crypto 没有 subtle；用 Node 的 WebCrypto 跑真实验签。
  vi.stubGlobal("crypto", webcrypto);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("content catalog loader", () => {
  test("verifies the signature and maps manifests to loadable entries", async () => {
    const payload = catalogJson([scene()]);
    const fetcher = fetcherFor({
      [CATALOG_URL]: { body: payload },
      [SIGNATURE_URL]: { body: signatureFile(payload) },
      [KEY_URL]: { body: JSON.stringify(publicJwk) },
    });

    const result = await loadContentSceneEntries(fetcher);
    expect(result.signature).toBe("valid");
    expect(result.issues).toEqual([]);
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]?.source).toBe("content");
    expect(result.entries[0]?.component).toBeNull();
    expect(result.entries[0]?.entryUrl).toBe("/content/scenes/mist/index.html");
  });

  test("loads an unsigned catalog but reports it as missing", async () => {
    const payload = catalogJson([scene()]);
    const fetcher = fetcherFor({ [CATALOG_URL]: { body: payload } });

    const result = await loadContentSceneEntries(fetcher);
    expect(result.signature).toBe("missing");
    expect(result.entries).toHaveLength(1);
  });

  test("rejects a catalog whose bytes no longer match the signature", async () => {
    const signed = catalogJson([scene()]);
    const tampered = signed.replace("雾岚", "雾岚（被改过）");
    const fetcher = fetcherFor({
      [CATALOG_URL]: { body: tampered },
      [SIGNATURE_URL]: { body: signatureFile(signed) },
      [KEY_URL]: { body: JSON.stringify(publicJwk) },
    });

    await expect(loadContentSceneEntries(fetcher)).rejects.toBeInstanceOf(
      ContentCatalogError,
    );
    await expect(loadContentSceneEntries(fetcher)).rejects.toThrow(/签名/);
  });

  test("reports HTTP failures without throwing raw fetch errors", async () => {
    const fetcher = fetcherFor({
      [CATALOG_URL]: { body: "", status: 404 },
    });
    await expect(loadContentSceneEntries(fetcher)).rejects.toBeInstanceOf(
      ContentCatalogError,
    );
  });

  test("drops one broken package instead of the whole catalog", async () => {
    const payload = catalogJson([
      scene(),
      scene({ id: "community.broken", entry: "https://evil.example/x.html" }),
    ]);
    const fetcher = fetcherFor({
      [CATALOG_URL]: { body: payload },
      [SIGNATURE_URL]: { body: signatureFile(payload) },
      [KEY_URL]: { body: JSON.stringify(publicJwk) },
    });

    const result = await loadContentSceneEntries(fetcher);
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]?.manifest.id).toBe("community.mist");
    expect(result.issues).toHaveLength(1);
    expect(result.issues[0]?.code).toBe("invalid-manifest");
    expect(result.issues[0]?.id).toBe("community.broken");
  });

  test("keeps the first package when two share an id", async () => {
    const payload = catalogJson([
      scene({ name: "先发布的" }),
      scene({ name: "后发布的" }),
    ]);
    const fetcher = fetcherFor({
      [CATALOG_URL]: { body: payload },
      [SIGNATURE_URL]: { body: signatureFile(payload) },
      [KEY_URL]: { body: JSON.stringify(publicJwk) },
    });

    const result = await loadContentSceneEntries(fetcher);
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]?.manifest.name).toBe("先发布的");
    expect(result.issues.map((issue) => issue.code)).toContain("duplicate-id");
  });

  test("the shipped catalog verifies against the committed key", async () => {
    // 锁死"仓库里的 catalog.json / catalog.sig.json / 公钥"三者一致：
    // 改了目录却忘了重新签名、或换了密钥没重签，这里立刻失败。
    const read = (relative: string): string =>
      readFileSync(resolve(process.cwd(), "public/content", relative), "utf8");
    const fetcher = fetcherFor({
      [CATALOG_URL]: { body: read("catalog.json") },
      [SIGNATURE_URL]: { body: read("catalog.sig.json") },
      [KEY_URL]: { body: read("keys/lull-official-1.jwk.json") },
    });

    const result = await loadContentSceneEntries(fetcher);
    expect(result.signature).toBe("valid");
    expect(result.issues).toEqual([]);
    expect(result.entries.map((entry) => entry.manifest.id)).toContain(
      "community.mist",
    );
  });
});
