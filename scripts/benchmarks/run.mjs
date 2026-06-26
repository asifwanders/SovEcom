#!/usr/bin/env node
/**
 * benchmark runner. Runs each scenario with autocannon, reads p97.5, applies
 * the CI margin, prints a table, writes bench-results.{md,json}, and EXITS NON-ZERO if any scenario
 * breaches its threshold or serves non-2xx responses (this is the CI build-fail gate).
 *
 * Env:
 *   BENCH_BASE_URL  target API origin (default http://localhost:3000)
 *   CI              when set/true, adds the 20% latency margin (variance allowance)
 *   BENCH_DURATION  override per-scenario duration seconds (default per-scenario, ~10s)
 *
 * Assumes the API is already running and seeded (seed-bench.sql) with the store rate limit raised
 * (STORE_RATE_LIMIT) — see bench.sh / the CI job.
 */
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import autocannon from 'autocannon';
import { scenarios } from './scenarios.mjs';
import { summarize, toMarkdown } from './verdict.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const BASE = process.env.BENCH_BASE_URL ?? 'http://localhost:3000';
const CI = Boolean(process.env.CI && process.env.CI !== 'false');
const DURATION_OVERRIDE = process.env.BENCH_DURATION ? Number(process.env.BENCH_DURATION) : null;

function runOne(s) {
  return new Promise((resolve, reject) => {
    autocannon(
      {
        url: BASE + s.path,
        method: s.method,
        headers: s.headers,
        body: s.body,
        connections: s.connections ?? 20,
        duration: DURATION_OVERRIDE ?? s.duration ?? 10,
      },
      (err, result) => (err ? reject(err) : resolve(result)),
    );
  });
}

async function main() {
  console.log(`\nBenchmarking ${BASE}  (${CI ? 'CI: +20% margin' : 'local'})\n`);
  const results = [];
  for (const s of scenarios) {
    process.stdout.write(`  → ${s.name} … `);
    const r = await runOne(s);
    // autocannon exposes p97_5 (stricter threshold). non2xx = errored responses.
    const p975 = Math.round(r.latency.p97_5);
    const non2xx = r.non2xx + (r.errors ?? 0);
    console.log(`p97.5=${p975}ms  req/s=${Math.round(r.requests.average)}  non2xx=${non2xx}`);
    results.push({ name: s.name, p975, thresholdMs: s.thresholdMs, non2xx });
  }

  const { rows, failed } = summarize(results, CI);
  const md = toMarkdown(rows, CI);
  console.log('\n' + md);
  writeFileSync(join(HERE, 'bench-results.md'), md);
  writeFileSync(join(HERE, 'bench-results.json'), JSON.stringify({ ci: CI, rows }, null, 2));

  if (failed) {
    console.error('❌ Performance regression — one or more thresholds exceeded.');
    process.exit(1);
  }
  console.log('✅ All benchmarks within thresholds.');
}

main().catch((e) => {
  console.error('benchmark run failed:', e.message);
  process.exit(2);
});
