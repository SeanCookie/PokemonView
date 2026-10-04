/**
 * Serve static image assets from R2 at the edge so the Docker image stays small.
 *
 * R2 key layout (single bucket `pokemonview-card-images`):
 *   /card-images/SV1/001.jpg           → SV1/001.jpg
 *   /card-images-japanese/...          → (path after prefix)
 *   /pokesymbols/symbols/foo.png       → pokesymbols/symbols/foo.png
 *   /set-images/BS/cover.png           → set-images/BS/cover.png
 *   /pricecharting-sealed/123.jpg      → pricecharting-sealed/123.jpg
 *
 * On R2 miss: pokesymbols are filled from pokesymbols.com CDN; other image
 * routes can write-through from the origin container when `fetchOrigin` is set.
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

const POKESYMBOLS_SETS_CDN = "https://pokesymbols.com/images/tcg/sets";
const POKESYMBOLS_TCG_CDN = "https://pokesymbols.com/images/tcg";

const CDN_PATH_ALIASES = {
  "symbols/fire-red-and-leafgreen.png": "symbols/firered-leafgreen.png",
  "logos/fire-red-and-leafgreen.png": "logos/firered-leafgreen.png",
  "symbols/expedition-base-set.png": "symbols/expedition.png",
  "logos/expedition-base-set.png": "logos/expedition.png",
  "symbols/heart-gold-and-soul-silver.png": "symbols/heartgold-soulsilver.png",
  "logos/heart-gold-and-soul-silver.png": "logos/heartgold-soulsilver.png"
};

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
    return {
      ok: true,
      key: `${route.keyPrefix}${rel}`,
      urlPrefix: route.urlPrefix,
      rel
    };
  }
  return { ok: false };
}

function pokesymbolsCdnUrls(relPath) {
  const normalized = String(relPath || "")
    .replace(/\\/g, "/")
    .replace(/^\/+/, "");
  if (!normalized || normalized.includes("..")) return [];
  const candidates = [];
  const aliased = CDN_PATH_ALIASES[normalized] || normalized;
  const promo = /-black-star-promos\.png$/i.test(normalized)
    ? normalized.replace(/[^/]+\.png$/i, "_promo.png")
    : "";
  for (const rel of [aliased, normalized, promo].filter(Boolean)) {
    if (!candidates.includes(rel)) candidates.push(rel);
  }
  return candidates.map((rel) => {
    const base = rel.startsWith("rarities/") ? POKESYMBOLS_TCG_CDN : POKESYMBOLS_SETS_CDN;
    return `${base}/${rel}`;
  });
}

function isCacheableImageResponse(response, pathname) {
  if (!response || !response.ok) return false;
  const ct = String(response.headers.get("content-type") || "").toLowerCase();
  if (ct.startsWith("image/")) return true;
  // Some origins omit content-type; allow known image extensions.
  return Boolean(IMAGE_CONTENT_TYPES[String(pathname).split(".").pop()?.toLowerCase()]);
}

async function putR2Object(bucket, key, body, contentType, waitUntil) {
  const putPromise = bucket
    .put(key, body, {
      httpMetadata: { contentType: contentType || "application/octet-stream" }
    })
    .catch((err) => {
      console.error(`[r2] put failed for ${key}:`, err?.message || err);
    });
  if (typeof waitUntil === "function") {
    waitUntil(putPromise);
    return;
  }
  await putPromise;
}

function buildImageResponse(body, pathname, method) {
  const headers = new Headers();
  headers.set("Cache-Control", IMAGE_CACHE_CONTROL);
  headers.set("Content-Type", contentTypeForPath(pathname));
  if (method === "HEAD") {
    return new Response(null, { status: 200, headers });
  }
  return new Response(body, { status: 200, headers });
}

/**
 * @param {Request} request
 * @param {object} env
 * @param {{ fetchOrigin?: (req: Request) => Promise<Response>, waitUntil?: (p: Promise<unknown>) => void }} [options]
 * @returns {Promise<Response|null>} Response when handled; null to fall through to the container.
 */
export async function tryServeCardImageFromR2(request, env, options = {}) {
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

  if (object) {
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

  // --- R2 miss: fill from CDN (pokesymbols) and/or origin, then cache ---
  const { fetchOrigin, waitUntil } = options;
  const contentType = contentTypeForPath(url.pathname);

  if (parsed.urlPrefix === "/pokesymbols/") {
    for (const cdnUrl of pokesymbolsCdnUrls(parsed.rel)) {
      try {
        const cdnRes = await fetch(cdnUrl);
        if (!isCacheableImageResponse(cdnRes, url.pathname)) continue;
        const bytes = await cdnRes.arrayBuffer();
        if (!bytes || bytes.byteLength < 32) continue;
        await putR2Object(bucket, parsed.key, bytes, contentType, waitUntil);
        return buildImageResponse(bytes, url.pathname, request.method);
      } catch (err) {
        console.warn(`[r2] CDN fill failed for ${parsed.key}:`, err?.message || err);
      }
    }
  }

  if (typeof fetchOrigin === "function") {
    try {
      const originRes = await fetchOrigin(request);
      if (isCacheableImageResponse(originRes, url.pathname)) {
        const bytes = await originRes.arrayBuffer();
        if (bytes && bytes.byteLength >= 32) {
          const originType = originRes.headers.get("content-type") || contentType;
          await putR2Object(bucket, parsed.key, bytes, originType, waitUntil);
          return buildImageResponse(bytes, url.pathname, request.method);
        }
      }
      // Origin handled the path (even 404) — do not fall through again.
      if (originRes) return originRes;
    } catch (err) {
      console.warn(`[r2] origin fill failed for ${parsed.key}:`, err?.message || err);
    }
  }

  return null;
}
