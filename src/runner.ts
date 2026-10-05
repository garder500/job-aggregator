import { chromium, type BrowserContext, type Page } from "playwright";
import { z } from "zod";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { config } from "./config.js";
import { pool, query, transaction, event, type Tx } from "./db.js";
import { currentProfile, settings, evaluate } from "./store.js";
import { publicAddresses, validatePublicUrl } from "./network.js";
import { canonicalUrl } from "./urls.js";
import { hash } from "./domain.js";
import { captureEvidence } from "./evidence.js";
export const formSchema = z.object({
  url: z.url(),
  allowedHosts: z.array(z.string().min(1)).min(1).max(10),
  authorizationEvidence: z.string().min(10).max(2000),
  fields: z
    .array(
      z.object({
        label: z.string().min(1).max(200),
        profileKey: z.string().min(1).max(200),
      }),
    )
    .min(1)
    .max(30),
  cvLabel: z.string().min(1).max(200),
  letterLabel: z.string().max(200).optional(),
  submitLabel: z.string().min(1).max(200),
  confirmationText: z.string().min(5).max(500),
});
export class ReviewError extends Error {}
export async function automationGate(
  applicationId: string,
  tx?: Tx,
  checkApproval = true,
) {
  const [app] = await query(
    "SELECT * FROM applications WHERE id=$1",
    [applicationId],
    tx,
  );
  if (!app) throw new ReviewError("Candidature introuvable");
  const prefs = await settings(tx);
  const profile = await currentProfile(tx);
  if (prefs.paused) throw new ReviewError("Arret global actif");
  if (!profile.data.validated) throw new ReviewError("Profil a valider");
  if (
    app.status !== "to_apply" ||
    ["submitting", "confirmed", "unknown"].includes(app.runner_state)
  )
    throw new ReviewError("Candidature deja envoyee ou resultat incertain");
  const [connector] = await query(
    "SELECT * FROM connectors WHERE id=$1",
    [app.connector_id],
    tx,
  );
  if (
    !connector?.enabled ||
    !connector.authorized ||
    !connector.auto_submit ||
    connector.kind !== "form" ||
    Number(connector.cursor.supervisedRuns || 0) < 1
  )
    throw new ReviewError("Connecteur non autorise ou non supervise");
  const result = await evaluate(app.job_id, tx);
  const score = result.evaluation.data;
  if (
    score.rejected ||
    score.score < prefs.autoThreshold ||
    score.unknowns.length
  )
    throw new ReviewError("Score ou informations insuffisants");
  if (
    prefs.aiEnabled &&
    (result.evaluation.ai_status !== "completed" ||
      result.evaluation.ai?.reservations?.length)
  )
    throw new ReviewError("Analyse IA absente ou reserves a verifier");
  const candidates = await query(
    "SELECT * FROM documents WHERE profile_id=$1 AND (job_id=$2 OR (job_id IS NULL AND kind='cv')) AND approved_at IS NOT NULL AND viewed_at IS NOT NULL ORDER BY created_at DESC",
    [profile.id, app.job_id],
    tx,
  );
  const docs = candidates.filter(
    (d) => d.job_id === null || d.content.jobHash === hash(result.job.data),
  );
  if (!docs.some((d) => d.kind === "cv"))
    throw new ReviewError("CV courant non consulte ou non approuve");
  const form = formSchema.parse(connector.config);
  if (canonicalUrl(form.url) !== result.job.canonical_url)
    throw new ReviewError("Le formulaire ne correspond plus a cette offre");
  if (form.letterLabel && !docs.some((d) => d.kind === "letter"))
    throw new ReviewError("Lettre courante non approuvee");
  const [count] = await query(
    "SELECT count(*) n FROM application_attempts WHERE state IN ('submitting','confirmed','unknown') AND created_at >= date_trunc('day',now() AT TIME ZONE 'Europe/Paris') AT TIME ZONE 'Europe/Paris'",
    [],
    tx,
  );
  if (Number(count.n) >= prefs.dailyLimit)
    throw new ReviewError("Plafond quotidien atteint");
  const snapshot = {
    profileId: profile.id,
    jobHash: hash(result.job.data),
    connectorHash: hash([
      connector.id,
      connector.config,
      connector.submission_mode,
    ]),
    documentIds: ["cv", ...(form.letterLabel ? ["letter"] : [])].map(
      (kind) => docs.find((d) => d.kind === kind)!.id,
    ),
  };
  if (checkApproval && connector.submission_mode === "review_required") {
    const [approval] = await query(
      "SELECT * FROM submission_approvals WHERE application_id=$1 AND expires_at>now() AND consumed_at IS NULL",
      [applicationId],
      tx,
    );
    if (
      !approval ||
      approval.snapshot.profileId !== snapshot.profileId ||
      approval.snapshot.jobHash !== snapshot.jobHash ||
      approval.snapshot.connectorHash !== snapshot.connectorHash ||
      JSON.stringify(approval.snapshot.documentIds) !==
        JSON.stringify(snapshot.documentIds)
    )
      throw new ReviewError(
        "Approbation de soumission absente, expiree ou modifiee",
      );
  }
  return {
    app,
    prefs,
    profile,
    connector,
    docs,
    form,
    job: result.job,
    snapshot,
  };
}
export async function prepareForm(
  page: Page,
  form: z.infer<typeof formSchema>,
  profile: any,
  docs: any[],
  testLocal = false,
  allowMutations: () => boolean = () => false,
) {
  if (testLocal && config.production)
    throw new ReviewError("Mode local interdit en production");
  if (!testLocal) validatePublicUrl(form.url);
  const expectedHost = new URL(form.url).hostname;
  if (!form.allowedHosts.includes(expectedHost))
    throw new ReviewError("Domaine du formulaire non autorise");
  await page.context().route("**/*", async (route) => {
    if (
      !["GET", "HEAD", "OPTIONS"].includes(route.request().method()) &&
      !allowMutations()
    )
      return route.abort();
    const url = new URL(route.request().url());
    if (!["http:", "https:"].includes(url.protocol)) return route.abort();
    if (!form.allowedHosts.includes(url.hostname)) return route.abort();
    try {
      if (!testLocal) {
        validatePublicUrl(url.toString());
        await publicAddresses(url.hostname);
      }
      await route.continue();
    } catch {
      await route.abort();
    }
  });
  await page.goto(form.url, { waitUntil: "domcontentloaded", timeout: 30000 });
  const body = await page.locator("body").innerText();
  if (/captcha|verify you are human|unusual traffic/i.test(body))
    throw new ReviewError("Challenge detecte");
  const mapped = new Set<string>();
  for (const field of form.fields) {
    const value = ["name", "email", "phone"].includes(field.profileKey)
      ? profile[field.profileKey]
      : profile.answers[field.profileKey];
    if (typeof value !== "string" || !value.trim())
      throw new ReviewError(`Reponse manquante : ${field.label}`);
    const input = page.getByLabel(field.label, { exact: true });
    if ((await input.count()) !== 1)
      throw new ReviewError(`Champ absent ou ambigu : ${field.label}`);
    const type = await input.getAttribute("type");
    if (["checkbox", "radio", "file", "password"].includes(type || ""))
      throw new ReviewError("Declaration ou choix engageant a verifier");
    if (await input.evaluate((el) => el.tagName === "SELECT"))
      await input.selectOption({ label: value });
    else await input.fill(value);
    await input.evaluate((el) => el.setAttribute("data-ja-mapped", "yes"));
    mapped.add(field.label);
  }
  for (const [label, kind] of [
    [form.cvLabel, "cv"],
    [form.letterLabel, "letter"],
  ] as const) {
    if (!label) continue;
    const doc = docs.find((d) => d.kind === kind);
    if (!doc) throw new ReviewError(`Document ${kind} manquant`);
    const input = page.getByLabel(label, { exact: true });
    if ((await input.count()) !== 1)
      throw new ReviewError(`Piece jointe absente : ${label}`);
    await input.setInputFiles(doc.path);
    await input.evaluate((el) => el.setAttribute("data-ja-mapped", "yes"));
  }
  const unknown = await page
    .locator(
      "input:not([type=hidden]):not([type=submit]):not([type=button]),textarea,select",
    )
    .evaluateAll((elements) =>
      elements
        .filter(
          (el) =>
            !(el as HTMLInputElement).disabled &&
            el.getAttribute("data-ja-mapped") !== "yes" &&
            (el as HTMLElement).getClientRects().length,
        )
        .map(
          (el) =>
            el.getAttribute("name") || el.getAttribute("id") || el.tagName,
        ),
    );
  if (unknown.length)
    throw new ReviewError(`Questions inconnues : ${unknown.join(", ")}`);
  const invalid = await page
    .locator("input,textarea,select")
    .evaluateAll((elements) =>
      elements.some(
        (el) =>
          !(el as HTMLInputElement).disabled &&
          !(el as HTMLInputElement).checkValidity(),
      ),
    );
  if (invalid) throw new ReviewError("Validation du formulaire incomplete");
  const button = page.getByRole("button", {
    name: form.submitLabel,
    exact: true,
  });
  if ((await button.count()) !== 1 || !(await button.isEnabled()))
    throw new ReviewError("Bouton de soumission absent ou ambigu");
  if (
    await page
      .getByText(form.confirmationText, { exact: true })
      .isVisible()
      .catch(() => false)
  )
    throw new ReviewError("Confirmation deja presente avant soumission");
  return button;
}
export async function runApplication(
  id: string,
  mode: "prepare" | "submit",
  options: { testLocal?: boolean } = {},
) {
  if (options.testLocal && config.production)
    throw new ReviewError("Mode local interdit en production");
  const lock = await pool.connect();
  let context: BrowserContext | undefined;
  let attempt: string | undefined;
  let clicked = false;
  let acquired = false;
  try {
    const {
      rows: [result],
    } = await lock.query("SELECT pg_try_advisory_lock(7421904) locked");
    if (!result.locked) throw new Error("Runner occupe");
    acquired = true;
    const [app] = await query("SELECT * FROM applications WHERE id=$1", [id]);
    if (
      !app ||
      app.status !== "to_apply" ||
      ["submitting", "confirmed", "unknown"].includes(app.runner_state)
    )
      return;
    if ((await settings()).paused) {
      await query(
        "UPDATE applications SET runner_state='needs_review',last_error='Preparation suspendue par arret global',updated_at=now() WHERE id=$1 AND runner_state='queued'",
        [id],
      );
      return;
    }
    const [connector] = await query("SELECT * FROM connectors WHERE id=$1", [
      app.connector_id,
    ]);
    if (
      !connector?.enabled ||
      !connector.authorized ||
      connector.kind !== "form"
    )
      throw new ReviewError("Parcours navigateur non autorise");
    const profile = await currentProfile();
    if (!profile.data.validated) throw new ReviewError("Profil a valider");
    const form = formSchema.parse(connector.config);
    const [job] = await query(
      "SELECT canonical_url,data FROM jobs WHERE id=$1",
      [app.job_id],
    );
    if (canonicalUrl(form.url) !== job.canonical_url)
      throw new ReviewError("Le formulaire ne correspond plus a cette offre");
    if (!options.testLocal) validatePublicUrl(form.url);
    const candidates = await query(
      "SELECT * FROM documents WHERE profile_id=$1 AND (job_id=$2 OR (job_id IS NULL AND kind='cv')) AND approved_at IS NOT NULL AND viewed_at IS NOT NULL ORDER BY created_at DESC",
      [profile.id, app.job_id],
    );
    const docs = candidates.filter(
      (d) => d.job_id === null || d.content.jobHash === hash(job.data),
    );
    if (mode === "submit") await automationGate(id);
    [{ id: attempt }] = await query(
      "INSERT INTO application_attempts(application_id,state,mode) VALUES($1,'preparing',$2) RETURNING id",
      [id, mode],
    );
    await query(
      "UPDATE applications SET runner_state='preparing',updated_at=now(),last_error=NULL WHERE id=$1",
      [id],
    );
    await mkdir(join(config.sessionsDir, connector.id), {
      recursive: true,
      mode: 0o700,
    });
    const resolverRules = options.testLocal
      ? []
      : await Promise.all(
          form.allowedHosts.map(async (host) => {
            const [address] = await publicAddresses(host);
            return `MAP ${host} ${address.family === 6 ? `[${address.address}]` : address.address}`;
          }),
        );
    context = await chromium.launchPersistentContext(
      join(config.sessionsDir, connector.id),
      {
        headless: true,
        timeout: 30000,
        args: resolverRules.length
          ? [
              `--host-resolver-rules=${resolverRules.join(", ")}, MAP * ~NOTFOUND`,
            ]
          : [],
      },
    );
    const page = await context.newPage();
    page.setDefaultTimeout(10000);
    const button = await prepareForm(
      page,
      form,
      profile.data,
      docs,
      options.testLocal,
      () => clicked,
    );
    const screenshot = await captureEvidence(page, attempt!, profile.data);
    if (mode === "prepare") {
      await query(
        "UPDATE applications SET runner_state='ready',updated_at=now() WHERE id=$1",
        [id],
      );
      await query(
        "UPDATE application_attempts SET state='ready',finished_at=now(),evidence=$2 WHERE id=$1",
        [
          attempt,
          JSON.stringify({
            fields: form.fields.map((f) => f.label),
            uploads: docs.map((d) => d.id),
            screenshot,
          }),
        ],
      );
      await query(
        "UPDATE connectors SET cursor=jsonb_set(cursor,'{supervisedRuns}',to_jsonb(coalesce((cursor->>'supervisedRuns')::int,0)+1)) WHERE id=$1",
        [connector.id],
      );
      return;
    }
    await transaction(async (tx) => {
      await tx.query("SELECT pg_advisory_xact_lock(7421905)");
      const fresh = await automationGate(id, tx);
      if (
        fresh.profile.id !== profile.id ||
        hash(fresh.job.data) !== hash(job.data) ||
        ["cv", ...(form.letterLabel ? ["letter"] : [])].some(
          (kind) =>
            docs.find((d) => d.kind === kind)?.id !==
            fresh.docs.find((d) => d.kind === kind)?.id,
        ) ||
        JSON.stringify(fresh.connector.config) !==
          JSON.stringify(connector.config)
      )
        throw new ReviewError("Configuration modifiee pendant la preparation");
      await query(
        "UPDATE applications SET runner_state='submitting',updated_at=now() WHERE id=$1",
        [id],
        tx,
      );
      if (fresh.connector.submission_mode === "review_required")
        await query(
          "UPDATE submission_approvals SET consumed_at=now() WHERE application_id=$1",
          [id],
          tx,
        );
      await query(
        "UPDATE application_attempts SET state='submitting',created_at=now() WHERE id=$1",
        [attempt],
        tx,
      );
    });
    clicked = true;
    await button.click();
    await page
      .getByText(form.confirmationText, { exact: true })
      .waitFor({ state: "visible", timeout: 15000 });
    await transaction(async (tx) => {
      await query(
        "UPDATE applications SET runner_state='confirmed',status='applied',submitted_at=now(),updated_at=now() WHERE id=$1",
        [id],
        tx,
      );
      await query(
        "UPDATE application_attempts SET state='confirmed',finished_at=now(),evidence=$2 WHERE id=$1",
        [
          attempt,
          JSON.stringify({
            confirmation: form.confirmationText,
            url: page.url(),
            documents: docs.map((d) => d.id),
            screenshot,
          }),
        ],
        tx,
      );
      await query(
        "INSERT INTO reminders(application_id,due_at) VALUES($1,now()+($2||' days')::interval) ON CONFLICT DO NOTHING",
        [id, String((await settings(tx)).reminderDays)],
        tx,
      );
      await event("application.confirmed", id, {}, tx);
    });
  } catch (e) {
    if (!acquired) throw e;
    const state = clicked
      ? "unknown"
      : e instanceof ReviewError
        ? "needs_review"
        : "failed";
    const message =
      e instanceof ReviewError
        ? e.message
        : clicked
          ? "Resultat incertain : verification manuelle requise"
          : "Preparation interrompue : verifier le connecteur";
    await query(
      "UPDATE applications SET runner_state=$2,last_error=$3,updated_at=now() WHERE id=$1 AND runner_state<>'confirmed'",
      [id, state, message],
    );
    if (attempt)
      await query(
        "UPDATE application_attempts SET state=$2,finished_at=now() WHERE id=$1 AND state<>'confirmed'",
        [attempt, state],
      );
    await event(`application.${state}`, id, { message });
    const { queueNotification } = await import("./notifications.js");
    await queueNotification(`runner:${attempt || id}:${state}`, message, null);
  } finally {
    await context?.close().catch(() => {});
    if (acquired) await lock.query("SELECT pg_advisory_unlock(7421904)");
    lock.release();
  }
}
