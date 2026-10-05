import { describe, it, expect } from "vitest";
import {
  jobSchema,
  profileSchema,
  canonicalUrl,
  hasTerm,
  sourceFromUrl,
} from "../../src/domain.js";
import { scoreJob } from "../../src/scoring.js";
import {
  normalizeJob,
  parseEmail,
  parseJobPosting,
} from "../../src/normalize.js";
import { readFile } from "node:fs/promises";
const profile = profileSchema.parse({
  name: "Camille Test",
  email: "camille@example.test",
  skills: ["TypeScript", "React"],
  roles: ["Developpeur"],
  locations: ["Paris"],
  seniority: "senior",
  validated: true,
  minAnnualGross: 50000,
});
const complete = jobSchema.parse({
  title: "Developpeur TypeScript",
  company: "Exemple",
  url: "https://example.com/jobs/1",
  description: "TypeScript React",
  location: "Paris",
  remote: "hybrid",
  contract: "CDI",
  seniority: "senior",
  salary: { min: 55000, max: 65000, period: "year", basis: "gross" },
});
describe("normalisation", () => {
  it("conserve les identifiants et retire seulement le tracking", () => {
    expect(
      canonicalUrl("https://www.indeed.fr/rc/clk?jk=abc&utm_source=x#x"),
    ).toBe("https://www.indeed.fr/viewjob?jk=abc");
    expect(canonicalUrl("https://example.com/job?id=12&utm_medium=email")).toBe(
      "https://example.com/job?id=12",
    );
  });
  it("ne confond pas Java et JavaScript, ni Go et Google", () => {
    expect(hasTerm("JavaScript Google", "Java")).toBe(false);
    expect(hasTerm("JavaScript Google", "Go")).toBe(false);
    expect(hasTerm("Node.js et C++", "Node.js")).toBe(true);
  });
  it("ne declare pas un domaine ressemblant comme une plateforme", () => {
    expect(sourceFromUrl("https://evil-linkedin.com/job")).toBe("career");
  });
  it("garde le salaire net et mensuel sans conversion", () => {
    const job = normalizeJob({
      ...complete,
      salary: { min: 4000, period: "month", basis: "net" },
    });
    expect(job.salary?.period).toBe("month");
    expect(job.salary?.basis).toBe("net");
  });
  it("lit un graphe JSON-LD et preserve les donnees inconnues", () => {
    const parsed = parseJobPosting(
      '<script type="application/ld+json">{"@graph":[{"@type":"JobPosting","title":"Dev","hiringOrganization":{"name":"Exemple"},"description":"<p>TypeScript</p>"}]}</script>',
      "https://example.com/jobs/1",
    );
    expect(parsed[0].skills).toContain("TypeScript");
    expect(parsed[0].salary).toBeNull();
  });
  for (const source of ["indeed", "linkedin", "meteojob", "hellowork", "wttj"])
    it(`importe la fixture email ${source}`, async () => {
      const jobs = await parseEmail(
        await readFile(`tests/fixtures/${source}.eml`),
      );
      expect(jobs).toHaveLength(1);
      expect(jobs[0].source).toBe(source);
      expect(jobs[0].company).toBe("");
    });
});
describe("matching", () => {
  it("attribue 100 a un profil totalement concordant", () => {
    const result = scoreJob(complete, profile);
    expect(result.score).toBe(100);
    expect(result.unknowns).toEqual([]);
  });
  it("rejette les exigences interdites mais pas les mentions facultatives", () => {
    const p = { ...profile, forbiddenKeywords: ["Java"] };
    expect(
      scoreJob(
        {
          ...complete,
          description: "Java serait un atout",
          requiredText: "TypeScript",
        },
        p,
      ).rejected,
    ).toBe(false);
    expect(
      scoreJob({ ...complete, requiredText: "Java obligatoire" }, p).rejected,
    ).toBe(true);
  });
  it("signale le salaire inconnu sans fabriquer un rejet", () => {
    const result = scoreJob({ ...complete, salary: null }, profile);
    expect(result.rejected).toBe(false);
    expect(result.unknowns).toContain("Salaire annuel brut");
  });
  it("refuse un salaire connu sous le minimum", () => {
    expect(
      scoreJob(
        {
          ...complete,
          salary: {
            min: 40000,
            max: 45000,
            currency: "EUR",
            period: "year",
            basis: "gross",
          },
        },
        profile,
      ).rejected,
    ).toBe(true);
  });
  it("refuse les profils valides sans identite", () => {
    expect(() => profileSchema.parse({ validated: true })).toThrow();
  });
  it("refuse deux faits portant le meme identifiant", () => {
    expect(() =>
      profileSchema.parse({
        ...profile,
        facts: [
          { id: "same", category: "experience", text: "A" },
          { id: "same", category: "education", text: "B" },
        ],
      }),
    ).toThrow(/unique/);
  });
});
