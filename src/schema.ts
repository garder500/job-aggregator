import {
  pgTable,
  uuid,
  text,
  jsonb,
  timestamp,
  integer,
} from "drizzle-orm/pg-core";
import type { JobInput, Profile } from "./domain.js";
export const jobs = pgTable("jobs", {
  id: uuid("id").primaryKey(),
  canonicalUrl: text("canonical_url").notNull(),
  data: jsonb("data").$type<JobInput>().notNull(),
  state: text("state").notNull(),
  fingerprint: text("fingerprint").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull(),
});
export const profiles = pgTable("profiles", {
  id: uuid("id").primaryKey(),
  version: integer("version").notNull(),
  data: jsonb("data").$type<Profile>().notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
});
export const documents = pgTable("documents", {
  id: uuid("id").primaryKey(),
  jobId: uuid("job_id"),
  profileId: uuid("profile_id").notNull(),
  kind: text("kind").notNull(),
  content: jsonb("content").notNull(),
  path: text("path").notNull(),
  approvedAt: timestamp("approved_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
});
