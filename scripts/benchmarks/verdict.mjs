/**
 * pure pass/fail logic for the benchmark gate. No I/O, so it is unit-tested
 * (verdict.test.mjs). A scenario PASSES when its p97.5 latency is within the threshold AND it served
 * zero non-2xx responses. In CI a 20% margin is added to the threshold to absorb
 * test-runner variance and avoid failing on noise.
 */

export const CI_MARGIN = 1.2;

/** Effective latency ceiling for a scenario: the raw threshold, +20% when running in CI. */
export function effectiveThreshold(thresholdMs, ci) {
  return ci ? Math.round(thresholdMs * CI_MARGIN) : thresholdMs;
}

/**
 * Evaluate one scenario result.
 * @param {{name:string, p975:number, thresholdMs:number, non2xx?:number}} r
 * @param {boolean} ci
 * @returns {{name:string, p975:number, thresholdMs:number, ceiling:number, non2xx:number, pass:boolean, reason:string}}
 */
export function evaluate(r, ci) {
  const ceiling = effectiveThreshold(r.thresholdMs, ci);
  const non2xx = r.non2xx ?? 0;
  let pass = true;
  let reason = 'ok';
  if (non2xx > 0) {
    pass = false;
    reason = `${non2xx} non-2xx responses`;
  } else if (r.p975 > ceiling) {
    pass = false;
    reason = `p97.5 ${r.p975}ms > ${ceiling}ms`;
  }
  return { name: r.name, p975: r.p975, thresholdMs: r.thresholdMs, ceiling, non2xx, pass, reason };
}

/** Evaluate all scenarios; returns rows + whether the whole run failed (the build-gate signal). */
export function summarize(results, ci) {
  const rows = results.map((r) => evaluate(r, ci));
  return { rows, failed: rows.some((row) => !row.pass) };
}

/** Render the verdict as a Markdown table (used for the PR comment + console). */
export function toMarkdown(rows, ci) {
  const head = `### Performance benchmarks ${ci ? '(CI, +20% margin)' : '(local)'}\n\n`;
  const cols = '| Scenario | p97.5 | Threshold | Verdict |\n|---|---|---|---|\n';
  const body = rows
    .map(
      (r) =>
        `| ${r.name} | ${r.p975}ms | ${r.ceiling}ms | ${r.pass ? '✅ pass' : `❌ ${r.reason}`} |`,
    )
    .join('\n');
  return head + cols + body + '\n';
}
