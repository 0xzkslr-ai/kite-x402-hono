import { expect, test } from "bun:test";
import { harness, PAY_TO } from "./helpers.js";

test("/.well-known/x402 exposes complete protocol metadata and testnet pricing", async () => {
  const { app, events } = harness({
    env: {
      KITE_NETWORK: "testnet",
      PRICE_USD: "0.001",
      SERVICE_DESCRIPTION: "AI Code Analysis Oracle",
    },
  });

  const res = await app.request("/.well-known/x402");
  expect(res.status).toBe(200);

  const body = (await res.json()) as {
    x402Version: number;
    scheme: string;
    network: string;
    asset: {
      address: string;
      symbol: string;
      decimals: number;
      name: string;
      version: string;
    };
    pricing: {
      usd: string;
      atomicAmount: string;
      payTo: string;
    };
    facilitator: string;
    description: string;
    limits: {
      maxBodyBytes: number;
      upstreamTimeoutMs: number;
      maxConcurrentRequests: number;
      facilitatorTimeoutMs: number;
    };
  };

  expect(body.x402Version).toBe(2);
  expect(body.scheme).toBe("exact");
  expect(body.network).toBe("eip155:2368");
  expect(body.asset.symbol).toBe("pieUSD");
  expect(body.asset.decimals).toBe(18);
  expect(body.pricing.usd).toBe("$0.001");
  // 0.001 * 10^18 = 10^15
  expect(body.pricing.atomicAmount).toBe("1000000000000000");
  expect(body.pricing.payTo).toBe(PAY_TO);
  expect(body.description).toBe("AI Code Analysis Oracle");
  expect(body.limits.maxBodyBytes).toBe(1048576);
  expect(body.limits.upstreamTimeoutMs).toBe(10000);

  // Unmetered discovery must never contact facilitator or settle
  expect(events).toEqual([]);
});

test("/.well-known/x402 reflects mainnet network and 6 decimal USDC.e asset", async () => {
  const { app, events } = harness({
    env: {
      KITE_NETWORK: "mainnet",
      PRICE_USD: "0.005",
    },
  });

  const res = await app.request("/.well-known/x402");
  expect(res.status).toBe(200);

  const body = (await res.json()) as any;
  expect(body.network).toBe("eip155:2366");
  expect(body.asset.symbol).toBe("USDC.e");
  expect(body.asset.decimals).toBe(6);
  expect(body.pricing.usd).toBe("$0.005");
  // 0.005 * 10^6 = 5000
  expect(body.pricing.atomicAmount).toBe("5000");
  expect(events).toEqual([]);
});
