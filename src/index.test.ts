import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRun, BudgetExceededError, GateFailedError, type RunEvent } from './index.js';

const noSleep = async () => {};

test('returns the result when the check passes', async () => {
  const run = createRun({ sleep: noSleep });
  const out = await run.step('draft', { run: () => 'hello' });
  assert.equal(out, 'hello');
});

test('retries until the check passes and feeds back the rejection', async () => {
  const run = createRun({ sleep: noSleep });
  const seen: (string | undefined)[] = [];
  const out = await run.step<string>('draft', {
    retries: 2,
    run: ({ attempt, lastRejection }) => {
      seen.push(lastRejection);
      return attempt < 3 ? 'short' : 'long enough';
    },
    check: (r) => r.length > 6 || 'needs more than 6 characters',
  });
  assert.equal(out, 'long enough');
  assert.deepEqual(seen, [undefined, 'needs more than 6 characters', 'needs more than 6 characters']);
});

test('throws GateFailedError when the check never passes', async () => {
  const run = createRun({ sleep: noSleep });
  await assert.rejects(
    run.step('draft', { retries: 1, run: () => 'no', check: () => 'still wrong' }),
    (e: unknown) => e instanceof GateFailedError && e.attempts === 2 && e.reason === 'still wrong',
  );
});

test('stops before a step that would break the budget', async () => {
  const run = createRun({ budgetUsd: 1, sleep: noSleep });
  await run.step('cheap', { run: () => 'ok', cost: () => 0.9 });
  let ran = false;
  await assert.rejects(
    run.step('expensive', {
      estimateUsd: 0.5,
      run: () => {
        ran = true;
        return 'ok';
      },
    }),
    BudgetExceededError,
  );
  assert.equal(ran, false, 'the step must not run at all');
  assert.equal(run.spentUsd, 0.9);
});

test('counts rejected attempts against the budget', async () => {
  const run = createRun({ budgetUsd: 0.25, sleep: noSleep });
  await assert.rejects(
    run.step('loop', {
      retries: 5,
      estimateUsd: 0.1,
      run: () => 'bad',
      cost: () => 0.1,
      check: () => 'never good',
    }),
    BudgetExceededError,
  );
  assert.ok(run.spentUsd <= 0.25 + 0.1, 'must not run away with the budget');
});

test('retries on a thrown error, then rethrows the last one', async () => {
  const run = createRun({ sleep: noSleep });
  let calls = 0;
  await assert.rejects(
    run.step('flaky', {
      retries: 2,
      run: () => {
        calls++;
        throw new Error('boom');
      },
    }),
    /boom/,
  );
  assert.equal(calls, 3);
});

test('reports remaining budget', async () => {
  const run = createRun({ budgetUsd: 2, sleep: noSleep });
  await run.step('a', { run: () => 1, cost: () => 0.75 });
  assert.equal(run.remainingUsd, 1.25);
});

test('emits events a logger can follow', async () => {
  const events: RunEvent[] = [];
  const run = createRun({ budgetUsd: 5, sleep: noSleep, onEvent: (e) => events.push(e) });
  await run.step('draft', {
    retries: 1,
    run: ({ attempt }) => (attempt === 1 ? 'no' : 'yes please'),
    check: (r: string) => r.length > 3 || 'too short',
    cost: () => 0.01,
  });
  assert.deepEqual(
    events.map((e) => e.type),
    ['step:start', 'run:spend', 'step:reject', 'step:start', 'run:spend', 'step:pass'],
  );
});
