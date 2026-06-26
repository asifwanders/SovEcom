CREATE TYPE "public"."email_status" AS ENUM('sent', 'failed');--> statement-breakpoint
CREATE TYPE "public"."email_type" AS ENUM('order_confirmation', 'order_shipped', 'refund_issued');--> statement-breakpoint
CREATE TABLE "email_logs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"order_id" uuid,
	"reference_id" uuid,
	"recipient" text NOT NULL,
	"type" "email_type" NOT NULL,
	"subject" text NOT NULL,
	"status" "email_status" NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"error" text,
	"provider_message_id" text,
	"sent_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "email_logs" ADD CONSTRAINT "email_logs_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "email_logs" ADD CONSTRAINT "email_logs_order_fk" FOREIGN KEY ("order_id","tenant_id") REFERENCES "public"."orders"("id","tenant_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "email_logs_tenant_created_idx" ON "email_logs" USING btree ("tenant_id","created_at");--> statement-breakpoint
CREATE INDEX "email_logs_tenant_order_idx" ON "email_logs" USING btree ("tenant_id","order_id");--> statement-breakpoint
CREATE INDEX "email_logs_tenant_status_idx" ON "email_logs" USING btree ("tenant_id","status");