ALTER TABLE "cart_items" ADD COLUMN "product_title" text;--> statement-breakpoint
ALTER TABLE "cart_items" ADD COLUMN "variant_title" text;--> statement-breakpoint
ALTER TABLE "cart_items" ADD COLUMN "options" jsonb;--> statement-breakpoint
ALTER TABLE "cart_items" ADD COLUMN "sku" text;--> statement-breakpoint
ALTER TABLE "cart_items" ADD COLUMN "product_slug" text;