const fsp = require("fs/promises");
const path = require("path");
const {
  fetchPriceChartingCardDetailsForCard,
  fetchPriceChartingSealedProductBundle
} = require("./pricecharting-market-history");
const {
  pullPricingCacheFromR2,
  pushPricingCacheToR2
} = require("./pricing-cache-r2-sync");

const DATA_DIR = path.join(__dirname, "..", "data");
const CACHE_FILE = path.join(DATA_DIR, "pricecharting-card-details-cache.json");
const CACHE_R2_NAME = "pricecharting-card-details-cache.json";
const SET_CARD_LIST_FILE = path.join(DATA_DIR, "set-card-lists.json");
const CACHE_TTL_MS = 1000 * 60 * 60 * 24 * 30;
const CACHE_VERSION = 2;
const PERSIST_DEBOUNCE_MS = 500;
/** Default for admin bulk runs — save to disk/R2 every N processed cards (not on every write). */
const DEFAULT_BULK_PERSIST_EVERY = 1000;
/** Keep details cache smaller — average-of-recent only needs a short window. */
const MAX_CACHED_SOLD_LISTINGS = 40;

const memCache = new Map();
let persistTimer = null;
let persistChain = Promise.resolve();
/** When true, skip debounce persists (bulk job uses interval + final save). */
let bulkPersistSuspended = false;
let cacheMeta = {
  savedAt: null,
  entryCount: 0
};

