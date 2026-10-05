import "dotenv/config";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
const secret = (key: string, fallback = "") =>
  process.env[`${key}_FILE`]
    ? readFileSync(process.env[`${key}_FILE`]!, "utf8").trim()
    : process.env[key] || fallback;
const production = process.env.NODE_ENV === "production";
export const config = {
  production,
  host: process.env.HOST || "127.0.0.1",
  port: Number(process.env.PORT || 3001),
  origin: process.env.APP_ORIGIN || "http://127.0.0.1:5173",
  password: secret("APP_PASSWORD", production ? "" : "local-development-only"),
  sessionSecret: secret(
    "SESSION_SECRET",
    production ? "" : "local-development-session-secret-32-chars",
  ),
  databaseUrl: secret(
    "DATABASE_URL",
    "postgres://job:localdev@127.0.0.1:55432/jobs",
  ),
  dataDir: resolve(process.env.DATA_DIR || ".local/data"),
  sessionsDir: resolve(process.env.SESSIONS_DIR || ".local/sessions"),
  discord: secret("DISCORD_WEBHOOK_URL"),
  slack: secret("SLACK_WEBHOOK_URL"),
  telegram: secret("TELEGRAM_BOT_TOKEN"),
  telegramChat: secret("TELEGRAM_CHAT_ID"),
  aiUrl: process.env.AI_BASE_URL || "https://api.openai.com/v1",
  aiKey: secret("AI_API_KEY"),
  aiModel: process.env.AI_MODEL || "",
  aiReserve: Number(process.env.AI_CALL_RESERVE_EUR || ".05"),
  imap: {
    host: process.env.IMAP_HOST || "",
    port: Number(process.env.IMAP_PORT || 993),
    user: secret("IMAP_USER"),
    password: secret("IMAP_PASSWORD"),
    mailbox: process.env.IMAP_MAILBOX || "INBOX",
  },
};
if (
  production &&
  (config.password.length < 20 ||
    config.sessionSecret.length < 32 ||
    config.password === "local-development-only")
)
  throw new Error(
    "APP_PASSWORD (20+ chars) and SESSION_SECRET (32+ chars) required.",
  );
if (!Number.isFinite(config.aiReserve) || config.aiReserve <= 0)
  throw new Error("AI_CALL_RESERVE_EUR must be positive.");
