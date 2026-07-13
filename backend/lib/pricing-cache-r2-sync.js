/**
 * Sync large pricing cache JSON files to R2 via the Worker.
 * Container disk is ephemeral — without this, admin price caches vanish on restart.
 */

const ALLOWED_FILES = new Set([
  "tcg-link-prices-cache.json",
  "pricecharting-card-details-cache.json",
  "tcg-link-price-fail-links.json",
  "pricecharting-card-details-fail-links.json"
]);

/** Merged with process.env on each call (file-loaded secrets may not be on process.env). */
let defaultSyncEnv = {};

function setPricingCacheR2Env(next = {}) {
  defaultSyncEnv = next && typeof next === "object" ? { ...next } : {};
}

function getSyncConfig(env = {}) {
  const merged = { ...defaultSyncEnv, ...process.env, ...env };
  const secret = String(merged.STORE_SYNC_SECRET || "").trim();
  const base = String(merged.APP_PUBLIC_URL || "https://pokemonview.com")
    .trim()
    .replace(/\/$/, "");
  return {
    secret,
    baseUrl: `${base}/api/internal/r2-data`,
    enabled: Boolean(secret && base)
  };
}

function assertAllowedFile(name) {
  const file = String(name || "").trim();
  if (!ALLOWED_FILES.has(file)) {
    throw new Error(`Unsupported R2 data file: ${file}`);
  }
  return file;
}

async function pullPricingCacheFromR2(fileName, env = {}) {
  const cfg = getSyncConfig(env);
  if (!cfg.enabled) return null;
  const file = assertAllowedFile(fileName);
  try {
    const url = `${cfg.baseUrl}?file=${encodeURIComponent(file)}`;
    const res = await fetch(url, {
      method: "GET",
      headers: { "x-store-sync-secret": cfg.secret }
    });
    if (res.status === 404) return null;
    if (!res.ok) {
      console.warn(`[pricing-r2] pull ${file} failed: HTTP ${res.status}`);
      return null;
    }
    const text = await res.text();
    if (!text || text.length < 2) return null;
    console.log(`[pricing-r2] restored ${file} (${text.length.toLocaleString()} bytes)`);
    return text;
  } catch (err) {
    console.warn(`[pricing-r2] pull ${fileName} error: ${err.message || err}`);
    return null;
  }
}

async function pushPricingCacheToR2(fileName, bodyText, env = {}) {
  const cfg = getSyncConfig(env);
  if (!cfg.enabled) return { ok: false, skipped: true };
  const file = assertAllowedFile(fileName);
  const body = String(bodyText || "");
  if (body.length < 2) return { ok: false, skipped: true };
  try {
    const url = `${cfg.baseUrl}?file=${encodeURIComponent(file)}`;
    const res = await fetch(url, {
      method: "PUT",
      headers: {
        "content-type": "application/json; charset=utf-8",
        "x-store-sync-secret": cfg.secret
      },
      body
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      console.warn(`[pricing-r2] push ${file} failed: HTTP ${res.status} ${text.slice(0, 200)}`);
      return { ok: false };
    }
    return { ok: true, bytes: body.length };
  } catch (err) {
    console.warn(`[pricing-r2] push ${fileName} error: ${err.message || err}`);
    return { ok: false };
  }
}

module.exports = {
  ALLOWED_FILES,
  getSyncConfig,
  setPricingCacheR2Env,
  pullPricingCacheFromR2,
  pushPricingCacheToR2
};
