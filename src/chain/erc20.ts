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

const ERC20_DECIMALS_ABI = [
  {
    type: "function",
    name: "decimals",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "uint8" }],
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

/**
 * Best-effort ERC-20 `decimals()` lookup, used only for USD-value
 * enrichment (converting a trade's raw base-unit tokenAmount into human
 * units before multiplying by a DexScreener price). Null on failure —
 * callers must skip enrichment rather than assume 18, since it's the one
 * thing that would silently make a USD figure wrong by orders of magnitude.
 */
export async function resolveTokenDecimals(
  client: MinimalReadClient,
  tokenAddress: `0x${string}`,
  logger: Logger,
): Promise<number | null> {
  try {
    const value = await client.readContract({
      address: tokenAddress,
      abi: ERC20_DECIMALS_ABI,
      functionName: "decimals",
    });
    return typeof value === "number" ? value : typeof value === "bigint" ? Number(value) : null;
  } catch (err) {
    logger.warn({ err, tokenAddress }, "failed to read ERC20 decimals()");
    return null;
  }
}
