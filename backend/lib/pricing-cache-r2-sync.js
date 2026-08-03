/**
 * Sync large pricing cache JSON files to R2 via the Worker.
 * Container disk is ephemeral — without this, admin price caches vanish on restart.
 *
 * Large files (PriceCharting details) are gzip-compressed for PUT/GET so they stay
 * under the Workers request body limit (~100MB). Uncompressed objects still load.
 */

const zlib = require("zlib");
const { promisify } = require("util");

const gzipAsync = promisify(zlib.gzip);
const gunzipAsync = promisify(zlib.gunzip);

const ALLOWED_FILES = new Set([
  "tcg-link-prices-cache.json",
  "pricecharting-card-details-cache.json",
  "tcg-link-price-fail-links.json",
  "pricecharting-card-details-fail-links.json",
  "admin-set-refresh-timestamps.json"
]);

/** Per-set snapshots: set-link-prices/{CODE}.json (strict set-code charset). */
const SET_LINK_PRICES_R2_RE = /^set-link-prices\/[A-Z0-9][A-Z0-9_-]{0,31}\.json$/;

/** Prefer gzip when payload exceeds this (keeps small files simple). */
const GZIP_MIN_BYTES = 256 * 1024;

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

function isAllowedPricingCacheFile(name) {
  const file = String(name || "").trim();
  if (!file) return false;
  if (ALLOWED_FILES.has(file)) return true;
  return SET_LINK_PRICES_R2_RE.test(file);
}

function assertAllowedFile(name) {
  const file = String(name || "").trim();
  if (!isAllowedPricingCacheFile(file)) {
    throw new Error(`Unsupported R2 data file: ${file}`);
  }
  return file;
}

function setLinkPricesR2FileName(setCode) {
  const code = String(setCode || "")
    .trim()
    .toUpperCase();
  if (!/^[A-Z0-9][A-Z0-9_-]{0,31}$/.test(code)) return null;
  return `set-link-prices/${code}.json`;
}

function looksLikeGzip(buffer) {
  return Buffer.isBuffer(buffer) && buffer.length >= 2 && buffer[0] === 0x1f && buffer[1] === 0x8b;
}

async function decodeMaybeGzipBody(buffer, contentEncoding = "") {
  const encoding = String(contentEncoding || "")
    .trim()
    .toLowerCase();
  if (encoding.includes("gzip") || looksLikeGzip(buffer)) {
    const inflated = await gunzipAsync(buffer);
    return inflated.toString("utf8");
  }
  return buffer.toString("utf8");
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
    const buffer = Buffer.from(await res.arrayBuffer());
    if (!buffer.length) return null;
    const text = await decodeMaybeGzipBody(buffer, res.headers.get("content-encoding"));
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
  const controller = new AbortController();
  const timeoutMs = 90_000;
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const url = `${cfg.baseUrl}?file=${encodeURIComponent(file)}`;
    const raw = Buffer.from(body, "utf8");
    const useGzip = raw.length >= GZIP_MIN_BYTES;
    const payload = useGzip ? await gzipAsync(raw, { level: 6 }) : raw;
    const headers = {
      "content-type": "application/json; charset=utf-8",
      "x-store-sync-secret": cfg.secret
    };
    if (useGzip) headers["content-encoding"] = "gzip";
    const res = await fetch(url, {
      method: "PUT",
      headers,
      body: payload,
      signal: controller.signal
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      console.warn(`[pricing-r2] push ${file} failed: HTTP ${res.status} ${text.slice(0, 200)}`);
      return { ok: false };
    }
    return {
      ok: true,
      bytes: payload.length,
      rawBytes: raw.length,
      gzip: useGzip
    };
  } catch (err) {
    console.warn(`[pricing-r2] push ${fileName} error: ${err.message || err}`);
    return { ok: false };
  } finally {
    clearTimeout(timer);
  }
}

module.exports = {
  ALLOWED_FILES,
  SET_LINK_PRICES_R2_RE,
  isAllowedPricingCacheFile,
  setLinkPricesR2FileName,
  getSyncConfig,
  setPricingCacheR2Env,
  pullPricingCacheFromR2,
  pushPricingCacheToR2
};
