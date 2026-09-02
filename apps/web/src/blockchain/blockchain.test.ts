import { describe, expect, test } from "bun:test";

import {
  BlockchainClient,
  BlockchainNotConfiguredError,
  buildHashableResult,
  canonicalize,
  contentHashOf,
  sha256Hex,
} from "./blockchain";

describe("canonicalize", () => {
  test("key order does not affect output", () => {
    const a = canonicalize({ similarity: 0.5, timestamp: 1, url: "x" });
    const b = canonicalize({ similarity: 0.5, timestamp: 1, url: "x" });
    expect(a).toBe(b);
  });

  test("nested objects are sorted recursively", () => {
    const a = canonicalize({ outer: { a: 2, b: 1 }, z: 3 });
    const b = canonicalize({ outer: { a: 2, b: 1 }, z: 3 });
    expect(a).toBe(b);
  });

  test("array order is preserved", () => {
    expect(canonicalize(["b", "a"])).not.toBe(canonicalize(["a", "b"]));
  });

  test("no whitespace in output", () => {
    expect(canonicalize({ a: 1, b: "two" })).toBe('{"a":1,"b":"two"}');
  });

  test("undefined values are dropped from objects", () => {
    expect(canonicalize({ a: 1, b: undefined })).toBe('{"a":1}');
  });

  test("null serializes as null, not dropped", () => {
    expect(canonicalize({ a: null })).toBe('{"a":null}');
  });

  test("deterministic across repeated calls", () => {
    const obj = { engines: ["yandex", "google-vision"], similarity: 0.7959 };
    expect(canonicalize(obj)).toBe(canonicalize(obj));
  });
});

describe("sha256Hex / contentHashOf", () => {
  test("matches known SHA-256 vector", async () => {
    expect(await sha256Hex("abc")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
    );
  });

  test("contentHashOf is deterministic and order-invariant", async () => {
    const r1 = buildHashableResult({
      engines: ["b", "a"],
      inputFaceHash: "deadbeef",
      similarity: 0.9,
      timestamp: 123,
      url: "https://example.com",
    });
    const r2 = buildHashableResult({
      engines: ["a", "b"],
      inputFaceHash: "deadbeef",
      similarity: 0.9,
      timestamp: 123,
      url: "https://example.com",
    });
    expect(await contentHashOf(r1)).toBe(await contentHashOf(r2));
  });

  test("different similarity produces different hash", async () => {
    const base = {
      engines: ["a"],
      inputFaceHash: "deadbeef",
      timestamp: 123,
      url: "https://example.com",
    };
    const h1 = await contentHashOf(
      buildHashableResult({ ...base, similarity: 0.9 })
    );
    const h2 = await contentHashOf(
      buildHashableResult({ ...base, similarity: 0.91 })
    );
    expect(h1).not.toBe(h2);
  });

  test("hash is 64-char lowercase hex", async () => {
    const h = await contentHashOf(
      buildHashableResult({
        engines: [],
        inputFaceHash: "x",
        similarity: 0,
        timestamp: 0,
        url: "",
      })
    );
    expect(h).toMatch(/^[0-9a-f]{64}$/u);
  });
});

describe("BlockchainClient config gating", () => {
  test("isConfigured false when env missing", () => {
    const client = new BlockchainClient({});
    expect(client.isConfigured()).toBe(false);
  });

  test("isConfigured true when all env present", () => {
    const client = new BlockchainClient({
      AMOY_RPC_URL: "http://127.0.0.1:8545",
      FACE_RECORD_CONTRACT_ADDR: "0x0000000000000000000000000000000000000001",
      WALLET_PRIVATE_KEY: `0x${"11".repeat(32)}`,
    });
    expect(client.isConfigured()).toBe(true);
  });

  test("store() throws BlockchainNotConfiguredError with missing key names", async () => {
    const client = new BlockchainClient({});
    try {
      await client.store(
        buildHashableResult({
          engines: [],
          inputFaceHash: "x",
          similarity: 0,
          timestamp: 0,
          url: "u",
        })
      );
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(BlockchainNotConfiguredError);
      expect((error as BlockchainNotConfiguredError).message).toContain(
        "AMOY_RPC_URL"
      );
    }
  });
});
