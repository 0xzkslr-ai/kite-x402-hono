import { describe, expect, test } from "bun:test";
import {
  KITE_NETWORKS,
  parsePrice,
  resolveNetwork,
  loadConfig,
} from "../src/index.js";
import { testConfig } from "./helpers.js";

describe("Kite configuration", () => {
  test("exact integer units and token domains for both networks", () => {
    expect(parsePrice("0.001", KITE_NETWORKS.mainnet)).toEqual({
      asset: KITE_NETWORKS.mainnet.asset,
      amount: "1000",
      extra: { name: "Bridged USDC (Kite AI)", version: "2" },
    });
    expect(parsePrice("$0.001", KITE_NETWORKS.testnet).amount).toBe(
      "1000000000000000",
    );
    expect(parsePrice("0.000001", KITE_NETWORKS.testnet).amount).toBe(
      "1000000000000",
    );
    expect(
      parsePrice("9007199254740993.123456", KITE_NETWORKS.mainnet).amount,
    ).toBe("9007199254740993123456");
  });
  test.each(["0", "-1", "1e-3", "NaN", "Infinity", "0.0000001", "1.", ".1"])(
    "rejects invalid price %s",
    (price) => {
      expect(() => parsePrice(price, KITE_NETWORKS.mainnet)).toThrow();
    },
  );
  test("validates mandatory config and network", () => {
    expect(() => loadConfig({})).toThrow("PAY_TO");
    expect(() => testConfig({ PAY_TO: `0x${"0".repeat(40)}` })).toThrow(
      "PAY_TO",
    );
    expect(() => testConfig({ KITE_NETWORK: "base" })).toThrow("KITE_NETWORK");
    expect(testConfig().facilitatorUrl).toBe(
      "https://facilitator.pieverse.io/v2",
    );
  });
  test.each([
    "https://user:password@example.com",
    "https://example.com/base",
    "https://example.com?key=secret",
    "file:///tmp/data",
    "http://remote.example",
  ])("rejects unsafe upstream %s", (url) => {
    expect(() => testConfig({ UPSTREAM_URL: url })).toThrow("UPSTREAM_URL");
  });
  test("permits local HTTP and preserves facilitator /v2", () => {
    expect(
      testConfig({ UPSTREAM_URL: "http://127.0.0.1:8081/" }).upstream,
    ).toBe("http://127.0.0.1:8081");
    expect(
      testConfig({ FACILITATOR_URL: "https://example.com/v2/" }).facilitatorUrl,
    ).toBe("https://example.com/v2");
  });
  test("rejects reserved auth headers and invalid limits", () => {
    for (const header of [
      "Host",
      "Connection",
      "PAYMENT-SIGNATURE",
      "x-payment",
      "bad header",
    ])
      expect(() => testConfig({ UPSTREAM_AUTH_HEADER: header })).toThrow();
    expect(() =>
      testConfig({ UPSTREAM_AUTH_VALUE: "secret\r\ninjected: x" }),
    ).toThrow();
    for (const [key, value] of [
      ["PORT", "65536"],
      ["PORT", "1.5"],
      ["UPSTREAM_TIMEOUT_MS", "0"],
      ["MAX_BODY_BYTES", "-1"],
    ]) {
      expect(() => testConfig({ [key!]: value! })).toThrow();
    }
  });
  test("resolves network by symbolic name, EVM chain ID, or CAIP-2 identifier", () => {
    expect(resolveNetwork("mainnet")).toBe(KITE_NETWORKS.mainnet);
    expect(resolveNetwork("2366")).toBe(KITE_NETWORKS.mainnet);
    expect(resolveNetwork(2366)).toBe(KITE_NETWORKS.mainnet);
    expect(resolveNetwork("eip155:2366")).toBe(KITE_NETWORKS.mainnet);

    expect(resolveNetwork("testnet")).toBe(KITE_NETWORKS.testnet);
    expect(resolveNetwork("2368")).toBe(KITE_NETWORKS.testnet);
    expect(resolveNetwork(2368)).toBe(KITE_NETWORKS.testnet);
    expect(resolveNetwork("eip155:2368")).toBe(KITE_NETWORKS.testnet);

    expect(resolveNetwork("unknown")).toBeUndefined();
    expect(resolveNetwork("1")).toBeUndefined();

    // Verify loadConfig accepts chain IDs and CAIP-2 strings
    expect(testConfig({ KITE_NETWORK: "2368" }).chain.network).toBe(
      "eip155:2368",
    );
    expect(testConfig({ KITE_NETWORK: "eip155:2366" }).chain.network).toBe(
      "eip155:2366",
    );
  });
});
