CREATE TABLE "storefront_home_sections" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"sections" jsonb DEFAULT '[]' NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "storefront_home_sections_tenant_uq" UNIQUE("tenant_id"),
	CONSTRAINT "storefront_home_sections_id_tenant_uq" UNIQUE("id","tenant_id")
);
--> statement-breakpoint
ALTER TABLE "storefront_home_sections" ADD CONSTRAINT "storefront_home_sections_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "storefront_home_sections_tenant_idx" ON "storefront_home_sections" USING btree ("tenant_id");
