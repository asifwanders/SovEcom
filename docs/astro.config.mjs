// @ts-check
import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';
import starlightOpenAPI, { openAPISidebarGroups } from 'starlight-openapi';
import remarkGfm from 'remark-gfm';

// API reference specs are split from apps/api/openapi.json by scripts/split-openapi.mjs
// (run automatically before dev/build). One section per surface.

// https://astro.build/config
export default defineConfig({
  site: 'https://docs.sovecom.io',
  // Astro 6 no longer bundles GFM by default; add it so Markdown tables, strikethrough,
  // task lists, and autolinks render across all docs (.md + .mdx via extendMarkdownConfig).
  markdown: { remarkPlugins: [remarkGfm] },
  integrations: [
    starlight({
      title: 'SovEcom',
      description: 'The open-source headless ecommerce platform built for the European Union.',
      logo: {
        light: './src/assets/logo-light.svg',
        dark: './src/assets/logo-dark.svg',
        replacesTitle: true,
      },
      favicon: '/favicon.svg',
      social: [
        { icon: 'github', label: 'GitHub', href: 'https://github.com/asifwanders/SovEcom' },
      ],
      plugins: [
        starlightOpenAPI([
          { base: 'api/admin', schema: './src/openapi/admin.json', sidebar: { label: 'Admin API' } },
          { base: 'api/store', schema: './src/openapi/store.json', sidebar: { label: 'Store API' } },
          { base: 'api/setup', schema: './src/openapi/setup.json', sidebar: { label: 'Setup & Platform API' } },
        ]),
      ],
      sidebar: [
        {
          label: 'Getting Started',
          items: [
            { label: 'Installation', slug: 'getting-started/installation' },
            { label: 'First Store', slug: 'getting-started/first-store' },
            { label: 'Architecture Overview', slug: 'getting-started/architecture-overview' },
          ],
        },
        {
          label: 'Operator Guides',
          items: [
            { label: 'Getting Started', slug: 'operator-guides/getting-started' },
            { label: 'Dashboard', slug: 'operator-guides/dashboard' },
            { label: 'Catalog', slug: 'operator-guides/catalog' },
            { label: 'Home Page', slug: 'operator-guides/storefront-home' },
            { label: 'Order Management', slug: 'operator-guides/orders' },
            { label: 'Customer Management', slug: 'operator-guides/customers' },
            { label: 'Staff Accounts', slug: 'operator-guides/staff' },
            { label: 'Discounts', slug: 'operator-guides/discounts' },
            { label: 'Shipping', slug: 'operator-guides/shipping' },
            { label: 'Tax & VAT', slug: 'operator-guides/tax' },
            { label: 'Payments', slug: 'operator-guides/payments' },
            { label: 'Email & Deliverability', slug: 'operator-guides/email' },
            { label: 'RGPD & Data Retention', slug: 'operator-guides/rgpd-data-retention' },
            { label: 'EU Invoicing & VAT Ops', slug: 'operator-guides/invoicing-vat' },
            { label: 'Backup & Recovery', slug: 'operator-guides/backup-recovery' },
            { label: 'Upgrades', slug: 'operator-guides/upgrade' },
          ],
        },
        {
          label: 'Developer Guides',
          items: [
            { label: 'Theme Authoring', slug: 'guides/themes' },
            { label: 'Theme Contract Reference', slug: 'guides/theme-contract' },
            { label: 'Module Authoring', slug: 'guides/modules' },
            { label: 'Module Security', slug: 'guides/module-security' },
            { label: 'Module Publishing', slug: 'guides/module-publishing' },
            { label: 'Custom API Endpoints', slug: 'guides/custom-endpoints' },
            { label: 'Webhook Reference', slug: 'guides/webhooks' },
            { label: 'JS Client Library', slug: 'guides/client-js' },
            { label: 'Database Schema Reference', slug: 'guides/schema-reference' },
            { label: 'Migration Guide', slug: 'guides/migration' },
            { label: 'Deployment', slug: 'guides/deployment' },
          ],
        },
        {
          label: 'API Reference',
          items: [
            { label: 'Overview', slug: 'api-reference' },
          ],
        },
        ...openAPISidebarGroups,
        {
          label: 'Concepts',
          items: [
            { label: 'Multi-tenancy', slug: 'concepts/multi-tenancy' },
            { label: 'Security', slug: 'concepts/security' },
          ],
        },
      ],
    }),
  ],
});
