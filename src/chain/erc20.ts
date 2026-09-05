import type { Logger } from "../logger.js";

/** Minimal ERC-20 metadata read surface — kept separate from viem's full
 * PublicClient type so this stays mockable in tests. */
export interface MinimalReadClient {
  readContract: (args: {
    address: `0x${string}`;
    abi: readonly unknown[];
    functionName: string;
  }) => Promise<unknown>;
}

const ERC20_METADATA_ABI = [
  {
    type: "function",
    name: "name",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "string" }],
  },
  {
    type: "function",
    name: "symbol",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "string" }],
  },
] as const;

export interface TokenMetadata {
  name: string | null;
  symbol: string | null;
}

/**
 * Best-effort ERC-20 `name()`/`symbol()` lookup for a freshly launched
 * token. Brand new tokens can be flaky to call against right at launch, so
 * failures are swallowed and reported as null rather than blocking the
 * detector from recording the launch.
 */
export async function resolveTokenMetadata(
  client: MinimalReadClient,
  tokenAddress: `0x${string}`,
  logger: Logger,
): Promise<TokenMetadata> {
  const [name, symbol] = await Promise.all([
    client
      .readContract({ address: tokenAddress, abi: ERC20_METADATA_ABI, functionName: "name" })
      .then((v) => (typeof v === "string" ? v : null))
      .catch((err: unknown) => {
        logger.warn({ err, tokenAddress }, "failed to read ERC20 name()");
        return null;
      }),
    client
      .readContract({ address: tokenAddress, abi: ERC20_METADATA_ABI, functionName: "symbol" })
      .then((v) => (typeof v === "string" ? v : null))
      .catch((err: unknown) => {
        logger.warn({ err, tokenAddress }, "failed to read ERC20 symbol()");
        return null;
      }),
  ]);

  return { name, symbol };
}
