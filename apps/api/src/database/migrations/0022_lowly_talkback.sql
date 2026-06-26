CREATE TABLE "module_slot_resolutions" (
	"tenant_id" uuid NOT NULL,
	"slot" text NOT NULL,
	"module_name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "module_slot_resolutions_tenant_id_slot_pk" PRIMARY KEY("tenant_id","slot")
);
--> statement-breakpoint
ALTER TABLE "module_slot_resolutions" ADD CONSTRAINT "module_slot_resolutions_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "module_slot_resolutions_tenant_idx" ON "module_slot_resolutions" USING btree ("tenant_id");