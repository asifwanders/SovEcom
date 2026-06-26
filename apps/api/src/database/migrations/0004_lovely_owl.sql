-- Rework product_images into a JOIN table.
-- storage_key held the image UUID with no FK; variants jsonb was dead.
-- Add image_id (nullable) → backfill from storage_key::uuid → drop orphans →
-- set NOT NULL → add composite FK + UNIQUE → drop storage_key + variants.

ALTER TABLE "product_images" ADD COLUMN "image_id" uuid;--> statement-breakpoint
UPDATE "product_images" SET "image_id" = "storage_key"::uuid WHERE "image_id" IS NULL;--> statement-breakpoint
-- Drop any row whose backfilled image_id does not resolve to an image in the same
-- tenant (would otherwise violate the new composite FK). This is defensive; there
-- should be none in initial data.
DELETE FROM "product_images" pi
  WHERE NOT EXISTS (
    SELECT 1 FROM "images" i
    WHERE i."id" = pi."image_id" AND i."tenant_id" = pi."tenant_id"
  );--> statement-breakpoint
-- Collapse any duplicate (product_id, image_id) attaches, keeping the lowest position.
DELETE FROM "product_images" pi
  USING "product_images" dup
  WHERE pi."product_id" = dup."product_id"
    AND pi."image_id" = dup."image_id"
    AND (pi."position" > dup."position"
         OR (pi."position" = dup."position" AND pi."id" > dup."id"));--> statement-breakpoint
ALTER TABLE "product_images" ALTER COLUMN "image_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "product_images" ADD CONSTRAINT "product_images_image_fk" FOREIGN KEY ("image_id","tenant_id") REFERENCES "public"."images"("id","tenant_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_images" ADD CONSTRAINT "product_images_product_image_uq" UNIQUE("product_id","image_id");--> statement-breakpoint
ALTER TABLE "product_images" DROP COLUMN "storage_key";--> statement-breakpoint
ALTER TABLE "product_images" DROP COLUMN "variants";
