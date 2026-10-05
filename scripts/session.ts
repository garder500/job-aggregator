import { chromium } from "playwright";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { config } from "../src/config.js";
import { query, pool } from "../src/db.js";
import { formSchema } from "../src/runner.js";
const id = process.argv[2];
const [connector] = await query(
  "SELECT * FROM connectors WHERE id=$1 AND kind='form' AND authorized",
  [id],
);
if (!connector) throw new Error("Connecteur autorise introuvable");
const form = formSchema.parse(connector.config);
await mkdir(join(config.sessionsDir, id), { recursive: true, mode: 0o700 });
const context = await chromium.launchPersistentContext(
  join(config.sessionsDir, id),
  { headless: false },
);
const page = await context.newPage();
await page.goto(form.url);
console.log(
  "Fermez le navigateur apres authentification. Le profil dedie reste prive.",
);
await new Promise<void>((done) => context.on("close", () => done()));
await pool.end();
