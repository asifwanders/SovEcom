CREATE TABLE "module_migrations" (
	"module" text NOT NULL,
	"migration_id" text NOT NULL,
	"checksum" text NOT NULL,
	"applied_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "module_migrations_module_migration_id_pk" PRIMARY KEY("module","migration_id")
);
