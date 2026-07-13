/**
 * Sync store.json to R2 via the Worker (CARD_IMAGES bucket key app-data/store.json).
 * Avoids losing accounts when the Cloudflare container disk is replaced.
 */

function getSyncConfig(env = {}) {
  const secret = String(env.STORE_SYNC_SECRET || process.env.STORE_SYNC_SECRET || "").trim();
  const base = String(
    env.APP_PUBLIC_URL || process.env.APP_PUBLIC_URL || "https://pokemonview.com"
  )
    .trim()
    .replace(/\/$/, "");
  return {
    secret,
    url: `${base}/api/internal/r2-store`,
    enabled: Boolean(secret && base)
  };
}

function userCount(store) {
  return Array.isArray(store?.users) ? store.users.length : 0;
}

async function pullStoreFromR2(env = {}) {
  const cfg = getSyncConfig(env);
  if (!cfg.enabled) return null;
  try {
    const res = await fetch(cfg.url, {
      method: "GET",
      headers: { "x-store-sync-secret": cfg.secret }
    });
    if (res.status === 404) return null;
    if (!res.ok) {
      console.warn(`[store-r2] pull failed: HTTP ${res.status}`);
      return null;
    }
    const text = await res.text();
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== "object") return null;
    console.log(`[store-r2] restored from R2 (users=${userCount(parsed)})`);
    return parsed;
  } catch (err) {
    console.warn(`[store-r2] pull error: ${err.message || err}`);
    return null;
  }
}

async function pushStoreToR2(store, env = {}) {
  const cfg = getSyncConfig(env);
  if (!cfg.enabled || !store) return { ok: false, skipped: true };
  try {
    const body = JSON.stringify(store);
    const res = await fetch(cfg.url, {
      method: "PUT",
      headers: {
        "content-type": "application/json; charset=utf-8",
        "x-store-sync-secret": cfg.secret
      },
      body
    });
    if (res.status === 409) {
      console.warn("[store-r2] push skipped: refusing to overwrite non-empty R2 with empty store");
      return { ok: false, skipped: true };
    }
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      console.warn(`[store-r2] push failed: HTTP ${res.status} ${text.slice(0, 200)}`);
      return { ok: false };
    }
    return { ok: true };
  } catch (err) {
    console.warn(`[store-r2] push error: ${err.message || err}`);
    return { ok: false };
  }
}

module.exports = {
  getSyncConfig,
  pullStoreFromR2,
  pushStoreToR2,
  userCount
};
