export interface BackoffOptions {
  /** Delay before the first retry, in milliseconds. */
  initialMs: number;
  /** Upper bound on the delay, in milliseconds. */
  maxMs: number;
  /** Multiplier applied to the delay after each attempt. */
  factor: number;
}

export const DEFAULT_BACKOFF_OPTIONS: BackoffOptions = {
  initialMs: 1_000,
  maxMs: 60_000,
  factor: 2,
};

/**
 * Exponential backoff with a configurable cap. Call `next()` to get the
 * delay to wait before the next retry attempt (also advances internal
 * state), and `reset()` once a connection succeeds to start over from
 * `initialMs`.
 */
export class ExponentialBackoff {
  private attempt = 0;
  private readonly opts: BackoffOptions;

  constructor(opts: Partial<BackoffOptions> = {}) {
    this.opts = { ...DEFAULT_BACKOFF_OPTIONS, ...opts };
  }

  next(): number {
    const delay = Math.min(
      this.opts.initialMs * this.opts.factor ** this.attempt,
      this.opts.maxMs,
    );
    this.attempt += 1;
    return delay;
  }

  reset(): void {
    this.attempt = 0;
  }
}
