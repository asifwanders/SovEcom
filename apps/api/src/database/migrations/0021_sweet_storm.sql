CREATE TABLE "installed_themes" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"name" text NOT NULL,
	"version" text NOT NULL,
	"source" text NOT NULL,
	"manifest" jsonb NOT NULL,
	"settings" jsonb DEFAULT '{}' NOT NULL,
	"is_active" boolean DEFAULT false NOT NULL,
	"installed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "installed_themes_tenant_name_uq" UNIQUE("tenant_id","name"),
	CONSTRAINT "installed_themes_id_tenant_uq" UNIQUE("id","tenant_id")
);
--> statement-breakpoint
ALTER TABLE "installed_themes" ADD CONSTRAINT "installed_themes_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "installed_themes_tenant_idx" ON "installed_themes" USING btree ("tenant_id");--> statement-breakpoint
-- Hand-written partial UNIQUE: at most ONE active theme per tenant.
-- drizzle-kit cannot express a partial index via the table builder, so it is added here.
-- The activate operation flips is_active for all the tenant's themes in one transaction
-- to satisfy this constraint.
CREATE UNIQUE INDEX "installed_themes_one_active_uq" ON "installed_themes" USING btree ("tenant_id") WHERE "is_active";