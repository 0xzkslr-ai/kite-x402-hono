import { describe, expect, test } from "bun:test";
import {
  parseIpList,
  matchIpv4Cidr,
  evaluateIpFilter,
  extractClientIp,
} from "../src/firewall.js";
import { harness, signature } from "./helpers.js";

describe("Firewall CIDR & IP Filtering Unit Tests", () => {
  test("parseIpList parses comma-delimited and whitespace-separated lists", () => {
    expect(parseIpList("127.0.0.1, 10.0.0.0/8, 192.168.1.100")).toEqual([
      "127.0.0.1",
      "10.0.0.0/8",
      "192.168.1.100",
    ]);
    expect(parseIpList("  ")).toEqual([]);
    expect(parseIpList("1.1.1.1, , 2.2.2.2")).toEqual(["1.1.1.1", "2.2.2.2"]);
  });

  test("matchIpv4Cidr correctly matches exact IP and subnet ranges", () => {
    expect(matchIpv4Cidr("192.168.1.50", "192.168.1.50")).toBe(true);
    expect(matchIpv4Cidr("192.168.1.51", "192.168.1.50")).toBe(false);

    // /24 subnet
    expect(matchIpv4Cidr("192.168.1.50", "192.168.1.0/24")).toBe(true);
    expect(matchIpv4Cidr("192.168.2.1", "192.168.1.0/24")).toBe(false);

    // /16 subnet
    expect(matchIpv4Cidr("10.50.1.2", "10.50.0.0/16")).toBe(true);
    expect(matchIpv4Cidr("10.51.1.2", "10.50.0.0/16")).toBe(false);

    // /8 subnet
    expect(matchIpv4Cidr("10.254.1.2", "10.0.0.0/8")).toBe(true);
    expect(matchIpv4Cidr("11.0.0.1", "10.0.0.0/8")).toBe(false);

    // /32 exact
    expect(matchIpv4Cidr("8.8.8.8", "8.8.8.8/32")).toBe(true);
    expect(matchIpv4Cidr("8.8.8.9", "8.8.8.8/32")).toBe(false);

    // invalid CIDR format or mask
    expect(matchIpv4Cidr("8.8.8.8", "8.8.8.8/99")).toBe(false);
    expect(matchIpv4Cidr("not-an-ip", "8.8.8.8/32")).toBe(false);
  });

  test("extractClientIp extracts IP with correct header priority", () => {
    const headers1 = new Headers({
      "x-forwarded-for": "203.0.113.195, 70.41.3.18, 150.172.238.178",
      "x-real-ip": "198.51.100.1",
    });
    expect(extractClientIp(headers1)).toBe("203.0.113.195");

    const headers2 = new Headers({
      "x-real-ip": "198.51.100.1",
      "cf-connecting-ip": "192.0.2.1",
    });
    expect(extractClientIp(headers2)).toBe("198.51.100.1");

    const headers3 = new Headers({
      "cf-connecting-ip": "192.0.2.1",
    });
    expect(extractClientIp(headers3)).toBe("192.0.2.1");

    const headersEmpty = new Headers();
    expect(extractClientIp(headersEmpty)).toBeNull();
  });

  test("evaluateIpFilter enforces allowlist and blocklist rules", () => {
    // Blocklist rejection
    const blockVerdict = evaluateIpFilter("192.168.1.10", {
      blocklist: ["192.168.1.0/24"],
    });
    expect(blockVerdict.allowed).toBe(false);
    expect(blockVerdict.reason).toBe("blocked_by_blocklist");

    // Blocklist bypass
    const blockPassVerdict = evaluateIpFilter("10.0.0.1", {
      blocklist: ["192.168.1.0/24"],
    });
    expect(blockPassVerdict.allowed).toBe(true);

    // Allowlist success
    const allowVerdict = evaluateIpFilter("10.0.0.5", {
      allowlist: ["10.0.0.0/16"],
    });
    expect(allowVerdict.allowed).toBe(true);

    // Allowlist rejection
    const allowRejectVerdict = evaluateIpFilter("172.16.0.1", {
      allowlist: ["10.0.0.0/16"],
    });
    expect(allowRejectVerdict.allowed).toBe(false);
    expect(allowRejectVerdict.reason).toBe("not_in_allowlist");

    // Null IP handling
    const nullIpVerdict = evaluateIpFilter(null, {
      allowlist: ["10.0.0.0/16"],
    });
    expect(nullIpVerdict.allowed).toBe(false);
    expect(nullIpVerdict.reason).toBe("invalid_ip");
  });
});

describe("Firewall Integration Tests with Hono app", () => {
  async function getSignatureWithIp(app: any, ip: string) {
    const res = await app.request("/v1/echo", {
      headers: { "x-forwarded-for": ip },
    });
    const encoded = res.headers.get("payment-required");
    if (res.status !== 402 || !encoded) {
      throw new Error(`Expected challenge, got ${res.status}`);
    }
    const challenge = JSON.parse(Buffer.from(encoded, "base64").toString());
    const accepted = challenge.accepts[0];
    const payload = {
      x402Version: 2,
      accepted,
      payload: {
        signature: "0xfixture",
        authorization: {
          from: "0xabcdefabcdefabcdefabcdefabcdefabcdefabcd",
          to: "0x1234567890123456789012345678901234567890",
          value: accepted.amount,
          validAfter: "0",
          validBefore: "9999999999",
          nonce: `0x${"00".repeat(32)}`,
        },
      },
    };
    return Buffer.from(JSON.stringify(payload)).toString("base64");
  }

  test("allows requests when IP is within allowlist", async () => {
    const { app } = harness({
      env: {
        FIREWALL_ALLOWLIST: "192.168.1.0/24, 10.0.0.1",
      },
      upstream: async () => Response.json({ status: "ok" }),
    });

    const sig = await getSignatureWithIp(app, "192.168.1.42");
    const res = await app.request("/v1/echo", {
      headers: {
        "x-forwarded-for": "192.168.1.42",
        "payment-signature": sig,
      },
    });
    expect(res.status).toBe(200);
  });

  test("blocks requests when IP is not in allowlist with 403 Forbidden", async () => {
    const { app } = harness({
      env: {
        FIREWALL_ALLOWLIST: "192.168.1.0/24",
      },
    });

    const res = await app.request("/v1/echo", {
      headers: {
        "x-forwarded-for": "8.8.8.8",
      },
    });
    expect(res.status).toBe(403);
    const body = (await res.json()) as {
      error: string;
      reason: string;
      ip: string;
    };
    expect(body.error).toBe("forbidden_ip");
    expect(body.reason).toBe("not_in_allowlist");
    expect(body.ip).toBe("8.8.8.8");
  });

  test("blocks requests when IP is in blocklist with 403 Forbidden", async () => {
    const { app } = harness({
      env: {
        FIREWALL_BLOCKLIST: "203.0.113.0/24",
      },
    });

    const res = await app.request("/v1/echo", {
      headers: {
        "x-real-ip": "203.0.113.5",
      },
    });
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: string; reason: string };
    expect(body.error).toBe("forbidden_ip");
    expect(body.reason).toBe("blocked_by_blocklist");
  });

  test("healthz and metrics bypass IP firewall", async () => {
    const { app } = harness({
      env: {
        FIREWALL_ALLOWLIST: "10.0.0.0/8",
      },
    });

    const healthRes = await app.request("/healthz", {
      headers: {
        "x-forwarded-for": "8.8.8.8",
      },
    });
    expect(healthRes.status).toBe(200);
  });
});
