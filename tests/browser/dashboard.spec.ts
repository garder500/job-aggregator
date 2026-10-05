import { test, expect } from "@playwright/test";
test("dashboard prive, vues et mobile sans debordement", async ({ page }) => {
  await page.goto("/");
  await page
    .getByLabel("Mot de passe", { exact: true })
    .fill(process.env.APP_PASSWORD || "local-development-only");
  await page.getByRole("button", { name: "Se connecter" }).click();
  await expect(
    page.getByRole("heading", { name: "Offres", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("Aucune offre pour le moment", { exact: true }),
  ).toBeVisible();
  await page.screenshot({
    path: "test-results/dashboard-desktop.png",
    fullPage: true,
    animations: "disabled",
  });
  for (const name of [
    "Candidatures",
    "Documents",
    "À valider",
    "Connecteurs",
    "Configuration",
  ]) {
    await page
      .getByRole("navigation")
      .getByRole("button", { name, exact: true })
      .click();
    await expect(
      page.getByRole("heading", { name, exact: true }).first(),
    ).toBeVisible();
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("button", { name: "Navigation", exact: true }).click();
  await page
    .getByRole("navigation")
    .getByRole("button", { name: "Offres", exact: true })
    .click();
  await page.screenshot({
    path: "test-results/dashboard-mobile.png",
    fullPage: true,
    animations: "disabled",
  });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  await page.getByRole("button", { name: "Importer des offres" }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.getByRole("button", { name: "Fermer", exact: true }).click();
  await page.getByRole("button", { name: "Navigation", exact: true }).click();
  await page.getByRole("button", { name: "Déconnexion", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Se connecter" }),
  ).toBeVisible();
});
