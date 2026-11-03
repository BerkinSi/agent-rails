/**
 * agent-rails — keep a multi-step agent run inside its budget, and stop it
 * the moment a step produces something you cannot use.
 *
 * Three things, no dependencies:
 *   1. a hard spend cap for the whole run, checked before a step, not after
 *   2. a validation gate on every step's output
 *   3. retries that hand the failure reason back to the next attempt
 */

export class BudgetExceededError extends Error {
  constructor(
    readonly step: string,
    readonly spentUsd: number,
    readonly budgetUsd: number,
    readonly estimatedUsd: number,
  ) {
    super(
      `Budget would be exceeded at step "${step}": spent $${spentUsd.toFixed(4)} ` +
      `+ estimated $${estimatedUsd.toFixed(4)} > cap $${budgetUsd.toFixed(4)}`,
    );
    this.name = 'BudgetExceededError';
  }
}

export class GateFailedError extends Error {
  constructor(
    readonly step: string,
    readonly attempts: number,
    readonly reason: string,
  ) {
    super(`Step "${step}" failed its check after ${attempts} attempt(s): ${reason}`);
    this.name = 'GateFailedError';
  }
}

/** What a check can return: true to pass, or a string explaining the refusal. */
export type CheckResult = boolean | string;

export type RunEvent =
  | { type: 'step:start'; step: string; attempt: number }
  | { type: 'step:pass'; step: string; attempt: number; costUsd: number; ms: number }
  | { type: 'step:reject'; step: string; attempt: number; reason: string; costUsd: number }
  | { type: 'step:error'; step: string; attempt: number; error: unknown }
  | { type: 'run:spend'; step: string; costUsd: number; spentUsd: number; budgetUsd: number };

export interface RunOptions {
  /** Hard cap in USD for the whole run. Omit for no cap. */
  budgetUsd?: number;
  /** Default retry count for steps that do not set their own. */
  retries?: number;
  /** Base delay in ms for exponential backoff between attempts. Default 250. */
  backoffMs?: number;
  /** Called for every event. Wire it to your logger. */
  onEvent?: (event: RunEvent) => void;
  /** Injectable sleep, so tests do not wait. */
  sleep?: (ms: number) => Promise<void>;
}

export interface StepOptions<T> {
  /** The work. Receives the reason the previous attempt was rejected, if any. */
  run: (context: { attempt: number; lastRejection?: string }) => Promise<T> | T;
  /**
   * Gate on the result. Return true to accept, or a string saying what is wrong.
   * The string is handed to the next attempt, so the model can repair its own output.
   */
  check?: (result: T) => CheckResult | Promise<CheckResult>;
  /** Actual cost of this attempt, read from the result. Defaults to 0. */
  cost?: (result: T) => number;
  /**
   * What this step might cost, checked BEFORE it runs. This is the difference
   * between a cap that works and a cap that reports the damage afterwards.
   */
  estimateUsd?: number;
  /** Overrides the run-level retry count. */
  retries?: number;
}

export interface Run {
  step<T>(name: string, options: StepOptions<T>): Promise<T>;
  /** USD spent so far. */
  readonly spentUsd: number;
  /** USD left before the cap, or Infinity when there is no cap. */
  readonly remainingUsd: number;
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export function createRun(options: RunOptions = {}): Run {
  const {
    budgetUsd,
    retries: defaultRetries = 0,
    backoffMs = 250,
    onEvent = () => {},
    sleep = defaultSleep,
  } = options;

  let spent = 0;
  const cap = budgetUsd ?? Infinity;

  async function step<T>(name: string, opts: StepOptions<T>): Promise<T> {
    const estimate = opts.estimateUsd ?? 0;

    // Check before spending, not after. A loop that overruns its budget should
    // be stopped on the attempt that would break it.
    if (spent + estimate > cap) {
      throw new BudgetExceededError(name, spent, cap, estimate);
    }

    const maxAttempts = (opts.retries ?? defaultRetries) + 1;
    let lastRejection: string | undefined;
    let lastError: unknown;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      onEvent({ type: 'step:start', step: name, attempt });
      const startedAt = Date.now();

      let result: T;
      try {
        result = await opts.run({ attempt, lastRejection });
      } catch (error) {
        lastError = error;
        onEvent({ type: 'step:error', step: name, attempt, error });
        if (attempt === maxAttempts) throw error;
        await sleep(backoffMs * 2 ** (attempt - 1));
        continue;
      }

      const costUsd = opts.cost ? opts.cost(result) : 0;
      spent += costUsd;
      if (costUsd > 0) {
        onEvent({ type: 'run:spend', step: name, costUsd, spentUsd: spent, budgetUsd: cap });
      }

      const verdict = opts.check ? await opts.check(result) : true;
      if (verdict === true) {
        onEvent({ type: 'step:pass', step: name, attempt, costUsd, ms: Date.now() - startedAt });
        return result;
      }

      lastRejection = typeof verdict === 'string' ? verdict : 'check returned false';
      onEvent({ type: 'step:reject', step: name, attempt, reason: lastRejection, costUsd });

      if (attempt === maxAttempts) {
        throw new GateFailedError(name, maxAttempts, lastRejection);
      }

      // A rejected attempt still cost money. Re-check the cap before retrying.
      if (spent + estimate > cap) {
        throw new BudgetExceededError(name, spent, cap, estimate);
      }
      await sleep(backoffMs * 2 ** (attempt - 1));
    }

    throw lastError ?? new Error(`Step "${name}" ended without a result`);
  }

  return {
    step,
    get spentUsd() {
      return spent;
    },
    get remainingUsd() {
      return cap === Infinity ? Infinity : Math.max(0, cap - spent);
    },
  };
}
