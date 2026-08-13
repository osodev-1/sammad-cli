import {
  pgTable,
  text,
  timestamp,
  integer,
  boolean,
  jsonb,
  pgEnum,
  uniqueIndex,
} from "drizzle-orm/pg-core";

export const planEnum = pgEnum("plan", ["free", "pro", "team", "enterprise"]);
export const subStatus = pgEnum("sub_status", [
  "active",
  "past_due",
  "canceled",
]);
export const deviceStatus = pgEnum("device_status", [
  "pending",
  "complete",
  "denied",
  "expired",
]);

export const organizations = pgTable("organizations", {
  id: text("id").primaryKey(), // Clerk org id
  name: text("name").notNull(),
  slug: text("slug").notNull(),
  type: text("type").notNull(), // "personal" | "team"
  createdAt: timestamp("created_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
});

export const users = pgTable("users", {
  id: text("id").primaryKey(), // Clerk user id
  email: text("email").notNull(),
  displayName: text("display_name"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
});

export const memberships = pgTable("memberships", {
  id: text("id").primaryKey(),
  orgId: text("org_id")
    .notNull()
    .references(() => organizations.id),
  userId: text("user_id")
    .notNull()
    .references(() => users.id),
  role: text("role").notNull(),
  seatAssigned: boolean("seat_assigned").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
});

export const subscriptions = pgTable("subscriptions", {
  id: text("id").primaryKey(),
  orgId: text("org_id")
    .notNull()
    .references(() => organizations.id),
  plan: planEnum("plan").notNull().default("free"),
  status: subStatus("status").notNull().default("active"),
  stripeCustomerId: text("stripe_customer_id"),
  stripeSubscriptionId: text("stripe_subscription_id"),
  seats: integer("seats").notNull().default(1),
  quota: jsonb("quota").notNull().default({}),
  currentPeriodEnd: timestamp("current_period_end", { withTimezone: true }),
});

export const deviceAuthRequests = pgTable("device_auth_requests", {
  id: text("id").primaryKey(),
  deviceAuthIdHash: text("device_auth_id_hash").notNull().unique(),
  userCode: text("user_code").notNull(),
  status: deviceStatus("status").notNull().default("pending"),
  approvedUserId: text("approved_user_id"),
  approvedOrgId: text("approved_org_id"),
  // Temporarily holds the plaintext CLI session token until first successful poll read
  pendingSessionToken: text("pending_session_token"),
  pollIntervalSeconds: integer("poll_interval_seconds").notNull().default(2),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
});

export const cliSessions = pgTable("cli_sessions", {
  id: text("id").primaryKey(),
  tokenHash: text("token_hash").notNull().unique(),
  userId: text("user_id")
    .notNull()
    .references(() => users.id),
  orgId: text("org_id")
    .notNull()
    .references(() => organizations.id),
  deviceRequestId: text("device_request_id").references(
    () => deviceAuthRequests.id
  ),
  deviceLabel: text("device_label"),
  // The workspace project (workspace_sessions.id) a web-terminal CLI session was
  // born in, if any. Soft reference (no FK): usage attribution flows from here
  // through the runtime-token → cli-session join, and deleting a project must
  // never be blocked by, or cascade into, its historical sessions. Null for
  // device-flow logins, which have no project.
  projectId: text("project_id"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
  lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
});

export const runtimeTokens = pgTable("runtime_tokens", {
  id: text("id").primaryKey(), // tokenId — a UUID
  tokenHash: text("token_hash").notNull().unique(), // SHA-256 of the opaque token the gateway validates
  familyId: text("family_id").notNull(),
  cliSessionId: text("cli_session_id")
    .notNull()
    .references(() => cliSessions.id),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  absoluteExpiresAt: timestamp("absolute_expires_at", {
    withTimezone: true,
  }).notNull(),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
});

export const usageEvents = pgTable("usage_events", {
  id: text("id").primaryKey(),
  orgId: text("org_id").notNull(),
  userId: text("user_id").notNull(),
  cliSessionId: text("cli_session_id"),
  // Attribution: the workspace project this consumption belongs to, resolved
  // from the runtime token's owning cli-session. Null for non-workspace usage
  // (e.g. a locally installed CLI logged in via the device flow). A supporting
  // index is deferred until a per-project usage view needs it — it must then be
  // built CREATE INDEX CONCURRENTLY (out of a migration txn) so it never locks
  // this hot, continuously-written table.
  projectId: text("project_id"),
  modelAlias: text("model_alias").notNull(),
  tokensIn: integer("tokens_in").notNull().default(0),
  tokensOut: integer("tokens_out").notNull().default(0),
  cost: integer("cost").notNull().default(0), // micro-cents
  createdAt: timestamp("created_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
});

export const workspaceTasks = pgTable("workspace_tasks", {
  id: text("id").primaryKey(),
  userId: text("user_id")
    .notNull()
    .unique()
    .references(() => users.id),
  // sha256(userId)[:12] — the public routing label (no PII in hostnames).
  hash12: text("hash12").notNull().unique(),
  efsAccessPointId: text("efs_access_point_id").notNull(),
  taskArn: text("task_arn"),
  taskIp: text("task_ip"),
  // Per-run nonce the machine credential derives from; rotated every RunTask.
  runNonce: text("run_nonce"),
  imageRef: text("image_ref").notNull(),
  state: text("state").notNull(), // "provisioning" | "ready" | "error"
  lastSeenAt: timestamp("last_seen_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

/**
 * A workspace session = a PROJECT (PRD §7.7): its own directory on EFS, its own
 * Fargate task (slept when idle — zero compute cost), its own agent history,
 * and — later — its own shipped app. The table name is kept for migration
 * stability; the product surfaces it as "Project". The user's original single
 * workspace became the "main" project via migration 0003.
 */
export const workspaceSessions = pgTable("workspace_sessions", {
  id: text("id").primaryKey(),
  userId: text("user_id")
    .notNull()
    .references(() => users.id),
  name: text("name").notNull(),
  // Per-session routing label; the migrated main session keeps the legacy
  // per-user hash so existing routes/APs survive unchanged.
  hash12: text("hash12").notNull().unique(),
  efsAccessPointId: text("efs_access_point_id").notNull(),
  taskArn: text("task_arn"),
  taskIp: text("task_ip"),
  runNonce: text("run_nonce"),
  imageRef: text("image_ref").notNull(),
  state: text("state").notNull(), // "provisioning" | "ready" | "error"
  lastSeenAt: timestamp("last_seen_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

// -- worker runtime (P0) ------------------------------------------------------

export const workspaces = pgTable("workspaces", {
  id: text("id").primaryKey(), // ws_<uuid>
  orgId: text("org_id").notNull().references(() => organizations.id),
  name: text("name").notNull(),
  keepWarm: boolean("keep_warm").default(false).notNull(),
  budgetUsdMonth: integer("budget_usd_month"), // null = uncapped in P0
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

export const agents = pgTable("agents", {
  id: text("id").primaryKey(), // ag_<uuid>
  workspaceId: text("workspace_id").notNull().references(() => workspaces.id),
  name: text("name").notNull(), // unique per workspace, enforced in registry.ts
  ownerUserId: text("owner_user_id").notNull().references(() => users.id),
  status: text("status").default("active").notNull(), // "active" | "orphaned"
  description: text("description"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

export const agentVersions = pgTable("agent_versions", {
  id: text("id").primaryKey(), // av_<uuid>
  agentId: text("agent_id").notNull().references(() => agents.id),
  contentHash: text("content_hash").notNull(), // sha256 of canonical bundle JSON
  bundle: jsonb("bundle").notNull(), // { files: { "agent.yaml": "...", "worker.yaml": "...", ... } }
  createdBy: text("created_by").notNull(), // soft user id
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

export const deployments = pgTable("deployments", {
  id: text("id").primaryKey(), // dp_<uuid>
  agentId: text("agent_id").notNull().references(() => agents.id),
  agentVersionId: text("agent_version_id").notNull().references(() => agentVersions.id),
  env: text("env").notNull(), // "dev" | "prod"
  status: text("status").default("active").notNull(), // "active" | "paused" | "superseded"
  maxTurnSeconds: integer("max_turn_seconds").default(900).notNull(),
  maxStepsPerTurn: integer("max_steps_per_turn").default(100).notNull(),
  maxTokensPerRun: integer("max_tokens_per_run").default(2000000).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

export const runs = pgTable(
  "runs",
  {
    id: text("id").primaryKey(), // r_<12 hex> — also the kimi session id on the machine
    deploymentId: text("deployment_id").notNull().references(() => deployments.id),
    agentVersionId: text("agent_version_id").notNull(),
    status: text("status").default("queued").notNull(),
    // "queued" | "running" | "succeeded" | "failed" | "cancelled" | "lost"
    errorCode: text("error_code"), // e.g. "no_output" | "turn_budget_exceeded"
    triggerPrincipal: text("trigger_principal").notNull(), // "itok:<tokenId>" | "user:<id>"
    idempotencyKey: text("idempotency_key"),
    output: jsonb("output"), // the ReturnOutput document (or {"text": ...})
    tokensIn: integer("tokens_in").default(0).notNull(),
    tokensOut: integer("tokens_out").default(0).notNull(),
    costUsdMicros: integer("cost_usd_micros").default(0).notNull(),
    modelAlias: text("model_alias"),
    traceUploaded: boolean("trace_uploaded").default(false).notNull(),
    startedAt: timestamp("started_at", { withTimezone: true }),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("runs_deployment_idem_uq").on(table.deploymentId, table.idempotencyKey),
  ]
);

export const invokeTokens = pgTable("invoke_tokens", {
  id: text("id").primaryKey(), // tokenId — a UUID
  tokenHash: text("token_hash").notNull().unique(),
  familyId: text("family_id").notNull(),
  agentId: text("agent_id").notNull().references(() => agents.id),
  env: text("env").notNull(),
  orgId: text("org_id").notNull(),
  createdBy: text("created_by").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

/**
 * A PRD Session (§7.8): a restorable unit of work INSIDE a project — its
 * user-facing name plus the durable UI state needed to resume (open tabs, tab
 * aliases, active tab, drawer/panel geometry, graph viewport). It is NOT the
 * machine; the machine is the project row above. Personal work state lives
 * here, never in the git-tracked workspace (PRD §10.6, SP-012). `uiState` is a
 * versioned JSON blob so the shape can evolve without a migration per field.
 */
export const projectSessions = pgTable("project_sessions", {
  id: text("id").primaryKey(),
  // The project (machine) this session's work belongs to.
  projectId: text("project_id")
    .notNull()
    .references(() => workspaceSessions.id),
  userId: text("user_id")
    .notNull()
    .references(() => users.id),
  name: text("name").notNull(),
  // { v, terminals[], fileTabs[], viewTabs[], active, drawerOpen } — see
  // lib/sessions/state.ts for the typed shape and validator.
  uiState: jsonb("ui_state").notNull().default({}),
  archivedAt: timestamp("archived_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  lastActiveAt: timestamp("last_active_at", { withTimezone: true }).defaultNow().notNull(),
});

export const ships = pgTable("ships", {
  id: text("id").primaryKey(),
  userId: text("user_id")
    .notNull()
    .references(() => users.id),
  orgId: text("org_id")
    .notNull()
    .references(() => organizations.id),
  appSlug: text("app_slug").notNull().unique(),
  ecrImage: text("ecr_image"),
  commitSha: text("commit_sha").notNull(),
  codebuildId: text("codebuild_id"),
  status: text("status").notNull(), // queued|building|deploying|deployed|failed
  url: text("url"),
  error: text("error"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  finishedAt: timestamp("finished_at", { withTimezone: true }),
});

export const terminalTickets = pgTable("terminal_tickets", {
  id: text("id").primaryKey(),
  ticketHash: text("ticket_hash").notNull().unique(), // sha256 of the opaque "tt_..." token
  // Plaintext CLI session token, held only until the one-time redeem (mirrors
  // device_auth_requests.pending_session_token).
  sessionToken: text("session_token"),
  userId: text("user_id")
    .notNull()
    .references(() => users.id),
  orgId: text("org_id")
    .notNull()
    .references(() => organizations.id),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  redeemedAt: timestamp("redeemed_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
});

/**
 * A workspace machine = the Fargate task backing a (workspace, env) pair for
 * running deployed agents (PRD worker runtime). Same wake state machine as
 * workspace_sessions, keyed per workspace+env instead of per user+session —
 * hash12 namespaced with a "wm:" prefix (see machineHash) so worker routing
 * never collides with user-session routing.
 */
export const workspaceMachines = pgTable("workspace_machines", {
  id: text("id").primaryKey(), // wm_<uuid>
  workspaceId: text("workspace_id").notNull().references(() => workspaces.id),
  env: text("env").notNull(),
  hash12: text("hash12").notNull().unique(),
  efsAccessPointId: text("efs_access_point_id").notNull(),
  taskArn: text("task_arn"),
  taskIp: text("task_ip"),
  runNonce: text("run_nonce"),
  imageRef: text("image_ref").notNull(),
  state: text("state").notNull(), // "provisioning" | "ready" | "error"
  keepWarm: boolean("keep_warm").default(false).notNull(),
  lastSeenAt: timestamp("last_seen_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});
