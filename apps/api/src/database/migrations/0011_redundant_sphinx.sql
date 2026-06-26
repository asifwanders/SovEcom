CREATE TYPE "public"."dispute_status" AS ENUM('open', 'won', 'lost');--> statement-breakpoint
CREATE TABLE "payment_events" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid,
	"provider" text NOT NULL,
	"event_id" text NOT NULL,
	"type" text NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"processed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "disputes" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"order_id" uuid NOT NULL,
	"payment_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"provider_dispute_id" text,
	"amount" integer NOT NULL,
	"currency" text NOT NULL,
	"reason" text,
	"status" "dispute_status" DEFAULT 'open' NOT NULL,
	"provider_status" text,
	"evidence_due_by" timestamp with time zone,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "disputes_id_tenant_uq" UNIQUE("id","tenant_id"),
	CONSTRAINT "disputes_amount_chk" CHECK ("disputes"."amount" >= 0),
	CONSTRAINT "disputes_currency_chk" CHECK (char_length("disputes"."currency") = 3)
);
--> statement-breakpoint
ALTER TABLE "customers" ADD COLUMN "stripe_customer_id" text;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "vies_consultation_ref" text;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "fulfillment_frozen" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "payment_events" ADD CONSTRAINT "payment_events_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "disputes" ADD CONSTRAINT "disputes_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "disputes" ADD CONSTRAINT "disputes_order_fk" FOREIGN KEY ("order_id","tenant_id") REFERENCES "public"."orders"("id","tenant_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "disputes" ADD CONSTRAINT "disputes_payment_fk" FOREIGN KEY ("payment_id","tenant_id") REFERENCES "public"."payments"("id","tenant_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "payment_events_provider_event_uq" ON "payment_events" USING btree ("provider","event_id");--> statement-breakpoint
CREATE INDEX "payment_events_tenant_idx" ON "payment_events" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "payment_events_type_idx" ON "payment_events" USING btree ("type");--> statement-breakpoint
CREATE UNIQUE INDEX "disputes_provider_dispute_uq" ON "disputes" USING btree ("provider_dispute_id") WHERE provider_dispute_id is not null;--> statement-breakpoint
CREATE INDEX "disputes_order_idx" ON "disputes" USING btree ("order_id");--> statement-breakpoint
CREATE INDEX "disputes_payment_idx" ON "disputes" USING btree ("payment_id");--> statement-breakpoint
CREATE INDEX "disputes_tenant_idx" ON "disputes" USING btree ("tenant_id");--> statement-breakpoint
CREATE UNIQUE INDEX "customers_tenant_stripe_customer_uq" ON "customers" USING btree ("tenant_id","stripe_customer_id") WHERE "customers"."stripe_customer_id" is not null;