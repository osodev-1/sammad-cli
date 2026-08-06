import {
  pgTable,
  text,
  timestamp,
  integer,
  boolean,
  jsonb,
  pgEnum,
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
