import { z } from "zod";
import { createHash } from "node:crypto";
export const sourceNames = [
  "indeed",
  "linkedin",
  "meteojob",
  "hellowork",
  "wttj",
  "career",
  "manual",
] as const;
export const jobSchema = z.object({
  title: z.string().trim().min(1).max(300),
  company: z.string().trim().max(300).default(""),
  location: z.string().max(300).default(""),
  url: z.url().refine((u) => ["http:", "https:"].includes(new URL(u).protocol)),
  source: z.enum(sourceNames).default("manual"),
  externalId: z.string().max(500).optional(),
  employerReference: z.string().max(300).optional(),
  description: z.string().max(60000).default(""),
  requiredText: z.string().max(20000).default(""),
  skills: z.array(z.string().max(100)).max(100).default([]),
  contract: z
    .enum(["CDI", "CDD", "freelance", "stage", "alternance", "unknown"])
    .default("unknown"),
  remote: z.enum(["onsite", "hybrid", "remote", "unknown"]).default("unknown"),
  seniority: z.string().max(100).default(""),
  salary: z
    .object({
      min: z.number().nonnegative().optional(),
      max: z.number().nonnegative().optional(),
      currency: z.string().max(10).default("EUR"),
      period: z.enum(["year", "month", "day", "hour", "unknown"]),
      basis: z.enum(["gross", "net", "unknown"]).default("unknown"),
    })
    .nullable()
    .default(null),
  publishedAt: z.iso.datetime().nullable().default(null),
});
export type JobInput = z.infer<typeof jobSchema>;
export const profileSchema = z
  .object({
    name: z.string().max(200).default(""),
    email: z.union([z.email(), z.literal("")]).default(""),
    phone: z.string().max(50).default(""),
    headline: z.string().max(300).default(""),
    summary: z.string().max(5000).default(""),
    skills: z.array(z.string().max(100)).max(100).default([]),
    roles: z.array(z.string().max(200)).max(30).default([]),
    locations: z.array(z.string().max(200)).max(30).default([]),
    seniority: z.string().max(100).default(""),
    contracts: z
      .array(z.enum(["CDI", "CDD", "freelance", "stage", "alternance"]))
      .default([]),
    remoteOnly: z.boolean().default(false),
    minAnnualGross: z.number().nonnegative().nullable().default(null),
    requiredKeywords: z.array(z.string().min(1).max(100)).max(100).default([]),
    forbiddenKeywords: z.array(z.string().min(1).max(100)).max(100).default([]),
    excludedCompanies: z.array(z.string().min(1).max(200)).max(100).default([]),
    facts: z
      .array(
        z.object({
          id: z.string().min(1).max(100),
          category: z.enum(["experience", "education", "achievement"]),
          text: z.string().min(1).max(3000),
        }),
      )
      .max(100)
      .default([]),
    answers: z.record(z.string(), z.string().max(3000)).default({}),
    validated: z.boolean().default(false),
  })
  .refine(
    (p) =>
      !p.validated ||
      Boolean(p.name && p.email && p.roles.length && p.skills.length),
    { message: "Un profil valide exige nom, email, metiers et competences." },
  )
  .refine((p) => new Set(p.facts.map((f) => f.id)).size === p.facts.length, {
    message: "Chaque fait doit posseder un identifiant unique.",
  });
export type Profile = z.infer<typeof profileSchema>;
export const settingsSchema = z.object({
  paused: z.boolean().default(false),
  aiEnabled: z.boolean().default(false),
  aiBudget: z.number().min(0).max(1000).default(10),
  notificationChannel: z
    .enum(["discord", "telegram", "slack", "none"])
    .default("discord"),
  notificationMinScore: z.number().min(0).max(100).default(60),
  dailyLimit: z.number().int().min(1).max(5).default(5),
  autoThreshold: z.number().min(85).max(100).default(85),
  reminderDays: z.number().int().min(1).max(60).default(7),
});
export type Settings = z.infer<typeof settingsSchema>;
export const hash = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
export const folded = (s: string) =>
  s
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
export const hasTerm = (text: string, term: string) => {
  const escaped = folded(term).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?:^|[^a-z0-9])${escaped}(?=$|[^a-z0-9])`, "i").test(
    folded(text),
  );
};
export { canonicalUrl } from "./urls.js";
export function sourceFromUrl(value: string): JobInput["source"] {
  const host = new URL(value).hostname;
  for (const [source, domains] of Object.entries({
    indeed: ["indeed.com", "indeed.fr"],
    linkedin: ["linkedin.com"],
    meteojob: ["meteojob.com"],
    hellowork: ["hellowork.com"],
    wttj: ["welcometothejungle.com"],
  }))
    if (domains.some((d) => host === d || host.endsWith(`.${d}`)))
      return source as JobInput["source"];
  return "career";
}
