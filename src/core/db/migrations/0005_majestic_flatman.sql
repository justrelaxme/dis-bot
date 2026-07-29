CREATE TABLE "lfg_members" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"post_id" integer NOT NULL,
	"user_id" text NOT NULL,
	"joined_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "lfg_members_uq" UNIQUE("post_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "lfg_pings" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"guild_id" text NOT NULL,
	"game" text NOT NULL,
	"role_id" text NOT NULL,
	CONSTRAINT "lfg_pings_uq" UNIQUE("guild_id","game")
);
--> statement-breakpoint
CREATE TABLE "lfg_posts" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"guild_id" text NOT NULL,
	"host_user_id" text NOT NULL,
	"game" text NOT NULL,
	"mode" text NOT NULL,
	"slots" integer NOT NULL,
	"note" text,
	"state" text DEFAULT 'open' NOT NULL,
	"channel_id" text NOT NULL,
	"message_id" text,
	"voice_channel_id" text,
	"expires_at" timestamp with time zone NOT NULL,
	"closed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "lfg_settings" (
	"guild_id" text PRIMARY KEY NOT NULL,
	"channel_id" text,
	"voice_category_id" text,
	"default_ttl_minutes" integer DEFAULT 120 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "lfg_members" ADD CONSTRAINT "lfg_members_post_id_lfg_posts_id_fk" FOREIGN KEY ("post_id") REFERENCES "public"."lfg_posts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "lfg_posts_due_idx" ON "lfg_posts" USING btree ("state","expires_at");--> statement-breakpoint
CREATE INDEX "lfg_posts_guild_state_idx" ON "lfg_posts" USING btree ("guild_id","state");