const fsp = require("fs/promises");
const path = require("path");

const DATA_DIR = path.join(__dirname, "..", "data");
const CACHE_FILE = path.join(DATA_DIR, "pricecharting-market-history-cache.json");
const CACHE_TTL_MS = 1000 * 60 * 60 * 24 * 30;
const CACHE_VERSION = 1;
const PERSIST_DEBOUNCE_MS = 500;

const memCache = new Map();
let persistTimer = null;
let persistChain = Promise.resolve();
let cacheMeta = {
  savedAt: null,
  entryCount: 0
};

function cacheKeyForCard(setCode = "", cardNo = "") {
  const code = String(setCode || "").trim().toUpperCase();
  const no = String(cardNo || "").trim();
  if (!code || !no) return "";
  return `${code}:${no}`;
}

function cacheValueValid(value) {
  return Boolean(
    value &&
      typeof value === "object" &&
      value.chartData &&
      typeof value.chartData === "object" &&
      Object.keys(value.chartData).length > 0
  );
}

function readCachedChartEntry(setCode = "", cardNo = "") {
  const key = cacheKeyForCard(setCode, cardNo);
  if (!key) return null;
  const row = memCache.get(key);
  if (!row || row.expiresAt <= Date.now() || !cacheValueValid(row.value)) {
    if (row) memCache.delete(key);
    return null;
  }
  return { ...row.value, cached: true };
}

function writeCachedChartEntry(
  setCode = "",
  cardNo = "",
  {
    productId = "",
    productUrl = "",
    category = "",
    consoleSlug = "",
    chartData = null,
    detailRarity = ""
  } = {}
) {
  const key = cacheKeyForCard(setCode, cardNo);
  if (!key || !chartData || typeof chartData !== "object") return false;
  memCache.set(key, {
    value: {
      setCode: String(setCode || "").trim().toUpperCase(),
      cardNo: String(cardNo || "").trim(),
      productId: String(productId || "").trim(),
      productUrl: String(productUrl || "").trim(),
      category: String(category || "").trim(),
      consoleSlug: String(consoleSlug || "").trim(),
      detailRarity: String(detailRarity || "").trim(),
      chartData,
      savedAt: new Date().toISOString()
    },
    expiresAt: Date.now() + CACHE_TTL_MS
  });
  cacheMeta.entryCount = memCache.size;
  schedulePersistMarketHistoryCache();
  return true;
}

function buildCacheFilePayload() {
  const now = Date.now();
  const entries = [];
  for (const [key, row] of memCache.entries()) {
    if (!row || row.expiresAt <= now || !cacheValueValid(row.value)) continue;
    entries.push({
      key,
      expiresAt: row.expiresAt,
      value: row.value
    });
  }
  return {
    version: CACHE_VERSION,
    savedAt: new Date().toISOString(),
    meta: {
      entryCount: entries.length
    },
    entries
  };
}

function schedulePersistMarketHistoryCache() {
  if (persistTimer) return;
  persistTimer = setTimeout(() => {
    persistTimer = null;
    void enqueuePersistMarketHistoryCacheNow();
  }, PERSIST_DEBOUNCE_MS);
}

function enqueuePersistMarketHistoryCacheNow() {
  persistChain = persistChain
    .then(() => persistMarketHistoryCacheNow())
    .catch(() => {});
  return persistChain;
}

async function persistMarketHistoryCacheNow() {
  if (persistTimer) {
    clearTimeout(persistTimer);
    persistTimer = null;
  }
  const payload = buildCacheFilePayload();
  cacheMeta.savedAt = payload.savedAt;
  cacheMeta.entryCount = payload.meta.entryCount;
  await fsp.mkdir(DATA_DIR, { recursive: true });
  await fsp.writeFile(CACHE_FILE, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

async function loadPersistedPriceChartingMarketHistoryCache() {
  try {
    const raw = await fsp.readFile(CACHE_FILE, "utf8");
    const parsed = JSON.parse(raw);
    const fileVersion = Number(parsed?.version) || 0;
    if (fileVersion !== CACHE_VERSION) {
      console.log(
        `[market-history] skipping stale PriceCharting history cache (v${fileVersion} -> v${CACHE_VERSION})`
      );
      return;
    }
    const rows = Array.isArray(parsed?.entries) ? parsed.entries : [];
    const revivedExpiresAt = Date.now() + CACHE_TTL_MS;
    let restored = 0;
    for (const row of rows) {
      const key = String(row?.key || "").trim();
      const value = row?.value && typeof row.value === "object" ? row.value : null;
      if (!key || !cacheValueValid(value)) continue;
      memCache.set(key, { value, expiresAt: revivedExpiresAt });
      restored += 1;
    }
    cacheMeta.savedAt = String(parsed?.savedAt || "").trim() || null;
    cacheMeta.entryCount = restored;
    if (restored > 0) {
      console.log(`[market-history] restored ${restored} persisted PriceCharting market history caches`);
    }
  } catch {
    // no cache file yet
  }
}

function getPriceChartingMarketHistoryCacheMeta() {
  const now = Date.now();
  let valid = 0;
  for (const row of memCache.values()) {
    if (row && row.expiresAt > now && cacheValueValid(row.value)) valid += 1;
  }
  return {
    cacheVersion: CACHE_VERSION,
    cacheSavedAt: cacheMeta.savedAt,
    cacheEntryCount: valid
  };
}

module.exports = {
  loadPersistedPriceChartingMarketHistoryCache,
  persistMarketHistoryCacheNow,
  enqueuePersistMarketHistoryCacheNow,
  getPriceChartingMarketHistoryCacheMeta,
  readCachedChartEntry,
  writeCachedChartEntry
};
