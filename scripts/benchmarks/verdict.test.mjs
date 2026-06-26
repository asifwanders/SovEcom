/** self-check for the benchmark gate logic. Run: `node --test scripts/benchmarks/`. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { effectiveThreshold, evaluate, summarize } from './verdict.mjs';

test('effectiveThreshold adds the 20% margin only in CI', () => {
  assert.equal(effectiveThreshold(200, false), 200);
  assert.equal(effectiveThreshold(200, true), 240);
  assert.equal(effectiveThreshold(150, true), 180);
});

test('passes when p97.5 is within the (margined) ceiling', () => {
  assert.equal(evaluate({ name: 'a', p975: 190, thresholdMs: 200 }, false).pass, true);
  // 210 > 200 locally → fail, but ≤ 240 in CI → pass
  assert.equal(evaluate({ name: 'a', p975: 210, thresholdMs: 200 }, false).pass, false);
  assert.equal(evaluate({ name: 'a', p975: 210, thresholdMs: 200 }, true).pass, true);
});

test('any non-2xx response fails the scenario regardless of latency', () => {
  const r = evaluate({ name: 'a', p975: 10, thresholdMs: 200, non2xx: 3 }, false);
  assert.equal(r.pass, false);
  assert.match(r.reason, /non-2xx/);
});

test('summarize fails the run if any scenario fails', () => {
  const ok = summarize([{ name: 'a', p975: 10, thresholdMs: 200 }], false);
  assert.equal(ok.failed, false);
  const bad = summarize(
    [
      { name: 'a', p975: 10, thresholdMs: 200 },
      { name: 'b', p975: 999, thresholdMs: 100 },
    ],
    false,
  );
  assert.equal(bad.failed, true);
});
