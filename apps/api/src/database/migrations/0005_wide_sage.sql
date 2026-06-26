CREATE TYPE "public"."cart_status" AS ENUM('active', 'converted', 'abandoned');--> statement-breakpoint
CREATE TYPE "public"."discount_scope" AS ENUM('all', 'products', 'categories');--> statement-breakpoint
CREATE TYPE "public"."discount_type" AS ENUM('percentage', 'fixed');--> statement-breakpoint
CREATE TYPE "public"."invoice_type" AS ENUM('invoice', 'credit_note');--> statement-breakpoint
CREATE TYPE "public"."order_status" AS ENUM('pending_payment', 'paid', 'fulfilled', 'shipped', 'delivered', 'completed', 'cancelled', 'refunded', 'partially_refunded');--> statement-breakpoint
CREATE TYPE "public"."payment_status" AS ENUM('pending', 'succeeded', 'failed', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."refund_status" AS ENUM('pending', 'succeeded', 'failed');--> statement-breakpoint
CREATE TYPE "public"."reservation_status" AS ENUM('reserved', 'confirmed', 'released');--> statement-breakpoint
CREATE TYPE "public"."return_status" AS ENUM('requested', 'approved', 'rejected', 'refunded');--> statement-breakpoint
CREATE TYPE "public"."return_type" AS ENUM('return', 'withdrawal');--> statement-breakpoint
CREATE TYPE "public"."shipping_rate_type" AS ENUM('flat', 'free_over', 'weight_based');--> statement-breakpoint
CREATE TABLE "carts" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"customer_id" uuid,
	"session_token" text,
	"currency" text NOT NULL,
	"discount_code" text,
	"status" "cart_status" DEFAULT 'active' NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "carts_id_tenant_uq" UNIQUE("id","tenant_id"),
	CONSTRAINT "carts_currency_chk" CHECK (char_length("carts"."currency") = 3)
);
--> statement-breakpoint
CREATE TABLE "cart_items" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"cart_id" uuid NOT NULL,
	"variant_id" uuid NOT NULL,
	"quantity" integer NOT NULL,
	"unit_price_amount" integer NOT NULL,
	"currency" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "cart_items_cart_variant_uq" UNIQUE("cart_id","variant_id"),
	CONSTRAINT "cart_items_quantity_chk" CHECK ("cart_items"."quantity" > 0),
	CONSTRAINT "cart_items_unit_price_chk" CHECK ("cart_items"."unit_price_amount" >= 0),
	CONSTRAINT "cart_items_currency_chk" CHECK (char_length("cart_items"."currency") = 3)
);
--> statement-breakpoint
CREATE TABLE "inventory_reservations" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"variant_id" uuid NOT NULL,
	"cart_id" uuid NOT NULL,
	"quantity" integer NOT NULL,
	"status" "reservation_status" DEFAULT 'reserved' NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "inventory_reservations_quantity_chk" CHECK ("inventory_reservations"."quantity" > 0)
);
--> statement-breakpoint
CREATE TABLE "orders" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"order_number" text NOT NULL,
	"customer_id" uuid,
	"email" text NOT NULL,
	"status" "order_status" DEFAULT 'pending_payment' NOT NULL,
	"currency" text NOT NULL,
	"subtotal_amount" integer NOT NULL,
	"discount_amount" integer DEFAULT 0 NOT NULL,
	"shipping_amount" integer DEFAULT 0 NOT NULL,
	"tax_amount" integer DEFAULT 0 NOT NULL,
	"total_amount" integer NOT NULL,
	"refunded_amount" integer DEFAULT 0 NOT NULL,
	"is_b2b" boolean DEFAULT false NOT NULL,
	"vat_number" text,
	"reverse_charge" boolean DEFAULT false NOT NULL,
	"tax_inclusive" boolean NOT NULL,
	"shipping_address" jsonb NOT NULL,
	"billing_address" jsonb NOT NULL,
	"shipping_method" text,
	"tracking_number" text,
	"carrier" text,
	"discount_code" text,
	"notes" text,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"placed_at" timestamp with time zone,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "orders_id_tenant_uq" UNIQUE("id","tenant_id"),
	CONSTRAINT "orders_currency_chk" CHECK (char_length("orders"."currency") = 3),
	CONSTRAINT "orders_amounts_nonneg_chk" CHECK ("orders"."subtotal_amount" >= 0 and "orders"."discount_amount" >= 0 and "orders"."shipping_amount" >= 0 and "orders"."tax_amount" >= 0 and "orders"."total_amount" >= 0 and "orders"."refunded_amount" >= 0)
);
--> statement-breakpoint
CREATE TABLE "order_items" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"order_id" uuid NOT NULL,
	"variant_id" uuid,
	"product_title" text NOT NULL,
	"variant_title" text,
	"sku" text NOT NULL,
	"quantity" integer NOT NULL,
	"unit_price_amount" integer NOT NULL,
	"tax_rate" numeric(5, 4) NOT NULL,
	"tax_amount" integer NOT NULL,
	"line_total_amount" integer NOT NULL,
	"refunded_quantity" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "order_items_id_tenant_uq" UNIQUE("id","tenant_id"),
	CONSTRAINT "order_items_quantity_chk" CHECK ("order_items"."quantity" > 0),
	CONSTRAINT "order_items_amounts_nonneg_chk" CHECK ("order_items"."unit_price_amount" >= 0 and "order_items"."tax_amount" >= 0 and "order_items"."line_total_amount" >= 0)
);
--> statement-breakpoint
CREATE TABLE "order_status_history" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"order_id" uuid NOT NULL,
	"from_status" "order_status",
	"to_status" "order_status" NOT NULL,
	"changed_by" uuid,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "invoices" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"order_id" uuid NOT NULL,
	"type" "invoice_type" DEFAULT 'invoice' NOT NULL,
	"series" text NOT NULL,
	"invoice_number" text NOT NULL,
	"issued_at" timestamp with time zone NOT NULL,
	"seller_snapshot" jsonb NOT NULL,
	"buyer_snapshot" jsonb NOT NULL,
	"currency" text NOT NULL,
	"subtotal_amount" integer NOT NULL,
	"tax_breakdown" jsonb NOT NULL,
	"tax_amount" integer NOT NULL,
	"total_amount" integer NOT NULL,
	"reverse_charge" boolean DEFAULT false NOT NULL,
	"vies_consultation_ref" text,
	"corrects_invoice_id" uuid,
	"storage_key" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "invoices_id_tenant_uq" UNIQUE("id","tenant_id"),
	CONSTRAINT "invoices_currency_chk" CHECK (char_length("invoices"."currency") = 3),
	CONSTRAINT "invoices_amounts_nonneg_chk" CHECK ("invoices"."subtotal_amount" >= 0 and "invoices"."tax_amount" >= 0 and "invoices"."total_amount" >= 0)
);
--> statement-breakpoint
CREATE TABLE "invoice_counters" (
	"tenant_id" uuid NOT NULL,
	"series" text NOT NULL,
	"next_value" bigint DEFAULT 1 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "invoice_counters_pk" PRIMARY KEY("tenant_id","series")
);
--> statement-breakpoint
CREATE TABLE "payments" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"order_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"provider_payment_id" text,
	"method" text,
	"amount" integer NOT NULL,
	"currency" text NOT NULL,
	"status" "payment_status" DEFAULT 'pending' NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payments_id_tenant_uq" UNIQUE("id","tenant_id"),
	CONSTRAINT "payments_amount_chk" CHECK ("payments"."amount" >= 0),
	CONSTRAINT "payments_currency_chk" CHECK (char_length("payments"."currency") = 3)
);
--> statement-breakpoint
CREATE TABLE "refunds" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"order_id" uuid NOT NULL,
	"payment_id" uuid NOT NULL,
	"provider_refund_id" text,
	"amount" integer NOT NULL,
	"currency" text NOT NULL,
	"tax_amount" integer DEFAULT 0 NOT NULL,
	"reason" text,
	"restocked" boolean DEFAULT false NOT NULL,
	"status" "refund_status" DEFAULT 'pending' NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "refunds_id_tenant_uq" UNIQUE("id","tenant_id"),
	CONSTRAINT "refunds_amount_chk" CHECK ("refunds"."amount" >= 0),
	CONSTRAINT "refunds_tax_amount_chk" CHECK ("refunds"."tax_amount" >= 0),
	CONSTRAINT "refunds_currency_chk" CHECK (char_length("refunds"."currency") = 3)
);
--> statement-breakpoint
CREATE TABLE "refund_line_items" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"refund_id" uuid NOT NULL,
	"order_item_id" uuid NOT NULL,
	"quantity" integer NOT NULL,
	"amount" integer NOT NULL,
	CONSTRAINT "refund_line_items_quantity_chk" CHECK ("refund_line_items"."quantity" > 0),
	CONSTRAINT "refund_line_items_amount_chk" CHECK ("refund_line_items"."amount" >= 0)
);
--> statement-breakpoint
CREATE TABLE "returns" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"order_id" uuid NOT NULL,
	"customer_id" uuid,
	"type" "return_type" NOT NULL,
	"status" "return_status" DEFAULT 'requested' NOT NULL,
	"items" jsonb NOT NULL,
	"reason" text,
	"within_withdrawal_window" boolean DEFAULT false NOT NULL,
	"requested_at" timestamp with time zone NOT NULL,
	"resolved_at" timestamp with time zone,
	"resolved_by" uuid,
	"refund_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "discounts" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"code" text,
	"type" "discount_type" NOT NULL,
	"value" integer NOT NULL,
	"currency" text,
	"min_cart_amount" integer,
	"applies_to" "discount_scope" DEFAULT 'all' NOT NULL,
	"target_ids" jsonb,
	"customer_segment" text,
	"stackable" boolean DEFAULT false NOT NULL,
	"usage_limit_total" integer,
	"usage_limit_per_customer" integer,
	"used_count" integer DEFAULT 0 NOT NULL,
	"starts_at" timestamp with time zone,
	"ends_at" timestamp with time zone,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "discounts_id_tenant_uq" UNIQUE("id","tenant_id"),
	CONSTRAINT "discounts_currency_chk" CHECK ("discounts"."currency" is null or char_length("discounts"."currency") = 3),
	CONSTRAINT "discounts_value_nonneg_chk" CHECK ("discounts"."value" >= 0)
);
--> statement-breakpoint
CREATE TABLE "discount_usages" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"discount_id" uuid NOT NULL,
	"order_id" uuid NOT NULL,
	"customer_id" uuid,
	"amount" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "discount_usages_amount_chk" CHECK ("discount_usages"."amount" >= 0)
);
--> statement-breakpoint
CREATE TABLE "tax_rates" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"country" text NOT NULL,
	"region" text,
	"rate" numeric(5, 4) NOT NULL,
	"name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tax_rates_country_chk" CHECK (char_length("tax_rates"."country") = 2)
);
--> statement-breakpoint
CREATE TABLE "shipping_zones" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"name" text NOT NULL,
	"countries" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "shipping_zones_id_tenant_uq" UNIQUE("id","tenant_id")
);
--> statement-breakpoint
CREATE TABLE "shipping_rates" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"zone_id" uuid NOT NULL,
	"name" text NOT NULL,
	"type" "shipping_rate_type" NOT NULL,
	"amount" integer DEFAULT 0 NOT NULL,
	"currency" text NOT NULL,
	"free_over_amount" integer,
	"weight_min_grams" integer,
	"weight_max_grams" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "shipping_rates_amount_chk" CHECK ("shipping_rates"."amount" >= 0),
	CONSTRAINT "shipping_rates_currency_chk" CHECK (char_length("shipping_rates"."currency") = 3)
);
--> statement-breakpoint
ALTER TABLE "customers" ADD COLUMN "token_version" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "carts" ADD CONSTRAINT "carts_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "carts" ADD CONSTRAINT "carts_customer_fk" FOREIGN KEY ("customer_id","tenant_id") REFERENCES "public"."customers"("id","tenant_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cart_items" ADD CONSTRAINT "cart_items_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cart_items" ADD CONSTRAINT "cart_items_cart_fk" FOREIGN KEY ("cart_id","tenant_id") REFERENCES "public"."carts"("id","tenant_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cart_items" ADD CONSTRAINT "cart_items_variant_fk" FOREIGN KEY ("variant_id","tenant_id") REFERENCES "public"."product_variants"("id","tenant_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_reservations" ADD CONSTRAINT "inventory_reservations_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_reservations" ADD CONSTRAINT "inventory_reservations_variant_fk" FOREIGN KEY ("variant_id","tenant_id") REFERENCES "public"."product_variants"("id","tenant_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_reservations" ADD CONSTRAINT "inventory_reservations_cart_fk" FOREIGN KEY ("cart_id","tenant_id") REFERENCES "public"."carts"("id","tenant_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_customer_fk" FOREIGN KEY ("customer_id","tenant_id") REFERENCES "public"."customers"("id","tenant_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_order_fk" FOREIGN KEY ("order_id","tenant_id") REFERENCES "public"."orders"("id","tenant_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
-- HAND-EDITED: Postgres 17 column-specific SET NULL.
-- Drizzle emits a plain `ON DELETE set null`, which would also null `tenant_id` (NOT NULL
-- → constraint error) when a variant is hard-deleted. The `(variant_id)` column list nulls
-- ONLY variant_id so the order_items snapshot (incl. tenant_id) survives — required so a
-- deleted sold product leaves its invoice line intact.
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_variant_fk" FOREIGN KEY ("variant_id","tenant_id") REFERENCES "public"."product_variants"("id","tenant_id") ON DELETE SET NULL ("variant_id") ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_status_history" ADD CONSTRAINT "order_status_history_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_status_history" ADD CONSTRAINT "order_status_history_order_fk" FOREIGN KEY ("order_id","tenant_id") REFERENCES "public"."orders"("id","tenant_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_status_history" ADD CONSTRAINT "order_status_history_changed_by_fk" FOREIGN KEY ("changed_by","tenant_id") REFERENCES "public"."users"("id","tenant_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_order_fk" FOREIGN KEY ("order_id","tenant_id") REFERENCES "public"."orders"("id","tenant_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_corrects_fk" FOREIGN KEY ("corrects_invoice_id","tenant_id") REFERENCES "public"."invoices"("id","tenant_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoice_counters" ADD CONSTRAINT "invoice_counters_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_order_fk" FOREIGN KEY ("order_id","tenant_id") REFERENCES "public"."orders"("id","tenant_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "refunds" ADD CONSTRAINT "refunds_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "refunds" ADD CONSTRAINT "refunds_order_fk" FOREIGN KEY ("order_id","tenant_id") REFERENCES "public"."orders"("id","tenant_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "refunds" ADD CONSTRAINT "refunds_payment_fk" FOREIGN KEY ("payment_id","tenant_id") REFERENCES "public"."payments"("id","tenant_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "refunds" ADD CONSTRAINT "refunds_created_by_fk" FOREIGN KEY ("created_by","tenant_id") REFERENCES "public"."users"("id","tenant_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "refund_line_items" ADD CONSTRAINT "refund_line_items_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "refund_line_items" ADD CONSTRAINT "refund_line_items_refund_fk" FOREIGN KEY ("refund_id","tenant_id") REFERENCES "public"."refunds"("id","tenant_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "refund_line_items" ADD CONSTRAINT "refund_line_items_order_item_fk" FOREIGN KEY ("order_item_id","tenant_id") REFERENCES "public"."order_items"("id","tenant_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "returns" ADD CONSTRAINT "returns_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "returns" ADD CONSTRAINT "returns_order_fk" FOREIGN KEY ("order_id","tenant_id") REFERENCES "public"."orders"("id","tenant_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "returns" ADD CONSTRAINT "returns_customer_fk" FOREIGN KEY ("customer_id","tenant_id") REFERENCES "public"."customers"("id","tenant_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "returns" ADD CONSTRAINT "returns_resolved_by_fk" FOREIGN KEY ("resolved_by","tenant_id") REFERENCES "public"."users"("id","tenant_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "returns" ADD CONSTRAINT "returns_refund_fk" FOREIGN KEY ("refund_id","tenant_id") REFERENCES "public"."refunds"("id","tenant_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "discounts" ADD CONSTRAINT "discounts_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "discount_usages" ADD CONSTRAINT "discount_usages_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "discount_usages" ADD CONSTRAINT "discount_usages_discount_fk" FOREIGN KEY ("discount_id","tenant_id") REFERENCES "public"."discounts"("id","tenant_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "discount_usages" ADD CONSTRAINT "discount_usages_order_fk" FOREIGN KEY ("order_id","tenant_id") REFERENCES "public"."orders"("id","tenant_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "discount_usages" ADD CONSTRAINT "discount_usages_customer_fk" FOREIGN KEY ("customer_id","tenant_id") REFERENCES "public"."customers"("id","tenant_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tax_rates" ADD CONSTRAINT "tax_rates_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shipping_zones" ADD CONSTRAINT "shipping_zones_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shipping_rates" ADD CONSTRAINT "shipping_rates_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shipping_rates" ADD CONSTRAINT "shipping_rates_zone_fk" FOREIGN KEY ("zone_id","tenant_id") REFERENCES "public"."shipping_zones"("id","tenant_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "carts_tenant_idx" ON "carts" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "carts_customer_idx" ON "carts" USING btree ("customer_id");--> statement-breakpoint
CREATE INDEX "carts_session_token_idx" ON "carts" USING btree ("session_token");--> statement-breakpoint
CREATE INDEX "carts_active_expires_idx" ON "carts" USING btree ("expires_at") WHERE status = 'active';--> statement-breakpoint
CREATE INDEX "cart_items_cart_idx" ON "cart_items" USING btree ("cart_id");--> statement-breakpoint
CREATE INDEX "cart_items_variant_idx" ON "cart_items" USING btree ("variant_id");--> statement-breakpoint
CREATE INDEX "cart_items_tenant_idx" ON "cart_items" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "inventory_reservations_variant_status_idx" ON "inventory_reservations" USING btree ("variant_id","status");--> statement-breakpoint
CREATE INDEX "inventory_reservations_cart_idx" ON "inventory_reservations" USING btree ("cart_id");--> statement-breakpoint
CREATE INDEX "inventory_reservations_tenant_idx" ON "inventory_reservations" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "inventory_reservations_reserved_expires_idx" ON "inventory_reservations" USING btree ("expires_at") WHERE status = 'reserved';--> statement-breakpoint
CREATE UNIQUE INDEX "orders_tenant_order_number_uq" ON "orders" USING btree ("tenant_id","order_number");--> statement-breakpoint
CREATE INDEX "orders_tenant_status_idx" ON "orders" USING btree ("tenant_id","status");--> statement-breakpoint
CREATE INDEX "orders_customer_idx" ON "orders" USING btree ("customer_id");--> statement-breakpoint
CREATE INDEX "orders_tenant_created_idx" ON "orders" USING btree ("tenant_id","created_at");--> statement-breakpoint
CREATE INDEX "order_items_order_idx" ON "order_items" USING btree ("order_id");--> statement-breakpoint
CREATE INDEX "order_items_variant_idx" ON "order_items" USING btree ("variant_id");--> statement-breakpoint
CREATE INDEX "order_items_tenant_idx" ON "order_items" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "order_status_history_order_created_idx" ON "order_status_history" USING btree ("order_id","created_at");--> statement-breakpoint
CREATE INDEX "order_status_history_changed_by_idx" ON "order_status_history" USING btree ("changed_by");--> statement-breakpoint
CREATE INDEX "order_status_history_tenant_idx" ON "order_status_history" USING btree ("tenant_id");--> statement-breakpoint
CREATE UNIQUE INDEX "invoices_tenant_series_number_uq" ON "invoices" USING btree ("tenant_id","series","invoice_number");--> statement-breakpoint
CREATE INDEX "invoices_order_idx" ON "invoices" USING btree ("order_id");--> statement-breakpoint
CREATE INDEX "invoices_corrects_idx" ON "invoices" USING btree ("corrects_invoice_id");--> statement-breakpoint
CREATE INDEX "invoices_tenant_issued_idx" ON "invoices" USING btree ("tenant_id","issued_at");--> statement-breakpoint
CREATE UNIQUE INDEX "payments_provider_payment_uq" ON "payments" USING btree ("provider","provider_payment_id") WHERE provider_payment_id is not null;--> statement-breakpoint
CREATE INDEX "payments_order_idx" ON "payments" USING btree ("order_id");--> statement-breakpoint
CREATE INDEX "payments_tenant_idx" ON "payments" USING btree ("tenant_id");--> statement-breakpoint
CREATE UNIQUE INDEX "refunds_provider_refund_uq" ON "refunds" USING btree ("provider_refund_id") WHERE provider_refund_id is not null;--> statement-breakpoint
CREATE INDEX "refunds_order_idx" ON "refunds" USING btree ("order_id");--> statement-breakpoint
CREATE INDEX "refunds_payment_idx" ON "refunds" USING btree ("payment_id");--> statement-breakpoint
CREATE INDEX "refunds_created_by_idx" ON "refunds" USING btree ("created_by");--> statement-breakpoint
CREATE INDEX "refunds_tenant_idx" ON "refunds" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "refund_line_items_refund_idx" ON "refund_line_items" USING btree ("refund_id");--> statement-breakpoint
CREATE INDEX "refund_line_items_order_item_idx" ON "refund_line_items" USING btree ("order_item_id");--> statement-breakpoint
CREATE INDEX "refund_line_items_tenant_idx" ON "refund_line_items" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "returns_tenant_status_idx" ON "returns" USING btree ("tenant_id","status");--> statement-breakpoint
CREATE INDEX "returns_order_idx" ON "returns" USING btree ("order_id");--> statement-breakpoint
CREATE INDEX "returns_customer_idx" ON "returns" USING btree ("customer_id");--> statement-breakpoint
CREATE INDEX "returns_resolved_by_idx" ON "returns" USING btree ("resolved_by");--> statement-breakpoint
CREATE INDEX "returns_refund_idx" ON "returns" USING btree ("refund_id");--> statement-breakpoint
CREATE UNIQUE INDEX "discounts_tenant_code_uq" ON "discounts" USING btree ("tenant_id","code") WHERE code is not null;--> statement-breakpoint
CREATE INDEX "discounts_tenant_active_idx" ON "discounts" USING btree ("tenant_id","active");--> statement-breakpoint
CREATE INDEX "discount_usages_discount_idx" ON "discount_usages" USING btree ("discount_id");--> statement-breakpoint
CREATE INDEX "discount_usages_order_idx" ON "discount_usages" USING btree ("order_id");--> statement-breakpoint
CREATE INDEX "discount_usages_customer_discount_idx" ON "discount_usages" USING btree ("customer_id","discount_id");--> statement-breakpoint
CREATE INDEX "discount_usages_tenant_idx" ON "discount_usages" USING btree ("tenant_id");--> statement-breakpoint
CREATE UNIQUE INDEX "tax_rates_tenant_country_region_uq" ON "tax_rates" USING btree ("tenant_id","country",coalesce("region", ''));--> statement-breakpoint
CREATE INDEX "shipping_zones_tenant_idx" ON "shipping_zones" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "shipping_rates_zone_idx" ON "shipping_rates" USING btree ("zone_id");--> statement-breakpoint
CREATE INDEX "shipping_rates_tenant_idx" ON "shipping_rates" USING btree ("tenant_id");