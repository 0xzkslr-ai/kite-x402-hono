import type { AssetAmount, Network } from "@x402/core/types";

export interface KiteNetwork {
  readonly network: Network;
  readonly asset: string;
  readonly symbol: string;
  readonly decimals: number;
  readonly name: string;
  readonly version: string;
}

// Network constants follow gokite-ai/kite-x402-services (see NOTICE).
export const KITE_NETWORKS = {
  mainnet: {
    network: "eip155:2366",
    asset: "0x7aB6f3ed87C42eF0aDb67Ed95090f8bF5240149e",
    symbol: "USDC.e",
    decimals: 6,
    name: "Bridged USDC (Kite AI)",
    version: "2",
  },
  testnet: {
    network: "eip155:2368",
    asset: "0x38129cf4CE5E183eFF248F42A7D345Bb1B47621A",
    symbol: "pieUSD",
    decimals: 18,
    name: "pieUSD",
    version: "1",
  },
} as const satisfies Record<string, KiteNetwork>;

export function parsePrice(price: string, chain: KiteNetwork): AssetAmount {
  const value = price.trim().replace(/^\$/, "");
  if (!/^\d+(?:\.\d{1,6})?$/.test(value) || value.length > 40) {
    throw new Error(
      "PRICE_USD must be a positive decimal with at most 6 fractional digits",
    );
  }
  const [whole = "0", fractional = ""] = value.split(".");
  const units = BigInt(whole + fractional.padEnd(chain.decimals, "0"));
  if (units <= 0n) throw new Error("PRICE_USD must be greater than zero");
  return {
    asset: chain.asset,
    amount: units.toString(),
    extra: { name: chain.name, version: chain.version },
  };
}

/**
 * Resolves a Kite network descriptor from symbolic names ('mainnet', 'testnet'),
 * numeric EVM chain IDs (2366, 2368), or CAIP-2 network identifiers ('eip155:2366', 'eip155:2368').
 */
export function resolveNetwork(
  identifier: string | number,
): KiteNetwork | undefined {
  const norm = String(identifier).trim().toLowerCase();
  if (norm === "mainnet" || norm === "2366" || norm === "eip155:2366") {
    return KITE_NETWORKS.mainnet;
  }
  if (norm === "testnet" || norm === "2368" || norm === "eip155:2368") {
    return KITE_NETWORKS.testnet;
  }
  return undefined;
}
