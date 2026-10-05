import { lookup } from "node:dns/promises";
import ipaddr from "ipaddr.js";
import { Agent, fetch as safeFetch } from "undici";
export class NetworkError extends Error {
  constructor(
    message: string,
    public retryAfterMs = 0,
    public structural = false,
  ) {
    super(message);
  }
}
export async function publicAddresses(host: string) {
  const addresses = await lookup(host.replace(/^\[|\]$/g, ""), { all: true });
  if (
    !addresses.length ||
    addresses.some((a) => ipaddr.process(a.address).range() !== "unicast")
  )
    throw new NetworkError(
      "Adresse reseau privee ou reservee interdite",
      0,
      true,
    );
  return addresses;
}
export function validatePublicUrl(value: string) {
  const u = new URL(value);
  if (
    u.protocol !== "https:" ||
    u.username ||
    u.password ||
    (u.port && u.port !== "443")
  )
    throw new NetworkError("URL HTTPS publique sans identifiants requise");
  return u;
}
const dispatcher = new Agent({
  connect: {
    lookup: (host, options, callback) => {
      publicAddresses(host)
        .then((addresses) => {
          if ((options as any).all) (callback as any)(null, addresses);
          else callback(null, addresses[0].address, addresses[0].family);
        })
        .catch((e) => callback(e, "", 4));
    },
  },
});
export async function fetchPublic(
  value: string,
  init: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
  } = {},
  allowedHosts?: string[],
): Promise<{
  text: string;
  headers: { get(name: string): string | null };
  url: string;
}> {
  let url = validatePublicUrl(value);
  for (let redirects = 0; redirects < 4; redirects++) {
    if (allowedHosts && !allowedHosts.includes(url.hostname))
      throw new NetworkError("Domaine hors liste autorisee");
    const response = await safeFetch(url, {
      ...init,
      dispatcher,
      redirect: "manual",
      signal: AbortSignal.timeout(30000),
      headers: { "User-Agent": "PrivateJobAggregator/0.1", ...init.headers },
    });
    if (
      response.status >= 300 &&
      response.status < 400 &&
      response.headers.get("location")
    ) {
      await response.body?.cancel();
      url = validatePublicUrl(
        new URL(response.headers.get("location")!, url).toString(),
      );
      continue;
    }
    if (response.status === 429) {
      const value = response.headers.get("retry-after");
      await response.body?.cancel();
      throw new NetworkError(
        "Limite de requetes atteinte",
        Math.min(
          86400000,
          Math.max(
            60000,
            value && /^\d+$/.test(value)
              ? Number(value) * 1000
              : value
                ? new Date(value).getTime() - Date.now()
                : 60000,
          ),
        ),
      );
    }
    if ([401, 403].includes(response.status)) {
      await response.body?.cancel();
      throw new NetworkError("Acces restreint : intervention requise", 0, true);
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new NetworkError(`Erreur HTTP ${response.status}`);
    }
    const reader = response.body?.getReader();
    let bytes = 0;
    const chunks: Buffer[] = [];
    if (reader)
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        bytes += value.length;
        if (bytes > 2000000) {
          await reader.cancel();
          throw new NetworkError("Reponse trop volumineuse");
        }
        chunks.push(Buffer.from(value));
      }
    return {
      text: Buffer.concat(chunks).toString("utf8"),
      headers: response.headers,
      url: url.toString(),
    };
  }
  throw new NetworkError("Trop de redirections");
}
