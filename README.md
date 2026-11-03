# agent-rails

Budget caps, validation gates and repair retries for multi-step agent runs. Zero dependencies, ~170 lines, TypeScript.

```bash
npm install agent-rails
```

## Why this exists

I sell a Mac app that drives coding agents on the buyer's own machine, and I run an agent pipeline that delivers client websites from a single interview. Both taught me the same three lessons, and none of them showed up while the agents were still demos on my laptop:

1. **A cap you check after the step is a report, not a cap.** By the time you add up what a run cost, the money is gone. The check has to happen before the call.
2. **A step that returns something unusable should not quietly continue.** Multi-step agents compound their own mistakes: step 3 builds confidently on the garbage step 2 produced.
3. **A retry that repeats the same prompt is a waste of a call.** If you know *why* you rejected the last attempt, hand that reason to the next one.

This library is those three things and nothing else. It does not wrap your model client, pick your provider, or own your prompts.

## Use

```ts
import { createRun } from 'agent-rails';

const run = createRun({
  budgetUsd: 2.00,
  retries: 2,
  onEvent: (e) => logger.info(e),
});

const outline = await run.step('outline', {
  estimateUsd: 0.05,
  run: ({ lastRejection }) =>
    llm.complete({
      prompt: lastRejection
        ? `${basePrompt}\n\nYour previous answer was rejected: ${lastRejection}. Fix it.`
        : basePrompt,
    }),
  cost: (r) => r.usage.costUsd,
  check: (r) => r.sections.length >= 3 || 'needs at least 3 sections',
});

const draft = await run.step('draft', {
  estimateUsd: 0.40,
  run: () => llm.complete({ prompt: writePrompt(outline) }),
  cost: (r) => r.usage.costUsd,
  check: (r) => (r.text.includes('TODO') ? 'left a TODO in the copy' : true),
});

console.log(`spent $${run.spentUsd.toFixed(2)}, $${run.remainingUsd.toFixed(2)} left`);
```

## The three ideas

### Spend is checked before the call

`estimateUsd` is what the step might cost. If `spent + estimate` would pass the cap, the step throws `BudgetExceededError` and never runs. Rejected attempts count too — a loop that fails its check five times cannot quietly drain the rest of the budget, because the cap is re-checked between retries.

```ts
const run = createRun({ budgetUsd: 1.00 });
await run.step('cheap', { run: ..., cost: () => 0.90 });
await run.step('expensive', { estimateUsd: 0.50, run: ... });
// BudgetExceededError: spent $0.9000 + estimated $0.5000 > cap $1.0000
// The expensive step never executed.
```

### A check is a gate, not a log line

`check` returns `true` to accept, or a **string saying what is wrong**. A string is a rejection, and it stops the step from returning.

```ts
check: (r) => r.rows.length > 0 || 'query returned no rows',
check: (r) => (isValidJson(r.text) ? true : 'not valid JSON'),
```

After the last attempt, a still-failing check throws `GateFailedError` carrying the reason. Your pipeline stops where the problem is, not three steps later.

### Retries carry the reason forward

The rejection string is passed to the next attempt as `lastRejection`. Put it in the prompt and the model repairs its own output instead of rolling the dice again.

```ts
run: ({ attempt, lastRejection }) =>
  llm.complete({
    prompt: lastRejection ? `${base}\n\nRejected because: ${lastRejection}` : base,
  }),
```

Backoff between attempts is exponential from `backoffMs` (default 250ms). Thrown errors retry on the same schedule and the last one is rethrown.

## Events

Everything emits, so you can put a run on a dashboard without instrumenting your own steps:

```ts
type RunEvent =
  | { type: 'step:start';  step: string; attempt: number }
  | { type: 'step:pass';   step: string; attempt: number; costUsd: number; ms: number }
  | { type: 'step:reject'; step: string; attempt: number; reason: string; costUsd: number }
  | { type: 'step:error';  step: string; attempt: number; error: unknown }
  | { type: 'run:spend';   step: string; costUsd: number; spentUsd: number; budgetUsd: number };
```

## API

| | |
|---|---|
| `createRun(options)` | `budgetUsd?`, `retries?`, `backoffMs?`, `onEvent?`, `sleep?` |
| `run.step(name, options)` | `run`, `check?`, `cost?`, `estimateUsd?`, `retries?` |
| `run.spentUsd` | USD spent so far |
| `run.remainingUsd` | USD left before the cap, or `Infinity` |
| `BudgetExceededError` | `step`, `spentUsd`, `budgetUsd`, `estimatedUsd` |
| `GateFailedError` | `step`, `attempts`, `reason` |

`sleep` is injectable so your tests do not wait for backoff.

## What this is not

Not a framework. It has no opinion about your model, your prompts, or how you store state. If you want an agent framework, use one — this is the seatbelt you put on whatever you already drive.

## License

MIT © Berkin Sili
