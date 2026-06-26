CREATE TABLE "tenant_secrets" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"ciphertext" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tenant_secrets_tenant_kind_uq" UNIQUE("tenant_id","kind")
);
--> statement-breakpoint
ALTER TABLE "tenant_secrets" ADD CONSTRAINT "tenant_secrets_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;