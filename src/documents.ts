import React from "react";
import {
  Document,
  Page,
  Text,
  View,
  StyleSheet,
  renderToFile,
  Font,
} from "@react-pdf/renderer";
import { mkdir, rename, unlink } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { config } from "./config.js";
import { query, event } from "./db.js";
import { currentProfile } from "./store.js";
import { callAI } from "./ai.js";
import { hash } from "./domain.js";
import { fetchPublic } from "./network.js";
Font.register({
  family: "Inter",
  fonts: [
    {
      src: resolve(
        "node_modules/@fontsource/inter/files/inter-latin-400-normal.woff",
      ),
      fontWeight: 400,
    },
    {
      src: resolve(
        "node_modules/@fontsource/inter/files/inter-latin-600-normal.woff",
      ),
      fontWeight: 600,
    },
  ],
});
const style = StyleSheet.create({
  page: {
    padding: 42,
    fontFamily: "Inter",
    fontSize: 10,
    lineHeight: 1.55,
  },
  name: { fontSize: 24, fontWeight: 600, color: "#163d32", marginBottom: 5 },
  headline: { fontSize: 13, marginBottom: 12 },
  section: { fontSize: 12, marginTop: 18, marginBottom: 7, color: "#163d32" },
  body: { marginBottom: 7 },
  contact: { fontSize: 9, color: "#555555" },
});
export async function generateDocument(
  jobId: string | null,
  kind: "cv" | "letter",
  request: typeof fetchPublic = fetchPublic,
) {
  const profile = await currentProfile();
  if (!profile.data.name || !profile.data.email)
    throw new Error("Nom et email requis dans le profil");
  const [job] = jobId
    ? await query("SELECT * FROM jobs WHERE id=$1", [jobId])
    : [];
  if (jobId && !job) throw new Error("Offre introuvable");
  if (kind === "letter" && !job) throw new Error("Une lettre exige une offre");
  if (kind === "letter") {
    const [cached] = await query(
      "SELECT * FROM documents WHERE job_id=$1 AND profile_id=$2 AND kind='letter' AND content->>'jobHash'=$3 ORDER BY created_at DESC LIMIT 1",
      [jobId, profile.id, hash(job.data)],
    );
    if (cached && existsSync(cached.path)) return cached.id;
  }
  let content: any = {
    jobHash: job ? hash(job.data) : null,
    name: profile.data.name,
    email: profile.data.email,
    phone: profile.data.phone,
    headline: profile.data.headline || profile.data.roles[0] || "",
    summary: profile.data.summary,
    skills: profile.data.skills,
    facts: profile.data.facts,
  };
  if (kind === "letter") {
    const result = z
      .object({
        factIds: z.array(z.string()).max(8),
      })
      .parse(
        await callAI(
          hash(["letter", job.data, profile.id]),
          "Selectionne les faits du profil pertinents pour l'offre. Retourne uniquement leurs identifiants existants. JSON {factIds:string[]}.",
          {
            offer: job.data,
            profile: {
              headline: profile.data.headline,
              facts: profile.data.facts,
            },
          },
          request,
        ),
      );
    const facts = result.factIds.map((id) => {
      const fact = profile.data.facts.find((f) => f.id === id);
      if (!fact) throw new Error("Fait invente par IA");
      return fact;
    });
    content = {
      ...content,
      opening: `Madame, Monsieur,\nJe vous propose ma candidature au poste de ${job.data.title}${job.data.company ? ` au sein de ${job.data.company}` : ""}. Les elements suivants de mon parcours sont pertinents pour cette opportunite.`,
      closing:
        "Je serais heureux de pouvoir echanger avec vous au sujet de ce poste. Je vous remercie pour votre attention et vous adresse mes salutations distinguees.",
      facts,
    };
  }
  const id = randomUUID();
  await mkdir(config.dataDir, { recursive: true, mode: 0o700 });
  const path = join(config.dataDir, `${id}.pdf`),
    tmp = `${path}.tmp`;
  const e = React.createElement;
  const children =
    kind === "cv"
      ? [
          e(Text, { style: style.headline, key: "h" }, content.headline),
          e(Text, { style: style.body, key: "s" }, content.summary),
          e(Text, { style: style.section, key: "sk" }, "Competences"),
          e(Text, { key: "skills" }, content.skills.join(" · ")),
          ...["experience", "education", "achievement"]
            .filter((category) =>
              content.facts.some((f: any) => f.category === category),
            )
            .flatMap((category) => [
              e(
                Text,
                { style: style.section, key: category },
                (
                  {
                    experience: "Experience",
                    education: "Formation",
                    achievement: "Realisations",
                  } as any
                )[category],
              ),
              ...content.facts
                .filter((f: any) => f.category === category)
                .map((f: any) =>
                  e(Text, { style: style.body, key: f.id }, f.text),
                ),
            ]),
        ]
      : [
          e(
            Text,
            { style: style.section, key: "subject" },
            `${job.data.title} — ${job.data.company}`,
          ),
          e(Text, { style: style.body, key: "open" }, content.opening),
          ...content.facts.map((f: any) =>
            e(Text, { style: style.body, key: f.id }, f.text),
          ),
          e(Text, { style: style.body, key: "close" }, content.closing),
        ];
  try {
    await renderToFile(
      e(
        Document,
        {},
        e(
          Page,
          { size: "A4", style: style.page },
          e(
            View,
            {},
            e(Text, { style: style.name }, content.name),
            e(
              Text,
              { style: style.contact },
              `${content.email} | ${content.phone}`,
            ),
          ),
          ...children,
        ),
      ),
      tmp,
    );
    await rename(tmp, path);
    await query(
      "INSERT INTO documents(id,job_id,profile_id,kind,content,path) VALUES($1,$2,$3,$4,$5,$6)",
      [id, jobId, profile.id, kind, JSON.stringify(content), path],
    );
    await event("document.generated", id, { kind, jobId });
    return id;
  } catch (e) {
    await unlink(tmp).catch(() => {});
    await unlink(path).catch(() => {});
    throw e;
  }
}
