export interface BackfillRange {
  fromBlock: bigint;
  toBlock: bigint;
}

/**
 * Computes the range of blocks missed while the process was down.
 *
 * - `lastProcessedBlock === null` means no prior scanner_state row exists
 *   (first ever startup) — returns null, no backfill, watcher starts from
 *   the current chain head.
 * - `lastProcessedBlock >= currentBlock` means nothing was missed — returns
 *   null.
 * - Otherwise returns the inclusive [lastProcessedBlock + 1, currentBlock]
 *   range that needs to be backfilled via the HTTP client.
 */
export function computeBackfillRange(
  lastProcessedBlock: bigint | null,
  currentBlock: bigint,
): BackfillRange | null {
  if (lastProcessedBlock === null) {
    return null;
  }
  if (currentBlock <= lastProcessedBlock) {
    return null;
  }
  return { fromBlock: lastProcessedBlock + 1n, toBlock: currentBlock };
}
