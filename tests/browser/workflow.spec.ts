import { test, expect } from "@playwright/test";
test("profil, import rejoue, suivi et CV approuve", async ({ page }) => {
  await page.goto("/");
  await page
    .getByLabel("Mot de passe", { exact: true })
    .fill("local-development-only");
  await page.getByRole("button", { name: "Se connecter" }).click();
  await page
    .getByRole("navigation")
    .getByRole("button", { name: "Configuration", exact: true })
    .click();
  await page.getByLabel("Nom complet", { exact: true }).fill("Camille Test");
  await page.getByLabel("Email", { exact: true }).fill("camille@example.test");
  await page
    .getByLabel("Titre du CV", { exact: true })
    .fill("Développeur TypeScript");
  await page
    .getByLabel("Compétences", { exact: true })
    .fill("TypeScript, React");
  await page
    .getByLabel("Présentation", { exact: true })
    .fill("Développement logiciel et automatisation.");
  await page.getByRole("button", { name: "Critères", exact: true }).click();
  await page.getByLabel("Métiers ciblés", { exact: true }).fill("Développeur");
  await page
    .getByLabel("Localisations acceptées", { exact: true })
    .fill("Paris");
  await page.getByLabel("Séniorité", { exact: true }).fill("senior");
  await page.getByLabel("Profil et critères validés", { exact: true }).check();
  await page.getByRole("button", { name: "Enregistrer", exact: true }).click();
  await expect(page.getByRole("status")).toContainText(
    "Modifications enregistrées",
  );
  const job = {
    title: "Développeur TypeScript",
    company: "Atelier Test",
    location: "Paris",
    url: "https://example.com/jobs/e2e",
    description: "TypeScript React. Poste senior en CDI.",
    contract: "CDI",
    remote: "hybrid",
    seniority: "senior",
    salary: { min: 55000, max: 65000, period: "year", basis: "gross" },
  };
  await page
    .getByRole("navigation")
    .getByRole("button", { name: "Offres", exact: true })
    .click();
  for (let i = 0; i < 2; i++) {
    await page.getByRole("button", { name: "Importer des offres" }).click();
    await page
      .getByLabel("Contenu", { exact: true })
      .fill(JSON.stringify([job]));
    await page.getByRole("button", { name: "Importer", exact: true }).click();
    await expect(page.getByRole("dialog")).not.toBeVisible();
  }
  await expect(
    page.getByRole("button", { name: "Développeur TypeScript", exact: true }),
  ).toHaveCount(1);
  await page
    .getByRole("button", { name: "Développeur TypeScript", exact: true })
    .click();
  await page.getByRole("button", { name: "Ajouter au suivi" }).click();
  await expect(
    page.getByRole("button", { name: "Candidature suivie" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "CV", exact: true }).click();
  await page.getByRole("button", { name: "Fermer", exact: true }).click();
  await page
    .getByRole("navigation")
    .getByRole("button", { name: "Documents", exact: true })
    .click();
  await expect(page.getByRole("heading", { name: "CV · Ciblé" })).toBeVisible({
    timeout: 20000,
  });
  const pdf = await page.request.get(
    (await page
      .getByRole("link", { name: "PDF", exact: true })
      .getAttribute("href")) || "",
  );
  expect(pdf.ok()).toBe(true);
  expect((await pdf.body()).subarray(0, 4).toString()).toBe("%PDF");
  await page.getByRole("button", { name: "Approuver", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Retirer l’approbation" }),
  ).toBeVisible();
  await page
    .getByRole("navigation")
    .getByRole("button", { name: "À valider", exact: true })
    .click();
  await page
    .getByLabel("Sélectionner Développeur TypeScript", { exact: true })
    .check();
  await expect(
    page.getByRole("button", { name: "Soumettre la sélection" }),
  ).toBeEnabled();
  await page.getByRole("button", { name: "Soumettre la sélection" }).click();
  await expect(
    page.getByRole("dialog", { name: "Confirmer la soumission" }),
  ).toContainText("Connecteur non autorise");
  await expect(
    page.getByRole("button", { name: "Confirmer l’envoi" }),
  ).toBeDisabled();
  await page.getByRole("button", { name: "Annuler", exact: true }).click();
  await page
    .getByRole("button", { name: "Générer les CV", exact: true })
    .click();
  await expect(page.getByText("cv · 1/1", { exact: true })).toBeVisible({
    timeout: 20000,
  });
  await page.screenshot({
    path: "test-results/review-desktop.png",
    fullPage: true,
    animations: "disabled",
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect
    .poll(() => page.evaluate(() => document.documentElement.scrollWidth))
    .toBe(390);
  await page.screenshot({
    path: "test-results/review-mobile.png",
    fullPage: true,
    animations: "disabled",
  });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page
    .getByRole("navigation")
    .getByRole("button", { name: "Candidatures", exact: true })
    .click();
  await page
    .getByLabel("Statut Développeur TypeScript")
    .selectOption("applied");
  await expect(page.getByLabel("Statut Développeur TypeScript")).toHaveValue(
    "applied",
  );
  await page
    .getByRole("navigation")
    .getByRole("button", { name: "Offres", exact: true })
    .click();
  await expect(page.locator("tbody tr")).toHaveCount(1);
  await page.screenshot({
    path: "test-results/dashboard-populated.png",
    fullPage: true,
    animations: "disabled",
  });
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.setViewportSize({ width: 390, height: 844 });
  await expect
    .poll(() => page.evaluate(() => document.documentElement.scrollWidth))
    .toBe(390);
  await page.screenshot({
    path: "test-results/dashboard-populated-mobile.png",
    fullPage: true,
    animations: "disabled",
  });
  expect(errors).toEqual([]);
});
