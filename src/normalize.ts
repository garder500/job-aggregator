import * as cheerio from "cheerio";
import { simpleParser } from "mailparser";
import { jobSchema, sourceFromUrl, hasTerm, type JobInput } from "./domain.js";
const knownSkills = [
  "TypeScript",
  "JavaScript",
  "Python",
  "Go",
  "Java",
  "React",
  "Vue",
  "Angular",
  "Node.js",
  "PostgreSQL",
  "Docker",
  "Kubernetes",
  "Terraform",
  "AWS",
  "Azure",
  "Linux",
  "SQL",
  "FastAPI",
];
export const textOf = (html: string) => {
  const $ = cheerio.load(html);
  $("script,style").remove();
  $("br").replaceWith("\n");
  $("p,li,h2,h3").append("\n");
  return $.root()
    .text()
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s*\n/g, "\n")
    .trim();
};
export function inferFields(description: string): Partial<JobInput> {
  const lines = description.split("\n");
  let required = false;
  const requirements: string[] = [];
  for (const line of lines) {
    if (
      /^(profil recherch|requirements|qualifications|competences requises|compétences requises)/i.test(
        line.trim(),
      )
    )
      required = true;
    if (
      /(nice to have|atout|facultatif|optional|nous offrons|avantages|benefits)/i.test(
        line,
      )
    )
      required = false;
    if (required) requirements.push(line);
  }
  const contracts = ["CDI", "CDD", "freelance", "stage", "alternance"] as const;
  return {
    skills: knownSkills.filter((s) => hasTerm(description, s)),
    contract: contracts.find((c) => hasTerm(description, c)) || "unknown",
    requiredText: requirements.join("\n"),
    remote: /(?:100\s*%|full)[ -]*(?:remote|télétravail)/i.test(description)
      ? "remote"
      : /hybrid|hybride/i.test(description)
        ? "hybrid"
        : "unknown",
  };
}
export function normalizeJob(input: unknown): JobInput {
  const value = jobSchema.parse(input);
  const inferred = inferFields(value.description);
  return {
    ...value,
    skills: value.skills.length ? value.skills : inferred.skills!,
    contract:
      value.contract === "unknown" ? inferred.contract! : value.contract,
    remote: value.remote === "unknown" ? inferred.remote! : value.remote,
    requiredText: value.requiredText || inferred.requiredText!,
  };
}
export function parseJobPosting(html: string, url: string): JobInput[] {
  const $ = cheerio.load(html);
  const entries: any[] = [];
  function visit(v: any) {
    if (!v || typeof v !== "object") return;
    if (Array.isArray(v)) return v.forEach(visit);
    if ([v["@type"]].flat().includes("JobPosting")) entries.push(v);
    if (v["@graph"]) visit(v["@graph"]);
  }
  $('script[type="application/ld+json"]').each((_, el) => {
    try {
      visit(JSON.parse($(el).text()));
    } catch {
      /* A malformed unrelated JSON-LD block must not discard other blocks. */
    }
  });
  return entries.map((v) => {
    const loc = [v.jobLocation]
      .flat()
      .filter(Boolean)
      .map((l: any) =>
        [
          l.address?.addressLocality,
          l.address?.addressRegion,
          l.address?.addressCountry,
        ]
          .filter(Boolean)
          .join(", "),
      )
      .join(" / ");
    const amount = v.baseSalary?.value;
    const unit = String(amount?.unitText || "").toLowerCase();
    const period =
      ({ year: "year", month: "month", day: "day", hour: "hour" } as const)[
        unit as "year"
      ] || "unknown";
    const posted = v.datePosted && new Date(v.datePosted);
    return normalizeJob({
      title: v.title,
      company: v.hiringOrganization?.name || "",
      location: loc,
      url: v.url ? new URL(v.url, url).toString() : url,
      source: sourceFromUrl(url),
      description: textOf(v.description || ""),
      employerReference:
        typeof v.identifier === "object"
          ? String(v.identifier.value || "")
          : undefined,
      remote: v.jobLocationType === "TELECOMMUTE" ? "remote" : "unknown",
      publishedAt:
        posted && Number.isFinite(posted.getTime())
          ? posted.toISOString()
          : null,
      salary: amount
        ? {
            min:
              typeof amount.value === "number" ? amount.value : amount.minValue,
            max: amount.maxValue,
            currency: v.baseSalary.currency || "EUR",
            period,
            basis: "unknown",
          }
        : null,
    });
  });
}
export async function parseEmail(raw: string | Buffer): Promise<JobInput[]> {
  const mail = await simpleParser(raw);
  const html = typeof mail.html === "string" ? mail.html : "";
  const $ = cheerio.load(html);
  const jobs: JobInput[] = [];
  $("a[href]").each((_, anchor) => {
    const href = $(anchor).attr("href")!;
    if (!/^https?:\/\//i.test(href)) return;
    const source = sourceFromUrl(href);
    const title = $(anchor).text().replace(/\s+/g, " ").trim();
    if (
      source === "career" ||
      title.length < 5 ||
      /unsubscribe|désabonn|se désinscrire|confidentialit|voir toutes|view all|connexion|logo/i.test(
        title,
      )
    )
      return;
    const path = new URL(href).pathname;
    if (
      !/job|emploi|offre|viewjob|rc\/clk|vacanc/i.test(path) &&
      !/[?&](jk|vjk)=/.test(href)
    )
      return;
    const context = $(anchor)
      .closest("tr,article,li")
      .text()
      .replace(/\s+/g, " ")
      .trim();
    jobs.push(
      normalizeJob({ title, url: href, source, description: context || title }),
    );
  });
  if (!jobs.length && mail.text)
    for (const url of mail.text.match(/https?:\/\/[^\s<>]+/g) || []) {
      if (sourceFromUrl(url) !== "career" && /job|emploi|offre|jk=/i.test(url))
        jobs.push(
          normalizeJob({
            title: mail.subject || "Offre importee",
            url,
            source: sourceFromUrl(url),
            description: mail.text.slice(0, 60000),
          }),
        );
    }
  return jobs;
}
