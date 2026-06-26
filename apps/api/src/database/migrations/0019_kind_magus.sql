CREATE TABLE "installed_modules" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"name" text NOT NULL,
	"version" text NOT NULL,
	"source" text NOT NULL,
	"manifest" jsonb NOT NULL,
	"granted_permissions" jsonb NOT NULL,
	"settings" jsonb DEFAULT '{}' NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"installed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "installed_modules_tenant_name_uq" UNIQUE("tenant_id","name"),
	CONSTRAINT "installed_modules_id_tenant_uq" UNIQUE("id","tenant_id")
);
--> statement-breakpoint
ALTER TABLE "installed_modules" ADD CONSTRAINT "installed_modules_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "installed_modules_tenant_idx" ON "installed_modules" USING btree ("tenant_id");