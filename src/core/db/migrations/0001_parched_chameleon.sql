CREATE TABLE "account_verifications" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"provider" text NOT NULL,
	"challenge" text NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "account_verifications_challenge_uq" UNIQUE("challenge")
);
--> statement-breakpoint
CREATE TABLE "game_accounts" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"provider" text NOT NULL,
	"external_id" text NOT NULL,
	"display_name" text NOT NULL,
	"region" text,
	"verified_at" timestamp with time zone,
	"verification_method" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "game_accounts_provider_external_uq" UNIQUE("provider","external_id"),
	CONSTRAINT "game_accounts_user_provider_uq" UNIQUE("user_id","provider")
);
--> statement-breakpoint
CREATE TABLE "rank_snapshots" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"account_id" bigint NOT NULL,
	"mode" text NOT NULL,
	"scale" text NOT NULL,
	"tier" text,
	"division" text,
	"points" integer,
	"source" text NOT NULL,
	"raw" jsonb NOT NULL,
	"captured_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "role_mappings" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"guild_id" text NOT NULL,
	"provider" text NOT NULL,
	"mode" text NOT NULL,
	"tier" text NOT NULL,
	"role_id" text NOT NULL,
	CONSTRAINT "role_mappings_uq" UNIQUE("guild_id","provider","mode","tier")
);
--> statement-breakpoint
ALTER TABLE "account_verifications" ADD CONSTRAINT "account_verifications_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "game_accounts" ADD CONSTRAINT "game_accounts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rank_snapshots" ADD CONSTRAINT "rank_snapshots_account_id_game_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."game_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "role_mappings" ADD CONSTRAINT "role_mappings_guild_id_guilds_id_fk" FOREIGN KEY ("guild_id") REFERENCES "public"."guilds"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "account_verifications_user_provider_idx" ON "account_verifications" USING btree ("user_id","provider");--> statement-breakpoint
CREATE INDEX "game_accounts_updated_idx" ON "game_accounts" USING btree ("updated_at");--> statement-breakpoint
CREATE INDEX "rank_snapshots_account_mode_idx" ON "rank_snapshots" USING btree ("account_id","mode","captured_at" DESC NULLS LAST);