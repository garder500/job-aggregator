import React, { useState, useEffect, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import {
  QueryClient,
  QueryClientProvider,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import {
  DndContext,
  useDraggable,
  useDroppable,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  BriefcaseBusiness,
  Search,
  SlidersHorizontal,
  ArrowUpRight,
  Bookmark,
  X,
  Plus,
  Download,
  Check,
  Pause,
  Play,
  LogOut,
  LayoutList,
  Columns3,
  FileText,
  Plug,
  Settings2,
  RefreshCw,
  Upload,
  ChevronRight,
  CircleAlert,
  Trash2,
  Send,
  ShieldCheck,
  Copy,
  PanelLeftClose,
  Menu,
} from "lucide-react";
import type { Profile, Settings } from "../src/domain";
import { canonicalUrl } from "../src/urls";
import "./style.css";
const client = new QueryClient({
  defaultOptions: { queries: { retry: false, refetchInterval: 10000 } },
});
async function api(path: string, body?: unknown) {
  const response = await fetch(`/api${path}`, {
    credentials: "same-origin",
    ...(body !== undefined
      ? {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        }
      : {}),
  });
  const data = await response.json();
  if (response.status === 401 && path !== "/login")
    client.setQueryData(["me"], null);
  if (!response.ok) throw new Error(data.error || "Opération interrompue");
  return data;
}
const labels: Record<string, string> = {
  new: "Nouvelles",
  seen: "Vues",
  ignored: "Ignorées",
  shortlisted: "Sélection",
  to_apply: "À postuler",
  applied: "Postulées",
  interview: "Entretiens",
  rejected: "Refusées",
  withdrawn: "Retirées",
  queued: "En file",
  preparing: "Préparation",
  ready: "Prête",
  submitting: "Envoi",
  confirmed: "Confirmée",
  needs_review: "À vérifier",
  failed: "Échec",
  unknown: "Incertaine",
  disabled: "Inactive",
  completed: "Terminée",
  pending: "En attente",
  sent: "Envoyée",
  sending: "Envoi",
};
const formatDate = (s: string) =>
  new Intl.DateTimeFormat("fr-FR", {
    dateStyle: "medium",
    timeZone: "Europe/Paris",
  }).format(new Date(s));
const split = (s: string) =>
  s
    .split(",")
    .map((v) => v.trim())
    .filter(Boolean);
function IconButton({
  title,
  children,
  onClick,
  disabled = false,
}: {
  title: string;
  children: ReactNode;
  onClick?: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      className="icon-button"
      type="button"
      title={title}
      aria-label={title}
      onClick={onClick}
      disabled={disabled}
    >
      {children}
    </button>
  );
}
function Badge({ value }: { value: string }) {
  return <span className={`badge ${value}`}>{labels[value] || value}</span>;
}
function Empty({ text, action }: { text: string; action?: ReactNode }) {
  return (
    <div className="empty">
      <BriefcaseBusiness size={32} />
      <h3>{text}</h3>
      {action}
    </div>
  );
}
function ListInput({
  values,
  onChange,
}: {
  values: string[];
  onChange: (values: string[]) => void;
}) {
  const [text, setText] = useState(values.join(", "));
  useEffect(() => setText(values.join(", ")), [values]);
  return (
    <input
      value={text}
      onChange={(e) => setText(e.target.value)}
      onBlur={() => onChange(split(text))}
    />
  );
}
function Modal({
  title,
  children,
  close,
  wide = false,
}: {
  title: string;
  children: ReactNode;
  close: () => void;
  wide?: boolean;
}) {
  useEffect(() => {
    const fn = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    window.addEventListener("keydown", fn);
    return () => window.removeEventListener("keydown", fn);
  }, [close]);
  return (
    <div
      className="overlay"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) close();
      }}
    >
      <section
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className={`modal ${wide ? "wide" : ""}`}
      >
        <header>
          <h2>{title}</h2>
          <IconButton title="Fermer" onClick={close}>
            <X size={20} />
          </IconButton>
        </header>
        {children}
      </section>
    </div>
  );
}
function App() {
  const cache = useQueryClient();
  const me = useQuery({
    queryKey: ["me"],
    queryFn: () => api("/me"),
    refetchInterval: false,
  });
  const [view, setView] = useState("jobs"),
    [error, setError] = useState(""),
    [success, setSuccess] = useState(""),
    [busy, setBusy] = useState(false),
    [importing, setImporting] = useState(false),
    [selected, setSelected] = useState<string | null>(
      new URLSearchParams(location.search).get("job"),
    ),
    [mobile, setMobile] = useState(false);
  const overview = useQuery({
    queryKey: ["overview"],
    queryFn: () => api("/overview"),
    enabled: !!me.data,
  });
  async function act(
    path: string,
    body?: unknown,
    message = "Modifications enregistrées",
  ) {
    setError("");
    setBusy(true);
    try {
      const result = await api(path, body);
      if (path === "/logout") {
        cache.setQueryData(["me"], null);
        return result;
      }
      await cache.invalidateQueries();
      setSuccess(message);
      setTimeout(() => setSuccess(""), 3500);
      return result;
    } catch (e) {
      setError((e as Error).message);
      throw e;
    } finally {
      setBusy(false);
    }
  }
  const run = (path: string, body?: unknown, message?: string) =>
    void act(path, body, message).catch(() => {});
  if (!me.data)
    return (
      <Login onLogin={() => cache.invalidateQueries({ queryKey: ["me"] })} />
    );
  const nav = [
    { id: "jobs", name: "Offres", icon: LayoutList },
    { id: "applications", name: "Candidatures", icon: Columns3 },
    { id: "documents", name: "Documents", icon: FileText },
    { id: "connectors", name: "Connecteurs", icon: Plug },
    { id: "settings", name: "Configuration", icon: Settings2 },
  ];
  const title = nav.find((n) => n.id === view)?.name;
  return (
    <div className="shell">
      <aside className={mobile ? "open" : ""}>
        <a className="brand" href="/" aria-label="Poste">
          <span>
            <BriefcaseBusiness size={22} />
          </span>
          poste<span className="brand-dot">.</span>
        </a>
        <div className="workspace">
          <span className="avatar">P</span>
          <div>
            Mon espace<span>Recherche privée</span>
          </div>
          <ShieldCheck size={16} />
        </div>
        <div className="nav-label">ESPACE DE TRAVAIL</div>
        <nav>
          {nav.map((n) => (
            <button
              key={n.id}
              aria-label={n.name}
              className={view === n.id ? "active" : ""}
              onClick={() => {
                setView(n.id);
                setMobile(false);
              }}
            >
              <n.icon size={19} />
              {n.name}
              {n.id === "jobs" && overview.data?.new > 0 ? (
                <span className="nav-count">{overview.data.new}</span>
              ) : null}
            </button>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <div className="private">
            <span className="status-dot" />
            Serveur privé
          </div>
          <button onClick={() => run("/logout", {}, "Déconnecté")}>
            <LogOut size={17} />
            Déconnexion
          </button>
        </div>
      </aside>
      <div className="main">
        <header className="topbar">
          <div className="breadcrumb">
            <button
              className="mobile-menu icon-button"
              title="Navigation"
              onClick={() => setMobile(!mobile)}
            >
              <Menu size={20} />
            </button>
            <span>Espace personnel</span>
            <ChevronRight size={14} />
            <strong>{title}</strong>
          </div>
          <div className="top-actions">
            <span className="time-zone">Europe / Paris</span>
            <button
              className={
                overview.data?.settings.paused
                  ? "button warning"
                  : "button subtle"
              }
              disabled={busy}
              onClick={() =>
                overview.data &&
                run("/settings", {
                  ...overview.data.settings,
                  paused: !overview.data.settings.paused,
                })
              }
            >
              {overview.data?.settings.paused ? (
                <Play size={15} />
              ) : (
                <Pause size={15} />
              )}
              <span>
                {overview.data?.settings.paused ? "Reprendre" : "Suspendre"}
              </span>
            </button>
            <span className="user-dot">P</span>
          </div>
        </header>
        <main>
          <div className="page-heading">
            <div>
              <div className="eyebrow">MON PARCOURS</div>
              <h1>{title}</h1>
            </div>
            {view === "jobs" && (
              <button
                className="button primary"
                onClick={() => setImporting(true)}
              >
                <Plus size={17} />
                Importer des offres
              </button>
            )}
          </div>
          {error && (
            <div role="alert" className="alert error floating-error">
              <CircleAlert size={17} />
              {error}
              <IconButton title="Fermer l’erreur" onClick={() => setError("")}>
                <X size={16} />
              </IconButton>
            </div>
          )}
          {success && (
            <div role="status" className="toast">
              <Check size={17} />
              {success}
            </div>
          )}
          {overview.data?.settings.paused && (
            <div className="alert">
              <Pause size={16} />
              Collecte, notifications et runner suspendus.
            </div>
          )}
          {view === "jobs" && (
            <Jobs
              overview={overview.data}
              select={setSelected}
              run={run}
              busy={busy}
            />
          )}
          {view === "applications" && (
            <Applications run={run} select={setSelected} busy={busy} />
          )}
          {view === "documents" && <Documents run={run} busy={busy} />}
          {view === "connectors" && (
            <Connectors
              run={run}
              act={act}
              busy={busy}
              overview={overview.data}
            />
          )}
          {view === "settings" && <Configuration act={act} busy={busy} />}
        </main>
        <footer>
          Poste · Espace privé
          <span>
            {new Intl.DateTimeFormat("fr-FR", {
              dateStyle: "long",
              timeZone: "Europe/Paris",
            }).format(new Date())}
          </span>
        </footer>
      </div>
      {importing && (
        <Import close={() => setImporting(false)} act={act} busy={busy} />
      )}{" "}
      {selected && (
        <JobDetail
          id={selected}
          close={() => setSelected(null)}
          run={run}
          busy={busy}
        />
      )}
    </div>
  );
}
type Actions = {
  run: (p: string, b?: unknown, m?: string) => void;
  busy: boolean;
};
function Login({ onLogin }: { onLogin: () => void }) {
  const [password, setPassword] = useState(""),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  return (
    <div className="login">
      <div className="login-brand">
        <BriefcaseBusiness size={34} />
        <span>poste.</span>
      </div>
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          try {
            await api("/login", { password });
            onLogin();
          } catch (e) {
            setError((e as Error).message);
          } finally {
            setBusy(false);
          }
        }}
      >
        <div className="eyebrow">ESPACE PRIVÉ</div>
        <h1>Bon retour.</h1>
        <label>
          Mot de passe
          <input
            autoFocus
            autoComplete="current-password"
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
          />
        </label>
        {error && (
          <p role="alert" className="error-text">
            {error}
          </p>
        )}
        <button className="button primary" disabled={busy}>
          {busy ? "Connexion…" : "Se connecter"}
          <ArrowUpRight size={17} />
        </button>
      </form>
    </div>
  );
}
function Jobs({
  overview,
  select,
  run,
  busy,
}: { overview: any; select: (id: string) => void } & Actions) {
  const [q, setQ] = useState(""),
    [state, setState] = useState("all"),
    [minScore, setMinScore] = useState(0),
    [offset, setOffset] = useState(0),
    [filters, setFilters] = useState(false);
  const jobs = useQuery({
    queryKey: ["jobs", q, state, minScore, offset],
    queryFn: () =>
      api(
        `/jobs?${new URLSearchParams({ q, state, minScore: String(minScore), offset: String(offset) })}`,
      ),
  });
  const duplicates = useQuery({
    queryKey: ["duplicates"],
    queryFn: () => api("/duplicates"),
  });
  return (
    <>
      <div className="metrics">
        {[
          {
            name: "Offres collectées",
            value: overview?.total,
            icon: BriefcaseBusiness,
            color: "green",
          },
          {
            name: "À découvrir",
            value: overview?.new,
            icon: LayoutList,
            color: "gold",
          },
          {
            name: "Candidatures envoyées",
            value: overview?.applied,
            icon: Send,
            color: "rose",
          },
          {
            name: "Entretiens",
            value: overview?.interviews,
            icon: Columns3,
            color: "blue",
          },
        ].map((m) => (
          <div className="metric" key={m.name}>
            <div>
              <span>{m.name}</span>
              <strong>{m.value ?? "—"}</strong>
            </div>
            <span className={`metric-icon ${m.color}`}>
              <m.icon size={21} />
            </span>
          </div>
        ))}
      </div>
      <section className="collection">
        <div className="collection-heading">
          <h2>Votre prochaine opportunité</h2>
          <span className="small-muted">
            {jobs.data?.length ?? 0} offres affichées
          </span>
        </div>
        <div className="toolbar">
          <div className="tabs">
            {[
              ["all", "Toutes"],
              ["new", "Nouvelles"],
              ["shortlisted", "Sélection"],
              ["ignored", "Ignorées"],
            ].map(([id, name]) => (
              <button
                key={id}
                className={state === id ? "active" : ""}
                onClick={() => {
                  setState(id);
                  setOffset(0);
                }}
              >
                {name}
              </button>
            ))}
          </div>
          <div className="table-tools">
            <div className="search">
              <Search size={16} />
              <input
                aria-label="Rechercher une offre"
                placeholder="Métier, entreprise…"
                value={q}
                onChange={(e) => {
                  setQ(e.target.value);
                  setOffset(0);
                }}
              />
            </div>
            <IconButton title="Filtres" onClick={() => setFilters(!filters)}>
              <SlidersHorizontal size={18} />
            </IconButton>
            <IconButton
              title="Actualiser"
              onClick={() => client.invalidateQueries()}
            >
              <RefreshCw size={17} />
            </IconButton>
          </div>
        </div>
        {filters && (
          <div className="filter-row">
            <label>
              Score minimum{" "}
              <input
                type="range"
                min="0"
                max="100"
                step="5"
                value={minScore}
                onChange={(e) => {
                  setMinScore(Number(e.target.value));
                  setOffset(0);
                }}
              />
              <strong>{minScore}</strong>
            </label>
            <select
              aria-label="État de veille"
              value={state}
              onChange={(e) => setState(e.target.value)}
            >
              {["all", "new", "seen", "shortlisted", "ignored"].map((s) => (
                <option key={s} value={s}>
                  {s === "all" ? "Tous les états" : labels[s]}
                </option>
              ))}
            </select>
          </div>
        )}
        {jobs.isLoading ? (
          <div className="empty">Chargement…</div>
        ) : jobs.error ? (
          <div className="alert error">{jobs.error.message}</div>
        ) : !jobs.data?.length ? (
          <Empty text="Aucune offre pour le moment" />
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>POSTE / ENTREPRISE</th>
                  <th>LOCALISATION</th>
                  <th>CONTRAT</th>
                  <th>MATCH</th>
                  <th>ÉTAT</th>
                  <th>
                    <span className="sr-only">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {jobs.data.map((j: any) => (
                  <tr key={j.id}>
                    <td>
                      <button
                        className="job-title"
                        onClick={() => select(j.id)}
                      >
                        {j.data.title}
                      </button>
                      <div className="company-line">
                        <span className="company-avatar">
                          {(j.data.company || "?").slice(0, 1)}
                        </span>
                        {j.data.company || "Entreprise inconnue"}
                        <span className="source-name">{j.data.source}</span>
                      </div>
                    </td>
                    <td>
                      {j.data.location || "À préciser"}
                      <span className="cell-note">
                        {
                          (
                            {
                              remote: "Télétravail intégral",
                              hybrid: "Hybride",
                              onsite: "Sur site",
                              unknown: "Télétravail à préciser",
                            } as any
                          )[j.data.remote]
                        }
                      </span>
                    </td>
                    <td>
                      <span className="contract">
                        {j.data.contract === "unknown"
                          ? "À préciser"
                          : j.data.contract}
                      </span>
                    </td>
                    <td>
                      <div
                        className={`score ${j.rejected ? "low" : j.score >= 70 ? "high" : ""}`}
                      >
                        <span>{j.score ?? 0}</span>
                        <small>/100</small>
                      </div>
                    </td>
                    <td>
                      <Badge value={j.application_status || j.state} />
                    </td>
                    <td>
                      <div className="row-actions">
                        <IconButton
                          title={
                            j.state === "shortlisted"
                              ? "Retirer de la sélection"
                              : "Sélectionner"
                          }
                          disabled={busy}
                          onClick={() =>
                            run(`/jobs/${j.id}/state`, {
                              state:
                                j.state === "shortlisted"
                                  ? "seen"
                                  : "shortlisted",
                            })
                          }
                        >
                          <Bookmark
                            size={17}
                            fill={
                              j.state === "shortlisted"
                                ? "currentColor"
                                : "none"
                            }
                          />
                        </IconButton>
                        <IconButton
                          title="Ignorer"
                          disabled={busy}
                          onClick={() =>
                            run(`/jobs/${j.id}/state`, { state: "ignored" })
                          }
                        >
                          <X size={17} />
                        </IconButton>
                        <a
                          className="icon-button"
                          href={j.data.url}
                          target="_blank"
                          rel="noreferrer"
                          title="Ouvrir l’offre"
                          aria-label="Ouvrir l’offre"
                        >
                          <ArrowUpRight size={17} />
                        </a>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <div className="pagination">
          <span>Triées par pertinence</span>
          <div>
            <button
              className="button subtle"
              disabled={!offset}
              onClick={() => setOffset(Math.max(0, offset - 100))}
            >
              Précédent
            </button>
            <span>{Math.floor(offset / 100) + 1}</span>
            <button
              className="button subtle"
              disabled={jobs.data?.length !== 100}
              onClick={() => setOffset(offset + 100)}
            >
              Suivant
            </button>
          </div>
        </div>
      </section>
      {!!duplicates.data?.length && (
        <section className="section">
          <h2>Rapprochements à vérifier</h2>
          {duplicates.data.map((d: any) => (
            <div className="list-row" key={d.left_id + d.right_id}>
              <div>
                <strong>{d.left_data.title}</strong>
                <span>
                  {d.left_data.company} · {d.left_data.location} /{" "}
                  {d.right_data.location}
                </span>
              </div>
              <button
                className="button"
                disabled={busy}
                onClick={() =>
                  run("/duplicates", {
                    left: d.left_id,
                    right: d.right_id,
                    action: "merge",
                  })
                }
              >
                <Copy size={15} />
                Fusionner
              </button>
              <IconButton
                title="Conserver séparément"
                onClick={() =>
                  run("/duplicates", {
                    left: d.left_id,
                    right: d.right_id,
                    action: "dismiss",
                  })
                }
              >
                <X size={17} />
              </IconButton>
            </div>
          ))}
        </section>
      )}
    </>
  );
}
function Import({
  close,
  act,
  busy,
}: {
  close: () => void;
  act: (p: string, b?: unknown, m?: string) => Promise<any>;
  busy: boolean;
}) {
  const [format, setFormat] = useState("json"),
    [content, setContent] = useState(""),
    [localError, setLocalError] = useState("");
  return (
    <Modal title="Importer des offres" close={close}>
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          setLocalError("");
          try {
            const body =
              format === "json"
                ? { format, items: JSON.parse(content) }
                : { format, content };
            await act("/import", body, "Import terminé");
            close();
          } catch (e) {
            setLocalError((e as Error).message);
          }
        }}
      >
        <div className="tabs">
          <button
            type="button"
            className={format === "json" ? "active" : ""}
            onClick={() => setFormat("json")}
          >
            JSON
          </button>
          <button
            type="button"
            className={format === "eml" ? "active" : ""}
            onClick={() => setFormat("eml")}
          >
            Email .eml
          </button>
        </div>
        <label className="file-input">
          <Upload size={16} />
          Choisir un fichier
          <input
            type="file"
            accept={format === "eml" ? ".eml" : ".json"}
            onChange={async (e) => {
              const f = e.target.files?.[0];
              if (f) setContent(await f.text());
            }}
          />
        </label>
        <label>
          Contenu
          <textarea
            className="code"
            rows={12}
            required
            value={content}
            onChange={(e) => setContent(e.target.value)}
            placeholder={
              format === "json"
                ? '[{"title":"Développeur TypeScript","company":"Entreprise","url":"https://example.com/jobs/123","description":"…"}]'
                : "From: alertes@example.com\nSubject: Nouvelles offres\nContent-Type: text/html\n\n…"
            }
          />
        </label>
        {localError && (
          <p className="error-text" role="alert">
            {localError}
          </p>
        )}
        <div className="form-actions">
          <button type="button" className="button" onClick={close}>
            Annuler
          </button>
          <button className="button primary" disabled={busy || !content}>
            <Upload size={16} />
            Importer
          </button>
        </div>
      </form>
    </Modal>
  );
}
function JobDetail({
  id,
  close,
  run,
  busy,
}: { id: string; close: () => void } & Actions) {
  const job = useQuery({
      queryKey: ["job", id],
      queryFn: () => api(`/jobs/${id}`),
    }),
    connectors = useQuery({
      queryKey: ["connectors"],
      queryFn: () => api("/connectors"),
    });
  const [connector, setConnector] = useState(""),
    [evidence, setEvidence] = useState("");
  const j = job.data;
  const ev = j?.evaluations?.[0];
  return (
    <Modal title="Détail de l’offre" close={close} wide>
      {j ? (
        <div className="detail">
          <div className="detail-heading">
            <span className="source-name">{j.data.source}</span>
            <h2>{j.data.title}</h2>
            <p>
              {j.data.company || "Entreprise inconnue"} ·{" "}
              {j.data.location || "Localisation inconnue"}
            </p>
            <div className="detail-actions">
              <a
                className="button"
                href={j.data.url}
                target="_blank"
                rel="noreferrer"
              >
                <ArrowUpRight size={16} />
                Offre originale
              </a>
              <button
                className="button primary"
                disabled={busy || !!j.application}
                onClick={() =>
                  run(
                    "/applications",
                    { jobId: id },
                    "Candidature ajoutée au suivi",
                  )
                }
              >
                <Plus size={16} />
                {j.application ? "Candidature suivie" : "Ajouter au suivi"}
              </button>
              <IconButton
                title="Recalculer"
                disabled={busy}
                onClick={() => run(`/jobs/${id}/evaluate`, {})}
              >
                <RefreshCw size={17} />
              </IconButton>
            </div>
          </div>
          <div className="detail-grid">
            <section>
              <h3>Annonce</h3>
              <p className="description">
                {j.data.description || "Description non disponible"}
              </p>
              <div className="skill-list">
                {j.data.skills.map((s: string) => (
                  <span key={s}>{s}</span>
                ))}
              </div>
              <h3>Provenance</h3>
              {j.sources.map((s: any, i: number) => (
                <a
                  key={i}
                  className="source-link"
                  href={s.url}
                  target="_blank"
                  rel="noreferrer"
                >
                  {s.source}
                  <ArrowUpRight size={14} />
                </a>
              ))}
            </section>
            <section className="evaluation">
              <h3>
                Matching <strong>{ev?.score ?? 0}/100</strong>
              </h3>
              {ev?.data.details.map((d: any) => (
                <div className="score-line" key={d.name}>
                  <span>{d.name}</span>
                  <strong>
                    {d.points}/{d.maximum}
                  </strong>
                  <progress value={d.points} max={d.maximum} />
                </div>
              ))}
              {!!ev?.data.reasons.length && (
                <div className="error-text">{ev.data.reasons.join(" · ")}</div>
              )}
              <h4>À préciser</h4>
              <div className="skill-list">
                {ev?.data.unknowns.map((s: string) => (
                  <span key={s}>{s}</span>
                ))}
              </div>
              {ev?.ai && (
                <>
                  <h4>Analyse IA · {ev.ai.adequacy}/100</h4>
                  {ev.ai.reservations.map((s: string, i: number) => (
                    <p key={i}>{s}</p>
                  ))}
                </>
              )}
              {ev?.ai_status === "failed" && (
                <p className="error-text">Analyse IA interrompue</p>
              )}
              <h4>Documents</h4>
              <div className="detail-actions">
                <button
                  className="button"
                  disabled={busy}
                  onClick={() =>
                    run(
                      "/documents",
                      { jobId: id, kind: "cv" },
                      "CV en préparation",
                    )
                  }
                >
                  <FileText size={15} />
                  CV
                </button>
                <button
                  className="button"
                  disabled={busy}
                  onClick={() =>
                    run(
                      "/documents",
                      { jobId: id, kind: "letter" },
                      "Lettre en préparation",
                    )
                  }
                >
                  <FileText size={15} />
                  Lettre
                </button>
              </div>
              {j.application && (
                <>
                  <h4>Candidature</h4>
                  <Badge value={j.application.runner_state} />
                  {j.application.last_error && (
                    <p className="error-text">{j.application.last_error}</p>
                  )}
                  <label>
                    Parcours autorisé
                    <select
                      value={connector || j.application.connector_id || ""}
                      onChange={(e) => setConnector(e.target.value)}
                    >
                      <option value="">Sélectionner</option>
                      {connectors.data
                        ?.filter(
                          (c: any) =>
                            c.kind === "form" &&
                            c.enabled &&
                            c.authorized &&
                            canonicalUrl(c.config.url) === j.canonical_url,
                        )
                        .map((c: any) => (
                          <option value={c.id} key={c.id}>
                            {c.name}
                          </option>
                        ))}
                    </select>
                  </label>
                  <div className="detail-actions">
                    <button
                      className="button"
                      disabled={
                        busy || !(connector || j.application.connector_id)
                      }
                      onClick={() =>
                        run(
                          `/applications/${j.application.id}/run`,
                          {
                            mode: "prepare",
                            connectorId:
                              connector || j.application.connector_id,
                          },
                          "Préparation en file",
                        )
                      }
                    >
                      <Play size={15} />
                      Préparer
                    </button>
                    <button
                      className="button primary"
                      disabled={
                        busy || !(connector || j.application.connector_id)
                      }
                      onClick={() =>
                        run(
                          `/applications/${j.application.id}/run`,
                          {
                            mode: "submit",
                            connectorId:
                              connector || j.application.connector_id,
                          },
                          "Soumission en file",
                        )
                      }
                    >
                      <Send size={15} />
                      Soumettre
                    </button>
                  </div>
                  {j.application.runner_state === "unknown" && (
                    <>
                      <label>
                        Preuve de vérification
                        <textarea
                          value={evidence}
                          onChange={(e) => setEvidence(e.target.value)}
                        />
                      </label>
                      <div className="detail-actions">
                        <button
                          className="button"
                          disabled={busy || evidence.length < 10}
                          onClick={() =>
                            run(`/applications/${j.application.id}/resolve`, {
                              submitted: true,
                              evidence,
                            })
                          }
                        >
                          Envoi confirmé
                        </button>
                        <button
                          className="button"
                          disabled={busy || evidence.length < 10}
                          onClick={() =>
                            run(`/applications/${j.application.id}/resolve`, {
                              submitted: false,
                              evidence,
                            })
                          }
                        >
                          Absence d’envoi vérifiée
                        </button>
                      </div>
                    </>
                  )}
                </>
              )}
            </section>
          </div>
        </div>
      ) : (
        <div className="empty">{job.error?.message || "Chargement…"}</div>
      )}
    </Modal>
  );
}
function ApplicationCard({
  app,
  run,
  select,
  busy,
}: { app: any; select: (id: string) => void } & Actions) {
  const { attributes, listeners, setNodeRef, transform } = useDraggable({
    id: app.id,
    disabled:
      busy ||
      ["queued", "preparing", "submitting", "unknown"].includes(
        app.runner_state,
      ),
  });
  return (
    <article
      ref={setNodeRef}
      style={{
        transform: transform
          ? `translate3d(${transform.x}px,${transform.y}px,0)`
          : undefined,
      }}
      className="application-card"
    >
      <div className="card-meta">
        <span className="source-name">{app.data.source}</span>
        <button
          className="drag-handle"
          aria-label="Déplacer la candidature"
          {...listeners}
          {...attributes}
        >
          <Columns3 size={15} />
        </button>
      </div>
      <button className="job-title" onClick={() => select(app.job_id)}>
        {app.data.title}
      </button>
      <p>{app.data.company || "Entreprise inconnue"}</p>
      <span className="small-muted">
        {app.data.location || "Lieu à préciser"}
      </span>
      <div className="card-bottom">
        <Badge value={app.runner_state} />
        <span className="small-muted">{app.score ?? 0}/100</span>
      </div>
      <select
        aria-label={`Statut ${app.data.title}`}
        disabled={busy}
        value={app.status}
        onChange={(e) =>
          run(`/applications/${app.id}/status`, { status: e.target.value })
        }
      >
        {["to_apply", "applied", "interview", "rejected", "withdrawn"].map(
          (s) => (
            <option key={s} value={s}>
              {labels[s]}
            </option>
          ),
        )}
      </select>
    </article>
  );
}
function Column({
  status,
  apps,
  run,
  select,
  busy,
}: { status: string; apps: any[]; select: (id: string) => void } & Actions) {
  const { setNodeRef, isOver } = useDroppable({ id: status });
  return (
    <section
      ref={setNodeRef}
      className={`kanban-column ${isOver ? "over" : ""}`}
    >
      <h2>
        <span className={`column-dot ${status}`} />
        {labels[status]}
        <span>{apps.length}</span>
      </h2>
      <div className="column-content">
        {apps.map((a) => (
          <ApplicationCard
            key={a.id}
            app={a}
            run={run}
            select={select}
            busy={busy}
          />
        ))}
        {!apps.length && <div className="column-empty">Aucune candidature</div>}
      </div>
    </section>
  );
}
function Applications({
  run,
  select,
  busy,
}: { select: (id: string) => void } & Actions) {
  const apps = useQuery({
    queryKey: ["applications"],
    queryFn: () => api("/applications"),
  });
  const onDrag = (e: DragEndEvent) => {
    if (e.over)
      run(`/applications/${e.active.id}/status`, { status: e.over.id });
  };
  return (
    <>
      <div className="section-heading">
        <h2>Pipeline de candidatures</h2>
        <span className="small-muted">
          {apps.data?.length ?? 0} candidatures
        </span>
      </div>
      {apps.error ? (
        <div className="alert error">{apps.error.message}</div>
      ) : (
        <DndContext onDragEnd={onDrag}>
          <div className="kanban">
            {["to_apply", "applied", "interview", "rejected", "withdrawn"].map(
              (status) => (
                <Column
                  key={status}
                  status={status}
                  apps={
                    apps.data?.filter((a: any) => a.status === status) || []
                  }
                  run={run}
                  select={select}
                  busy={busy}
                />
              ),
            )}
          </div>
        </DndContext>
      )}
      <Reminders run={run} busy={busy} />
    </>
  );
}
function Reminders({ run, busy }: Actions) {
  const overview = useQuery({
    queryKey: ["overview"],
    queryFn: () => api("/overview"),
  });
  const profile = useQuery({
    queryKey: ["profile"],
    queryFn: () => api("/profile"),
  });
  const [draft, setDraft] = useState<string | null>(null),
    [copied, setCopied] = useState(false);
  const reminders = overview.data?.reminders || [];
  if (!reminders.length) return null;
  return (
    <section className="section">
      <h2>Relances</h2>
      {reminders.map((r: any) => (
        <div className="list-row" key={r.id}>
          <div>
            <strong>{r.data.title}</strong>
            <span>
              {r.data.company} · {formatDate(r.due_at)}
            </span>
          </div>
          <button
            className="button"
            onClick={() => {
              setCopied(false);
              setDraft(
                `Bonjour,\n\nJe me permets de revenir vers vous concernant ma candidature au poste de ${r.data.title}. Je reste disponible pour echanger au sujet de cette opportunite.\n\nCordialement,\n${profile.data?.data.name || ""}`,
              );
            }}
          >
            <FileText size={15} />
            Préparer la relance
          </button>
          <IconButton
            title="Terminer le rappel"
            disabled={busy}
            onClick={() => run(`/reminders/${r.id}/dismiss`, {})}
          >
            <Check size={17} />
          </IconButton>
        </div>
      ))}
      {draft !== null && (
        <Modal title="Brouillon de relance" close={() => setDraft(null)}>
          <form onSubmit={(e) => e.preventDefault()}>
            <label>
              Message
              <textarea
                rows={12}
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
              />
            </label>
            <div className="form-actions">
              <button
                type="button"
                className="button primary"
                onClick={() =>
                  void navigator.clipboard
                    .writeText(draft)
                    .then(() => setCopied(true))
                }
              >
                {copied ? <Check size={16} /> : <Copy size={16} />}{" "}
                {copied ? "Copié" : "Copier"}
              </button>
            </div>
          </form>
        </Modal>
      )}
    </section>
  );
}
function Documents({ run, busy }: Actions) {
  const docs = useQuery({
    queryKey: ["documents"],
    queryFn: () => api("/documents"),
  });
  return (
    <>
      <div className="section-heading">
        <h2>Bibliothèque</h2>
        <button
          className="button primary"
          disabled={busy}
          onClick={() =>
            run(
              "/documents",
              { kind: "cv", jobId: null },
              "CV maître en préparation",
            )
          }
        >
          <Plus size={16} />
          CV maître
        </button>
      </div>
      {!docs.data?.length ? (
        <Empty text="Aucun document" />
      ) : (
        <div className="document-grid">
          {docs.data.map((d: any) => (
            <article className="document-card" key={d.id}>
              <div className="document-preview">
                <FileText size={44} />
                <span>
                  {d.kind === "cv"
                    ? "CURRICULUM VITAE"
                    : "LETTRE DE MOTIVATION"}
                </span>
                <strong>{d.content.name}</strong>
                <div className="paper-lines">
                  <i />
                  <i />
                  <i />
                </div>
              </div>
              <div className="document-info">
                <h3>
                  {d.kind === "cv" ? "CV" : "Lettre"} ·{" "}
                  {d.jobId ? "Ciblé" : "Maître"}
                </h3>
                <p>{formatDate(d.createdAt)}</p>
                <Badge value={d.approvedAt ? "confirmed" : "needs_review"} />
                <div className="detail-actions">
                  <a
                    className="button"
                    href={`/api/documents/${d.id}/download`}
                    target="_blank"
                    rel="noreferrer"
                  >
                    <Download size={15} />
                    PDF
                  </a>
                  <button
                    className="button"
                    disabled={busy}
                    onClick={() =>
                      run(`/documents/${d.id}/approve`, {
                        approved: !d.approvedAt,
                      })
                    }
                  >
                    <Check size={15} />
                    {d.approvedAt ? "Retirer l’approbation" : "Approuver"}
                  </button>
                </div>
              </div>
            </article>
          ))}
        </div>
      )}
    </>
  );
}
function Connectors({
  run,
  act,
  busy,
  overview,
}: Actions & {
  act: (p: string, b?: unknown, m?: string) => Promise<any>;
  overview: any;
}) {
  const sources = useQuery({
    queryKey: ["connectors"],
    queryFn: () => api("/connectors"),
  });
  const [editing, setEditing] = useState<any>(null),
    [text, setText] = useState(""),
    [localError, setLocalError] = useState("");
  const template = {
    url: "https://example.com/jobs/feed.xml",
    allowedHosts: ["example.com"],
    authorizationEvidence: "",
  };
  return (
    <>
      <div className="section-heading">
        <h2>Sources et parcours</h2>
        <button
          className="button primary"
          onClick={() => {
            setEditing({
              id: "",
              name: "",
              kind: "rss",
              enabled: false,
              authorized: false,
              auto_submit: false,
              config: template,
            });
            setText(JSON.stringify(template, null, 2));
          }}
        >
          <Plus size={16} />
          Ajouter une source
        </button>
      </div>
      <div className="service-strip">
        {["worker", "runner"].map((s) => {
          const beat = overview?.heartbeats.find((h: any) => h.service === s);
          const live =
            beat && Date.now() - new Date(beat.last_seen_at).getTime() < 180000;
          return (
            <span key={s}>
              <span className={`status-dot ${live ? "" : "offline"}`} />
              {s} · {live ? "actif" : "hors ligne"}
            </span>
          );
        })}
      </div>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>CONNECTEUR</th>
              <th>CAPACITÉS</th>
              <th>DERNIER SUCCÈS</th>
              <th>SANTÉ</th>
              <th>ACTIVATION</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {sources.data?.map((c: any) => (
              <tr key={c.id}>
                <td>
                  <strong>{c.name}</strong>
                  <span className="cell-note">{c.kind}</span>
                </td>
                <td>
                  {c.kind === "import"
                    ? "Import"
                    : c.kind === "form"
                      ? `Préparation${c.auto_submit ? " · Soumission" : ""}`
                      : "Collecte"}
                </td>
                <td>
                  {c.last_success_at ? formatDate(c.last_success_at) : "—"}
                </td>
                <td>
                  {c.last_error ? (
                    <span className="error-text">{c.last_error}</span>
                  ) : (
                    <Badge value={c.enabled ? "confirmed" : "disabled"} />
                  )}
                </td>
                <td>
                  <input
                    type="checkbox"
                    role="switch"
                    aria-label={`Activer ${c.name}`}
                    checked={c.enabled}
                    disabled={busy}
                    onChange={(e) =>
                      run(`/connectors/${c.id}/toggle`, {
                        enabled: e.target.checked,
                      })
                    }
                  />
                </td>
                <td>
                  <div className="row-actions">
                    {!["import", "email"].includes(c.kind) && (
                      <IconButton
                        title={`Configurer ${c.name}`}
                        onClick={() => {
                          setEditing(c);
                          setText(JSON.stringify(c.config, null, 2));
                        }}
                      >
                        <Settings2 size={17} />
                      </IconButton>
                    )}
                    {["email", "rss", "html"].includes(c.kind) && (
                      <IconButton
                        title={`Collecter ${c.name}`}
                        disabled={busy || !c.enabled}
                        onClick={() =>
                          run(
                            `/connectors/${c.id}/collect`,
                            {},
                            "Collecte en file",
                          )
                        }
                      >
                        <RefreshCw size={17} />
                      </IconButton>
                    )}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {editing && (
        <Modal
          title="Configuration du connecteur"
          close={() => setEditing(null)}
        >
          <form
            onSubmit={async (e) => {
              e.preventDefault();
              setLocalError("");
              try {
                await act("/connectors", {
                  id: editing.id,
                  name: editing.name,
                  kind: editing.kind,
                  enabled: editing.enabled,
                  authorized: editing.authorized,
                  auto_submit: editing.auto_submit,
                  config: JSON.parse(text),
                });
                setEditing(null);
              } catch (e) {
                setLocalError((e as Error).message);
              }
            }}
          >
            <div className="form-grid">
              <label>
                Identifiant
                <input
                  required
                  value={editing.id}
                  onChange={(e) =>
                    setEditing({ ...editing, id: e.target.value })
                  }
                />
              </label>
              <label>
                Nom
                <input
                  required
                  value={editing.name}
                  onChange={(e) =>
                    setEditing({ ...editing, name: e.target.value })
                  }
                />
              </label>
            </div>
            <label>
              Type
              <select
                value={editing.kind}
                onChange={(e) => {
                  const kind = e.target.value;
                  setEditing({ ...editing, kind });
                  if (kind === "form")
                    setText(
                      JSON.stringify(
                        {
                          url: "https://example.com/jobs/123",
                          allowedHosts: ["example.com"],
                          authorizationEvidence: "",
                          fields: [
                            { label: "Nom", profileKey: "name" },
                            { label: "Email", profileKey: "email" },
                          ],
                          cvLabel: "CV",
                          submitLabel: "Postuler",
                          confirmationText: "Votre candidature a été reçue",
                        },
                        null,
                        2,
                      ),
                    );
                }}
              >
                <option value="rss">RSS</option>
                <option value="html">HTML / JobPosting</option>
                <option value="form">Formulaire autorisé</option>
              </select>
            </label>
            <label>
              Configuration
              <textarea
                className="code"
                rows={12}
                required
                value={text}
                onChange={(e) => setText(e.target.value)}
              />
            </label>
            <label className="check-label">
              <input
                type="checkbox"
                checked={editing.authorized}
                onChange={(e) =>
                  setEditing({ ...editing, authorized: e.target.checked })
                }
              />
              Autorisation d’utilisation vérifiée
            </label>
            <label className="check-label">
              <input
                type="checkbox"
                checked={editing.enabled}
                onChange={(e) =>
                  setEditing({ ...editing, enabled: e.target.checked })
                }
              />
              Actif
            </label>
            {editing.kind === "form" && (
              <label className="check-label">
                <input
                  type="checkbox"
                  checked={editing.auto_submit}
                  onChange={(e) =>
                    setEditing({ ...editing, auto_submit: e.target.checked })
                  }
                />
                Soumission automatique autorisée
              </label>
            )}
            {localError && (
              <p role="alert" className="error-text">
                {localError}
              </p>
            )}
            <div className="form-actions">
              <button className="button primary" disabled={busy}>
                <Check size={16} />
                Enregistrer
              </button>
            </div>
          </form>
        </Modal>
      )}
    </>
  );
}
function Configuration({
  act,
  busy,
}: {
  act: (p: string, b?: unknown, m?: string) => Promise<any>;
  busy: boolean;
}) {
  const profile = useQuery({
      queryKey: ["profile"],
      queryFn: () => api("/profile"),
    }),
    settings = useQuery({
      queryKey: ["settings"],
      queryFn: () => api("/settings"),
    }),
    notifications = useQuery({
      queryKey: ["notifications"],
      queryFn: () => api("/notifications"),
    });
  const [tab, setTab] = useState("profile"),
    [draft, setDraft] = useState<Profile | null>(null),
    [prefs, setPrefs] = useState<Settings | null>(null);
  useEffect(() => {
    if (profile.data) setDraft(profile.data.data);
  }, [profile.data]);
  useEffect(() => {
    if (settings.data) setPrefs(settings.data.data);
  }, [settings.data]);
  const save = (path: string, body: unknown) =>
    void act(path, body).catch(() => {});
  function field(key: keyof Profile, label: string, array = false) {
    if (!draft) return null;
    return (
      <label>
        {label}
        {array ? (
          <ListInput
            values={draft[key] as string[]}
            onChange={(values) => setDraft({ ...draft, [key]: values })}
          />
        ) : (
          <input
            value={String(draft[key] || "")}
            onChange={(e) => setDraft({ ...draft, [key]: e.target.value })}
          />
        )}
      </label>
    );
  }
  return (
    <>
      <div className="tabs config-tabs">
        {[
          ["profile", "Profil"],
          ["rules", "Critères"],
          ["preferences", "Automatisation"],
          ["notifications", "Notifications"],
        ].map(([id, name]) => (
          <button
            className={tab === id ? "active" : ""}
            key={id}
            onClick={() => setTab(id)}
          >
            {name}
          </button>
        ))}
      </div>
      {draft && ["profile", "rules"].includes(tab) && (
        <form
          className="config-form"
          onSubmit={(e) => {
            e.preventDefault();
            save("/profile", draft);
          }}
        >
          <div className="section-heading">
            <h2>
              {tab === "profile" ? "Profil candidat" : "Critères de recherche"}
            </h2>
            <span className="small-muted">Version {profile.data?.version}</span>
          </div>
          {tab === "profile" ? (
            <>
              <div className="form-grid">
                {field("name", "Nom complet")}
                {field("email", "Email")}
                {field("phone", "Téléphone")}
                {field("headline", "Titre du CV")}
              </div>
              <label>
                Présentation
                <textarea
                  rows={4}
                  value={draft.summary}
                  onChange={(e) =>
                    setDraft({ ...draft, summary: e.target.value })
                  }
                />
              </label>
              {field("skills", "Compétences", true)}
              <div className="section-heading">
                <h3>Expériences, formations et réalisations</h3>
                <IconButton
                  title="Ajouter un fait"
                  onClick={() =>
                    setDraft({
                      ...draft,
                      facts: [
                        ...draft.facts,
                        {
                          id: crypto.randomUUID(),
                          category: "experience",
                          text: "",
                        },
                      ],
                    })
                  }
                >
                  <Plus size={18} />
                </IconButton>
              </div>
              {draft.facts.map((fact, i) => (
                <div className="fact-row" key={fact.id}>
                  <select
                    aria-label="Type de fait"
                    value={fact.category}
                    onChange={(e) =>
                      setDraft({
                        ...draft,
                        facts: draft.facts.map((f, n) =>
                          n === i
                            ? { ...f, category: e.target.value as any }
                            : f,
                        ),
                      })
                    }
                  >
                    <option value="experience">Expérience</option>
                    <option value="education">Formation</option>
                    <option value="achievement">Réalisation</option>
                  </select>
                  <textarea
                    aria-label={`Fait ${i + 1}`}
                    required
                    rows={2}
                    value={fact.text}
                    onChange={(e) =>
                      setDraft({
                        ...draft,
                        facts: draft.facts.map((f, n) =>
                          n === i ? { ...f, text: e.target.value } : f,
                        ),
                      })
                    }
                  />
                  <IconButton
                    title="Supprimer le fait"
                    onClick={() =>
                      setDraft({
                        ...draft,
                        facts: draft.facts.filter((_, n) => n !== i),
                      })
                    }
                  >
                    <Trash2 size={17} />
                  </IconButton>
                </div>
              ))}
              <label>
                Réponses factuelles
                <textarea
                  className="code"
                  rows={5}
                  defaultValue={JSON.stringify(draft.answers, null, 2)}
                  key={profile.data?.version}
                  onBlur={(e) => {
                    try {
                      setDraft({
                        ...draft,
                        answers: JSON.parse(e.target.value),
                      });
                    } catch {
                      e.target.setCustomValidity("JSON invalide");
                    }
                  }}
                  onChange={(e) => e.target.setCustomValidity("")}
                />
              </label>
            </>
          ) : (
            <>
              <div className="form-grid">
                {field("roles", "Métiers ciblés", true)}
                {field("seniority", "Séniorité")}
                {field("locations", "Localisations acceptées", true)}
                <label>
                  Salaire annuel brut minimum (€)
                  <input
                    type="number"
                    min="0"
                    value={draft.minAnnualGross ?? ""}
                    onChange={(e) =>
                      setDraft({
                        ...draft,
                        minAnnualGross: e.target.value
                          ? Number(e.target.value)
                          : null,
                      })
                    }
                  />
                </label>
              </div>
              <fieldset>
                <legend>Contrats acceptés</legend>
                <div className="checkboxes">
                  {["CDI", "CDD", "freelance", "stage", "alternance"].map(
                    (c) => (
                      <label className="check-label" key={c}>
                        <input
                          type="checkbox"
                          checked={draft.contracts.includes(c as any)}
                          onChange={(e) =>
                            setDraft({
                              ...draft,
                              contracts: e.target.checked
                                ? [...draft.contracts, c as any]
                                : draft.contracts.filter((v) => v !== c),
                            })
                          }
                        />
                        {c}
                      </label>
                    ),
                  )}
                </div>
              </fieldset>
              <label className="check-label">
                <input
                  type="checkbox"
                  checked={draft.remoteOnly}
                  onChange={(e) =>
                    setDraft({ ...draft, remoteOnly: e.target.checked })
                  }
                />
                Télétravail intégral requis
              </label>
              {field("requiredKeywords", "Mots-clés requis", true)}
              {field("forbiddenKeywords", "Exigences interdites", true)}
              {field("excludedCompanies", "Entreprises exclues", true)}
            </>
          )}
          <div className="form-actions">
            <label className="check-label">
              <input
                type="checkbox"
                checked={draft.validated}
                onChange={(e) =>
                  setDraft({ ...draft, validated: e.target.checked })
                }
              />
              Profil et critères validés
            </label>
            <button className="button primary" disabled={busy}>
              <Check size={16} />
              Enregistrer
            </button>
          </div>
        </form>
      )}
      {tab === "preferences" && prefs && (
        <form
          className="config-form"
          onSubmit={(e) => {
            e.preventDefault();
            save("/settings", prefs);
          }}
        >
          <h2>Automatisation</h2>
          <div className="form-grid">
            <label>
              Canal de notification
              <select
                value={prefs.notificationChannel}
                onChange={(e) =>
                  setPrefs({
                    ...prefs,
                    notificationChannel: e.target.value as any,
                  })
                }
              >
                {["discord", "telegram", "slack", "none"].map((c) => (
                  <option value={c} key={c}>
                    {c === "none" ? "Aucun" : c}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Score minimum de notification
              <input
                type="number"
                min="0"
                max="100"
                value={prefs.notificationMinScore}
                onChange={(e) =>
                  setPrefs({
                    ...prefs,
                    notificationMinScore: Number(e.target.value),
                  })
                }
              />
            </label>
            <label>
              Plafond journalier
              <input
                type="number"
                min="1"
                max="5"
                value={prefs.dailyLimit}
                onChange={(e) =>
                  setPrefs({ ...prefs, dailyLimit: Number(e.target.value) })
                }
              />
            </label>
            <label>
              Score minimum de soumission
              <input
                type="number"
                min="85"
                max="100"
                value={prefs.autoThreshold}
                onChange={(e) =>
                  setPrefs({ ...prefs, autoThreshold: Number(e.target.value) })
                }
              />
            </label>
            <label>
              Relance après (jours)
              <input
                type="number"
                min="1"
                max="60"
                value={prefs.reminderDays}
                onChange={(e) =>
                  setPrefs({ ...prefs, reminderDays: Number(e.target.value) })
                }
              />
            </label>
            <label>
              Budget IA mensuel (€)
              <input
                type="number"
                min="0"
                max="1000"
                step=".5"
                value={prefs.aiBudget}
                onChange={(e) =>
                  setPrefs({ ...prefs, aiBudget: Number(e.target.value) })
                }
              />
            </label>
          </div>
          <label className="check-label">
            <input
              type="checkbox"
              checked={prefs.aiEnabled}
              onChange={(e) =>
                setPrefs({ ...prefs, aiEnabled: e.target.checked })
              }
            />
            Analyse IA active
          </label>
          <div className="service-strip">
            {Object.entries(settings.data?.configured || {}).map(
              ([name, configured]) => (
                <span key={name}>
                  <span
                    className={`status-dot ${configured ? "" : "offline"}`}
                  />
                  {name} · {configured ? "configuré" : "non configuré"}
                </span>
              ),
            )}
          </div>
          <div className="form-actions">
            <button className="button primary" disabled={busy}>
              <Check size={16} />
              Enregistrer
            </button>
          </div>
        </form>
      )}
      {tab === "notifications" && (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>DATE</th>
                <th>CANAL</th>
                <th>CONTENU</th>
                <th>ÉTAT</th>
              </tr>
            </thead>
            <tbody>
              {notifications.data?.map((n: any) => (
                <tr key={n.id}>
                  <td>{formatDate(n.created_at)}</td>
                  <td>{n.channel}</td>
                  <td className="notification-content">
                    {n.data.text}
                    <span className="cell-note error-text">{n.last_error}</span>
                  </td>
                  <td>
                    <Badge value={n.state} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <QueryClientProvider client={client}>
      <App />
    </QueryClientProvider>
  </React.StrictMode>,
);
