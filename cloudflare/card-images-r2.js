/**
 * Serve static image assets from R2 at the edge so the Docker image stays small.
 *
 * R2 key layout (single bucket `pokemonview-card-images`):
 *   /card-images/SV1/001.jpg           → SV1/001.jpg
 *   /card-images-japanese/...          → (path after prefix)
 *   /pokesymbols/symbols/foo.png       → pokesymbols/symbols/foo.png
 *   /set-images/BS/cover.png           → set-images/BS/cover.png
 *   /pricecharting-sealed/123.jpg      → pricecharting-sealed/123.jpg
 */
const IMAGE_CACHE_CONTROL = "public, max-age=31536000, immutable";

const IMAGE_CONTENT_TYPES = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
  gif: "image/gif",
  avif: "image/avif"
};

const ROUTE_PREFIXES = [
  { urlPrefix: "/card-images/", keyPrefix: "" },
  { urlPrefix: "/card-images-japanese/", keyPrefix: "" },
  { urlPrefix: "/pokesymbols/", keyPrefix: "pokesymbols/" },
  { urlPrefix: "/set-images/", keyPrefix: "set-images/" },
  { urlPrefix: "/pricecharting-sealed/", keyPrefix: "pricecharting-sealed/" }
];

function contentTypeForPath(pathname) {
  const ext = String(pathname || "")
    .split(".")
    .pop()
    ?.toLowerCase();
  return IMAGE_CONTENT_TYPES[ext] || "application/octet-stream";
}

function r2KeyFromRequest(pathname) {
  for (const route of ROUTE_PREFIXES) {
    if (!pathname.startsWith(route.urlPrefix)) continue;
    const raw = pathname.slice(route.urlPrefix.length);
    let decoded = raw;
    try {
      decoded = decodeURIComponent(raw);
    } catch {
      decoded = raw;
    }
    if (!decoded || decoded.includes("..") || decoded.includes("\\")) {
      return { ok: false };
    }
    const rel = decoded.replace(/\\/g, "/").replace(/^\/+/, "");
    if (!rel) return { ok: false };
    return { ok: true, key: `${route.keyPrefix}${rel}` };
  }
  return { ok: false };
}

/**
 * @param {Request} request
 * @param {object} env
 * @returns {Promise<Response|null>} Response when handled; null to fall through to the container.
 */
export async function tryServeCardImageFromR2(request, env) {
  const bucket = env.CARD_IMAGES;
  if (!bucket) return null;

  const url = new URL(request.url);
  if (request.method !== "GET" && request.method !== "HEAD") return null;

  const parsed = r2KeyFromRequest(url.pathname);
  if (!parsed.ok) return null;

  let object;
  try {
    object = await bucket.get(parsed.key);
  } catch (err) {
    console.error(`[r2] get failed for ${parsed.key}:`, err);
    return null;
  }
  if (!object) return null;

  const headers = new Headers();
  if (typeof object.writeHttpMetadata === "function") {
    object.writeHttpMetadata(headers);
  }
  headers.set("Cache-Control", IMAGE_CACHE_CONTROL);
  if (!headers.has("Content-Type")) {
    headers.set("Content-Type", contentTypeForPath(url.pathname));
  }

  if (request.method === "HEAD") {
    return new Response(null, { status: 200, headers });
  }

  return new Response(object.body, { status: 200, headers });
}
