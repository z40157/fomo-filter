// EIP-7702 delegation designator detection (added after the 2026-09-07 FOMO
// Top100 investigation — all 72 candidates' eth_getCode came back as exactly
// this pattern, not genuine contract bytecode; delegate resolved to
// eth-infinitism's Simple7702Account behind EntryPoint v0.8).
//
// Moved here (from scripts/lib/fomoWalletVerification.ts) so it ships in the
// production build and can be reused by src/discovery/walletDiscoveryJob.ts —
// scripts/ is dev-tooling only and isn't part of the compiled dist/ image.

export type AddressType = "EOA" | "EIP7702_DELEGATED_EOA" | "CONTRACT_OR_SMART_ACCOUNT";

function normalizeAddress(address: string): string {
  return address.toLowerCase();
}

/** EIP-7702 sets an EOA's code to EXACTLY `0xef0100` + a 20-byte delegate
 * address (23 bytes total, never more/less) — anything else non-empty is a
 * genuinely deployed contract. Getting this distinction wrong previously
 * collapsed every 7702-delegated address into CONTRACT_OR_SMART_ACCOUNT,
 * which (a) wrongly implied "not a real EOA / behavior unattributable to
 * one person" and (b) silently excluded these addresses from the
 * historical-RPC-support probe (Section 8) since it only ever looked for an
 * `addressType === "EOA"` candidate — with zero real EOAs in a candidate set
 * that's 72/72 delegated, the probe always short-circuited to UNKNOWN
 * regardless of what the RPC actually supports. */
const EIP7702_DELEGATION_DESIGNATOR_RE = /^0xef0100([a-fA-F0-9]{40})$/;

export function parseEip7702Delegate(code: string): string | null {
  const match = EIP7702_DELEGATION_DESIGNATOR_RE.exec(code);
  return match ? normalizeAddress(`0x${match[1]!}`) : null;
}

export function classifyAddressType(code: string): AddressType {
  if (!code || code === "0x") return "EOA";
  if (parseEip7702Delegate(code) !== null) return "EIP7702_DELEGATED_EOA";
  return "CONTRACT_OR_SMART_ACCOUNT";
}
