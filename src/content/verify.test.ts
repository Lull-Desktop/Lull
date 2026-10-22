import { generateKeyPairSync, sign, webcrypto } from "node:crypto";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  ContentSignatureError,
  parseCatalogSignature,
  verifyCatalogSignature,
} from "./verify";

const { privateKey, publicKey } = generateKeyPairSync("ec", {
  namedCurve: "P-256",
});
const publicJwk = publicKey.export({ format: "jwk" });

function signatureFor(payload: string): string {
  return sign("sha256", Buffer.from(payload, "utf8"), {
    key: privateKey,
    dsaEncoding: "ieee-p1363",
  }).toString("base64");
}

function document(signature: string, overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1,
    algorithm: "ECDSA-P256-SHA256",
    keyId: "lull-official-1",
    signature,
    ...overrides,
  };
}

beforeEach(() => {
  vi.stubGlobal("crypto", webcrypto);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("catalog signature file", () => {
  test("parses a well-formed signature", () => {
    const parsed = parseCatalogSignature(document("AAAA"));
    expect(parsed.keyId).toBe("lull-official-1");
    expect(parsed.algorithm).toBe("ECDSA-P256-SHA256");
  });

  test("rejects unknown algorithms and bad key ids", () => {
    expect(() =>
      parseCatalogSignature(document("AAAA", { algorithm: "HS256" })),
    ).toThrow(ContentSignatureError);
    expect(() =>
      parseCatalogSignature(document("AAAA", { keyId: "../escape" })),
    ).toThrow(/keyId/);
    expect(() => parseCatalogSignature(document("not base64!"))).toThrow(
      /base64/,
    );
    expect(() =>
      parseCatalogSignature(document("AAAA", { schemaVersion: 2 })),
    ).toThrow(/schemaVersion/);
  });
});

describe("catalog signature verification", () => {
  test("accepts a signature produced over the exact payload", async () => {
    const payload = '{"schemaVersion":1,"scenes":[]}\n';
    const parsed = parseCatalogSignature(document(signatureFor(payload)));
    await expect(
      verifyCatalogSignature(payload, parsed, publicJwk as JsonWebKey),
    ).resolves.toBe(true);
  });

  test("rejects any byte change in the payload", async () => {
    const payload = '{"schemaVersion":1,"scenes":[]}\n';
    const parsed = parseCatalogSignature(document(signatureFor(payload)));
    await expect(
      verifyCatalogSignature(`${payload} `, parsed, publicJwk as JsonWebKey),
    ).resolves.toBe(false);
  });

  test("rejects non EC P-256 keys", async () => {
    const payload = "payload";
    const parsed = parseCatalogSignature(document(signatureFor(payload)));
    await expect(
      verifyCatalogSignature(payload, parsed, {
        kty: "RSA",
        n: "abc",
        e: "AQAB",
      }),
    ).rejects.toThrow(/EC P-256/);
  });

  test("fails closed when the environment has no SubtleCrypto", async () => {
    vi.stubGlobal("crypto", {});
    const parsed = parseCatalogSignature(document("AAAA"));
    await expect(
      verifyCatalogSignature("payload", parsed, publicJwk as JsonWebKey),
    ).rejects.toThrow(/SubtleCrypto/);
  });
});
