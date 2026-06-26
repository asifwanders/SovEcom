CREATE TABLE "order_counters" (
	"tenant_id" uuid PRIMARY KEY NOT NULL,
	"next_value" bigint DEFAULT 1 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "order_counters" ADD CONSTRAINT "order_counters_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;