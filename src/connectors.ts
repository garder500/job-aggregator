import Parser from "rss-parser";
import { ImapFlow } from "imapflow";
import { config } from "./config.js";
import { query, event } from "./db.js";
import { ingest, settings } from "./store.js";
import {
  parseEmail,
  parseJobPosting,
  normalizeJob,
  textOf,
} from "./normalize.js";
import { fetchPublic, NetworkError } from "./network.js";
import { sourceFromUrl, type JobInput } from "./domain.js";
export interface Connector {
  capabilities: {
    collect: boolean;
    enrich: boolean;
    prepare: boolean;
    submit: boolean;
  };
  collect(
    cursor: Record<string, any>,
  ): Promise<{ items: JobInput[]; cursor: Record<string, any> }>;
  normalize(raw: unknown): JobInput;
}
export function httpConnector(row: any): Connector {
  return {
    capabilities: {
      collect: row.authorized,
      enrich: row.authorized,
      prepare: false,
      submit: false,
    },
    normalize: normalizeJob,
    async collect(cursor) {
      if (!row.authorized)
        throw new NetworkError("Collecte non autorisee", 0, true);
      const response = await fetchPublic(
        row.config.url,
        {},
        row.config.allowedHosts,
      );
      if (/captcha|verify you are human|unusual traffic/i.test(response.text))
        throw new NetworkError("Challenge detecte", 0, true);
      let items: JobInput[] = [];
      if (row.kind === "rss") {
        const feed = await new Parser().parseString(response.text);
        items = feed.items
          .filter((i) => i.link && i.title)
          .map((i) =>
            normalizeJob({
              title: i.title,
              url: i.link,
              company: (i as any).creator || "",
              source: sourceFromUrl(i.link!),
              description: textOf(i.content || i.contentSnippet || ""),
            }),
          );
      } else {
        items = parseJobPosting(response.text, response.url);
        if (!items.length)
          throw new NetworkError(
            "Aucun JobPosting : structure a verifier",
            0,
            true,
          );
      }
      return {
        items,
        cursor: { ...cursor, lastFetch: new Date().toISOString() },
      };
    },
  };
}
export async function collectEmail(row: any) {
  if (!config.imap.host || !config.imap.user || !config.imap.password)
    throw new NetworkError("Configuration IMAP absente", 0, true);
  const imap = new ImapFlow({
    host: config.imap.host,
    port: config.imap.port,
    secure: true,
    auth: { user: config.imap.user, pass: config.imap.password },
    logger: false,
  });
  await imap.connect();
  const lock = await imap.getMailboxLock(config.imap.mailbox);
  try {
    const validity = String((imap.mailbox as any).uidValidity);
    const start =
      row.cursor.uidValidity === validity ? Number(row.cursor.uid || 0) + 1 : 1;
    const uids = await imap.search({ uid: `${start}:*` }, { uid: true });
    if (!uids) return;
    for (const uid of uids.filter((n) => n >= start).slice(0, 100)) {
      const message = await imap.fetchOne(uid, { source: true }, { uid: true });
      if (!message || !message.source) continue;
      const raw = message.source.toString("utf8");
      for (const job of await parseEmail(raw))
        await ingest(job, {
          email: raw,
          mailbox: config.imap.mailbox,
          uid,
          uidValidity: validity,
        });
      await query("UPDATE connectors SET cursor=$2 WHERE id=$1", [
        row.id,
        JSON.stringify({ uid, uidValidity: validity }),
      ]);
    }
  } finally {
    lock.release();
    await imap.logout();
  }
}
export async function collectConnector(id: string) {
  if ((await settings()).paused) return;
  const client = await (await import("./db.js")).pool.connect();
  let domainLock: string | undefined;
  try {
    const {
      rows: [lock],
    } = await client.query("SELECT pg_try_advisory_lock(hashtext($1)) locked", [
      `collect:${id}`,
    ]);
    if (!lock.locked) return;
    try {
      const [row] = await query("SELECT * FROM connectors WHERE id=$1", [id]);
      if (
        !row?.enabled ||
        !row.authorized ||
        row.kind === "import" ||
        row.kind === "form"
      )
        return;
      if (
        row.cursor.nextAllowed &&
        new Date(row.cursor.nextAllowed).getTime() > Date.now()
      )
        return;
      if (["rss", "html"].includes(row.kind)) {
        domainLock = `domain:${new URL(row.config.url).hostname}`;
        await client.query("SELECT pg_advisory_lock(hashtext($1))", [
          domainLock,
        ]);
      }
      await query("UPDATE connectors SET last_run_at=now() WHERE id=$1", [id]);
      if (row.kind === "email") await collectEmail(row);
      else {
        const result = await httpConnector(row).collect(row.cursor);
        for (const job of result.items)
          await ingest(job, { job, connector: id });
        await query("UPDATE connectors SET cursor=$2 WHERE id=$1", [
          id,
          JSON.stringify(result.cursor),
        ]);
      }
      await query(
        "UPDATE connectors SET failures=0,last_error=NULL,last_success_at=now(),cursor=cursor || '{\"structuralFailures\":0}'::jsonb WHERE id=$1",
        [id],
      );
    } catch (e) {
      const structural = e instanceof NetworkError && e.structural;
      const [row] = await query(
        "UPDATE connectors SET failures=failures+1,last_error=$2 WHERE id=$1 RETURNING *",
        [
          id,
          structural ? "Structure ou acces a verifier" : "Collecte interrompue",
        ],
      );
      if (row) {
        const structuralFailures = structural
          ? Number(row.cursor.structuralFailures || 0) + 1
          : 0;
        const delay =
          e instanceof NetworkError && e.retryAfterMs
            ? e.retryAfterMs
            : Math.min(21600000, 60000 * 2 ** Math.min(row.failures, 8)) +
              Math.floor(Math.random() * 10000);
        await query(
          "UPDATE connectors SET cursor=cursor || $2::jsonb,enabled=CASE WHEN $3 THEN false ELSE enabled END WHERE id=$1",
          [
            id,
            JSON.stringify({
              nextAllowed: new Date(Date.now() + delay).toISOString(),
              structuralFailures,
            }),
            structural &&
              (structuralFailures >= 3 ||
                /challenge|restreint/i.test(String(e))),
          ],
        );
        await event("connector.failed", id, {
          structural,
          failures: row.failures,
        });
        if (row.failures === 3) {
          const { queueNotification } = await import("./notifications.js");
          await queueNotification(
            `connector:${id}:${row.last_success_at || "initial"}`,
            `Connecteur ${row.name} interrompu. Verification requise.`,
            null,
          );
        }
      }
    }
  } finally {
    try {
      if (domainLock)
        await client.query("SELECT pg_advisory_unlock(hashtext($1))", [
          domainLock,
        ]);
      await client.query("SELECT pg_advisory_unlock(hashtext($1))", [
        `collect:${id}`,
      ]);
    } finally {
      client.release();
    }
  }
}