function decodeHtmlName(text) {
  return String(text || "")
    .replace(/&#038;/g, "&")
    .replace(/&#8217;/g, "'")
    .replace(/&amp;/g, "&")
    .trim();
}

function cacheKeyForCard(setCode = "", cardNo = "") {
  const code = String(setCode || "").trim().toUpperCase();
  const no = String(cardNo || "").trim();
  if (!code || !no) return "";
  return `${code}:${no}`;
}

function cacheKeyForSealedProduct(setCode = "", productId = "") {
  const id = String(productId || "").trim();
  if (!id) return "";
  const code = String(setCode || "").trim().toUpperCase() || "SEALED";
  return cacheKeyForCard(code, `sealed:${id}`);
}

function cacheValueValid(value) {
  return Boolean(value && typeof value === "object" && value.ok === true);
}

function readCachedCardDetails(setCode = "", cardNo = "") {
  const key = cacheKeyForCard(setCode, cardNo);
  if (!key) return null;
  const row = memCache.get(key);
  if (!row || row.expiresAt <= Date.now() || !cacheValueValid(row.value)) {
    if (row) memCache.delete(key);
    return null;
  }
  const soldGuides = normalizeSoldGuides(row.value);
  return {
    ...row.value,
    soldListings: soldGuides[0]?.listings || row.value.soldListings || [],
    soldGuides,
    cached: true
  };
}

function normalizeSoldGuides(value) {
  if (Array.isArray(value?.soldGuides) && value.soldGuides.length) {
    return value.soldGuides
      .map((guide) => ({
        variant: String(guide?.variant || "normal").trim() || "normal",
        title: String(guide?.title || "").trim(),
        productUrl: String(guide?.productUrl || "").trim(),
        listings: Array.isArray(guide?.listings) ? guide.listings : []
      }))
      .filter((guide) => guide.listings.length > 0);
  }
  const listings = Array.isArray(value?.soldListings) ? value.soldListings : [];
  if (!listings.length) return [];
  return [
    {
      variant: "normal",
      title: "",
      productUrl: String(value?.productUrl || "").trim(),
      listings
    }
  ];
}

function isLikelyGradedSoldListingTitle(title = "") {
  return /\b(PSA|BGS|CGC|SGC|TAG|ACE)\b|\bgraded\b/i.test(String(title || ""));
}

/**
 * Average of the most recent ungraded sold listings (newest-first in PriceCharting data).
 * Uses up to `limit` listings; fewer is fine when history is short.
 */
function averageRecentUngradedSoldPrice(details, { limit = 10 } = {}) {
  const max = Math.max(1, Math.min(50, Math.floor(Number(limit) || 10)));
  const guides = normalizeSoldGuides(details);
  if (!guides.length) return null;
  const normal =
    guides.find((guide) => String(guide.variant || "").trim().toLowerCase() === "normal") || guides[0];
  const listings = Array.isArray(normal?.listings) ? normal.listings : [];
  const prices = [];
  for (const row of listings) {
    if (isLikelyGradedSoldListingTitle(row?.title)) continue;
    const price = Number(row?.price);
    if (!Number.isFinite(price) || price <= 0) continue;
    prices.push(price);
    if (prices.length >= max) break;
  }
  if (!prices.length) return null;
  const sum = prices.reduce((acc, n) => acc + n, 0);
  return {
    price: Number((sum / prices.length).toFixed(2)),
    sampleSize: prices.length
  };
}

function trimSoldListings(listings = []) {
  const list = Array.isArray(listings) ? listings : [];
  return list.length > MAX_CACHED_SOLD_LISTINGS ? list.slice(0, MAX_CACHED_SOLD_LISTINGS) : list;
}

function writeCachedCardDetails(setCode = "", cardNo = "", value) {
  const key = cacheKeyForCard(setCode, cardNo);
  if (!key || !cacheValueValid(value)) return false;
  const soldGuides = normalizeSoldGuides(value).map((guide) => ({
    ...guide,
    listings: trimSoldListings(guide.listings)
  }));
  const soldListings = soldGuides[0]?.listings || trimSoldListings(value.soldListings);
  const entry = {
    ok: true,
    productUrl: String(value.productUrl || ""),
    soldListings,
    soldGuides,
    gradedGuides: Array.isArray(value.gradedGuides) ? value.gradedGuides : []
  };
  // Sealed product extras — kept in the same PriceCharting details cache.
  if (String(value.kind || "").trim().toLowerCase() === "sealed" || Array.isArray(value.series)) {
    entry.kind = "sealed";
    if (value.productId != null) entry.productId = String(value.productId || "").trim();
    if (Array.isArray(value.series)) entry.series = value.series;
    if (value.ungradedPrice != null && Number.isFinite(Number(value.ungradedPrice))) {
      entry.ungradedPrice = Number(value.ungradedPrice);
    }
    if (value.priceText != null) entry.priceText = String(value.priceText || "");
    if (value.tcgplayerUrl != null) entry.tcgplayerUrl = String(value.tcgplayerUrl || "");
    if (value.ebayUrl != null) entry.ebayUrl = String(value.ebayUrl || "");
    if (value.source != null) entry.source = String(value.source || "");
    if (value.rangeKey != null) entry.rangeKey = String(value.rangeKey || "");
    if (value.rangeLabel != null) entry.rangeLabel = String(value.rangeLabel || "");
  }
  memCache.set(key, {
    value: entry,
    expiresAt: Date.now() + CACHE_TTL_MS
  });
  cacheMeta.entryCount = memCache.size;
  if (!bulkPersistSuspended) {
    schedulePersistPriceChartingCardDetailsCache();
  }
  return true;
}

function readCachedSealedProductDetails(setCode = "", productId = "") {
  const key = cacheKeyForSealedProduct(setCode, productId);
  if (!key) return null;
  const row = memCache.get(key);
  if (!row || row.expiresAt <= Date.now() || !cacheValueValid(row.value)) {
    if (row) memCache.delete(key);
    return null;
  }
  const soldGuides = normalizeSoldGuides(row.value);
  return {
    ...row.value,
    kind: "sealed",
    soldListings: soldGuides[0]?.listings || row.value.soldListings || [],
    soldGuides,
    series: Array.isArray(row.value.series) ? row.value.series : [],
    cached: true
  };
}

function writeCachedSealedProductDetails(setCode = "", productId = "", value) {
  const id = String(productId || value?.productId || "").trim();
  const code = String(setCode || "").trim().toUpperCase() || "SEALED";
  if (!id) return false;
  return writeCachedCardDetails(code, `sealed:${id}`, {
    ...value,
    kind: "sealed",
    productId: id
  });
}

async function getOrFetchPriceChartingSealedDetails(
  {
    setCode = "",
    productUrl = "",
    productId = "",
    productTitle = "",
    setName = ""
  } = {},
  { forceRefresh = false, cacheOnly = false } = {}
) {
  const id = String(productId || "").trim();
  if (!forceRefresh && id) {
    const cached = readCachedSealedProductDetails(setCode, id);
    if (cached) return cached;
  }
  if (cacheOnly) {
    return {
      ok: false,
      pending: true,
      cached: false,
      kind: "sealed",
      productId: id,
      productUrl: String(productUrl || "").trim(),
      series: [],
      soldListings: [],
      soldGuides: [],
      gradedGuides: [],
      ungradedPrice: null,
      priceText: "",
      tcgplayerUrl: "",
      ebayUrl: ""
    };
  }
  const fresh = await fetchPriceChartingSealedProductBundle({
    productUrl,
    productId: id,
    productTitle,
    setName
  });
  const resolvedId = String(fresh?.productId || id || "").trim();
  if (fresh?.ok && resolvedId) {
    writeCachedSealedProductDetails(setCode, resolvedId, fresh);
  }
  return { ...fresh, kind: "sealed", cached: false };
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

function schedulePersistPriceChartingCardDetailsCache() {
  if (bulkPersistSuspended) return;
  if (persistTimer) return;
  persistTimer = setTimeout(() => {
    persistTimer = null;
    void enqueuePersistPriceChartingCardDetailsCacheNow();
  }, PERSIST_DEBOUNCE_MS);
}

function enqueuePersistPriceChartingCardDetailsCacheNow() {
  persistChain = persistChain
    .then(() => persistPriceChartingCardDetailsCacheNow())
    .catch((err) => {
      console.warn(`[pricing-cache] PriceCharting details persist failed: ${err?.message || err}`);
    });
  return persistChain;
}

async function persistPriceChartingCardDetailsCacheNow() {
  if (persistTimer) {
    clearTimeout(persistTimer);
    persistTimer = null;
  }
  const payload = buildCacheFilePayload();
  cacheMeta.savedAt = payload.savedAt;
  cacheMeta.entryCount = payload.meta.entryCount;
  // Compact JSON — pretty-print ballooned past the Workers ~100MB body limit around ~4k cards.
  const body = `${JSON.stringify(payload)}\n`;
  await fsp.mkdir(DATA_DIR, { recursive: true });
  await fsp.writeFile(CACHE_FILE, body, "utf8");
  const r2 = await pushPricingCacheToR2(CACHE_R2_NAME, body);
  if (r2?.ok) {
    const gzipNote = r2.gzip ? `, gzip ${Number(r2.bytes || 0).toLocaleString()}B` : "";
    console.log(
      `[pricing-cache] PriceCharting details saved (${payload.meta.entryCount} entries, R2 ok${gzipNote})`
    );
  } else if (!r2?.skipped) {
    console.warn("[pricing-cache] PriceCharting details saved to disk but R2 push failed");
  }
}

function applyParsedPriceChartingCache(parsed) {
  const fileVersion = Number(parsed?.version) || 0;
  if (fileVersion !== CACHE_VERSION) {
    console.log(
      `[pricing-cache] skipping stale PriceCharting card details cache (v${fileVersion} -> v${CACHE_VERSION})`
    );
    return 0;
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
  return restored;
}

async function loadPersistedPriceChartingCardDetailsCache() {
  let raw = null;
  try {
    raw = await fsp.readFile(CACHE_FILE, "utf8");
  } catch {
    // try R2 below
  }

  if (!raw || raw.length < 2) {
    raw = await pullPricingCacheFromR2(CACHE_R2_NAME);
    if (raw) {
      try {
        await fsp.mkdir(DATA_DIR, { recursive: true });
        await fsp.writeFile(CACHE_FILE, raw.endsWith("\n") ? raw : `${raw}\n`, "utf8");
      } catch (err) {
        console.warn(`[pricing-cache] could not write R2 PriceCharting cache to disk: ${err?.message || err}`);
      }
    }
  }

  if (!raw) return;

  try {
    const parsed = JSON.parse(raw);
    const restored = applyParsedPriceChartingCache(parsed);
    if (restored > 0) {
      console.log(`[pricing-cache] restored ${restored} persisted PriceCharting card detail caches`);
    }
  } catch (err) {
    console.warn(`[pricing-cache] PriceCharting details cache parse failed: ${err?.message || err}`);
  }
}

function getPriceChartingCardDetailsCacheMeta() {
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

async function getOrFetchPriceChartingCardDetails(
  { setCode = "", setName = "", cardNo = "", cardName = "" } = {},
  { forceRefresh = false, cacheOnly = false } = {}
) {
  if (!forceRefresh) {
    const cached = readCachedCardDetails(setCode, cardNo);
    if (cached) return cached;
  }
  if (cacheOnly) {
    return {
      ok: false,
      pending: true,
      cached: false,
      productUrl: "",
      soldListings: [],
      soldGuides: [],
      gradedGuides: []
    };
  }
  const fresh = await fetchPriceChartingCardDetailsForCard({
    setCode,
    setName,
    cardNo,
    cardName
  });
  if (fresh?.ok) {
    writeCachedCardDetails(setCode, cardNo, fresh);
  }
  return { ...fresh, cached: false };
}

async function collectEnglishCardsForPriceChartingPrewarm(options = {}) {
  const onlySetCode = String(options.setCode || "")
    .trim()
    .toUpperCase();
  const raw = await fsp.readFile(SET_CARD_LIST_FILE, "utf8");
  const parsed = JSON.parse(raw);
  const byCode = parsed?.byCode && typeof parsed.byCode === "object" ? parsed.byCode : {};
  const cards = [];
  for (const [setCode, entry] of Object.entries(byCode)) {
    const code = String(setCode || "").trim().toUpperCase();
    if (!code) continue;
    if (code === "SVE") continue;
    if (onlySetCode && code !== onlySetCode) continue;
    const cardMap = entry?.cards && typeof entry.cards === "object" ? entry.cards : {};
    const setName = String(entry?.sourceTitle || "").trim();
    for (const [cardNo, cardName] of Object.entries(cardMap)) {
      const no = String(cardNo || "").trim();
      if (!no) continue;
      cards.push({
        setCode: code,
        setName,
        cardNo: no,
        cardName: decodeHtmlName(cardName)
      });
    }
  }
  return cards;
}

/** Full English catalog size for admin “Total PriceCharting Sections”. Cached briefly. */
let englishCardUniverseCache = { expiresAt: 0, count: 0 };

async function getPriceChartingEnglishCardUniverseCount() {
  const now = Date.now();
  if (englishCardUniverseCache.expiresAt > now && englishCardUniverseCache.count > 0) {
    return englishCardUniverseCache.count;
  }
  try {
    const cards = await collectEnglishCardsForPriceChartingPrewarm();
    englishCardUniverseCache = {
      expiresAt: now + 1000 * 60 * 30,
      count: cards.length
    };
    return cards.length;
  } catch {
    return englishCardUniverseCache.count || 0;
  }
}

async function refreshPriceChartingCardDetailsBatch(
  cards,
  {
    concurrency = 1,
    max = 100_000,
    skipValidCached = false,
    persistEvery = DEFAULT_BULK_PERSIST_EVERY,
    onProgress,
    onFail,
    onPersistInterval,
    onSetComplete,
    shouldCancel = () => false
  } = {}
) {
  let list = (Array.isArray(cards) ? cards : []).slice(0, max);
  if (!list.length) return { ok: 0, fail: 0, skipped: 0, total: 0, cancelled: false };

  // Hit gaps first so a long skip of already-cached cards does not look idle/stuck.
  if (skipValidCached && list.length > 1) {
    const missing = [];
    const cached = [];
    for (const card of list) {
      if (readCachedCardDetails(card.setCode, card.cardNo)) cached.push(card);
      else missing.push(card);
    }
    list = missing.concat(cached);
  }

  let cursor = 0;
  let ok = 0;
  let fail = 0;
  let skipped = 0;
  let processed = 0;
  let currentCard = null;
  const notFoundThisRun = new Set();
  const remainingBySet = new Map();
  const completedSets = new Set();
  for (const card of list) {
    const code = String(card?.setCode || "").trim().toUpperCase();
    if (!code) continue;
    remainingBySet.set(code, (remainingBySet.get(code) || 0) + 1);
  }
  const markSetDone = (setCode = "") => {
    const code = String(setCode || "").trim().toUpperCase();
    if (!code || !remainingBySet.has(code) || completedSets.has(code)) return;
    const next = (remainingBySet.get(code) || 0) - 1;
    if (next > 0) {
      remainingBySet.set(code, next);
      return;
    }
    remainingBySet.set(code, 0);
    completedSets.add(code);
    if (typeof onSetComplete === "function") {
      try {
        onSetComplete(code);
      } catch {
        // best effort
      }
    }
  };

  const reportProgress = () => {
    if (typeof onProgress !== "function") return;
    const card = currentCard && typeof currentCard === "object" ? currentCard : {};
    onProgress({
      total: list.length,
      done: ok + fail + skipped,
      ok,
      fail,
      skipped,
      currentSetCode: String(card.setCode || "").trim().toUpperCase(),
      currentSetName: String(card.setName || "").trim(),
      currentCardNo: String(card.cardNo || "").trim(),
      currentCardName: String(card.cardName || "").trim(),
      completedSets: [...completedSets],
      ...getPriceChartingCardDetailsCacheMeta()
    });
  };

  bulkPersistSuspended = true;
  try {
    const workers = Array.from({ length: Math.min(concurrency, list.length) }, async () => {
      while (cursor < list.length) {
        if (shouldCancel()) break;
        const card = list[cursor];
        cursor += 1;
        currentCard = card;
        reportProgress();
        try {
          const cardKey = cacheKeyForCard(card.setCode, card.cardNo);
          if (skipValidCached && readCachedCardDetails(card.setCode, card.cardNo)) {
            skipped += 1;
          } else if (cardKey && notFoundThisRun.has(cardKey)) {
            fail += 1;
          } else {
            const result = await getOrFetchPriceChartingCardDetails(card, { forceRefresh: true });
            if (result?.ok) {
              ok += 1;
            } else {
              fail += 1;
              if (cardKey) notFoundThisRun.add(cardKey);
              if (typeof onFail === "function") {
                onFail(card, result?.error || "PriceCharting details fetch failed");
              }
            }
          }
        } catch (err) {
          fail += 1;
          const cardKey = cacheKeyForCard(card?.setCode, card?.cardNo);
          if (cardKey) notFoundThisRun.add(cardKey);
          if (typeof onFail === "function") {
            onFail(card, err?.message || "PriceCharting details fetch failed");
          }
        }
        markSetDone(card?.setCode);
        processed += 1;
        if (persistEvery > 0 && processed % persistEvery === 0) {
          // Fire-and-forget so R2 uploads don't pause/OOM the scrape workers.
          void enqueuePersistPriceChartingCardDetailsCacheNow();
          if (typeof onPersistInterval === "function") {
            void Promise.resolve(onPersistInterval()).catch(() => {});
          }
        }
        if (processed % 3 === 0 || processed === list.length) reportProgress();
      }
    });

    await Promise.all(workers);
    reportProgress();
  } finally {
    bulkPersistSuspended = false;
    try {
      await persistChain.catch(() => {});
      await persistPriceChartingCardDetailsCacheNow();
    } catch (err) {
      console.warn(`[pricing-cache] final PriceCharting details persist failed: ${err?.message || err}`);
    }
  }

  return {
    ok,
    fail,
    skipped,
    total: list.length,
    cancelled: shouldCancel(),
    completedSets: [...completedSets]
  };
}

module.exports = {
  loadPersistedPriceChartingCardDetailsCache,
  persistPriceChartingCardDetailsCacheNow,
  enqueuePersistPriceChartingCardDetailsCacheNow,
  getPriceChartingCardDetailsCacheMeta,
  readCachedCardDetails,
  writeCachedCardDetails,
  getOrFetchPriceChartingCardDetails,
  cacheKeyForSealedProduct,
  readCachedSealedProductDetails,
  writeCachedSealedProductDetails,
  getOrFetchPriceChartingSealedDetails,
  averageRecentUngradedSoldPrice,
  collectEnglishCardsForPriceChartingPrewarm,
  getPriceChartingEnglishCardUniverseCount,
  refreshPriceChartingCardDetailsBatch,
  DEFAULT_BULK_PERSIST_EVERY
};
