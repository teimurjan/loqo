CREATE TYPE "public"."member_role" AS ENUM('admin', 'editor', 'reader');--> statement-breakpoint
ALTER TYPE "public"."prompt_scope" ADD VALUE 'scenario';--> statement-breakpoint
CREATE TABLE "guard_rules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"guard" text NOT NULL,
	"scope" "prompt_scope" NOT NULL,
	"scope_ref" text NOT NULL,
	"params" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "project_members" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"user_id" uuid,
	"email" text NOT NULL,
	"role" "member_role" NOT NULL,
	"invited_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"accepted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "scenarios" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"name" text NOT NULL,
	"tags" text[] DEFAULT '{}' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"token_hash" text NOT NULL,
	"user_id" uuid NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sessions_tokenHash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" text NOT NULL,
	"name" text NOT NULL,
	"avatar_url" text,
	"google_sub" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_email_unique" UNIQUE("email"),
	CONSTRAINT "users_googleSub_unique" UNIQUE("google_sub")
);
--> statement-breakpoint
ALTER TABLE "layers" DROP CONSTRAINT "layers_name_unique";--> statement-breakpoint
ALTER TABLE "prompts" DROP CONSTRAINT "prompts_name_unique";--> statement-breakpoint
ALTER TABLE "layers" ADD COLUMN "scope" "prompt_scope" DEFAULT 'default' NOT NULL;--> statement-breakpoint
ALTER TABLE "layers" ADD COLUMN "scope_ref" text;--> statement-breakpoint
ALTER TABLE "layers" ADD COLUMN "builtin" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "prompts" ADD COLUMN "builtin" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "project_members" ADD CONSTRAINT "project_members_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_members" ADD CONSTRAINT "project_members_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_members" ADD CONSTRAINT "project_members_invited_by_users_id_fk" FOREIGN KEY ("invited_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scenarios" ADD CONSTRAINT "scenarios_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "guard_rules_guard_scope" ON "guard_rules" USING btree ("guard","scope","scope_ref");--> statement-breakpoint
CREATE UNIQUE INDEX "project_members_project_email" ON "project_members" USING btree ("project_id","email");--> statement-breakpoint
CREATE INDEX "project_members_user" ON "project_members" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "scenarios_project_name" ON "scenarios" USING btree ("project_id","name");--> statement-breakpoint
ALTER TABLE "layers" ADD CONSTRAINT "layers_name_scope" UNIQUE NULLS NOT DISTINCT("name","scope","scope_ref");--> statement-breakpoint
ALTER TABLE "prompts" ADD CONSTRAINT "prompts_name_scope" UNIQUE NULLS NOT DISTINCT("name","scope","scope_ref");