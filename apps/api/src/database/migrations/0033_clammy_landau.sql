ALTER TABLE "customers" ADD COLUMN "failed_attempts" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "customers" ADD COLUMN "locked_until" timestamp with time zone;
