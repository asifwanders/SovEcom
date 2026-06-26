CREATE TABLE "email_change_tokens" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"customer_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"pending_email" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "email_change_tokens_token_hash_uq" UNIQUE("token_hash")
);
--> statement-breakpoint
ALTER TABLE "customers" ADD COLUMN "pending_email" text;--> statement-breakpoint
ALTER TABLE "email_change_tokens" ADD CONSTRAINT "email_change_tokens_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "email_change_tokens" ADD CONSTRAINT "email_change_tokens_customer_fk" FOREIGN KEY ("customer_id","tenant_id") REFERENCES "public"."customers"("id","tenant_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "email_change_tokens_customer_idx" ON "email_change_tokens" USING btree ("customer_id");--> statement-breakpoint
CREATE INDEX "email_change_tokens_tenant_idx" ON "email_change_tokens" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "email_change_tokens_expires_idx" ON "email_change_tokens" USING btree ("expires_at");