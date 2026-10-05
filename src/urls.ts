export function canonicalUrl(value: string) {
  const u = new URL(value);
  u.hash = "";
  u.hostname = u.hostname.toLowerCase();
  for (const k of [...u.searchParams.keys()])
    if (/^(utm_|trk$|tracking|ref$|source$|fbclid$)/i.test(k))
      u.searchParams.delete(k);
  if (u.hostname.endsWith("indeed.com") || u.hostname.endsWith("indeed.fr")) {
    const id = u.searchParams.get("jk") || u.searchParams.get("vjk");
    if (id) return `https://${u.hostname}/viewjob?jk=${encodeURIComponent(id)}`;
  }
  u.searchParams.sort();
  u.pathname = u.pathname.replace(/\/$/, "") || "/";
  return u.toString();
}
