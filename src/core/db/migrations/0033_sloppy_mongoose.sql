CREATE TABLE "player_pages" (
	"guild_id" text NOT NULL,
	"user_id" text NOT NULL,
	"display_name" text NOT NULL,
	"show_accounts" boolean DEFAULT false NOT NULL,
	"show_ranks" boolean DEFAULT false NOT NULL,
	"enabled_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "player_pages_guild_id_user_id_pk" PRIMARY KEY("guild_id","user_id")
);
