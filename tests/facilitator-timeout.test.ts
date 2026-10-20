import { expect, test } from "bun:test";
import { createApp } from "../src/index.js";
import { testConfig, signature, supported, PAYER } from "./helpers.js";

for (const stage of ["supported", "verify", "settle"] as const) {
  for (const stall of ["headers", "body"] as const) {
    test(`${stage} stalled ${stall}: HTTP deadline, no automatic payment retry, recovery`, async () => {
      let blocked = true;
      const calls: string[] = [];
      let unblock!: () => void;
      const headerGate = new Promise<void>((resolve) => {
        unblock = resolve;
      });
      const facilitator = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        async fetch(request) {
          const operation = new URL(request.url).pathname.split("/").at(-1)!;
          calls.push(operation);
          if (operation === stage && blocked) {
            if (stall === "headers") await headerGate;
            else
              return new Response(
                new ReadableStream({
                  start(controller) {
                    controller.enqueue(new TextEncoder().encode('{"partial":'));
                  },
                }),
                { headers: { "content-type": "application/json" } },
              );
          }
          if (operation === "supported") return Response.json(supported);
          if (operation === "verify")
            return Response.json({ isValid: true, payer: PAYER });
          return Response.json({
            success: true,
            transaction: "0xsimulated",
            network: "eip155:2368",
            payer: PAYER,
          });
        },
      });
      let upstreamCalls = 0;
      const app = createApp(
        testConfig({
          FACILITATOR_URL: `${facilitator.url.origin}/v2`,
          FACILITATOR_TIMEOUT_MS: "100",
          MAX_CONCURRENT_REQUESTS: "1",
          CORS_ORIGIN: "https://app.example",
        }),
        {
          fetchUpstream: async () => {
            upstreamCalls++;
            return Response.json({ secretResource: true });
          },
        },
      );
      try {
        const headers =
          stage === "supported"
            ? {}
            : { "payment-signature": await signature(app) };
        const response = await app.request("/v1/echo", {
          headers: { ...headers, origin: "https://app.example" },
        });
        expect(response.status).toBe(stage === "supported" ? 503 : 502);
        expect(await response.text()).not.toContain("secretResource");
        expect(response.headers.get("payment-response")).toBeNull();
        expect(response.headers.get("access-control-allow-origin")).toBe(
          "https://app.example",
        );
        expect(
          response.headers.get("access-control-expose-headers")?.toLowerCase(),
        ).toContain("payment-response");
        expect(response.headers.get("vary")).toContain("Origin");
        expect(upstreamCalls).toBe(stage === "settle" ? 1 : 0);
        expect(calls.filter((x) => x === stage)).toHaveLength(1);
        if (stage === "verify") expect(calls).not.toContain("settle");
        expect((await app.request("/healthz")).status).toBe(200);
        blocked = false;
        unblock();
        // Use an unpaid request, not a payment retry: settlement outcome may be unknown.
        const recovered = await app.request("/v1/echo");
        expect(recovered.status).toBe(402);
        expect(upstreamCalls).toBe(stage === "settle" ? 1 : 0);
      } finally {
        unblock();
        await facilitator.stop(true);
      }
    }, 5000);
  }
}

test("facilitator deadline config is bounded and backwards compatible", async () => {
  expect(testConfig().facilitatorTimeoutMs).toBe(90000);
  expect(
    testConfig({ FACILITATOR_TIMEOUT_MS: "300000" }).facilitatorTimeoutMs,
  ).toBe(300000);
  for (const value of ["0", "-1", "1.5", "300001", "Infinity", "abc"]) {
    expect(() => testConfig({ FACILITATOR_TIMEOUT_MS: value })).toThrow(
      "FACILITATOR_TIMEOUT_MS",
    );
  }
  const config = testConfig();
  delete config.facilitatorTimeoutMs;
  expect((await createApp(config).request("/healthz")).status).toBe(200);
  for (const value of [0, -1, 1.5, 300001, NaN, Infinity]) {
    expect(() => createApp({ ...config, facilitatorTimeoutMs: value })).toThrow(
      "facilitatorTimeoutMs",
    );
  }
});
