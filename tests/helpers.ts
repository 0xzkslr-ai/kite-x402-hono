import type { FacilitatorClient } from "@x402/core/server";
import type {
  PaymentPayload,
  PaymentRequired,
  SupportedResponse,
} from "@x402/core/types";
import {
  createApp,
  loadConfig,
  KITE_NETWORKS,
  PaymentNonceReplayGuard,
  type Config,
} from "../src/index.js";
import type { FetchUpstream } from "../src/proxy.js";

export const PAY_TO = "0x1234567890123456789012345678901234567890";
export const PAYER = "0xabcdefabcdefabcdefabcdefabcdefabcdefabcd";
export const supported: SupportedResponse = {
  kinds: Object.values(KITE_NETWORKS).map((chain) => ({
    x402Version: 2,
    scheme: "exact",
    network: chain.network,
  })),
  extensions: [],
  signers: {},
};

export function testConfig(env: Record<string, string> = {}): Config {
  return loadConfig({
    PAY_TO,
    UPSTREAM_URL: "https://upstream.example",
    KITE_NETWORK: "testnet",
    ...env,
  });
}

export function harness(
  options: {
    env?: Record<string, string>;
    valid?: boolean;
    settles?: boolean;
    upstream?: FetchUpstream;
    facilitator?: Partial<FacilitatorClient>;
    nonceGuard?: PaymentNonceReplayGuard;
  } = {},
) {
  const events: string[] = [];
  const config = testConfig(options.env);
  const facilitator: FacilitatorClient = {
    getSupported: async () => supported,
    verify: async () => {
      events.push("verify");
      return options.valid === false
        ? { isValid: false, invalidReason: "invalid_signature" }
        : { isValid: true, payer: PAYER };
    },
    settle: async () => {
      events.push("settle");
      return {
        success: options.settles !== false,
        transaction:
          options.settles === false ? "" : "0xmock-transaction-not-on-chain",
        network: config.chain.network,
        payer: PAYER,
        ...(options.settles === false
          ? { errorReason: "settlement_failed" }
          : {}),
      };
    },
    ...options.facilitator,
  };
  const app = createApp(config, {
    facilitator,
    nonceGuard: options.nonceGuard,
    fetchUpstream: async (request) => {
      events.push("upstream");
      return options.upstream
        ? options.upstream(request)
        : Response.json({ result: "protected response" });
    },
  });
  return { app, events, config };
}

export async function signature(
  app: ReturnType<typeof createApp>,
  path = "/v1/echo",
): Promise<string> {
  const response = await app.request(path);
  const encoded = response.headers.get("payment-required");
  if (response.status !== 402 || !encoded)
    throw new Error(
      `Expected challenge, got ${response.status}: ${await response.text()}`,
    );
  const challenge = JSON.parse(
    Buffer.from(encoded, "base64").toString(),
  ) as PaymentRequired;
  const accepted = challenge.accepts[0];
  if (!accepted) throw new Error("No payment requirements");
  // The facilitator is simulated. These bytes are deliberately not a real payment signature.
  const payload: PaymentPayload = {
    x402Version: 2,
    accepted,
    payload: {
      signature: "0xfixture",
      authorization: {
        from: PAYER,
        to: PAY_TO,
        value: accepted.amount,
        validAfter: "0",
        validBefore: "9999999999",
        nonce: `0x${"00".repeat(32)}`,
      },
    },
  };
  return Buffer.from(JSON.stringify(payload)).toString("base64");
}
