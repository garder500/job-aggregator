import React, { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, FileText, RefreshCw, Send, Play } from "lucide-react";
type Api = (path: string, body?: unknown) => Promise<any>;
const states: Record<string, string> = {
  queued: "En file",
  running: "En cours",
  ready: "Prête",
  preparing: "Préparation",
  submitting: "Envoi",
  confirmed: "Confirmée",
  completed: "Terminée",
  excluded: "Exclue",
  failed: "Échec",
  unknown: "Incertaine",
  needs_review: "À vérifier",
};
export function SetupChecklist({ api }: { api: Api }) {
  const client = useQueryClient();
  const status = useQuery({
    queryKey: ["setup"],
    queryFn: () => api("/setup"),
  });
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const names: Record<string, string> = {
    profile: "Profil validé",
    imap: "Boîte email",
    notifications: "Notifications",
    ai: "Analyse IA",
    sources: "Sources autorisées",
  };
  async function test(integration: string) {
    setBusy(true);
    setError("");
    try {
      await api(`/diagnostics/${integration}`, {});
      await client.invalidateQueries({ queryKey: ["setup"] });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="setup-checklist">
      <div className="section-heading">
        <h2>Configuration initiale</h2>
      </div>
      {error && (
        <p role="alert" className="error-text">
          {error}
        </p>
      )}
      {Object.entries(status.data?.configured || {}).map(([key, ready]) => {
        const result = status.data.diagnostics.find(
          (d: any) => d.integration === key,
        );
        return (
          <div className="setup-row" key={key}>
            <Check size={16} color={ready ? "#16815a" : "#999"} />
            <div>
              <strong>{names[key]}</strong>
              <p>
                {ready
                  ? "Configuré"
                  : status.data.requiredVariables[key]?.join(", ") ||
                    "À configurer"}
              </p>
              {result && (
                <p>
                  {result.message} ·{" "}
                  {new Date(result.checked_at).toLocaleString("fr-FR")}
                </p>
              )}
            </div>
            {["imap", "notifications", "ai"].includes(key) && (
              <button
                className="button"
                disabled={busy || !ready || result?.state === "queued"}
                onClick={() => test(key)}
              >
                <RefreshCw size={15} />
                {key === "notifications" ? "Envoyer un test" : "Tester"}
              </button>
            )}
          </div>
        );
      })}
      <div className="section-heading">
        <h3>Exploitation</h3>
      </div>
      {!status.data?.operationalChecks.length && (
        <p>Aucune sauvegarde ou restauration enregistrée.</p>
      )}
      {status.data?.operationalChecks.map((c: any) => (
        <p key={c.kind}>
          {c.kind === "backup"
            ? "Sauvegarde"
            : c.kind === "restore"
              ? "Restauration"
              : c.kind}{" "}
          : {c.state} · {new Date(c.checked_at).toLocaleString("fr-FR")}
        </p>
      ))}
    </section>
  );
}
export function ReviewQueue({
  api,
  select,
}: {
  api: Api;
  select: (id: string) => void;
}) {
  const client = useQueryClient();
  const rows = useQuery({
    queryKey: ["review"],
    queryFn: () => api("/review"),
  });
  const operations = useQuery({
    queryKey: ["operations"],
    queryFn: () => api("/operations"),
  });
  const [selected, setSelected] = useState<string[]>([]),
    [filter, setFilter] = useState("all"),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [confirmation, setConfirmation] = useState<any[] | null>(null);
  async function batch(action: string) {
    setBusy(true);
    setError("");
    try {
      const eligible =
        confirmation?.filter((a) => a.eligibility.eligible) || [];
      await api("/batches", {
        action,
        applicationIds:
          action === "submit" ? eligible.map((a) => a.id) : selected,
        reviewTokens:
          action === "submit"
            ? Object.fromEntries(
                eligible.map((a) => [a.id, a.eligibility.reviewToken]),
              )
            : {},
      });
      setSelected([]);
      setConfirmation(null);
      await client.invalidateQueries();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function preview() {
    setBusy(true);
    setError("");
    try {
      const fresh = await api("/review");
      setConfirmation(fresh.filter((a: any) => selected.includes(a.id)));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  const visible = (rows.data || []).filter(
    (a: any) =>
      filter === "all" ||
      (filter === "eligible"
        ? a.eligibility.eligible
        : !a.eligibility.eligible),
  );
  return (
    <>
      <div className="section-heading review-heading">
        <h2>Sélection de candidatures</h2>
        <select
          aria-label="Filtrer la validation"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        >
          <option value="all">Toutes</option>
          <option value="eligible">Éligibles à l’envoi</option>
          <option value="blocked">À compléter</option>
        </select>
      </div>
      {error && (
        <p role="alert" className="error-text">
          {error}
        </p>
      )}
      <div className="detail-actions batch-toolbar">
        <span>{selected.length} sélectionnée(s)</span>
        <button
          className="button"
          disabled={busy || !selected.length}
          onClick={() => batch("cv")}
        >
          <FileText size={16} />
          Générer les CV
        </button>
        <button
          className="button"
          disabled={busy || !selected.length}
          onClick={() => batch("letter")}
        >
          <FileText size={16} />
          Générer les lettres
        </button>
        <button
          className="button"
          disabled={busy || !selected.length}
          onClick={() => batch("prepare")}
        >
          <Play size={16} />
          Préparer
        </button>
        <button
          className="button primary"
          disabled={busy || !selected.length}
          onClick={preview}
        >
          <Send size={16} />
          Soumettre la sélection
        </button>
      </div>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>
                <input
                  aria-label="Sélectionner toutes les offres visibles"
                  type="checkbox"
                  checked={
                    visible.length > 0 &&
                    visible.every((a: any) => selected.includes(a.id))
                  }
                  onChange={(e) =>
                    setSelected(
                      e.target.checked ? visible.map((a: any) => a.id) : [],
                    )
                  }
                />
              </th>
              <th>Offre</th>
              <th>Score</th>
              <th>Réserves</th>
              <th>Documents</th>
              <th>Préparation</th>
            </tr>
          </thead>
          <tbody>
            {visible.map((a: any) => (
              <tr key={a.id}>
                <td>
                  <input
                    aria-label={`Sélectionner ${a.data.title}`}
                    type="checkbox"
                    checked={selected.includes(a.id)}
                    onChange={(e) =>
                      setSelected(
                        e.target.checked
                          ? [...selected, a.id]
                          : selected.filter((id) => id !== a.id),
                      )
                    }
                  />
                </td>
                <td>
                  <button
                    className="job-title"
                    onClick={() => select(a.job_id)}
                  >
                    {a.data.title}
                  </button>
                  <p>{a.data.company}</p>
                </td>
                <td>{a.evaluation.score}/100</td>
                <td>
                  {[
                    ...a.evaluation.data.unknowns,
                    ...(a.evaluation.ai?.reservations || []),
                  ].join(", ") || "Aucune"}
                  {a.evaluation.rejected && <p>Exclusion stricte</p>}
                </td>
                <td>
                  {a.documents.map((d: any) => (
                    <div key={d.id}>
                      <a
                        href={`/api/documents/${d.id}/download`}
                        target="_blank"
                        rel="noreferrer"
                      >
                        {d.kind === "cv" ? "CV" : "Lettre"}
                      </a>{" "}
                      · {d.approved_at ? "Approuvé" : "À approuver"}
                    </div>
                  ))}
                </td>
                <td>
                  {states[a.runner_state] || a.runner_state}
                  <p>{a.eligibility.reason || "Éligible"}</p>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {!visible.length && <p>Aucune candidature à valider.</p>}
      <div className="section-heading">
        <h2>Opérations récentes</h2>
      </div>
      {operations.data
        ?.filter((op: any) => op.items.length)
        .map((op: any) => (
          <div className="operation-row" key={op.id}>
            <strong>
              {op.kind} ·{" "}
              {op.items.filter((i: any) => i.state === "completed").length}/
              {op.items.length}
            </strong>
            {op.items.map((i: any) => (
              <p key={i.id}>
                {states[i.state] || i.state}
                {i.message ? ` : ${i.message}` : ""}
              </p>
            ))}
          </div>
        ))}
      {confirmation && (
        <div className="overlay">
          <section
            className="modal batch-confirmation"
            role="dialog"
            aria-modal="true"
            aria-label="Confirmer la soumission"
          >
            <h2>Confirmer la soumission</h2>
            <p>
              {confirmation.filter((a) => a.eligibility.eligible).length}{" "}
              candidature(s) éligible(s)
            </p>
            {confirmation.map((a) => (
              <p key={a.id}>
                {a.data.title} :{" "}
                {a.eligibility.eligible
                  ? "Envoi autorisé"
                  : a.eligibility.reason}
              </p>
            ))}
            <div className="detail-actions">
              <button className="button" onClick={() => setConfirmation(null)}>
                Annuler
              </button>
              <button
                className="button primary"
                disabled={
                  busy || !confirmation.some((a) => a.eligibility.eligible)
                }
                onClick={() => batch("submit")}
              >
                <Send size={16} />
                Confirmer l’envoi
              </button>
            </div>
          </section>
        </div>
      )}
    </>
  );
}
