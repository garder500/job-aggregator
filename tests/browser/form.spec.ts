import { test, expect } from "@playwright/test";
import { prepareForm, ReviewError } from "../../src/runner.js";
import { createServer } from "node:http";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
let server: ReturnType<typeof createServer>;
let port: number;
let submits = 0;
test.beforeAll(async () => {
  server = createServer((req, res) => {
    res.setHeader("Content-Type", "text/html");
    if (req.url === "/submit") {
      submits++;
      res.end("<h1>Candidature confirmee</h1>");
      return;
    }
    const extra =
      req.url === "/unknown"
        ? '<label>Question inconnue<input name="extra" required></label>'
        : req.url === "/changed"
          ? '<label>Nouveau nom<input name="name"></label>'
          : '<label>Nom complet<input name="name" required></label>';
    res.end(
      `<form method="post" action="/submit">${extra}<label>Email<input type="email" name="email" required></label><label>CV<input type="file" name="cv" required></label><button>Postuler</button></form>`,
    );
  });
  await new Promise<void>((done) =>
    server.listen(0, "127.0.0.1", () => {
      port = (server.address() as any).port;
      done();
    }),
  );
  await mkdir(resolve(".local/fixtures"), { recursive: true });
  await writeFile(resolve(".local/fixtures/cv.pdf"), "%PDF-1.4\n test fixture");
});
test.afterAll(async () => {
  await new Promise<void>((done) => server.close(() => done()));
});
const form = (path = "/") => ({
  url: `http://127.0.0.1:${port}${path}`,
  allowedHosts: ["127.0.0.1"],
  authorizationEvidence: "Local owned test fixture",
  fields: [
    { label: "Nom complet", profileKey: "name" },
    { label: "Email", profileKey: "email" },
  ],
  cvLabel: "CV",
  submitLabel: "Postuler",
  confirmationText: "Candidature confirmee",
});
const profile = {
  name: "Camille Test",
  email: "test@example.test",
  answers: {},
};
const docs = () => [
  { id: "fixture", kind: "cv", path: resolve(".local/fixtures/cv.pdf") },
];
test("preparation remplit les champs et upload sans soumission", async ({
  page,
}) => {
  const before = submits;
  await prepareForm(page, form(), profile, docs(), true);
  await expect(page.getByLabel("Nom complet")).toHaveValue("Camille Test");
  expect(
    await page
      .getByLabel("CV")
      .evaluate((el) => (el as HTMLInputElement).files?.length),
  ).toBe(1);
  expect(submits).toBe(before);
});
test("question inconnue bloque avant soumission", async ({ page }) => {
  await expect(
    prepareForm(page, form("/unknown"), profile, docs(), true),
  ).rejects.toBeInstanceOf(ReviewError);
});
test("DOM modifie exige une revue", async ({ page }) => {
  await expect(
    prepareForm(page, form("/changed"), profile, docs(), true),
  ).rejects.toThrow(/absent/);
});
test("confirmation identifiable apres soumission locale", async ({ page }) => {
  const button = await prepareForm(
    page,
    form(),
    profile,
    docs(),
    true,
    () => true,
  );
  await button.click();
  await expect(
    page.getByText("Candidature confirmee", { exact: true }),
  ).toBeVisible();
});
