import { mkdir, readdir, stat, unlink } from "node:fs/promises";
import { join } from "node:path";
import type { Page } from "playwright";
import { config } from "./config.js";
import type { Profile } from "./domain.js";
export const evidencePath = (id: string) =>
  join(config.dataDir, "evidence", `${id}.png`);
export async function captureEvidence(
  page: Page,
  id: string,
  profile: Profile,
) {
  try {
    await mkdir(join(config.dataDir, "evidence"), {
      recursive: true,
      mode: 0o700,
    });
    await page.evaluate(
      (values) => {
        const stored: { node: Text; value: string }[] = [];
        const walker = document.createTreeWalker(
          document.body,
          NodeFilter.SHOW_TEXT,
        );
        for (let node = walker.nextNode(); node; node = walker.nextNode()) {
          if (node.parentElement?.closest("script,style")) continue;
          const value = node.textContent || "";
          let redacted = value.replace(
            /[\w.+-]+@[\w.-]+\.[a-z]{2,}/gi,
            "[masque]",
          );
          for (const v of values)
            if (v.length >= 3) redacted = redacted.split(v).join("[masque]");
          if (redacted !== value) {
            stored.push({ node: node as Text, value });
            node.textContent = redacted;
          }
        }
        (window as any).__posteRedactions = stored;
      },
      [
        profile.name,
        profile.email,
        profile.phone,
        ...Object.values(profile.answers),
        ...profile.facts.map((f) => f.text),
      ].filter(Boolean),
    );
    try {
      await page.screenshot({
        path: evidencePath(id),
        fullPage: true,
        mask: [
          page.locator("input,textarea,select,iframe,[contenteditable=true]"),
        ],
        animations: "disabled",
      });
    } finally {
      await page
        .evaluate(() => {
          for (const { node, value } of (window as any).__posteRedactions || [])
            node.textContent = value;
          delete (window as any).__posteRedactions;
        })
        .catch(() => {});
    }
    return true;
  } catch {
    return false;
  }
}
export async function pruneEvidence() {
  const directory = join(config.dataDir, "evidence");
  for (const name of await readdir(directory).catch(() => []))
    if (/^[a-f0-9-]{36}\.png$/.test(name)) {
      const path = join(directory, name);
      const meta = await stat(path);
      if (meta.isFile() && meta.mtimeMs < Date.now() - 7 * 86400000)
        await unlink(path);
    }
}
