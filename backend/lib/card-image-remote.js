/**
 * Fetch card art from a remote origin when local files are missing (local dev / no git-lfs pull).
 */
function normalizeOrigin(value) {
  return String(value || "")
    .trim()
    .replace(/\/$/, "");
}

function proxyOrigins(getConfig) {
  const seen = new Set();
  const out = [];
  for (const raw of [
    getConfig("CARD_IMAGES_PROXY_ORIGIN", ""),
    getConfig("APP_PUBLIC_URL", ""),
    process.env.CARD_IMAGES_PROXY_ORIGIN,
    process.env.APP_PUBLIC_URL
  ]) {
    const base = normalizeOrigin(raw);
    if (!base || seen.has(base)) continue;
    seen.add(base);
    out.push(base);
  }
  return out;
}

async function fetchCardImageBytes(pathname, getConfig) {
  const path = String(pathname || "").trim();
  if (!path.startsWith("/card-images/") && !path.startsWith("/card-images-japanese/")) {
    return null;
  }
  const bases = proxyOrigins(getConfig);
  if (!bases.length) return null;

  for (const base of bases) {
    try {
      const response = await fetch(`${base}${path}`, {
        headers: { "User-Agent": "PokemonView/1.0 (card-image-fallback)" },
        redirect: "follow"
      });
      if (!response.ok) continue;
      const bytes = Buffer.from(await response.arrayBuffer());
      if (bytes.length) return bytes;
    } catch {
      /* try next origin */
    }
  }
  return null;
}

module.exports = {
  fetchCardImageBytes,
  proxyOrigins
};
