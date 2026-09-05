import { createPublicClient, http, webSocket } from "viem";

export const CHAIN_ID = 4663;

function chainDefinition(rpcUrl: string) {
  return {
    id: CHAIN_ID,
    name: "Robinhood Chain",
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: {
      default: { http: [rpcUrl], webSocket: [rpcUrl] },
    },
  } as const;
}

export function createHttpClient(rpcHttpUrl: string) {
  return createPublicClient({
    chain: chainDefinition(rpcHttpUrl),
    transport: http(rpcHttpUrl),
  });
}

export type HttpClient = ReturnType<typeof createHttpClient>;

export function createWsClient(rpcWsUrl: string) {
  return createPublicClient({
    chain: chainDefinition(rpcWsUrl),
    transport: webSocket(rpcWsUrl, {
      // Reconnection is handled by ChainWatcher's own exponential backoff
      // rather than viem's built-in retry, so we get consistent logging.
      reconnect: false,
      // This RPC's WSS edge doesn't handle WebSocket-level ping frames —
      // viem's keepalive ping was closing an otherwise-healthy connection
      // every ~20s (confirmed: a raw eth_subscribe with no ping traffic
      // stayed open and streamed blocks fine). Plain JSON-RPC traffic over
      // the socket is what actually detects a dead connection here.
      keepAlive: false,
    }),
  });
}

export type WsClient = ReturnType<typeof createWsClient>;
