import { randomUUID } from "node:crypto";
import { ImapFlow } from "imapflow";
import { config } from "./config.js";
import { query } from "./db.js";
import { currentProfile, settings } from "./store.js";
import { callAI } from "./ai.js";
import { queueNotification, deliverNotification } from "./notifications.js";
export async function setupStatus() {
  const profile = await currentProfile();
  const prefs = await settings();
  const configured = {
    profile: profile.data.validated,
    imap: !!(config.imap.host && config.imap.user && config.imap.password),
    notifications:
      prefs.notificationChannel === "discord"
        ? !!config.discord
        : prefs.notificationChannel === "slack"
          ? !!config.slack
          : !!(config.telegram && config.telegramChat),
    ai: !!(config.aiKey && config.aiModel),
    sources:
      (
        await query(
          "SELECT id FROM connectors WHERE authorized AND enabled AND kind IN ('html','rss','email') LIMIT 1",
        )
      ).length > 0,
  };
  const missing = (entries: [string, string][]) =>
    entries.filter(([, value]) => !value).map(([key]) => key);
  return {
    configured,
    requiredVariables: {
      imap: missing([
        ["IMAP_HOST", config.imap.host],
        ["IMAP_USER", config.imap.user],
        ["IMAP_PASSWORD", config.imap.password],
      ]),
      notifications:
        prefs.notificationChannel === "discord"
          ? missing([["DISCORD_WEBHOOK_URL", config.discord]])
          : prefs.notificationChannel === "slack"
            ? missing([["SLACK_WEBHOOK_URL", config.slack]])
            : missing([
                ["TELEGRAM_BOT_TOKEN", config.telegram],
                ["TELEGRAM_CHAT_ID", config.telegramChat],
              ]),
      ai: missing([
        ["AI_API_KEY", config.aiKey],
        ["AI_MODEL", config.aiModel],
      ]),
    },
    diagnostics: await query("SELECT * FROM diagnostics"),
    operationalChecks: await query("SELECT * FROM operational_checks"),
  };
}
export async function runDiagnostic(integration: string) {
  let state = "failed",
    message = "Configuration ou connexion a verifier";
  try {
    if ((await settings()).paused) throw new Error("paused");
    const status = await setupStatus();
    if (!status.configured[integration as keyof typeof status.configured])
      throw new Error("missing");
    if (integration === "imap") {
      const client = new ImapFlow({
        host: config.imap.host,
        port: config.imap.port,
        secure: true,
        auth: { user: config.imap.user, pass: config.imap.password },
        logger: false,
        connectionTimeout: 10000,
        socketTimeout: 15000,
      });
      try {
        await client.connect();
        await client.mailboxOpen(config.imap.mailbox, { readOnly: true });
      } finally {
        await client.logout().catch(() => client.close());
      }
    } else if (integration === "notifications") {
      const key = `diagnostic:${randomUUID()}`;
      await queueNotification(
        key,
        "Poste : notification de test demandee depuis le dashboard",
        null,
        false,
      );
      const [n] = await query(
        "SELECT id FROM notifications WHERE logical_key=$1",
        [key],
      );
      await deliverNotification(n.id);
      const [result] = await query(
        "SELECT state FROM notifications WHERE id=$1",
        [n.id],
      );
      state =
        result.state === "sent"
          ? "completed"
          : result.state === "unknown"
            ? "unknown"
            : "failed";
      message =
        result.state === "sent"
          ? "Notification envoyee"
          : "Livraison non confirmee ; aucune repetition automatique du test";
    } else if (integration === "ai") {
      const response = await callAI(
        `diagnostic:${randomUUID()}`,
        'Retourne JSON {"ok":true}',
        { test: true },
      );
      if (response.ok !== true) throw new Error("invalid");
    } else throw new Error("invalid");
    if (integration !== "notifications") {
      state = "completed";
      message = "Connexion verifiee";
    }
  } catch {
    /* Do not expose provider errors containing account identifiers or URLs. */
  }
  await query(
    "INSERT INTO diagnostics(integration,state,message) VALUES($1,$2,$3) ON CONFLICT(integration) DO UPDATE SET state=excluded.state,message=excluded.message,checked_at=now()",
    [integration, state, message],
  );
}
