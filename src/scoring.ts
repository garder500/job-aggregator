import { folded, hasTerm, type JobInput, type Profile } from "./domain.js";
export function scoreJob(job: JobInput, profile: Profile) {
  const reasons: string[] = [],
    unknowns: string[] = [];
  const details: {
    name: string;
    points: number;
    maximum: number;
    evidence: string[];
  }[] = [];
  const text = `${job.title}\n${job.description}\n${job.skills.join(" ")}`;
  for (const term of profile.requiredKeywords)
    if (!hasTerm(text, term)) reasons.push(`Mot-cle requis absent : ${term}`);
  for (const term of profile.forbiddenKeywords)
    if (hasTerm(`${job.title}\n${job.requiredText}`, term))
      reasons.push(`Exigence exclue : ${term}`);
  if (profile.excludedCompanies.some((c) => folded(c) === folded(job.company)))
    reasons.push("Entreprise exclue");
  if (
    profile.contracts.length &&
    job.contract !== "unknown" &&
    !profile.contracts.includes(job.contract)
  )
    reasons.push("Contrat exclu");
  if (job.contract === "unknown") unknowns.push("Contrat");
  if (!job.company) unknowns.push("Entreprise");
  if (profile.remoteOnly && ["onsite", "hybrid"].includes(job.remote))
    reasons.push("Teletravail integral requis");
  if (job.remote === "unknown") unknowns.push("Teletravail");
  const locationMatch = profile.locations.some((l) => hasTerm(job.location, l));
  if (
    profile.locations.length &&
    job.location &&
    job.remote !== "remote" &&
    job.remote !== "unknown" &&
    !locationMatch
  )
    reasons.push("Localisation exclue");
  if (!job.location && job.remote !== "remote") unknowns.push("Localisation");
  const salaryKnown =
    job.salary?.currency === "EUR" &&
    job.salary.period === "year" &&
    job.salary.basis === "gross" &&
    (job.salary.max ?? job.salary.min) !== undefined;
  if (!salaryKnown) unknowns.push("Salaire annuel brut");
  if (
    salaryKnown &&
    profile.minAnnualGross !== null &&
    (job.salary!.max ?? job.salary!.min!) < profile.minAnnualGross
  )
    reasons.push("Salaire sous le minimum");
  const matches = profile.skills.filter((s) => hasTerm(text, s));
  details.push({
    name: "Competences",
    points: profile.skills.length
      ? Math.round((40 * matches.length) / profile.skills.length)
      : 0,
    maximum: 40,
    evidence: matches,
  });
  const roles = profile.roles.filter((r) => hasTerm(job.title, r));
  details.push({
    name: "Metier",
    points: roles.length ? 25 : 0,
    maximum: 25,
    evidence: roles,
  });
  if (!job.seniority) unknowns.push("Seniorite");
  details.push({
    name: "Seniorite",
    points:
      job.seniority &&
      profile.seniority &&
      hasTerm(job.seniority, profile.seniority)
        ? 15
        : 0,
    maximum: 15,
    evidence: job.seniority ? [job.seniority] : [],
  });
  details.push({
    name: "Localisation",
    points: job.remote === "remote" || locationMatch ? 10 : 0,
    maximum: 10,
    evidence: [job.location, job.remote].filter(Boolean),
  });
  details.push({
    name: "Remuneration",
    points:
      salaryKnown &&
      (profile.minAnnualGross === null ||
        (job.salary!.max ?? job.salary!.min!) >= profile.minAnnualGross)
        ? 10
        : 0,
    maximum: 10,
    evidence: salaryKnown ? [JSON.stringify(job.salary)] : [],
  });
  if (!profile.validated) unknowns.push("Profil non valide");
  return {
    score: details.reduce((sum, d) => sum + d.points, 0),
    rejected: reasons.length > 0,
    reasons,
    unknowns,
    details,
  };
}
