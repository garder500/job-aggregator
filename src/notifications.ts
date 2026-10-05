import { config } from "./config.js";
import { query, enqueue, transaction, event } from "./db.js";
import { settings } from "./store.js";
import { fetchPublic, NetworkError } from "./network.js";
export async function queueNotification(
  key: string,
  text: string,
  jobId: string | null,
) {
  const prefs = await settings();
  await transaction(async (tx) => {
    const [row] = await query(
      "INSERT INTO notifications(logical_key,channel,data) VALUES($1,$2,$3) ON CONFLICT DO NOTHING RETURNING id",
      [key, prefs.notificationChannel, JSON.stringify({ text, jobId })],
      tx,
    );
    if (row) await enqueue("notify", { id: row.id }, `notify:${row.id}`, tx);
  });
}
export async function deliverNotification(id: string) {
  if ((await settings()).paused) return;
  const [row] = await query(
    "UPDATE notifications SET state='sending',updated_at=now() WHERE id=$1 AND state IN ('pending','failed') RETURNING *",
    [id],
  );
  if (!row) return;
  const url = row.data.jobId
    ? `${config.origin}/?job=${row.data.jobId}`
    : config.origin;
  const text = `${row.data.text}\n${url}`.slice(0, 1900);
  try {
    if (row.channel === "discord" && config.discord)
      await fetchPublic(config.discord, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          content: text,
          allowed_mentions: { parse: [] },
        }),
      });
    else if (row.channel === "slack" && config.slack)
      await fetchPublic(config.slack, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text }),
      });
    else if (
      row.channel === "telegram" &&
      config.telegram &&
      config.telegramChat
    )
      await fetchPublic(
        `https://api.telegram.org/bot${config.telegram}/sendMessage`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ chat_id: config.telegramChat, text }),
        },
      );
    else {
      await query(
        "UPDATE notifications SET state='disabled',last_error='Canal non configure' WHERE id=$1",
        [id],
      );
      return;
    }
    await query(
      "UPDATE notifications SET state='sent',sent_at=now(),last_error=NULL WHERE id=$1",
      [id],
    );
  } catch (e) {
    // A timed-out webhook may have been accepted. Do not send it twice.
    const rateLimited = e instanceof NetworkError && e.retryAfterMs > 0;
    await query("UPDATE notifications SET state=$2,last_error=$3 WHERE id=$1", [
      id,
      rateLimited ? "pending" : "unknown",
      rateLimited ? "Limite distante" : "Resultat de livraison incertain",
    ]);
    if (rateLimited)
      await query(
        "SELECT graphile_worker.add_job('notify',$1::json,job_key := $2,run_at := $3,max_attempts := 4)",
        [
          JSON.stringify({ id }),
          `notify-retry:${id}`,
          new Date(Date.now() + (e as NetworkError).retryAfterMs),
        ],
      );
    await event("notification.delivery", id, {
      state: rateLimited ? "pending" : "unknown",
    });
  }
}
