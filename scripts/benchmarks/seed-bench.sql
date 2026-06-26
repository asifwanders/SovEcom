-- bulk benchmark seed: 50 categories + 1000 published products (one variant
-- each, high stock) for the default tenant. Idempotent (WHERE NOT EXISTS — no unique-constraint
-- dependency). Deterministic slugs: bench-cat-N / bench-product-N (so scenarios target a known slug).
-- Run AFTER migrate + the install seed (which creates the default tenant in system_state).

-- Categories
WITH t AS (SELECT (value #>> '{}')::uuid AS tenant_id FROM system_state WHERE key = 'default_tenant_id')
INSERT INTO categories (id, tenant_id, name, slug, position)
SELECT gen_random_uuid(), t.tenant_id, 'Bench Category ' || g, 'bench-cat-' || g, g
FROM t, generate_series(1, 50) AS g
WHERE NOT EXISTS (
  SELECT 1 FROM categories c WHERE c.tenant_id = t.tenant_id AND c.slug = 'bench-cat-' || g
);

-- Products (published so the store list/detail endpoints return them)
WITH t AS (SELECT (value #>> '{}')::uuid AS tenant_id FROM system_state WHERE key = 'default_tenant_id')
INSERT INTO products (id, tenant_id, title, slug, status)
SELECT gen_random_uuid(), t.tenant_id, 'Bench Product ' || g, 'bench-product-' || g, 'published'
FROM t, generate_series(1, 1000) AS g
WHERE NOT EXISTS (
  SELECT 1 FROM products p WHERE p.tenant_id = t.tenant_id AND p.slug = 'bench-product-' || g
);

-- One variant per bench product (price 19.99 EUR, effectively unlimited stock for add-to-cart)
INSERT INTO product_variants (id, tenant_id, product_id, sku, options, price_amount, currency, stock_quantity)
SELECT gen_random_uuid(), p.tenant_id, p.id, 'BENCH-' || p.slug, '{}'::jsonb, 1999, 'EUR', 1000000
FROM products p
WHERE p.slug LIKE 'bench-product-%'
AND NOT EXISTS (
  SELECT 1 FROM product_variants v WHERE v.tenant_id = p.tenant_id AND v.sku = 'BENCH-' || p.slug
);

-- Report
SELECT
  (SELECT count(*) FROM categories WHERE slug LIKE 'bench-cat-%') AS bench_categories,
  (SELECT count(*) FROM products WHERE slug LIKE 'bench-product-%') AS bench_products,
  (SELECT count(*) FROM product_variants WHERE sku LIKE 'BENCH-%') AS bench_variants;
