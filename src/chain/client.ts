import { createPublicClient, http, webSocket, type EIP1193RequestFn, type Transport } from "viem";
import { rpcMetrics } from "./rpcMetrics.js";

/** Wraps a transport so every JSON-RPC method it sends is counted in
 * `rpcMetrics` (Phase 0 observability — see rpcMetrics.ts). Purely a
 * counting side effect on the request path; request/response handling is
 * untouched. */
function withRpcMetrics(transport: Transport): Transport {
  return (params) => {
    const inner = transport(params);
    const instrumentedRequest: EIP1193RequestFn = (async (args: { method: string }) => {
      rpcMetrics.record(args.method);
      return inner.request(args as Parameters<typeof inner.request>[0]);
    }) as EIP1193RequestFn;
    return { ...inner, request: instrumentedRequest };
  };
}

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
    transport: withRpcMetrics(http(rpcHttpUrl)),
  });
}

export type HttpClient = ReturnType<typeof createHttpClient>;

export function createWsClient(rpcWsUrl: string) {
  return createPublicClient({
    chain: chainDefinition(rpcWsUrl),
    transport: withRpcMetrics(webSocket(rpcWsUrl, {
      // Reconnection is handled by ChainWatcher's own exponential backoff
      // rather than viem's built-in retry, so we get consistent logging.
      reconnect: false,
      // This RPC's WSS edge doesn't handle WebSocket-level ping frames —
      // viem's keepalive ping was closing an otherwise-healthy connection
      // every ~20s (confirmed: a raw eth_subscribe with no ping traffic
      // stayed open and streamed blocks fine). Plain JSON-RPC traffic over
      // the socket is what actually detects a dead connection here.
      keepAlive: false,
    })),
  });
}

export type WsClient = ReturnType<typeof createWsClient>;
