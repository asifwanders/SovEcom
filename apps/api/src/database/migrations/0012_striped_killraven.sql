ALTER TABLE "orders" ADD COLUMN "cart_id" uuid;--> statement-breakpoint
CREATE INDEX "orders_tenant_cart_idx" ON "orders" USING btree ("tenant_id","cart_id");