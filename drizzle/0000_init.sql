CREATE TYPE "public"."prompt_scope" AS ENUM('default', 'project', 'tag', 'resource');--> statement-breakpoint
CREATE TYPE "public"."target_origin" AS ENUM('machine', 'human', 'legacy');--> statement-breakpoint
CREATE TYPE "public"."target_status" AS ENUM('pending', 'queued', 'translating', 'translated', 'rejected', 'failed', 'skipped');--> statement-breakpoint
CREATE TYPE "public"."verdict_outcome" AS ENUM('pass', 'repair', 'reject');--> statement-breakpoint
CREATE TABLE "audit_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"actor" text NOT NULL,
	"action" text NOT NULL,
	"project_id" uuid,
	"resource_id" uuid,
	"target_id" uuid,
	"detail" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "layer_overrides" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"layer_id" uuid NOT NULL,
	"scope" "prompt_scope" NOT NULL,
	"scope_ref" text NOT NULL,
	"model" text,
	"reasoning_effort" text,
	"enabled" boolean,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "layer_run_targets" (
	"layer_run_id" uuid NOT NULL,
	"target_id" uuid NOT NULL,
	CONSTRAINT "layer_run_targets_layer_run_id_target_id_pk" PRIMARY KEY("layer_run_id","target_id")
);
--> statement-breakpoint
CREATE TABLE "layer_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid NOT NULL,
	"project_id" uuid,
	"locale" text NOT NULL,
	"layer_id" uuid,
	"layer_name" text NOT NULL,
	"kind" text DEFAULT 'layer' NOT NULL,
	"model" text NOT NULL,
	"prompt_version_ids" uuid[] DEFAULT '{}' NOT NULL,
	"target_count" integer NOT NULL,
	"input_tokens" integer DEFAULT 0 NOT NULL,
	"output_tokens" integer DEFAULT 0 NOT NULL,
	"reasoning_tokens" integer DEFAULT 0 NOT NULL,
	"cached_input_tokens" integer DEFAULT 0 NOT NULL,
	"cost_usd" double precision,
	"latency_ms" integer DEFAULT 0 NOT NULL,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "layers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"position" integer NOT NULL,
	"model" text NOT NULL,
	"reasoning_effort" text,
	"enabled" boolean DEFAULT true NOT NULL,
	"description" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "layers_name_unique" UNIQUE("name")
);
--> statement-breakpoint
CREATE TABLE "price_cache" (
	"id" text PRIMARY KEY NOT NULL,
	"body" jsonb NOT NULL,
	"fetched_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "projects" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"adapter" text NOT NULL,
	"source_locale" text DEFAULT 'en' NOT NULL,
	"target_locales" text[] DEFAULT '{}' NOT NULL,
	"glossary" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"extra_instructions" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"debounce_seconds" integer DEFAULT 60 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "projects_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE "prompt_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"prompt_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"body" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "prompts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"layer_id" uuid,
	"name" text NOT NULL,
	"scope" "prompt_scope" DEFAULT 'default' NOT NULL,
	"scope_ref" text,
	"position" integer DEFAULT 100 NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "prompts_name_unique" UNIQUE("name")
);
--> statement-breakpoint
CREATE TABLE "resources" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"key" text NOT NULL,
	"source" text NOT NULL,
	"source_revision" text NOT NULL,
	"tags" text[] DEFAULT '{}' NOT NULL,
	"meta" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"translatable" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "targets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"resource_id" uuid NOT NULL,
	"locale" text NOT NULL,
	"value" text,
	"status" "target_status" DEFAULT 'pending' NOT NULL,
	"origin" "target_origin",
	"pinned" boolean DEFAULT false NOT NULL,
	"native" boolean DEFAULT false NOT NULL,
	"source_revision" text,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "verdicts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"target_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"guard" text NOT NULL,
	"outcome" "verdict_outcome" NOT NULL,
	"detail" text,
	"before" text,
	"after" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "layer_overrides" ADD CONSTRAINT "layer_overrides_layer_id_layers_id_fk" FOREIGN KEY ("layer_id") REFERENCES "public"."layers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "layer_run_targets" ADD CONSTRAINT "layer_run_targets_layer_run_id_layer_runs_id_fk" FOREIGN KEY ("layer_run_id") REFERENCES "public"."layer_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "layer_run_targets" ADD CONSTRAINT "layer_run_targets_target_id_targets_id_fk" FOREIGN KEY ("target_id") REFERENCES "public"."targets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "layer_runs" ADD CONSTRAINT "layer_runs_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "layer_runs" ADD CONSTRAINT "layer_runs_layer_id_layers_id_fk" FOREIGN KEY ("layer_id") REFERENCES "public"."layers"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prompt_versions" ADD CONSTRAINT "prompt_versions_prompt_id_prompts_id_fk" FOREIGN KEY ("prompt_id") REFERENCES "public"."prompts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prompts" ADD CONSTRAINT "prompts_layer_id_layers_id_fk" FOREIGN KEY ("layer_id") REFERENCES "public"."layers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "resources" ADD CONSTRAINT "resources_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "targets" ADD CONSTRAINT "targets_resource_id_resources_id_fk" FOREIGN KEY ("resource_id") REFERENCES "public"."resources"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "verdicts" ADD CONSTRAINT "verdicts_target_id_targets_id_fk" FOREIGN KEY ("target_id") REFERENCES "public"."targets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "audit_log_created" ON "audit_log" USING btree ("created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "layer_overrides_layer_scope" ON "layer_overrides" USING btree ("layer_id","scope","scope_ref");--> statement-breakpoint
CREATE INDEX "layer_run_targets_target" ON "layer_run_targets" USING btree ("target_id");--> statement-breakpoint
CREATE INDEX "layer_runs_project" ON "layer_runs" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "layer_runs_created" ON "layer_runs" USING btree ("created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "prompt_versions_prompt_version" ON "prompt_versions" USING btree ("prompt_id","version");--> statement-breakpoint
CREATE UNIQUE INDEX "resources_project_key" ON "resources" USING btree ("project_id","key");--> statement-breakpoint
CREATE INDEX "resources_project" ON "resources" USING btree ("project_id");--> statement-breakpoint
CREATE UNIQUE INDEX "targets_resource_locale" ON "targets" USING btree ("resource_id","locale");--> statement-breakpoint
CREATE INDEX "targets_status" ON "targets" USING btree ("status");--> statement-breakpoint
CREATE INDEX "targets_locale" ON "targets" USING btree ("locale");--> statement-breakpoint
CREATE INDEX "verdicts_target" ON "verdicts" USING btree ("target_id");