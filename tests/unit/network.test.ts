import { it, expect } from "vitest";
import { publicAddresses, validatePublicUrl } from "../../src/network.js";
it("bloque les URL locales, credentials et ports inattendus", async () => {
  expect(() => validatePublicUrl("http://example.com")).toThrow();
  expect(() => validatePublicUrl("https://user:secret@example.com")).toThrow();
  expect(() => validatePublicUrl("https://example.com:444")).toThrow();
  await expect(publicAddresses("127.0.0.1")).rejects.toThrow(/privee/);
  await expect(publicAddresses("::1")).rejects.toThrow(/privee/);
});
