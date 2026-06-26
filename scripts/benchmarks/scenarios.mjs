/**
 * benchmark scenarios. Stateless public store endpoints with hard p97.5
 * latency gates (stricter thresholds). A 20% margin is applied in CI by the runner.
 * Concurrency/oversell + stateful checkout are covered by integration tests (inventory.int-spec.ts,
 * orders int-specs), not re-run here.
 *
 * `path` is relative to BENCH_BASE_URL (default http://localhost:3000). Product detail targets a
 * deterministic slug created by seed-bench.sql.
 */
export const scenarios = [
  {
    name: 'catalog browse',
    method: 'GET',
    path: '/store/v1/products',
    thresholdMs: 200,
    connections: 20,
    duration: 10,
  },
  {
    name: 'product detail',
    method: 'GET',
    path: '/store/v1/products/bench-product-500',
    thresholdMs: 150,
    connections: 20,
    duration: 10,
  },
  {
    name: 'categories list',
    method: 'GET',
    path: '/store/v1/categories',
    thresholdMs: 200,
    connections: 20,
    duration: 10,
  },
  {
    name: 'cart create',
    method: 'POST',
    path: '/store/v1/carts',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ currency: 'EUR' }),
    thresholdMs: 100,
    connections: 20,
    duration: 10,
  },
];
