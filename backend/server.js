const http = require("http");
const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");
const crypto = require("crypto");
const { spawn } = require("child_process");
const { URL } = require("url");
const { resolveChaseLocalImagesBatch } = require("./chase-resolve-local-images");
const pokeScanner = require("./poke-scanner");
const {
  refreshAmazonItems,
  refreshTargetWalmartItems,
  refreshInStockPrices
} = require("./lib/amazon-availability");
const {
  refreshSmokeAndMirrorsCatalog,
  refreshPokeNeCatalog
} = require("./lib/restock-catalog-refresh");
const {
  buildLocalImageIndexFromDisk,
  hydrateByCodeWithDiskImages
} = require("./lib/local-card-images");
const { fetchCardImageBytes } = require("./lib/card-image-remote");
const { isLfsPointer, materializeLfsFile, materializeDirectoryIfNeeded } = require("./lib/github-lfs-materialize");
const { fetchPokesymbolBytes, hydratePokesymbolsFromCdnIfNeeded } = require("./lib/pokesymbols-cdn");
const { isSelfHosted } = require("./lib/self-hosted");
const {
  isDetailsCatalogComplete,
  finalizeLocalCardDetailsFile
} = require("./lib/finalize-local-card-details");
const {
  parseAdminUsernameList,
  isAdminUserRecord,
  ensureDefaultAdminRoles,
  withAdminFlag
} = require("./lib/admin-auth");
const {
  loadRestockManualItems,
  mergeRestockTrackerPayload,
  addRestockManualItem,
  removeRestockManualItem
} = require("./lib/restock-manual");
const {
  loadCardNicknames,
  addCardNickname,
  removeCardNickname,
  findNicknamesForQuery,
  publicNicknamePayload
} = require("./lib/card-nicknames");
const {
  fetchPriceChartingMarketHistoryForCard,
  fetchPriceChartingUngradedPriceForCard,
  fetchPriceChartingUngradedPriceFromProductUrl,
  fetchPriceChartingCardDetailsFromProductUrl,
  comparePriceChartingSeries
} = require("./lib/pricecharting-market-history");
const {
  loadPersistedPriceChartingCardDetailsCache,
  getOrFetchPriceChartingCardDetails,
  getPriceChartingCardDetailsCacheMeta,
  collectEnglishCardsForPriceChartingPrewarm,
  refreshPriceChartingCardDetailsBatch,
  enqueuePersistPriceChartingCardDetailsCacheNow,
  writeCachedCardDetails,
  persistPriceChartingCardDetailsCacheNow
} = require("./lib/pricecharting-card-details-cache");
const { loadPersistedPriceChartingMarketHistoryCache } = require("./lib/pricecharting-market-history-cache");
const { requestPasswordReset, completePasswordReset, isEmailConfigured } = require("./lib/password-reset");
const { pullStoreFromR2, pushStoreToR2 } = require("./lib/store-r2-sync");
const {
  pullPricingCacheFromR2,
  pushPricingCacheToR2,
  setPricingCacheR2Env
} = require("./lib/pricing-cache-r2-sync");
const {
  defaultShowcaseSettings,
  normalizeShowcaseSettings,
  ensureUserShowcase,
  normalizeUsernameSlug,
  showcasePathForUsername,
  publicShowcaseProfilePayload,
  publicShowcaseItemPayload,
  summarizeShowcaseCollection,
  migrateStoreCollections,
  effectiveItemValue
} = require("./lib/showcase");
const {
  buildShowcaseSetLookup,
  resolveSetCodeForItem,
  resolveShowcaseImageUrl,
  resolveCanonicalCardNumber
} = require("./lib/showcase-enrich");
const {
  parseCollectrProfileUrl,
  fetchCollectrShowcaseCatalog,
  filterCollectrPokemonProducts,
  filterCollectrProductsByImportType,
  mapCollectrProductToItem,
  itemImportKey
} = require("./lib/collectr-import");
const {
  saveShowcaseAvatarUpload,
  removeShowcaseAvatarFiles,
  normalizeShowcaseAvatarUrl
} = require("./lib/showcase-avatar");

const ROOT = path.resolve(__dirname, "..");
const FRONTEND_DIR = path.join(ROOT, "frontend");
const PRIVATE_ADMIN_DIR = path.join(ROOT, "backend", "private");
const DATA_DIR = path.join(__dirname, "data");
const DATA_FILE = path.join(DATA_DIR, "store.json");
const SET_IMAGE_DIR = path.join(DATA_DIR, "set-images");
const POKESYMBOLS_DIR = path.join(DATA_DIR, "pokesymbols");
const POKESYMBOLS_MANIFEST_FILE = path.join(POKESYMBOLS_DIR, "manifest.json");
const POKESYMBOLS_JSON_CACHE_CONTROL = "public, max-age=3600, stale-while-revalidate=86400";
let pokesymbolsManifestMem = null;
let pokesymbolsManifestMemMtime = 0;
let setImageManifestMem = null;
let setImageManifestMemMtime = 0;

async function getPokesymbolsManifestCached() {
  let mtimeMs = 0;
  try {
    const stat = await fsp.stat(POKESYMBOLS_MANIFEST_FILE);
    mtimeMs = stat.mtimeMs;
    if (pokesymbolsManifestMem && mtimeMs === pokesymbolsManifestMemMtime) return pokesymbolsManifestMem;
  } catch {
    throw new Error("Pokesymbols manifest missing");
  }
  const raw = await fsp.readFile(POKESYMBOLS_MANIFEST_FILE, "utf8");
  pokesymbolsManifestMem = JSON.parse(raw);
  pokesymbolsManifestMemMtime = mtimeMs;
  return pokesymbolsManifestMem;
}
const CARD_IMAGE_DIR = path.join(DATA_DIR, "card-images");
const CARD_IMAGE_JAPANESE_DIR = path.join(DATA_DIR, "card-images-japanese");
const SET_CARD_LIST_FILE = path.join(DATA_DIR, "set-card-lists.json");
const SET_CARD_IMPORT_STATUS_FILE = path.join(DATA_DIR, "set-card-import-status.json");
const SET_CARD_IMPORT_SCRIPT = path.join(__dirname, "scripts", "import-pkmncards-set-cards.js");
const SET_CARD_DETAILS_IMPORT_SCRIPT = path.join(
  __dirname,
  "scripts",
  "import-pkmncards-all-set-details.js"
);
const MIN_ENGLISH_SETS_FOR_COMPLETE = 80;
const MIN_ENGLISH_DETAIL_SETS_FOR_COMPLETE = 80;
const SET_CARD_DETAILS_FILE = path.join(DATA_DIR, "set-card-details.json");
const SET_CARD_DETAILS_BY_CODE_DIR = path.join(DATA_DIR, "set-card-details", "by-code");
const SET_CARD_DETAILS_IMPORT_STATUS_FILE = path.join(DATA_DIR, "set-card-details-import-status.json");
const RESTOCK_TRACKER_FILE = path.join(DATA_DIR, "restock-tracker.json");
const RESTOCK_MANUAL_ITEMS_FILE = path.join(DATA_DIR, "restock-manual-items.json");
const CARD_NICKNAMES_FILE = path.join(DATA_DIR, "card-nicknames.json");
const TCGPLAYER_CARD_OVERRIDES_FILE = path.join(DATA_DIR, "tcgplayer-card-overrides.json");
const PASSWORD_RESET_FILE = path.join(DATA_DIR, "password-reset-tokens.json");
let cardNicknamesMem = null;
let cardNicknamesMemMtime = 0;
let tcgplayerCardOverridesMem = null;
let tcgplayerCardOverridesMemMtime = 0;

async function getCardNicknamesCached() {
  let mtimeMs = 0;
  try {
    const stat = await fsp.stat(CARD_NICKNAMES_FILE);
    mtimeMs = stat.mtimeMs;
    if (cardNicknamesMem && mtimeMs === cardNicknamesMemMtime) return cardNicknamesMem;
  } catch {
    cardNicknamesMem = [];
    cardNicknamesMemMtime = 0;
    return cardNicknamesMem;
  }
  cardNicknamesMem = await loadCardNicknames(CARD_NICKNAMES_FILE);
  cardNicknamesMemMtime = mtimeMs;
  return cardNicknamesMem;
}

function invalidateCardNicknamesCache() {
  cardNicknamesMem = null;
  cardNicknamesMemMtime = 0;
}
const POWER_PACKS_CACHE_DIR = path.join(DATA_DIR, "power-packs-cache");
const TCG_LINK_PRICE_CACHE_FILE = path.join(DATA_DIR, "tcg-link-prices-cache.json");
const TCG_LINK_PRICE_FAIL_LINKS_FILE = path.join(DATA_DIR, "tcg-link-price-fail-links.json");
const TCG_LINK_PRICE_FAIL_LINKS_MAX = 2000;
const PRICECHARTING_DETAILS_FAIL_LINKS_FILE = path.join(DATA_DIR, "pricecharting-card-details-fail-links.json");
const PRICECHARTING_DETAILS_FAIL_LINKS_MAX = 2000;
const PRICECHARTING_DETAILS_PERSIST_EVERY = 100;
const SHOWCASE_AVATAR_DIR = path.join(DATA_DIR, "showcase-avatars");
const TCG_PRICE_LEDGER_FILE = path.join(DATA_DIR, "tcg-price-ledger.json");
const MARKET_HISTORY_RANGE_DAYS = {
  "30": 30,
  "90": 90,
  "180": 180,
  "365": 365,
  all: 0
};
const ENV_FILE = path.join(__dirname, ".env");
const SUPPORTED_IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif", ".avif", ".svg"]);
const IMAGE_CONTENT_TYPES = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".avif": "image/avif",
  ".svg": "image/svg+xml"
};

const DEFAULT_CURRENCY = process.env.DEFAULT_CURRENCY || "USD";
const DEFAULT_REGION = process.env.DEFAULT_REGION || "US";
const SESSION_COOKIE_NAME = "poke_session";
/** Default sign-in (no Remember me): browser session cookie; server TTL for cleanup. */
const SESSION_TTL_MS = 1000 * 60 * 60 * 24;
const SESSION_REMEMBER_TTL_MS = 1000 * 60 * 60 * 24 * 30;
const RESTOCK_AUTO_REFRESH_MS = 60 * 60 * 1000;
const SET_PRICING_CACHE_TTL_MS = 1000 * 60 * 60;
const SET_PRICING_ERROR_CACHE_TTL_MS = 1000 * 60 * 2;
/** Bump when pricing manifest shape/rules change (invalidates set pricing cache). */
const SET_PRICING_MANIFEST_VERSION = 3;
/** Persisted admin TCG link prices; long TTL so Sets inline prices stay valid between restarts. */
const TCG_LINK_PRICE_CACHE_TTL_MS = 1000 * 60 * 60 * 24 * 30;
/** Soft age after which background/admin refresh should re-fetch even if TTL is still valid. */
const TCG_LINK_PRICE_REFRESH_MAX_AGE_MS = 1000 * 60 * 60 * 24;
/** Admin "Update all" re-fetches prices older than this (keeps runs from re-scraping everything). */
const TCG_LINK_PRICE_ADMIN_REFRESH_MAX_AGE_MS = 1000 * 60 * 60;
/** Persist TCG link cache to disk every N processed cards during bulk refresh (reduces IO stalls). */
const TCG_LINK_PRICE_PERSIST_EVERY = 1000;
/** Bump when link-price selection rules change (invalidates persisted cache). */
const TCG_LINK_PRICE_LOGIC_VERSION = 9;
const TCG_PRICE_GUIDE_INDEX_TTL_MS = 1000 * 60 * 60 * 6;
/** App set code → TCGplayer price guide slug when auto-matching is unreliable. */
const TCG_GUIDE_SLUG_BY_SET_CODE = {
  CRI: "me04-chaos-rising"
};

let env = {};

function loadEnvFile() {
  try {
    const raw = fs.readFileSync(ENV_FILE, "utf8");
    for (const line of raw.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const idx = trimmed.indexOf("=");
      if (idx === -1) continue;
      const key = trimmed.slice(0, idx).trim();
      const value = trimmed.slice(idx + 1).trim();
      env[key] = value;
    }
  } catch {
    env = {};
  }
}

loadEnvFile();
setPricingCacheR2Env(env);

const PORT = Number(process.env.PORT || env.PORT || 3000);
let tcgTokenCache = {
  accessToken: null,
  expiresAt: 0
};
let priceChartingLastCallMs = 0;
let store = {
  users: [],
  items: [],
  pokeViewWatchlists: [],
  activities: [],
  refreshedAt: null
};
const sessions = new Map();
let restockRefreshTimer = null;
let restockRefreshKickoffTimer = null;
let restockRefreshInFlight = false;
let restockRefreshCancelRequested = false;
let restockRefreshMeta = {
  lastStartedAt: null,
  lastFinishedAt: null,
  lastError: null,
  lastInStockStamped: 0,
  lastAmazonStatusUpdates: 0,
  lastPriceUpdates: 0,
  lastSmokeStatusUpdates: 0,
  lastSmokePriceUpdates: 0,
  lastPokeNeStatusUpdates: 0,
  lastPokeNePriceUpdates: 0,
  lastSelectedRetailers: null,
  autoRefreshedAt: null,
  itemCount: 0,
  progress: {
    phase: "",
    label: "",
    current: 0,
    total: 0,
    percent: 0
  }
};

function setRestockRefreshProgress( partial = {}) {
  const prev = restockRefreshMeta.progress || {};
  const current = Number(partial.current ?? prev.current) || 0;
  const total = Number(partial.total ?? prev.total) || 0;
  let percent = Number(partial.percent);
  if (!Number.isFinite(percent)) {
    percent = total > 0 ? Math.round((current / total) * 100) : Number(prev.percent) || 0;
  }
  restockRefreshMeta.progress = {
    phase: String(partial.phase ?? prev.phase ?? ""),
    label: String(partial.label ?? prev.label ?? ""),
    current,
    total,
    percent: Math.max(0, Math.min(100, percent))
  };
}

async function readRestockTrackerMeta() {
  try {
    const raw = await fsp.readFile(RESTOCK_TRACKER_FILE, "utf8");
    const parsed = JSON.parse(raw);
    const items = Array.isArray(parsed.items) ? parsed.items : [];
    return {
      autoRefreshedAt: parsed.autoRefreshedAt || parsed.importedAt || null,
      importedAt: parsed.importedAt || null,
      itemCount: items.length
    };
  } catch {
    return { autoRefreshedAt: null, importedAt: null, itemCount: 0 };
  }
}
const setPricingCache = new Map();
const setPricingInFlight = new Map();
const tcgLinkPriceCache = new Map();
/** @type {Map<string, { url: string, productId: number|null, error: string, failedAt: string }>} */
const tcgLinkPriceFailLinks = new Map();
const tcgLinkPriceInFlight = new Map();
let tcgLinkPriceCachePersistTimer = null;
let tcgLinkPricePersistChain = Promise.resolve();
/** When true, skip debounce persists (bulk job uses interval + final save). */
let tcgLinkPriceBulkPersistSuspended = false;
let tcgLinkPricePrewarmInFlight = false;
let tcgLinkPricePrewarmKickoffTimer = null;
let tcgLinkPriceBackgroundTimer = null;
const tcgLinkPriceBackgroundQueue = new Map();
let tcgLinkPricePrewarmStatus = {
  lastRunAt: null,
  lastElapsedSec: 0,
  lastUrls: 0,
  lastOk: 0,
  lastFail: 0,
  lastSkipped: 0
};
const adminUsernames = parseAdminUsernameList({ ...process.env, ...env });
let tcgBulkPriceCheckMeta = {
  status: "idle",
  startedAt: null,
  finishedAt: null,
  lastSuccessfulAt: null,
  triggeredBy: null,
  logicVersion: TCG_LINK_PRICE_LOGIC_VERSION,
  progress: { total: 0, done: 0, ok: 0, fail: 0, skipped: 0 },
  lastError: null,
  cacheSavedAt: null,
  cacheEntryCount: 0,
  totalLinkCount: 0,
  pricedInCacheCount: 0,
  phase: null,
  setCode: null,
  setName: null
};
let tcgBulkPriceCheckJob = null;
let priceChartingDetailsPrewarmJob = null;
let tcgPriceCheckCancelRequested = false;
let priceChartingCancelRequested = false;
let priceChartingBulkMeta = {
  status: "idle",
  startedAt: null,
  finishedAt: null,
  lastSuccessfulAt: null,
  triggeredBy: null,
  progress: { total: 0, done: 0, ok: 0, fail: 0, skipped: 0 },
  lastError: null,
  cacheSavedAt: null,
  cacheEntryCount: 0
};
const priceChartingFailLinks = new Map();
let priceChartingFailLinksPersistTimer = null;
const TCG_LINK_PRICE_PREWARM_DELAY_MS = 140;
const TCG_LINK_PRICE_SET_MANIFEST_DELAY_MS = 80;
const TCG_LINK_PRICE_PREWARM_STARTUP_DELAY_MS = 180_000;
const TCG_CATALOG_PRIORITY_MS = 3 * 60 * 1000;
const SET_CATALOG_IMPORT_KICKOFF_DELAY_MS = 4_000;
let tcgCatalogPriorityUntilMs = 0;

function markTcgCatalogPriorityWindow(ms = TCG_CATALOG_PRIORITY_MS) {
  tcgCatalogPriorityUntilMs = Math.max(tcgCatalogPriorityUntilMs, Date.now() + ms);
}

function isTcgCatalogPriorityActive() {
  return Date.now() < tcgCatalogPriorityUntilMs;
}
let setCardListsDiskCache = { mtimeMs: 0, parsed: null };
let setCardDetailsDiskCache = { mtimeMs: 0, parsed: null };
let localCardImageIndexCache = { mtimeMs: 0, index: null };
let localCardImageIndexInFlight = null;
let englishSetCardsImportChild = null;
let englishSetDetailsImportChild = null;
let tcgPriceGuideIndexCache = {
  expiresAt: 0,
  rows: []
};
let tcgPriceGuideIndexInFlight = null;

async function ensureStore() {
  await fsp.mkdir(DATA_DIR, { recursive: true });
  await fsp.mkdir(SET_IMAGE_DIR, { recursive: true });
  await fsp.mkdir(POKESYMBOLS_DIR, { recursive: true });
  await fsp.mkdir(path.join(POKESYMBOLS_DIR, "symbols"), { recursive: true });
  await fsp.mkdir(path.join(POKESYMBOLS_DIR, "logos"), { recursive: true });
  await fsp.mkdir(CARD_IMAGE_DIR, { recursive: true });
  await fsp.mkdir(CARD_IMAGE_JAPANESE_DIR, { recursive: true });
  await fsp.mkdir(SHOWCASE_AVATAR_DIR, { recursive: true });
  await fsp.mkdir(POWER_PACKS_CACHE_DIR, { recursive: true });

  let parsed = null;
  // Prefer durable R2 copy on Cloudflare (container disk is ephemeral).
  try {
    const remote = await pullStoreFromR2({ ...env, ...process.env });
    if (remote && typeof remote === "object") parsed = remote;
  } catch (err) {
    console.warn(`[store] R2 pull skipped: ${err.message || err}`);
  }

  if (!parsed) {
    try {
      const raw = await fsp.readFile(DATA_FILE, "utf8");
      parsed = JSON.parse(raw);
    } catch {
      parsed = null;
    }
  }

  store = {
    users: Array.isArray(parsed?.users) ? parsed.users : [],
    items: Array.isArray(parsed?.items) ? parsed.items : [],
    pokeViewWatchlists: Array.isArray(parsed?.pokeViewWatchlists) ? parsed.pokeViewWatchlists : [],
    activities: Array.isArray(parsed?.activities) ? parsed.activities : [],
    refreshedAt: parsed?.refreshedAt || null
  };

  let storeChanged = false;
  if (migrateStoreCollections(store)) storeChanged = true;
  if (migratePlaintextPasswords(store)) storeChanged = true;
  if (ensureDefaultAdminRoles(store, adminUsernames)) storeChanged = true;

  // Always keep a local copy for this container lifetime.
  await fsp.writeFile(DATA_FILE, JSON.stringify(store, null, 2), "utf8");
  // Only push to R2 when we have something worth saving or migrations changed data.
  // Never boot-push an empty store (that used to wipe durable accounts).
  if (storeChanged || (Array.isArray(store.users) && store.users.length > 0)) {
    await pushStoreToR2(store, { ...env, ...process.env });
  }
}

async function persistStore() {
  await fsp.writeFile(DATA_FILE, JSON.stringify(store, null, 2), "utf8");
  // Await durable backup so signup/sign-in cannot finish before R2 has the account.
  await pushStoreToR2(store, { ...env, ...process.env });
}

function schedulePersistTcgLinkPriceCache() {
  if (tcgLinkPriceBulkPersistSuspended) return;
  if (tcgLinkPriceCachePersistTimer) return;
  tcgLinkPriceCachePersistTimer = setTimeout(() => {
    tcgLinkPriceCachePersistTimer = null;
    void enqueuePersistTcgLinkPriceCacheNow();
  }, 500);
}

function buildTcgLinkPriceCacheFilePayload(entries) {
  return {
    savedAt: new Date().toISOString(),
    logicVersion: TCG_LINK_PRICE_LOGIC_VERSION,
    meta: {
      status: tcgBulkPriceCheckMeta.status,
      startedAt: tcgBulkPriceCheckMeta.startedAt,
      finishedAt: tcgBulkPriceCheckMeta.finishedAt,
      lastSuccessfulAt: tcgBulkPriceCheckMeta.lastSuccessfulAt,
      triggeredBy: tcgBulkPriceCheckMeta.triggeredBy,
      logicVersion: TCG_LINK_PRICE_LOGIC_VERSION,
      progress: tcgBulkPriceCheckMeta.progress,
      lastError: tcgBulkPriceCheckMeta.lastError,
      cacheSavedAt: tcgBulkPriceCheckMeta.cacheSavedAt,
      cacheEntryCount: tcgBulkPriceCheckMeta.cacheEntryCount,
      totalLinkCount: tcgBulkPriceCheckMeta.totalLinkCount,
      pricedInCacheCount: tcgBulkPriceCheckMeta.pricedInCacheCount,
      phase: tcgBulkPriceCheckMeta.phase,
      setCode: tcgBulkPriceCheckMeta.setCode,
      setName: tcgBulkPriceCheckMeta.setName
    },
    entries: Array.isArray(entries) ? entries : []
  };
}

async function persistTcgLinkPriceCacheNow() {
  if (tcgLinkPriceCachePersistTimer) {
    clearTimeout(tcgLinkPriceCachePersistTimer);
    tcgLinkPriceCachePersistTimer = null;
  }
  const now = Date.now();
  const entries = [];
  for (const [key, row] of tcgLinkPriceCache.entries()) {
    if (!row || typeof row !== "object") continue;
    const expiresAt = Number(row.expiresAt || 0);
    if (!Number.isFinite(expiresAt) || expiresAt <= now) continue;
    entries.push({
      key: String(key),
      expiresAt,
      value: row.value && typeof row.value === "object" ? row.value : null
    });
  }
  tcgBulkPriceCheckMeta.cacheEntryCount = entries.length;
  tcgBulkPriceCheckMeta.cacheSavedAt = new Date().toISOString();
  const body = JSON.stringify(buildTcgLinkPriceCacheFilePayload(entries), null, 2);
  await fsp.writeFile(TCG_LINK_PRICE_CACHE_FILE, body, "utf8");
  const r2 = await pushPricingCacheToR2("tcg-link-prices-cache.json", body, { ...env, ...process.env });
  if (r2?.ok) {
    console.log(`[pricing-cache] TCG link prices saved (${entries.length} entries, R2 ok)`);
  } else if (!r2?.skipped) {
    console.warn("[pricing-cache] TCG link prices saved to disk but R2 push failed");
  }
}

function enqueuePersistTcgLinkPriceCacheNow() {
  tcgLinkPricePersistChain = tcgLinkPricePersistChain
    .then(() => persistTcgLinkPriceCacheNow())
    .catch((err) => {
      console.warn(`[pricing-cache] TCG link price persist failed: ${err?.message || err}`);
    });
  return tcgLinkPricePersistChain;
}

function tcgLinkPriceCacheValueValid(value) {
  return Boolean(
    value &&
      value.ok &&
      Number(value.logicVersion) === TCG_LINK_PRICE_LOGIC_VERSION
  );
}

function getTcgLinkPriceCacheLiveStats() {
  const now = Date.now();
  let cachedCount = 0;
  let pricedInCacheCount = 0;
  for (const row of tcgLinkPriceCache.values()) {
    if (!row || typeof row !== "object") continue;
    const expiresAt = Number(row.expiresAt || 0);
    if (!Number.isFinite(expiresAt) || expiresAt <= now) continue;
    cachedCount += 1;
    if (tcgLinkPriceCacheValueValid(row.value)) pricedInCacheCount += 1;
  }
  const totalLinkCount =
    Number(tcgBulkPriceCheckMeta.totalLinkCount) > 0
      ? Number(tcgBulkPriceCheckMeta.totalLinkCount)
      : Number(tcgBulkPriceCheckMeta.progress?.total) || 0;
  return {
    cachedCount,
    pricedInCacheCount,
    totalLinkCount,
    cacheEntryCount: cachedCount,
    updatedAt: new Date().toISOString()
  };
}

function syncTcgBulkPriceCheckCacheCount() {
  const live = getTcgLinkPriceCacheLiveStats();
  tcgBulkPriceCheckMeta.cacheEntryCount = live.cachedCount;
  tcgBulkPriceCheckMeta.pricedInCacheCount = live.pricedInCacheCount;
  return live;
}

function isTcgPriceCheckCancelled() {
  return tcgPriceCheckCancelRequested;
}

function isPriceChartingCancelled() {
  return priceChartingCancelRequested;
}

function clearTcgPriceCheckCancelFlag() {
  tcgPriceCheckCancelRequested = false;
}

function clearPriceChartingCancelFlag() {
  priceChartingCancelRequested = false;
}

function isTcgBulkPriceCheckInFlight() {
  return Boolean(tcgBulkPriceCheckJob || tcgLinkPricePrewarmInFlight);
}

function isPriceChartingDetailsPrewarmInFlight() {
  return Boolean(priceChartingDetailsPrewarmJob);
}

/** True only while an admin-started bulk TCG link price job is running. */
function isTcgAdminPriceCachingActive() {
  return isTcgBulkPriceCheckInFlight();
}

function clearTcgLinkPriceBackgroundWork() {
  tcgLinkPriceBackgroundQueue.clear();
  if (tcgLinkPriceBackgroundTimer) {
    clearTimeout(tcgLinkPriceBackgroundTimer);
    tcgLinkPriceBackgroundTimer = null;
  }
}

function requestStopTcgPriceCheck() {
  if (!isTcgBulkPriceCheckInFlight()) {
    return { ok: false, reason: "not_running" };
  }
  tcgPriceCheckCancelRequested = true;
  if (tcgLinkPricePrewarmKickoffTimer) {
    clearTimeout(tcgLinkPricePrewarmKickoffTimer);
    tcgLinkPricePrewarmKickoffTimer = null;
  }
  clearTcgLinkPriceBackgroundWork();
  return { ok: true };
}

function requestStopPriceChartingDetailsCheck() {
  if (!isPriceChartingDetailsPrewarmInFlight()) {
    return { ok: false, reason: "not_running" };
  }
  priceChartingCancelRequested = true;
  return { ok: true };
}

function stampTcgLinkPriceResult(value) {
  if (!value || typeof value !== "object") return value;
  return {
    ...value,
    logicVersion: TCG_LINK_PRICE_LOGIC_VERSION,
    fetchedAt: new Date().toISOString()
  };
}

function getTcgLinkPriceCacheFetchedAt(value) {
  const parsed = Date.parse(String(value?.fetchedAt || ""));
  return Number.isFinite(parsed) ? parsed : 0;
}

function isTcgLinkPriceCacheFresh(productId, rawUrl = "", maxAgeMs = TCG_LINK_PRICE_REFRESH_MAX_AGE_MS) {
  const cached = readTcgLinkPriceFromCache(productId, rawUrl);
  if (!cached) return false;
  const fetchedAt = getTcgLinkPriceCacheFetchedAt(cached);
  // Legacy rows without fetchedAt are treated as stale so the next refresh updates them.
  if (!fetchedAt) return false;
  const ageLimit = Number.isFinite(maxAgeMs) ? Math.max(0, maxAgeMs) : TCG_LINK_PRICE_REFRESH_MAX_AGE_MS;
  return Date.now() - fetchedAt < ageLimit;
}

function enrichTcgLinkPriceResult(value) {
  if (!value || typeof value !== "object" || !value.ok) return value;
  const nearMintPrice = Number(value.nearMintPrice);
  const shippingPrice = Number(value.shippingPrice);
  const listingCondition = String(value.listingCondition || "Near Mint").trim() || "Near Mint";
  let nearMintWithShipping = String(value.nearMintWithShipping || "").trim();
  if (!nearMintWithShipping && Number.isFinite(nearMintPrice) && nearMintPrice > 0) {
    nearMintWithShipping = formatTcgListingWithShippingDisplay(
      nearMintPrice,
      Number.isFinite(shippingPrice) && shippingPrice >= 0 ? shippingPrice : 0
    );
  }
  const totalPrice = Number(value.totalPrice ?? value.price);
  return {
    ...value,
    listingCondition,
    nearMintWithShipping,
    totalPrice: Number.isFinite(totalPrice) && totalPrice > 0 ? totalPrice : null,
    price: Number.isFinite(totalPrice) && totalPrice > 0 ? totalPrice : value.price
  };
}

function toTcgLinkPriceClientNode(cachedValue) {
  const enriched = enrichTcgLinkPriceResult(cachedValue);
  if (!enriched || typeof enriched !== "object" || !enriched.ok) return null;
  const totalPrice = Number(enriched.totalPrice ?? enriched.price);
  const nearMintPrice = Number(enriched.nearMintPrice);
  const shippingPrice = Number(enriched.shippingPrice);
  return {
    totalPrice: Number.isFinite(totalPrice) && totalPrice > 0 ? totalPrice : null,
    nearMintPrice: Number.isFinite(nearMintPrice) && nearMintPrice > 0 ? nearMintPrice : null,
    shippingPrice: Number.isFinite(shippingPrice) && shippingPrice >= 0 ? shippingPrice : null,
    listingCondition: enriched.listingCondition ? String(enriched.listingCondition) : "Near Mint",
    nearMintWithShipping: enriched.nearMintWithShipping ? String(enriched.nearMintWithShipping) : "",
    sellerName: enriched.sellerName ? String(enriched.sellerName) : "",
    source: enriched.source ? String(enriched.source) : "",
    pricingLogicVersion: Number(enriched.logicVersion) || 0,
    cached: true
  };
}

function getCachedSetPricingManifestOnly(setCode = "", setName = "") {
  const cacheKey = getSetPricingCacheKey(setCode, setName);
  const cached = setPricingCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.value;
  return null;
}

function buildTcgUrlPriceChartingContextFromManifest(manifest, setCode = "", setName = "") {
  const map = new Map();
  const code = String(setCode || "").trim().toUpperCase();
  const name = String(setName || "").trim();
  const makeCtx = (cardNo, cardName) => ({
    setCode: code,
    setName: name,
    cardNo: String(cardNo || "").trim(),
    cardName: String(cardName || "").trim()
  });
  const addUrl = (url, ctx) => {
    const normalized = String(url || "").trim();
    if (!normalized || !ctx.cardNo) return;
    if (!map.has(normalized)) map.set(normalized, ctx);
  };

  const byCardNo =
    manifest && manifest.byCardNo && typeof manifest.byCardNo === "object" ? manifest.byCardNo : {};
  for (const [key, entry] of Object.entries(byCardNo)) {
    const cardNo = String(entry?.cardNumber || key || "").trim();
    addUrl(entry?.tcgplayerUrl, makeCtx(cardNo, entry?.name));
  }

  const variantsByCardNo =
    manifest && manifest.variantsByCardNo && typeof manifest.variantsByCardNo === "object"
      ? manifest.variantsByCardNo
      : {};
  for (const [key, variants] of Object.entries(variantsByCardNo)) {
    if (!Array.isArray(variants)) continue;
    const cardNo = String(key || "").trim();
    for (const variant of variants) {
      addUrl(variant?.tcgplayerUrl, makeCtx(cardNo, variant?.name || byCardNo[key]?.name));
    }
  }
  return map;
}

function normalizePriceChartingContextByUrl(input) {
  if (input instanceof Map) return input;
  const map = new Map();
  if (input && typeof input === "object") {
    for (const [url, ctx] of Object.entries(input)) {
      if (ctx && typeof ctx === "object") map.set(String(url || "").trim(), ctx);
    }
  }
  return map;
}

async function buildTcgPriceFromPriceChartingUngraded(productId, rawUrl, priceChartingContext = null) {
  const ctx = priceChartingContext && typeof priceChartingContext === "object" ? priceChartingContext : null;
  if (!ctx?.setCode || !ctx?.cardNo) return null;
  try {
    const pc = await fetchPriceChartingUngradedPriceForCard(ctx);
    if (!pc?.ok || !Number(pc.ungradedPrice) || pc.ungradedPrice <= 0) return null;
    const price = Number(pc.ungradedPrice);
    return stampTcgLinkPriceResult({
      ok: true,
      productId,
      price,
      totalPrice: price,
      nearMintPrice: price,
      shippingPrice: 0,
      listingCondition: "Ungraded",
      nearMintWithShipping: `$${price.toFixed(2)} · PriceCharting`,
      sellerName: "",
      listingId: null,
      source: "pricecharting-ungraded",
      marketPrice: null,
      priceChartingProductUrl: String(pc.productUrl || "").trim(),
      error: ""
    });
  } catch {
    return null;
  }
}

function collectTcgplayerUrlsFromLinkPriceCache() {
  const urls = [];
  for (const [key, row] of tcgLinkPriceCache.entries()) {
    const value = row?.value && typeof row.value === "object" ? row.value : null;
    const pid = Number(value?.productId) || Number(String(key).split("::")[0]);
    if (!Number.isFinite(pid) || pid <= 0) continue;
    const printing = String(key).includes("::")
      ? String(key)
          .slice(String(key).indexOf("::") + 2)
          .trim()
      : "";
    let url = `https://www.tcgplayer.com/product/${pid}`;
    if (printing) {
      const printLabel = printing
        .split(/[\s_-]+/)
        .filter(Boolean)
        .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
        .join(" ");
      url += `?Language=English&Printing=${encodeURIComponent(printLabel || printing)}`;
    }
    urls.push(url);
  }
  return urls;
}

function collectTcgplayerUrlsFromPricingManifest(manifest) {
  const urls = new Set();
  const byCardNo = manifest && manifest.byCardNo && typeof manifest.byCardNo === "object" ? manifest.byCardNo : {};
  for (const entry of Object.values(byCardNo)) {
    const url = String(entry?.tcgplayerUrl || "").trim();
    if (url) urls.add(url);
  }
  const variantsByCardNo =
    manifest && manifest.variantsByCardNo && typeof manifest.variantsByCardNo === "object"
      ? manifest.variantsByCardNo
      : {};
  for (const variants of Object.values(variantsByCardNo)) {
    if (!Array.isArray(variants)) continue;
    for (const variant of variants) {
      const url = String(variant?.tcgplayerUrl || "").trim();
      if (url) urls.add(url);
    }
  }
  return [...urls];
}

function kickTcgLinkPriceBackgroundDrain() {
  if (tcgLinkPriceBackgroundTimer || tcgLinkPricePrewarmInFlight) return;
  if (!tcgLinkPriceBackgroundQueue.size) return;
  const delayMs = isTcgCatalogPriorityActive() ? 8000 : 2500;
  tcgLinkPriceBackgroundTimer = setTimeout(() => {
    tcgLinkPriceBackgroundTimer = null;
    drainTcgLinkPriceBackgroundQueue().catch(() => {});
  }, delayMs);
}

function queueTcgLinkPriceBackgroundRefresh(rawUrl = "") {
  if (!isTcgAdminPriceCachingActive()) return;
  if (isTcgCatalogPriorityActive()) return;
  const url = String(rawUrl || "").trim();
  const productId = extractTcgplayerProductIdFromUrl(url);
  if (!url || !productId) return;
  const cacheKey = getTcgLinkPriceCacheKey(url, productId) || String(productId);
  tcgLinkPriceBackgroundQueue.set(cacheKey, url);
  kickTcgLinkPriceBackgroundDrain();
}

async function drainTcgLinkPriceBackgroundQueue() {
  if (!isTcgAdminPriceCachingActive()) {
    clearTcgLinkPriceBackgroundWork();
    return;
  }
  if (isTcgCatalogPriorityActive()) {
    kickTcgLinkPriceBackgroundDrain();
    return;
  }
  if (tcgLinkPricePrewarmInFlight || tcgLinkPriceBackgroundQueue.size === 0) return;
  const batch = [...tcgLinkPriceBackgroundQueue.entries()].slice(0, 4);
  for (const [productId] of batch) {
    tcgLinkPriceBackgroundQueue.delete(productId);
  }
  await refreshTcgLinkPricesForUrls(
    batch.map(([, url]) => url),
    { concurrency: 4, max: batch.length }
  );
  if (tcgLinkPriceBackgroundQueue.size > 0) {
    kickTcgLinkPriceBackgroundDrain();
  }
}

function readTcgLinkPriceFromCache(productId, rawUrl = "") {
  const pid = Number(productId) || extractTcgplayerProductIdFromUrl(rawUrl);
  const now = Date.now();
  const tryReadKey = (key) => {
    const cached = tcgLinkPriceCache.get(String(key || "").trim());
    if (!cached || cached.expiresAt <= now || !tcgLinkPriceCacheValueValid(cached.value)) {
      return null;
    }
    return enrichTcgLinkPriceResult({ ...cached.value, cached: true });
  };

  const cacheKey = getTcgLinkPriceCacheKey(rawUrl, pid) || (pid ? String(pid) : "");
  const direct = cacheKey ? tryReadKey(cacheKey) : null;
  if (direct) return direct;

  if (!Number.isFinite(pid) || pid <= 0) return null;

  const printing = extractTcgPrintingFromUrl(rawUrl).toLowerCase();
  if (printing) {
    const withPrinting = tryReadKey(`${pid}::${printing}`);
    if (withPrinting) return withPrinting;
  }

  const prefix = `${pid}::`;
  let best = null;
  let bestTotal = Number.POSITIVE_INFINITY;
  for (const [key, row] of tcgLinkPriceCache.entries()) {
    if (key !== String(pid) && !key.startsWith(prefix)) continue;
    const hit = tryReadKey(key);
    if (!hit) continue;
    const total = Number(hit.totalPrice ?? hit.price);
    if (!Number.isFinite(total) || total <= 0) continue;
    if (total < bestTotal) {
      bestTotal = total;
      best = hit;
    }
  }
  return best;
}

async function refreshTcgLinkPricesForUrls(
  urls,
  {
    concurrency = 6,
    max = 50_000,
    onProgress,
    skipValidCached = false,
    maxAgeMs = TCG_LINK_PRICE_REFRESH_MAX_AGE_MS,
    persistEvery = TCG_LINK_PRICE_PERSIST_EVERY,
    priceChartingContextByUrl = null
  } = {}
) {
  const pcContextByUrl = normalizePriceChartingContextByUrl(priceChartingContextByUrl);
  const freshnessMs = Number.isFinite(Number(maxAgeMs))
    ? Math.max(0, Number(maxAgeMs))
    : TCG_LINK_PRICE_REFRESH_MAX_AGE_MS;
  const list = [...new Set((Array.isArray(urls) ? urls : []).map((u) => String(u || "").trim()).filter(Boolean))].slice(
    0,
    max
  );
  if (!list.length) return { ok: 0, fail: 0, skipped: 0, total: 0 };
  let cursor = 0;
  let ok = 0;
  let fail = 0;
  let skipped = 0;
  let processed = 0;
  const reportProgress = () => {
    const live = syncTcgBulkPriceCheckCacheCount();
    if (typeof onProgress !== "function") return;
    onProgress({ total: list.length, done: ok + fail + skipped, ok, fail, skipped, ...live });
  };
  tcgLinkPriceBulkPersistSuspended = true;
  try {
    const workers = Array.from({ length: Math.min(concurrency, list.length) }, async () => {
      while (cursor < list.length) {
        if (isTcgPriceCheckCancelled()) break;
        const url = list[cursor];
        cursor += 1;
        try {
          const productId = extractTcgplayerProductIdFromUrl(url);
          if (skipValidCached && productId && isTcgLinkPriceCacheFresh(productId, url, freshnessMs)) {
            skipped += 1;
          } else {
            const result = await fetchTcgPriceFromProductLink(url, {
              forceRefresh: true,
              priceChartingContext: pcContextByUrl.get(url) || null
            });
            if (result && result.ok) {
              ok += 1;
              removeTcgLinkPriceFailLink(url);
            } else if (result?.skippedNonPokemon) {
              skipped += 1;
              removeTcgLinkPriceFailLink(url);
            } else {
              fail += 1;
              recordTcgLinkPriceFailLink(url, result?.error || "Price fetch failed");
            }
          }
        } catch (err) {
          fail += 1;
          recordTcgLinkPriceFailLink(url, err?.message || "Price fetch failed");
        }
        processed += 1;
        if (persistEvery > 0 && processed % persistEvery === 0) {
          await enqueuePersistTcgLinkPriceCacheNow();
        }
        if (processed % 8 === 0 || processed === list.length) reportProgress();
      }
    });
    await Promise.all(workers);
    reportProgress();
    return { ok, fail, skipped, total: list.length, cancelled: isTcgPriceCheckCancelled() };
  } finally {
    tcgLinkPriceBulkPersistSuspended = false;
    try {
      await persistTcgLinkPriceCacheNow();
    } catch (err) {
      console.warn(`[pricing-cache] final TCG link price persist failed: ${err?.message || err}`);
    }
  }
}

async function listEnglishSetPricingTargets() {
  const manifest = await getSetCardManifest("english");
  const byCode = manifest.byCode && typeof manifest.byCode === "object" ? manifest.byCode : {};
  return Object.entries(byCode).map(([setCode, row]) => ({
    setCode: String(setCode || "").trim().toUpperCase(),
    setName: String(row?.sourceTitle || row?.name || row?.setName || "").trim()
  }));
}

function getTcgLinkCacheMeta() {
  const live = syncTcgBulkPriceCheckCacheCount();
  const cacheSavedAt = tcgBulkPriceCheckMeta.cacheSavedAt || null;
  const pricedInCacheCount = Number(live.pricedInCacheCount) || 0;
  return {
    logicVersion: TCG_LINK_PRICE_LOGIC_VERSION,
    cacheSavedAt,
    pricedInCacheCount,
    cacheGenerationKey: `${TCG_LINK_PRICE_LOGIC_VERSION}::${cacheSavedAt || "unknown"}::${pricedInCacheCount}`,
    ...live
  };
}

async function buildSetLinkPricesPayload(setCode = "", setName = "") {
  let manifest = getCachedSetPricingManifestOnly(setCode, setName);
  if (!manifest || !manifest.byCardNo || !Object.keys(manifest.byCardNo).length) {
    try {
      manifest = await getSetCardPricingManifest(setCode, setName);
    } catch {
      manifest = null;
    }
  } else {
    try {
      manifest = await applyTcgplayerCardOverridesToManifest(manifest, setCode);
    } catch {
      // keep cached manifest without overrides
    }
  }
  const urls = manifest ? collectTcgplayerUrlsFromPricingManifest(manifest) : [];
  const priceChartingContextByUrl = manifest
    ? buildTcgUrlPriceChartingContextFromManifest(manifest, setCode, setName)
    : new Map();
  const byUrl = {};
  const pendingUrls = [];
  for (const url of urls) {
    const productId = extractTcgplayerProductIdFromUrl(url);
    if (!productId) continue;
    const cached = readTcgLinkPriceFromCache(productId, url);
    if (cached) {
      const node = toTcgLinkPriceClientNode(cached);
      if (node) byUrl[url] = node;
      continue;
    }
    const pcContext = priceChartingContextByUrl.get(url) || null;
    const pcFallback = await buildTcgPriceFromPriceChartingUngraded(productId, url, pcContext);
    if (pcFallback && tcgLinkPriceCacheValueValid(pcFallback)) {
      const cacheKey = getTcgLinkPriceCacheKey(url, productId) || String(productId);
      tcgLinkPriceCache.set(cacheKey, {
        value: pcFallback,
        expiresAt: Date.now() + TCG_LINK_PRICE_CACHE_TTL_MS
      });
      schedulePersistTcgLinkPriceCache();
      removeTcgLinkPriceFailLink(url);
      const node = toTcgLinkPriceClientNode(pcFallback);
      if (node) byUrl[url] = node;
      continue;
    }
    pendingUrls.push(url);
    queueTcgLinkPriceBackgroundRefresh(url);
  }
  return {
    ok: true,
    ...getTcgLinkCacheMeta(),
    setCode: String(setCode || "").trim().toUpperCase(),
    setName: String(setName || "").trim(),
    cachedCount: Object.keys(byUrl).length,
    linkCount: urls.length,
    pendingCount: pendingUrls.length,
    pricingManifestCached: Boolean(manifest),
    prewarmInFlight: tcgLinkPricePrewarmInFlight,
    prewarmLastRunAt: tcgLinkPricePrewarmStatus.lastRunAt,
    byUrl
  };
}

async function collectAllTcgplayerUrlsForPrewarm({ onProgress } = {}) {
  const urls = new Set(collectTcgplayerUrlsFromLinkPriceCache());
  const priceChartingContextByUrl = new Map();
  const targets = (await listEnglishSetPricingTargets()).filter((target) => target?.setCode);
  const totalSets = targets.length;
  let setsDone = 0;
  const report = (phase = "collecting") => {
    if (typeof onProgress !== "function") return;
    onProgress({
      phase,
      setsDone,
      setsTotal: totalSets,
      linkCount: urls.size
    });
  };
  report("collecting");

  const concurrency = Math.min(4, Math.max(1, totalSets));
  let cursor = 0;
  const workers = Array.from({ length: concurrency }, async () => {
    while (cursor < targets.length) {
      if (isTcgPriceCheckCancelled()) break;
      const target = targets[cursor];
      cursor += 1;
      try {
        const manifest = await getSetCardPricingManifest(target.setCode, target.setName);
        for (const url of collectTcgplayerUrlsFromPricingManifest(manifest)) {
          urls.add(url);
        }
        const ctxMap = buildTcgUrlPriceChartingContextFromManifest(
          manifest,
          target.setCode,
          target.setName
        );
        for (const [url, ctx] of ctxMap) {
          if (!priceChartingContextByUrl.has(url)) priceChartingContextByUrl.set(url, ctx);
        }
      } catch {
        // best effort per set
      }
      setsDone += 1;
      if (setsDone === 1 || setsDone === totalSets || setsDone % 3 === 0) {
        report("collecting");
      }
      await sleep(TCG_LINK_PRICE_SET_MANIFEST_DELAY_MS);
    }
  });
  await Promise.all(workers);
  report("collected");
  return { urls: [...urls], priceChartingContextByUrl };
}

function normalizeStaleTcgBulkPriceCheckMeta() {
  if (isTcgBulkPriceCheckInFlight() || isPriceChartingDetailsPrewarmInFlight()) return;
  if (tcgBulkPriceCheckMeta.status !== "running") return;
  tcgBulkPriceCheckMeta.status = "idle";
  tcgBulkPriceCheckMeta.finishedAt =
    tcgBulkPriceCheckMeta.finishedAt || tcgBulkPriceCheckMeta.startedAt || new Date().toISOString();
  console.warn("[pricing-cache] Reset stale bulk price check status after restart (was running).");
}

function runPriceChartingDetailsPrewarmBackground(triggeredBy = "", options = {}) {
  if (priceChartingDetailsPrewarmJob) {
    return { skipped: true, reason: "in_flight" };
  }
  const onlySetCode = String(options.setCode || "")
    .trim()
    .toUpperCase();
  const onlySetName = String(options.setName || "").trim();
  clearPriceChartingCancelFlag();
  const startedAt = new Date().toISOString();
  priceChartingBulkMeta = {
    ...priceChartingBulkMeta,
    status: "running",
    startedAt,
    finishedAt: null,
    triggeredBy: String(triggeredBy || "").trim() || null,
    lastError: null,
    setCode: onlySetCode || null,
    setName: onlySetName || null,
    progress: { total: 0, done: 0, ok: 0, fail: 0, skipped: 0 }
  };
  priceChartingDetailsPrewarmJob = (async () => {
    try {
      const scopeLabel = onlySetCode ? ` for ${onlySetCode}` : "";
      console.log(`[pricing] PriceCharting card details cache started${scopeLabel}...`);
      if (!onlySetCode) {
        await clearPriceChartingFailLinks();
      }
      const pcCards = await collectEnglishCardsForPriceChartingPrewarm(
        onlySetCode ? { setCode: onlySetCode } : {}
      );
      if (onlySetCode && !pcCards.length) {
        throw new Error(`No English cards found for set ${onlySetCode}`);
      }
      const pcCachedBefore = getPriceChartingCardDetailsCacheMeta().cacheEntryCount;
      // Single-set refreshes always re-fetch; full runs can skip valid cached cards.
      const skipValidCached = !onlySetCode && pcCachedBefore > 0;
      priceChartingBulkMeta.progress = {
        total: pcCards.length,
        done: 0,
        ok: 0,
        fail: 0,
        skipped: 0
      };
      const pcResult = await refreshPriceChartingCardDetailsBatch(pcCards, {
        concurrency: 1,
        max: pcCards.length,
        skipValidCached,
        persistEvery: PRICECHARTING_DETAILS_PERSIST_EVERY,
        shouldCancel: isPriceChartingCancelled,
        onFail: (card, error) => {
          recordPriceChartingFailLink(card, error);
        },
        onProgress: (progress) => {
          priceChartingBulkMeta.progress = {
            total: progress.total,
            done: progress.done,
            ok: progress.ok,
            fail: progress.fail,
            skipped: Number(progress.skipped) || 0
          };
          const pcMeta = getPriceChartingCardDetailsCacheMeta();
          priceChartingBulkMeta.cacheEntryCount = pcMeta.cacheEntryCount;
          priceChartingBulkMeta.cacheSavedAt = pcMeta.cacheSavedAt;
        }
      });
      await enqueuePersistPriceChartingCardDetailsCacheNow();
      await flushPersistPriceChartingFailLinks();
      const pcMeta = getPriceChartingCardDetailsCacheMeta();
      const finishedAt = new Date().toISOString();
      const stopped = Boolean(pcResult.cancelled) || isPriceChartingCancelled();
      priceChartingBulkMeta.status = stopped ? "stopped" : "idle";
      priceChartingBulkMeta.finishedAt = finishedAt;
      if (!stopped) priceChartingBulkMeta.lastSuccessfulAt = finishedAt;
      priceChartingBulkMeta.cacheEntryCount = pcMeta.cacheEntryCount;
      priceChartingBulkMeta.cacheSavedAt = pcMeta.cacheSavedAt;
      priceChartingBulkMeta.progress = {
        total: pcCards.length,
        done: stopped ? Number(priceChartingBulkMeta.progress?.done) || 0 : pcCards.length,
        ok: pcResult.ok,
        fail: pcResult.fail,
        skipped: Number(pcResult.skipped) || 0
      };
      console.log(
        `[pricing] PriceCharting card details ${stopped ? "stopped" : "done"}${scopeLabel}: cards=${pcCards.length}, ok=${pcResult.ok}, fail=${pcResult.fail}, skipped=${pcResult.skipped || 0}`
      );
      return pcResult;
    } catch (err) {
      priceChartingBulkMeta.status = "error";
      priceChartingBulkMeta.finishedAt = new Date().toISOString();
      priceChartingBulkMeta.lastError = err.message || "PriceCharting details refresh failed";
      console.warn(`[pricing] PriceCharting card details prewarm failed: ${err.message}`);
      throw err;
    } finally {
      priceChartingDetailsPrewarmJob = null;
      clearPriceChartingCancelFlag();
      if (priceChartingBulkMeta) {
        priceChartingBulkMeta.setCode = null;
        priceChartingBulkMeta.setName = null;
      }
    }
  })();
  return priceChartingDetailsPrewarmJob;
}

async function refreshTcgLinkPricesHourlyTick(options = {}) {
  if (tcgBulkPriceCheckJob || tcgLinkPricePrewarmInFlight) {
    return { skipped: true, reason: tcgBulkPriceCheckJob ? "admin_in_flight" : "in_flight" };
  }
  const forceRefresh = options.forceRefresh === true;
  const maxAgeMs = Number.isFinite(Number(options.maxAgeMs))
    ? Math.max(0, Number(options.maxAgeMs))
    : TCG_LINK_PRICE_REFRESH_MAX_AGE_MS;
  clearTcgPriceCheckCancelFlag();
  tcgLinkPricePrewarmInFlight = true;
  const startedAt = Date.now();
  let skipped = 0;
  try {
    console.log("[pricing-hourly] collecting TCGplayer links from all English sets...");
    const { urls, priceChartingContextByUrl } = await collectAllTcgplayerUrlsForPrewarm();
    tcgBulkPriceCheckMeta.totalLinkCount = urls.length;
    syncTcgBulkPriceCheckCacheCount();
    const targets = forceRefresh
      ? urls
      : urls.filter((url) => {
          const productId = extractTcgplayerProductIdFromUrl(url);
          if (!productId) return false;
          if (isTcgLinkPriceCacheFresh(productId, url, maxAgeMs)) {
            skipped += 1;
            return false;
          }
          return true;
        });
    console.log(
      `[pricing-hourly] prewarming ${targets.length} TCG link prices (${urls.length} total, ${skipped} fresh within ${Math.round(maxAgeMs / 3600000)}h)`
    );
    const { ok, fail, cancelled } = await refreshTcgLinkPricesForUrls(targets, {
      concurrency: 6,
      max: targets.length,
      persistEvery: TCG_LINK_PRICE_PERSIST_EVERY,
      priceChartingContextByUrl
    });
    await persistTcgLinkPriceCacheNow();
    const elapsedSec = Math.round((Date.now() - startedAt) / 1000);
    const finishedAt = new Date().toISOString();
    tcgLinkPricePrewarmStatus = {
      lastRunAt: finishedAt,
      lastElapsedSec: elapsedSec,
      lastUrls: urls.length,
      lastOk: ok,
      lastFail: fail,
      lastSkipped: skipped
    };
    if (!tcgBulkPriceCheckJob) {
      tcgBulkPriceCheckMeta.status = cancelled ? "stopped" : "idle";
      tcgBulkPriceCheckMeta.finishedAt = finishedAt;
      if (!cancelled) {
        tcgBulkPriceCheckMeta.lastSuccessfulAt = finishedAt;
      }
      tcgBulkPriceCheckMeta.progress = {
        total: urls.length,
        done: tcgBulkPriceCheckMeta.progress?.done || 0,
        ok,
        fail,
        skipped
      };
      tcgBulkPriceCheckMeta.lastError = null;
    }
    console.log(
      `[pricing-hourly] link prewarm ${cancelled ? "stopped" : "done"} in ${elapsedSec}s: urls=${urls.length}, refreshed=${targets.length}, ok=${ok}, fail=${fail}, skipped=${skipped}`
    );
    return { urls: urls.length, refreshed: targets.length, ok, fail, skipped, elapsedSec };
  } catch (err) {
    console.warn(`[pricing-hourly] link prewarm failed: ${err.message}`);
    return { error: err.message || "link prewarm failed" };
  } finally {
    if (!tcgBulkPriceCheckJob) {
      tcgLinkPricePrewarmInFlight = false;
      clearTcgPriceCheckCancelFlag();
    }
    kickTcgLinkPriceBackgroundDrain();
  }
}

function scheduleTcgLinkPricePrewarmKickoff(delayMs = TCG_LINK_PRICE_PREWARM_STARTUP_DELAY_MS) {
  if (tcgLinkPricePrewarmKickoffTimer) return;
  tcgLinkPricePrewarmKickoffTimer = setTimeout(() => {
    tcgLinkPricePrewarmKickoffTimer = null;
    refreshTcgLinkPricesHourlyTick({ forceRefresh: false }).catch(() => {});
  }, delayMs);
}

let tcgLinkPriceHourlyTimer = null;
let tcgLinkPriceHourlyKickoffTimer = null;

function startTcgLinkPriceHourlyRefreshLoop() {
  if (tcgLinkPriceHourlyTimer || tcgLinkPriceHourlyKickoffTimer) return;
  const initialDelayMs = getMsUntilNextTopOfHour();
  const nextRunAt = new Date(Date.now() + initialDelayMs).toISOString();
  console.log(
    `[pricing-hourly] TCG link cache refresh at ${nextRunAt} (every 60m, in ${Math.round(initialDelayMs / 1000)}s)`
  );
  tcgLinkPriceHourlyKickoffTimer = setTimeout(() => {
    tcgLinkPriceHourlyKickoffTimer = null;
    // Re-fetch entries older than the soft max-age; keep serving valid cache meanwhile.
    refreshTcgLinkPricesHourlyTick({ forceRefresh: false }).catch(() => {});
    tcgLinkPriceHourlyTimer = setInterval(() => {
      refreshTcgLinkPricesHourlyTick({ forceRefresh: false }).catch(() => {});
    }, RESTOCK_AUTO_REFRESH_MS);
  }, initialDelayMs);
}

function normalizeTcgFailLinkUrl(url) {
  return String(url || "").trim();
}

function getTcgLinkPriceFailLinksList() {
  return [...tcgLinkPriceFailLinks.values()].sort((a, b) => {
    const ta = Date.parse(a.failedAt || "") || 0;
    const tb = Date.parse(b.failedAt || "") || 0;
    return tb - ta;
  });
}

let tcgLinkPriceFailLinksPersistTimer = null;

async function persistTcgLinkPriceFailLinks() {
  const links = getTcgLinkPriceFailLinksList().slice(0, TCG_LINK_PRICE_FAIL_LINKS_MAX);
  await fsp.writeFile(
    TCG_LINK_PRICE_FAIL_LINKS_FILE,
    JSON.stringify(
      {
        updatedAt: new Date().toISOString(),
        count: links.length,
        links
      },
      null,
      2
    ),
    "utf8"
  );
}

function schedulePersistTcgLinkPriceFailLinks() {
  if (tcgLinkPriceFailLinksPersistTimer) return;
  tcgLinkPriceFailLinksPersistTimer = setTimeout(() => {
    tcgLinkPriceFailLinksPersistTimer = null;
    void persistTcgLinkPriceFailLinks().catch(() => {});
  }, 750);
}

async function flushPersistTcgLinkPriceFailLinks() {
  if (tcgLinkPriceFailLinksPersistTimer) {
    clearTimeout(tcgLinkPriceFailLinksPersistTimer);
    tcgLinkPriceFailLinksPersistTimer = null;
  }
  await persistTcgLinkPriceFailLinks();
}

async function loadPersistedTcgLinkPriceFailLinks() {
  try {
    const raw = await fsp.readFile(TCG_LINK_PRICE_FAIL_LINKS_FILE, "utf8");
    const parsed = JSON.parse(raw);
    const links = Array.isArray(parsed?.links) ? parsed.links : [];
    tcgLinkPriceFailLinks.clear();
    for (const row of links) {
      const url = normalizeTcgFailLinkUrl(row?.url);
      if (!url) continue;
      const productId = Number(row?.productId);
      tcgLinkPriceFailLinks.set(url, {
        url,
        productId: Number.isFinite(productId) && productId > 0 ? productId : null,
        error: String(row?.error || "").trim() || "Price fetch failed",
        failedAt: String(row?.failedAt || parsed?.updatedAt || "").trim() || new Date().toISOString()
      });
    }
    if (links.length) {
      console.log(`[pricing-cache] restored ${tcgLinkPriceFailLinks.size} failed TCG link(s) for manual review`);
    }
  } catch {
    // no fail-links file yet
  }
}

function recordTcgLinkPriceFailLink(url, error = "") {
  const normalized = normalizeTcgFailLinkUrl(url);
  if (!normalized) return;
  const productId = extractTcgplayerProductIdFromUrl(normalized);
  tcgLinkPriceFailLinks.set(normalized, {
    url: normalized,
    productId: Number.isFinite(productId) && productId > 0 ? productId : null,
    error: String(error || "").trim() || "Price fetch failed",
    failedAt: new Date().toISOString()
  });
  if (tcgLinkPriceFailLinks.size > TCG_LINK_PRICE_FAIL_LINKS_MAX) {
    const oldest = getTcgLinkPriceFailLinksList().slice(TCG_LINK_PRICE_FAIL_LINKS_MAX);
    for (const row of oldest) tcgLinkPriceFailLinks.delete(row.url);
  }
  schedulePersistTcgLinkPriceFailLinks();
}

function removeTcgLinkPriceFailLink(url, productId = null) {
  const normalized = normalizeTcgFailLinkUrl(url);
  if (normalized && tcgLinkPriceFailLinks.has(normalized)) {
    tcgLinkPriceFailLinks.delete(normalized);
    schedulePersistTcgLinkPriceFailLinks();
    return true;
  }
  const pid = Number(productId) || extractTcgplayerProductIdFromUrl(normalized);
  if (Number.isFinite(pid) && pid > 0) {
    for (const [key, row] of tcgLinkPriceFailLinks.entries()) {
      if (Number(row?.productId) === pid) {
        tcgLinkPriceFailLinks.delete(key);
        schedulePersistTcgLinkPriceFailLinks();
        return true;
      }
    }
  }
  return false;
}

async function fetchTcgProductLineName(productId) {
  const pid = Number(productId);
  if (!Number.isFinite(pid) || pid <= 0) return "";
  try {
    const detailsRes = await fetch(`https://mp-search-api.tcgplayer.com/v2/product/${pid}/details`, {
      method: "GET",
      headers: {
        Accept: "application/json, text/plain, */*",
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36"
      }
    });
    const details = await detailsRes.json().catch(() => ({}));
    if (!detailsRes.ok || !details || typeof details !== "object") return "";
    return String(details.productLineName || "").trim();
  } catch {
    return "";
  }
}

async function pruneNonPokemonTcgFailLinks({ concurrency = 4, max = 300 } = {}) {
  const list = getTcgLinkPriceFailLinksList().slice(0, Math.max(1, Number(max) || 300));
  if (!list.length) return { checked: 0, removed: 0, kept: 0 };
  let cursor = 0;
  let removed = 0;
  let kept = 0;
  const workers = Array.from({ length: Math.min(concurrency, list.length) }, async () => {
    while (cursor < list.length) {
      const row = list[cursor];
      cursor += 1;
      const productId = Number(row?.productId) || extractTcgplayerProductIdFromUrl(row?.url);
      const line = await fetchTcgProductLineName(productId);
      if (line && !isPokemonTcgProductLine(line)) {
        if (removeTcgLinkPriceFailLink(row.url, productId)) removed += 1;
      } else {
        kept += 1;
      }
    }
  });
  await Promise.all(workers);
  if (removed > 0) await flushPersistTcgLinkPriceFailLinks();
  return { checked: list.length, removed, kept };
}

function priceChartingFailLinkKey(setCode = "", cardNo = "") {
  const code = String(setCode || "").trim().toUpperCase();
  const no = String(cardNo || "").trim();
  if (!code || !no) return "";
  return `${code}:${no}`;
}

function getPriceChartingFailLinksList() {
  return [...priceChartingFailLinks.values()].sort((a, b) => {
    const at = Date.parse(String(a?.failedAt || "")) || 0;
    const bt = Date.parse(String(b?.failedAt || "")) || 0;
    return bt - at;
  });
}

async function persistPriceChartingFailLinks() {
  const links = getPriceChartingFailLinksList().slice(0, PRICECHARTING_DETAILS_FAIL_LINKS_MAX);
  await fsp.writeFile(
    PRICECHARTING_DETAILS_FAIL_LINKS_FILE,
    JSON.stringify({ updatedAt: new Date().toISOString(), count: links.length, links }, null, 2),
    "utf8"
  );
}

function schedulePersistPriceChartingFailLinks() {
  if (priceChartingFailLinksPersistTimer) return;
  priceChartingFailLinksPersistTimer = setTimeout(() => {
    priceChartingFailLinksPersistTimer = null;
    void persistPriceChartingFailLinks().catch(() => {});
  }, 750);
}

async function flushPersistPriceChartingFailLinks() {
  if (priceChartingFailLinksPersistTimer) {
    clearTimeout(priceChartingFailLinksPersistTimer);
    priceChartingFailLinksPersistTimer = null;
  }
  await persistPriceChartingFailLinks();
}

async function loadPersistedPriceChartingFailLinks() {
  try {
    const raw = await fsp.readFile(PRICECHARTING_DETAILS_FAIL_LINKS_FILE, "utf8");
    const parsed = JSON.parse(raw);
    const links = Array.isArray(parsed?.links) ? parsed.links : [];
    priceChartingFailLinks.clear();
    for (const row of links) {
      const key = priceChartingFailLinkKey(row?.setCode, row?.cardNo);
      if (!key) continue;
      priceChartingFailLinks.set(key, {
        key,
        setCode: String(row?.setCode || "").trim().toUpperCase(),
        setName: String(row?.setName || "").trim(),
        cardNo: String(row?.cardNo || "").trim(),
        cardName: String(row?.cardName || "").trim(),
        error: String(row?.error || "").trim() || "PriceCharting details fetch failed",
        failedAt: String(row?.failedAt || parsed?.updatedAt || "").trim() || new Date().toISOString()
      });
    }
    if (links.length) {
      console.log(`[pricing-cache] restored ${priceChartingFailLinks.size} failed PriceCharting card(s)`);
    }
  } catch {
    // no fail-links file yet
  }
}

function recordPriceChartingFailLink(card = {}, error = "") {
  const key = priceChartingFailLinkKey(card?.setCode, card?.cardNo);
  if (!key) return;
  priceChartingFailLinks.set(key, {
    key,
    setCode: String(card?.setCode || "").trim().toUpperCase(),
    setName: String(card?.setName || "").trim(),
    cardNo: String(card?.cardNo || "").trim(),
    cardName: String(card?.cardName || "").trim(),
    error: String(error || "").trim() || "PriceCharting details fetch failed",
    failedAt: new Date().toISOString()
  });
  if (priceChartingFailLinks.size > PRICECHARTING_DETAILS_FAIL_LINKS_MAX) {
    const oldest = getPriceChartingFailLinksList().slice(PRICECHARTING_DETAILS_FAIL_LINKS_MAX);
    for (const row of oldest) priceChartingFailLinks.delete(row.key);
  }
  schedulePersistPriceChartingFailLinks();
}

function removePriceChartingFailLink(setCode = "", cardNo = "") {
  const key = priceChartingFailLinkKey(setCode, cardNo);
  if (!key || !priceChartingFailLinks.has(key)) return false;
  priceChartingFailLinks.delete(key);
  schedulePersistPriceChartingFailLinks();
  return true;
}

async function clearPriceChartingFailLinks() {
  priceChartingFailLinks.clear();
  await flushPersistPriceChartingFailLinks();
}

function getPriceChartingAdminMeta() {
  const disk = getPriceChartingCardDetailsCacheMeta();
  return {
    ...priceChartingBulkMeta,
    cacheEntryCount: Number(priceChartingBulkMeta.cacheEntryCount) || disk.cacheEntryCount || 0,
    cacheSavedAt: priceChartingBulkMeta.cacheSavedAt || disk.cacheSavedAt || null,
    failLinkCount: priceChartingFailLinks.size,
    inFlight: isPriceChartingDetailsPrewarmInFlight(),
    details: disk
  };
}

function isPriceChartingProductUrl(rawUrl = "") {
  return /pricecharting\.com\/game\//i.test(String(rawUrl || "").trim());
}

function isTcgplayerProductUrl(rawUrl = "") {
  return /tcgplayer\.com\/product\//i.test(String(rawUrl || "").trim());
}

function storeResolvedTcgLinkPriceOnUrl(targetUrl, priceResult, { source = "" } = {}) {
  const normalized = normalizeTcgFailLinkUrl(targetUrl);
  if (!normalized) {
    throw new Error("url is required");
  }
  if (!priceResult || priceResult.ok !== true) {
    throw new Error(priceResult?.error || "Could not resolve a price from that link");
  }
  const productId =
    Number(priceResult.productId) || extractTcgplayerProductIdFromUrl(normalized) || null;
  const nearMintPrice = Number(priceResult.nearMintPrice ?? priceResult.price);
  const shippingPrice = Number(priceResult.shippingPrice ?? 0);
  const totalPrice = Number(priceResult.totalPrice ?? priceResult.price);
  if (!Number.isFinite(totalPrice) || totalPrice <= 0) {
    throw new Error("Resolved price is invalid");
  }
  const stamped = stampTcgLinkPriceResult({
    ok: true,
    productId,
    price: totalPrice,
    totalPrice,
    nearMintPrice: Number.isFinite(nearMintPrice) && nearMintPrice > 0 ? nearMintPrice : totalPrice,
    shippingPrice: Number.isFinite(shippingPrice) && shippingPrice >= 0 ? shippingPrice : 0,
    listingCondition: String(priceResult.listingCondition || "Near Mint").trim() || "Near Mint",
    nearMintWithShipping:
      String(priceResult.nearMintWithShipping || "").trim() ||
      formatTcgListingWithShippingDisplay(
        Number.isFinite(nearMintPrice) && nearMintPrice > 0 ? nearMintPrice : totalPrice,
        Number.isFinite(shippingPrice) && shippingPrice >= 0 ? shippingPrice : 0
      ),
    sellerName: String(priceResult.sellerName || "").trim(),
    listingId: priceResult.listingId ?? null,
    source: String(source || priceResult.source || "manual-admin").trim() || "manual-admin",
    priceChartingProductUrl: String(priceResult.priceChartingProductUrl || "").trim(),
    error: ""
  });
  if (!tcgLinkPriceCacheValueValid(stamped)) {
    throw new Error("Could not build a valid cache entry from that link");
  }
  const cacheKey = getTcgLinkPriceCacheKey(normalized, productId) || String(productId || normalized);
  tcgLinkPriceCache.set(cacheKey, {
    value: stamped,
    expiresAt: Date.now() + TCG_LINK_PRICE_CACHE_TTL_MS
  });
  schedulePersistTcgLinkPriceCache();
  removeTcgLinkPriceFailLink(normalized, productId);
  syncTcgBulkPriceCheckCacheCount();
  return stamped;
}

async function resolveFailLinkPriceFromSourceUrl(failUrl, priceSourceUrl) {
  const normalizedFail = normalizeTcgFailLinkUrl(failUrl);
  const normalizedSource = String(priceSourceUrl || "").trim();
  if (!normalizedFail) throw new Error("Failed link URL is required");
  if (!normalizedSource) throw new Error("Price link URL is required");

  if (isTcgplayerProductUrl(normalizedSource)) {
    const fetched = await fetchTcgPriceFromProductLink(normalizedSource, {
      forceRefresh: true,
      cacheOnly: false
    });
    if (fetched?.ok) {
      return storeResolvedTcgLinkPriceOnUrl(normalizedFail, fetched, {
        source: "manual-admin-tcg-link"
      });
    }
    throw new Error(fetched?.error || "Could not fetch a price from that TCGplayer link");
  }

  if (isPriceChartingProductUrl(normalizedSource)) {
    const pc = await fetchPriceChartingUngradedPriceFromProductUrl(normalizedSource);
    if (!pc?.ok || !pc.ungradedPrice) {
      throw new Error(pc?.error || "Could not read Ungraded price from PriceCharting");
    }
    const price = Number(pc.ungradedPrice);
    return storeResolvedTcgLinkPriceOnUrl(
      normalizedFail,
      {
        ok: true,
        productId: extractTcgplayerProductIdFromUrl(normalizedFail),
        price,
        totalPrice: price,
        nearMintPrice: price,
        shippingPrice: 0,
        listingCondition: "Ungraded",
        nearMintWithShipping: `$${price.toFixed(2)} · PriceCharting`,
        sellerName: "",
        source: "pricecharting-ungraded",
        priceChartingProductUrl: pc.productUrl
      },
      { source: "pricecharting-ungraded" }
    );
  }

  throw new Error("Price link must be a TCGplayer or PriceCharting product URL");
}

async function clearTcgLinkPriceFailLinks() {
  tcgLinkPriceFailLinks.clear();
  await flushPersistTcgLinkPriceFailLinks();
}

function storeManualTcgLinkPriceForUrl(url, nearMintPrice, shippingPrice) {
  const normalized = normalizeTcgFailLinkUrl(url);
  if (!normalized) {
    throw new Error("url is required");
  }
  const listing = Number(nearMintPrice);
  const shipping = Number(shippingPrice);
  if (!Number.isFinite(listing) || listing < 0) {
    throw new Error("listingPrice must be a non-negative number");
  }
  if (!Number.isFinite(shipping) || shipping < 0) {
    throw new Error("shippingPrice must be a non-negative number");
  }
  const productId = extractTcgplayerProductIdFromUrl(normalized);
  const totalPrice = Number((listing + shipping).toFixed(2));
  const stamped = stampTcgLinkPriceResult({
    ok: true,
    productId: Number.isFinite(productId) && productId > 0 ? productId : null,
    price: totalPrice,
    totalPrice,
    nearMintPrice: Number(listing.toFixed(2)),
    shippingPrice: Number(shipping.toFixed(2)),
    listingCondition: "Near Mint",
    nearMintWithShipping: formatTcgListingWithShippingDisplay(listing, shipping),
    sellerName: "Manual entry",
    source: "manual-admin",
    error: ""
  });
  if (!tcgLinkPriceCacheValueValid(stamped)) {
    throw new Error("Could not build a valid cache entry from those values");
  }
  const cacheKey = getTcgLinkPriceCacheKey(normalized, productId) || String(productId || normalized);
  tcgLinkPriceCache.set(cacheKey, {
    value: stamped,
    expiresAt: Date.now() + TCG_LINK_PRICE_CACHE_TTL_MS
  });
  schedulePersistTcgLinkPriceCache();
  removeTcgLinkPriceFailLink(normalized);
  syncTcgBulkPriceCheckCacheCount();
  return stamped;
}

async function loadPersistedTcgLinkPriceCache() {
  let raw = null;
  try {
    raw = await fsp.readFile(TCG_LINK_PRICE_CACHE_FILE, "utf8");
  } catch {
    // try R2 below
  }

  if (!raw || raw.length < 2) {
    raw = await pullPricingCacheFromR2("tcg-link-prices-cache.json", { ...env, ...process.env });
    if (raw) {
      try {
        await fsp.mkdir(DATA_DIR, { recursive: true });
        await fsp.writeFile(TCG_LINK_PRICE_CACHE_FILE, raw, "utf8");
      } catch (err) {
        console.warn(`[pricing-cache] could not write R2 TCG cache to disk: ${err?.message || err}`);
      }
    }
  }

  if (!raw) return;

  try {
    const parsed = JSON.parse(raw);
    const rows = Array.isArray(parsed?.entries) ? parsed.entries : [];
    if (parsed?.meta && typeof parsed.meta === "object") {
      tcgBulkPriceCheckMeta = {
        ...tcgBulkPriceCheckMeta,
        ...parsed.meta,
        logicVersion: TCG_LINK_PRICE_LOGIC_VERSION
      };
      const progress = tcgBulkPriceCheckMeta.progress || {};
      const total = Number(progress.total) || 0;
      const done = Number(progress.done) || 0;
      if (tcgBulkPriceCheckMeta.status === "running" && total > 0 && done >= total) {
        tcgBulkPriceCheckMeta.status = "idle";
        tcgBulkPriceCheckMeta.finishedAt =
          tcgBulkPriceCheckMeta.finishedAt || parsed?.savedAt || new Date().toISOString();
      }
      normalizeStaleTcgBulkPriceCheckMeta();
    }
    const now = Date.now();
    let restored = 0;
    for (const row of rows) {
      const key = String(row?.key || "").trim();
      if (!key) continue;
      const value = row?.value && typeof row.value === "object" ? row.value : null;
      if (!tcgLinkPriceCacheValueValid(value)) continue;
      // Legacy rows: treat disk save time as fetchedAt so soft refresh doesn't re-scrape everything.
      if (!getTcgLinkPriceCacheFetchedAt(value)) {
        const fallbackFetchedAt =
          String(parsed?.savedAt || parsed?.meta?.cacheSavedAt || "").trim() || new Date().toISOString();
        value.fetchedAt = fallbackFetchedAt;
      }
      const storedExpiresAt = Number(row?.expiresAt || 0);
      const fetchedAt = getTcgLinkPriceCacheFetchedAt(value);
      // Prefer persisted expiry; fall back from fetchedAt, then a fresh TTL for legacy rows.
      let expiresAt = Number.isFinite(storedExpiresAt) && storedExpiresAt > now ? storedExpiresAt : 0;
      if (!expiresAt && fetchedAt > 0) {
        expiresAt = fetchedAt + TCG_LINK_PRICE_CACHE_TTL_MS;
      }
      if (!expiresAt || expiresAt <= now) {
        expiresAt = now + TCG_LINK_PRICE_CACHE_TTL_MS;
      }
      tcgLinkPriceCache.set(key, {
        value,
        expiresAt
      });
      restored += 1;
    }
    tcgBulkPriceCheckMeta.cacheEntryCount = restored;
    tcgBulkPriceCheckMeta.cacheSavedAt = String(parsed?.savedAt || parsed?.meta?.cacheSavedAt || "").trim() || null;
    if (restored > 0) {
      console.log(`[pricing-cache] restored ${restored} persisted TCG link prices`);
    }
  } catch (err) {
    console.warn(`[pricing-cache] TCG link price cache parse failed: ${err?.message || err}`);
  }
}

async function getRestockTrackerPayload() {
  let base = {
    ok: false,
    sources: [],
    importedAt: null,
    items: [],
    message: "Run: node backend/scripts/import-restock-tracker.js"
  };
  try {
    const raw = await fsp.readFile(RESTOCK_TRACKER_FILE, "utf8");
    base = JSON.parse(raw);
  } catch {
    // use stub
  }
  const manualItems = await loadRestockManualItems(RESTOCK_MANUAL_ITEMS_FILE);
  return mergeRestockTrackerPayload(base, manualItems);
}

function isRequestAdmin(req) {
  const sessionUser = getCurrentUser(req);
  if (!sessionUser?.isAdmin) return false;
  const record = store.users.find((entry) => entry.id === sessionUser.id);
  return isAdminUserRecord(record, adminUsernames);
}

function requireAdmin(req, res) {
  const sessionUser = getCurrentUser(req);
  if (!sessionUser) {
    json(res, 401, { ok: false, error: "Sign in required" });
    return null;
  }
  const record = store.users.find((entry) => entry.id === sessionUser.id);
  if (!isAdminUserRecord(record, adminUsernames)) {
    json(res, 403, { ok: false, error: "Administrator access required" });
    return null;
  }
  return { sessionUser, record };
}

async function runAdminBulkTcgPriceCheck(triggeredBy = "") {
  if (tcgBulkPriceCheckJob || tcgLinkPricePrewarmInFlight) {
    return {
      skipped: true,
      reason: tcgBulkPriceCheckJob ? "admin_in_flight" : "prewarm_in_flight",
      meta: tcgBulkPriceCheckMeta
    };
  }
  clearTcgPriceCheckCancelFlag();
  tcgLinkPricePrewarmInFlight = true;
  tcgBulkPriceCheckJob = (async () => {
    const startedAt = new Date().toISOString();
    tcgBulkPriceCheckMeta = {
      ...tcgBulkPriceCheckMeta,
      status: "running",
      startedAt,
      finishedAt: null,
      triggeredBy: String(triggeredBy || "").trim() || null,
      lastError: null,
      phase: "collecting",
      setCode: null,
      setName: null,
      progress: { total: 0, done: 0, ok: 0, fail: 0, skipped: 0, setsDone: 0, setsTotal: 0 }
    };
    try {
      console.log("[admin] bulk TCG price check started...");
      await clearTcgLinkPriceFailLinks();
      const { urls, priceChartingContextByUrl } = await collectAllTcgplayerUrlsForPrewarm({
        onProgress: (info) => {
          tcgBulkPriceCheckMeta.phase = String(info?.phase || "collecting");
          tcgBulkPriceCheckMeta.progress = {
            ...tcgBulkPriceCheckMeta.progress,
            total: Number(info?.linkCount) || tcgBulkPriceCheckMeta.progress?.total || 0,
            done: 0,
            ok: 0,
            fail: 0,
            skipped: 0,
            setsDone: Number(info?.setsDone) || 0,
            setsTotal: Number(info?.setsTotal) || 0
          };
          tcgBulkPriceCheckMeta.totalLinkCount =
            Number(info?.linkCount) || tcgBulkPriceCheckMeta.totalLinkCount || 0;
          syncTcgBulkPriceCheckCacheCount();
        }
      });
      tcgBulkPriceCheckMeta.phase = "pricing";
      tcgBulkPriceCheckMeta.totalLinkCount = urls.length;
      tcgBulkPriceCheckMeta.progress.total = urls.length;
      syncTcgBulkPriceCheckCacheCount();
      if (isTcgPriceCheckCancelled()) {
        await persistTcgLinkPriceCacheNow();
        await flushPersistTcgLinkPriceFailLinks();
        const finishedAt = new Date().toISOString();
        tcgBulkPriceCheckMeta.status = "stopped";
        tcgBulkPriceCheckMeta.phase = "stopped";
        tcgBulkPriceCheckMeta.finishedAt = finishedAt;
        console.log(
          `[admin] bulk TCG price check stopped during link collection (urls=${urls.length}; cancel flag set — use Stop only when you mean to stop)`
        );
        return { stopped: true, urls: urls.length, ok: 0, fail: 0 };
      }
      if (!urls.length) {
        tcgBulkPriceCheckMeta.lastError =
          "No TCGplayer product links found. Check TCGplayer API keys in backend/.env and set pricing manifests.";
        console.warn("[admin] bulk TCG price check: 0 TCGplayer links collected");
      }
      console.log(
        `[admin] collected ${urls.length} TCG links; refreshing prices older than ${Math.round(TCG_LINK_PRICE_ADMIN_REFRESH_MAX_AGE_MS / 60000)}m`
      );
      // Re-fetch stale/missing prices. Fresh entries (within admin max-age) are skipped so runs finish.
      const { ok, fail, skipped, cancelled } = await refreshTcgLinkPricesForUrls(urls, {
        concurrency: 6,
        max: urls.length,
        skipValidCached: true,
        maxAgeMs: TCG_LINK_PRICE_ADMIN_REFRESH_MAX_AGE_MS,
        persistEvery: TCG_LINK_PRICE_PERSIST_EVERY,
        priceChartingContextByUrl,
        onProgress: (progress) => {
          tcgBulkPriceCheckMeta.progress = {
            total: progress.total,
            done: progress.done,
            ok: progress.ok,
            fail: progress.fail,
            skipped: Number(progress.skipped) || 0
          };
          if (Number.isFinite(progress.pricedInCacheCount)) {
            tcgBulkPriceCheckMeta.pricedInCacheCount = progress.pricedInCacheCount;
            tcgBulkPriceCheckMeta.cacheEntryCount = progress.cachedCount ?? progress.pricedInCacheCount;
          } else {
            syncTcgBulkPriceCheckCacheCount();
          }
        }
      });
      await persistTcgLinkPriceCacheNow();
      await flushPersistTcgLinkPriceFailLinks();
      const finishedAt = new Date().toISOString();
      const stopped = Boolean(cancelled) || isTcgPriceCheckCancelled();
      tcgBulkPriceCheckMeta.status = stopped ? "stopped" : "idle";
      tcgBulkPriceCheckMeta.phase = stopped ? "stopped" : "idle";
      tcgBulkPriceCheckMeta.finishedAt = finishedAt;
      if (!stopped) {
        tcgBulkPriceCheckMeta.lastSuccessfulAt = finishedAt;
      }
      tcgBulkPriceCheckMeta.progress = {
        total: urls.length,
        done: stopped ? Number(tcgBulkPriceCheckMeta.progress?.done) || 0 : urls.length,
        ok,
        fail,
        skipped: Number(skipped) || 0
      };
      tcgLinkPricePrewarmStatus = {
        lastRunAt: finishedAt,
        lastElapsedSec: Math.round((Date.now() - Date.parse(startedAt)) / 1000),
        lastUrls: urls.length,
        lastOk: ok,
        lastFail: fail,
        lastSkipped: Number(skipped) || 0
      };
      console.log(
        `[admin] bulk TCG price check ${stopped ? "stopped" : "done"}: urls=${urls.length}, ok=${ok}, fail=${fail}, skipped=${skipped || 0}`
      );
      return { urls: urls.length, ok, fail, stopped };
    } catch (err) {
      tcgBulkPriceCheckMeta.status = "error";
      tcgBulkPriceCheckMeta.finishedAt = new Date().toISOString();
      tcgBulkPriceCheckMeta.lastError = err.message || "Bulk price check failed";
      console.warn(`[admin] bulk TCG price check failed: ${err.message}`);
      throw err;
    } finally {
      tcgBulkPriceCheckJob = null;
      tcgLinkPricePrewarmInFlight = false;
      clearTcgPriceCheckCancelFlag();
      kickTcgLinkPriceBackgroundDrain();
    }
  })();
  return tcgBulkPriceCheckJob;
}

async function runAdminTcgPriceCheckForSet(setCode = "", setName = "", triggeredBy = "") {
  if (tcgBulkPriceCheckJob || tcgLinkPricePrewarmInFlight) {
    return {
      skipped: true,
      reason: tcgBulkPriceCheckJob ? "admin_in_flight" : "prewarm_in_flight",
      meta: tcgBulkPriceCheckMeta
    };
  }
  const code = String(setCode || "").trim().toUpperCase();
  if (!code) {
    throw new Error("setCode is required");
  }
  let resolvedName = String(setName || "").trim();
  if (!resolvedName) {
    const targets = await listEnglishSetPricingTargets();
    const match = targets.find((row) => row.setCode === code);
    resolvedName = match?.setName || code;
  }
  clearTcgPriceCheckCancelFlag();
  tcgLinkPricePrewarmInFlight = true;
  tcgBulkPriceCheckJob = (async () => {
    const startedAt = new Date().toISOString();
    tcgBulkPriceCheckMeta = {
      ...tcgBulkPriceCheckMeta,
      status: "running",
      startedAt,
      finishedAt: null,
      triggeredBy: String(triggeredBy || "").trim() || null,
      lastError: null,
      phase: "collecting",
      setCode: code,
      setName: resolvedName,
      progress: { total: 0, done: 0, ok: 0, fail: 0, skipped: 0, setsDone: 0, setsTotal: 1 }
    };
    try {
      console.log(`[admin] set TCG price check started for ${code} (${resolvedName})...`);
      const manifest = await getSetCardPricingManifest(code, resolvedName);
      const urls = collectTcgplayerUrlsFromPricingManifest(manifest);
      const priceChartingContextByUrl = buildTcgUrlPriceChartingContextFromManifest(
        manifest,
        code,
        resolvedName
      );
      tcgBulkPriceCheckMeta.phase = "pricing";
      tcgBulkPriceCheckMeta.progress = {
        total: urls.length,
        done: 0,
        ok: 0,
        fail: 0,
        skipped: 0,
        setsDone: 1,
        setsTotal: 1
      };
      tcgBulkPriceCheckMeta.totalLinkCount = urls.length;
      syncTcgBulkPriceCheckCacheCount();
      if (!urls.length) {
        tcgBulkPriceCheckMeta.lastError = `No TCGplayer links found for set ${code}.`;
      }
      const { ok, fail, skipped, cancelled } = await refreshTcgLinkPricesForUrls(urls, {
        concurrency: 6,
        max: urls.length,
        skipValidCached: false,
        persistEvery: TCG_LINK_PRICE_PERSIST_EVERY,
        priceChartingContextByUrl,
        onProgress: (progress) => {
          tcgBulkPriceCheckMeta.progress = {
            total: progress.total,
            done: progress.done,
            ok: progress.ok,
            fail: progress.fail,
            skipped: Number(progress.skipped) || 0,
            setsDone: 1,
            setsTotal: 1
          };
          if (Number.isFinite(progress.pricedInCacheCount)) {
            tcgBulkPriceCheckMeta.pricedInCacheCount = progress.pricedInCacheCount;
            tcgBulkPriceCheckMeta.cacheEntryCount = progress.cachedCount ?? progress.pricedInCacheCount;
          } else {
            syncTcgBulkPriceCheckCacheCount();
          }
        }
      });
      await persistTcgLinkPriceCacheNow();
      await flushPersistTcgLinkPriceFailLinks();
      const finishedAt = new Date().toISOString();
      const stopped = Boolean(cancelled) || isTcgPriceCheckCancelled();
      tcgBulkPriceCheckMeta.status = stopped ? "stopped" : "idle";
      tcgBulkPriceCheckMeta.phase = stopped ? "stopped" : "idle";
      tcgBulkPriceCheckMeta.finishedAt = finishedAt;
      if (!stopped) tcgBulkPriceCheckMeta.lastSuccessfulAt = finishedAt;
      tcgBulkPriceCheckMeta.progress = {
        total: urls.length,
        done: stopped ? Number(tcgBulkPriceCheckMeta.progress?.done) || 0 : urls.length,
        ok,
        fail,
        skipped: Number(skipped) || 0,
        setsDone: 1,
        setsTotal: 1
      };
      console.log(
        `[admin] set TCG price check ${stopped ? "stopped" : "done"} for ${code}: urls=${urls.length}, ok=${ok}, fail=${fail}, skipped=${skipped || 0}`
      );
      return { setCode: code, urls: urls.length, ok, fail, stopped };
    } catch (err) {
      tcgBulkPriceCheckMeta.status = "error";
      tcgBulkPriceCheckMeta.finishedAt = new Date().toISOString();
      tcgBulkPriceCheckMeta.lastError = err.message || "Set price check failed";
      console.warn(`[admin] set TCG price check failed for ${code}: ${err.message}`);
      throw err;
    } finally {
      tcgBulkPriceCheckJob = null;
      tcgLinkPricePrewarmInFlight = false;
      clearTcgPriceCheckCancelFlag();
      kickTcgLinkPriceBackgroundDrain();
    }
  })();
  return tcgBulkPriceCheckJob;
}

function json(res, statusCode, payload, extraHeaders = {}) {
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET,POST,PUT,PATCH,DELETE,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    ...extraHeaders
  });
  res.end(JSON.stringify(payload));
}

function notFound(res) {
  json(res, 404, { error: "Not found" });
}

function randomId() {
  return `${Date.now()}-${Math.floor(Math.random() * 1e7)}`;
}

function normalizeEmail(value) {
  return String(value || "").trim().toLowerCase();
}

function normalizeUsername(value) {
  return String(value || "").trim().toLowerCase();
}

function isValidUsername(value) {
  return /^[a-z0-9_]{3,24}$/i.test(String(value || "").trim());
}

function hashPassword(password, saltHex = "") {
  // scrypt one-way hash (salt:hash). Plaintext passwords are never stored.
  const salt = saltHex || crypto.randomBytes(16).toString("hex");
  const hash = crypto.scryptSync(String(password), salt, 64).toString("hex");
  return `${salt}:${hash}`;
}

function looksLikePasswordHash(stored) {
  const raw = String(stored || "");
  const [salt, digest] = raw.split(":");
  return Boolean(salt && digest && /^[a-f0-9]{16,}$/i.test(salt) && /^[a-f0-9]{64,}$/i.test(digest));
}

function migratePlaintextPasswords(storeObj) {
  let changed = false;
  for (const user of storeObj.users || []) {
    if (!user || user.passwordHash == null || user.passwordHash === "") continue;
    if (looksLikePasswordHash(user.passwordHash)) continue;
    // Legacy/plaintext value — hash it in place so a dump never exposes usable passwords.
    user.passwordHash = hashPassword(String(user.passwordHash));
    changed = true;
  }
  return changed;
}

function verifyPassword(password, storedHash) {
  if (!looksLikePasswordHash(storedHash)) return false;
  const [salt, expected] = String(storedHash || "").split(":");
  if (!salt || !expected) return false;
  const actual = crypto.scryptSync(String(password), salt, 64).toString("hex");
  const expectedBuffer = Buffer.from(expected, "hex");
  const actualBuffer = Buffer.from(actual, "hex");
  if (expectedBuffer.length !== actualBuffer.length) return false;
  return crypto.timingSafeEqual(expectedBuffer, actualBuffer);
}

function parseCookies(req) {
  const raw = String(req.headers.cookie || "");
  const pairs = raw ? raw.split(";") : [];
  const out = {};
  for (const pair of pairs) {
    const idx = pair.indexOf("=");
    if (idx === -1) continue;
    const key = pair.slice(0, idx).trim();
    const value = pair.slice(idx + 1).trim();
    if (!key) continue;
    out[key] = decodeURIComponent(value);
  }
  return out;
}

function parseRememberMe(value) {
  if (value === true || value === 1) return true;
  if (value === false || value === 0) return false;
  const text = String(value || "")
    .trim()
    .toLowerCase();
  return text === "true" || text === "1" || text === "on" || text === "yes";
}

function sessionTtlMs(rememberMe) {
  return rememberMe ? SESSION_REMEMBER_TTL_MS : SESSION_TTL_MS;
}

function createSession(userId, rememberMe = false) {
  const token = crypto.randomBytes(24).toString("hex");
  sessions.set(token, {
    userId,
    rememberMe: Boolean(rememberMe),
    expiresAt: Date.now() + sessionTtlMs(rememberMe)
  });
  return token;
}

function issueAuthSession(userId, rememberMe = false) {
  const token = createSession(userId, rememberMe);
  return { token, cookie: buildSessionCookie(token, rememberMe) };
}

function getSessionFromToken(token) {
  const row = sessions.get(token);
  if (!row) return null;
  if (Date.now() > row.expiresAt) {
    sessions.delete(token);
    return null;
  }
  return row;
}

function getCurrentUser(req) {
  const cookies = parseCookies(req);
  const token = cookies[SESSION_COOKIE_NAME];
  if (!token) return null;
  const session = getSessionFromToken(token);
  if (!session) return null;
  const user = store.users.find((entry) => entry.id === session.userId);
  if (!user) return null;
  const out = withAdminFlag(
    {
      id: user.id,
      email: user.email,
      username: user.username || "",
      name: user.name || "",
      role: user.role || "",
      hasPassword: Boolean(user.passwordHash)
    },
    adminUsernames
  );
  if (user.picture) out.picture = user.picture;
  return out;
}

function defaultUserPreferences() {
  return {
    showCostBasis: false,
    showUnrealizedPnL: false
  };
}

function ensureUserPreferences(user) {
  const base = defaultUserPreferences();
  if (!user || typeof user !== "object") return { ...base };
  const raw = user.preferences && typeof user.preferences === "object" ? user.preferences : {};
  user.preferences = {
    showCostBasis: raw.showCostBasis === true,
    showUnrealizedPnL: raw.showUnrealizedPnL === true
  };
  return user.preferences;
}

function publicUserPayload(user) {
  const prefs = ensureUserPreferences(user);
  const out = withAdminFlag(
    {
      id: user.id,
      email: user.email,
      username: user.username || "",
      name: user.name || "",
      role: user.role || "",
      hasPassword: Boolean(user.passwordHash),
      preferences: { ...prefs }
    },
    adminUsernames
  );
  if (user.picture) out.picture = user.picture;
  ensureUserShowcase(user);
  out.showcaseUrl = showcasePathForUsername(user.username);
  return out;
}

function allocateUniqueUsernameForGoogle(email) {
  const seed = String(email).split("@")[0] || "user";
  let base = seed.toLowerCase().replace(/[^a-z0-9_]/g, "").replace(/_+/g, "_");
  if (base.length < 3) base = "usr";
  base = base.slice(0, 20);
  for (let n = 0; n < 10000; n += 1) {
    const extra = n === 0 ? "" : String(n);
    const candidate = (base + extra).slice(0, 24);
    if (!isValidUsername(candidate)) continue;
    const taken = store.users.some((u) => normalizeUsername(u.username) === normalizeUsername(candidate));
    if (!taken) return candidate;
  }
  return `g${Date.now()}`.slice(0, 24);
}

async function verifyGoogleIdToken(jwt) {
  const clientId = getConfig("GOOGLE_CLIENT_ID");
  if (!clientId) {
    const err = new Error("Google sign-in is not configured");
    err.code = "NO_GOOGLE";
    throw err;
  }
  const url = `https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(jwt)}`;
  const { response, data } = await fetchJson(url);
  if (!response.ok || !data || typeof data !== "object") {
    const err = new Error("Invalid Google credential");
    err.code = "BAD_TOKEN";
    throw err;
  }
  if (String(data.aud) !== String(clientId)) {
    const err = new Error("Invalid Google credential");
    err.code = "BAD_TOKEN";
    throw err;
  }
  if (String(data.email_verified) !== "true") {
    const err = new Error("Google account email must be verified");
    err.code = "UNVERIFIED";
    throw err;
  }
  const sub = String(data.sub || "");
  const email = normalizeEmail(data.email || "");
  if (!sub || !email) {
    const err = new Error("Invalid Google credential");
    err.code = "BAD_TOKEN";
    throw err;
  }
  return {
    sub,
    email,
    name: String(data.name || "").trim(),
    picture: String(data.picture || "").trim()
  };
}

function shouldUseSecureCookies() {
  const publicUrl = String(getConfig("APP_PUBLIC_URL") || process.env.APP_PUBLIC_URL || "").trim();
  if (publicUrl.startsWith("https://")) return true;
  return String(process.env.NODE_ENV || "").trim().toLowerCase() === "production";
}

function buildSessionCookie(token, rememberMe = false) {
  const secure = shouldUseSecureCookies() ? "; Secure" : "";
  const base = `${SESSION_COOKIE_NAME}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax${secure}`;
  if (!rememberMe) {
    return base;
  }
  const maxAge = Math.floor(SESSION_REMEMBER_TTL_MS / 1000);
  return `${base}; Max-Age=${maxAge}`;
}

function buildClearedSessionCookie() {
  const secure = shouldUseSecureCookies() ? "; Secure" : "";
  return `${SESSION_COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax${secure}; Max-Age=0`;
}

async function readBody(req, maxBytes = 1_000_000) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => {
      data += chunk;
      if (data.length > maxBytes) {
        reject(new Error("Payload too large"));
      }
    });
    req.on("end", () => {
      if (!data) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(data));
      } catch {
        reject(new Error("Invalid JSON body"));
      }
    });
    req.on("error", reject);
  });
}

function addActivity(action, itemId, details, userId = null) {
  store.activities.unshift({
    id: randomId(),
    action,
    itemId,
    details,
    userId: userId ? String(userId) : null,
    createdAt: new Date().toISOString()
  });
  store.activities = store.activities.slice(0, 150);
}

function requireSignedInUser(req, res) {
  const user = getCurrentUser(req);
  if (!user) {
    json(res, 401, { ok: false, error: "Sign in required" });
    return null;
  }
  return user;
}

function findStoreUserById(userId) {
  return store.users.find((entry) => entry.id === userId) || null;
}

function findStoreUserByUsername(username) {
  const slug = normalizeUsernameSlug(username);
  if (!slug) return null;
  return (
    store.users.find((entry) => normalizeUsernameSlug(entry.username) === slug) || null
  );
}

function getCollectionItemsForUser(userId) {
  const id = String(userId || "").trim();
  if (!id) return [];
  return store.items.filter((item) => String(item.userId || "") === id);
}

function normalizePokeViewWatchlistMetric(value) {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function normalizePokeViewWatchlistCard(input) {
  const cardId = String(input?.id || input?.cardId || "").trim();
  if (!cardId) return null;
  const cardName = String(input.cardName || "").trim();
  const cardLabel = String(input.card || "").trim();
  return {
    id: cardId,
    card: cardLabel || cardName || cardId,
    cardName: cardName || cardLabel,
    setCode: String(input.setCode || "").trim().toUpperCase(),
    cardNo: String(input.cardNo || "").trim(),
    setName: String(input.setName || "").trim(),
    language: String(input.language || "english").trim().toLowerCase() || "english",
    last: normalizePokeViewWatchlistMetric(input.last),
    change: normalizePokeViewWatchlistMetric(input.change),
    changePct: normalizePokeViewWatchlistMetric(input.changePct),
    psaLast: normalizePokeViewWatchlistMetric(input.psaLast),
    psaChange: normalizePokeViewWatchlistMetric(input.psaChange),
    psaChangePct: normalizePokeViewWatchlistMetric(input.psaChangePct)
  };
}

function getPokeViewWatchlistForUser(userId) {
  const id = String(userId || "").trim();
  if (!id) return [];
  const row = (store.pokeViewWatchlists || []).find((entry) => String(entry.userId || "") === id);
  if (!row || !Array.isArray(row.cards)) return [];
  const seen = new Set();
  const cards = [];
  for (const raw of row.cards) {
    const card = normalizePokeViewWatchlistCard(raw);
    if (!card || seen.has(card.id)) continue;
    seen.add(card.id);
    cards.push(card);
  }
  return cards;
}

function setPokeViewWatchlistForUser(userId, cards) {
  const id = String(userId || "").trim();
  if (!id) return [];
  if (!Array.isArray(store.pokeViewWatchlists)) store.pokeViewWatchlists = [];
  const normalized = [];
  const seen = new Set();
  for (const raw of Array.isArray(cards) ? cards : []) {
    const card = normalizePokeViewWatchlistCard(raw);
    if (!card || seen.has(card.id)) continue;
    seen.add(card.id);
    normalized.push(card);
  }
  const payload = {
    userId: id,
    cards: normalized,
    updatedAt: new Date().toISOString()
  };
  const idx = store.pokeViewWatchlists.findIndex((entry) => String(entry.userId || "") === id);
  if (idx === -1) store.pokeViewWatchlists.push(payload);
  else store.pokeViewWatchlists[idx] = payload;
  return normalized;
}

let showcaseSetLookupCache = null;

async function getShowcaseSetLookup() {
  if (showcaseSetLookupCache) return showcaseSetLookupCache;
  const [englishManifest, japaneseManifest] = await Promise.all([
    getSetCardManifest("english"),
    getSetCardManifest("japanese")
  ]);
  showcaseSetLookupCache = buildShowcaseSetLookup(englishManifest, japaneseManifest);
  return showcaseSetLookupCache;
}

async function applySetsCatalogPricingToItem(item, lookup, manifestCache) {
  if (!item || item.type !== "single") return item;
  if (String(item.setLanguage || "").toLowerCase() === "japanese") return item;
  const hasManual =
    item.manualPrice !== null &&
    item.manualPrice !== undefined &&
    Number.isFinite(Number(item.manualPrice)) &&
    Number(item.manualPrice) > 0;
  if (hasManual) return item;

  const draft = { ...item };
    const setCode = resolveSetCodeForItem(draft, lookup);
    if (setCode) draft.setCode = setCode;
    const canonNo = resolveCanonicalCardNumber(draft, lookup);
    if (canonNo) draft.cardNumber = canonNo;
  if (!String(draft.imageUrl || "").trim()) {
    const imageUrl = resolveShowcaseImageUrl(draft, lookup);
    if (imageUrl) draft.imageUrl = imageUrl;
  }
  if (Number(draft.marketPrice) > 0) {
    return draft;
  }
  return resolveTcgSetPriceForCollectrItem(draft, manifestCache);
}

async function syncCollectionPricesFromSets(userId, options = {}) {
  const id = String(userId || "").trim();
  if (!id) return { updated: 0, priced: 0 };
  const lookup = await getShowcaseSetLookup();
  const manifestCache = new Map();
  const force = options.force === true;
  let updated = 0;
  let priced = 0;

  for (const item of store.items) {
    if (String(item.userId || "") !== id) continue;
    if (item.type !== "single") continue;
    const hasManual =
      item.manualPrice !== null &&
      item.manualPrice !== undefined &&
      Number.isFinite(Number(item.manualPrice)) &&
      Number(item.manualPrice) > 0;
    if (hasManual) continue;
    if (!force && Number(item.marketPrice) > 0) continue;

    const beforePrice = Number(item.marketPrice) || 0;
    const beforeCode = String(item.setCode || "").trim().toUpperCase();
    const next = await applySetsCatalogPricingToItem(item, lookup, manifestCache);
    let changed = false;

    const nextCode = String(next.setCode || "").trim().toUpperCase();
    if (nextCode && nextCode !== beforeCode) {
      item.setCode = nextCode;
      changed = true;
    }
    if (String(next.imageUrl || "").trim() && !String(item.imageUrl || "").trim()) {
      item.imageUrl = next.imageUrl;
      changed = true;
    }
    if (Number(next.marketPrice) > 0 && Number(next.marketPrice) !== beforePrice) {
      item.marketPrice = Number(next.marketPrice);
      item.sourceBreakdown = next.sourceBreakdown || item.sourceBreakdown || { tcgplayer: item.marketPrice };
      item.lastPricedAt = next.lastPricedAt || new Date().toISOString();
      if (next.tcgProductId) item.tcgProductId = String(next.tcgProductId);
      priced += 1;
      changed = true;
    }
    if (changed) {
      item.updatedAt = new Date().toISOString();
      updated += 1;
    }
  }

  return { updated, priced };
}

async function enrichCollectionItemsForShowcase(items) {
  const lookup = await getShowcaseSetLookup();
  const manifestCache = new Map();
  const out = [];
  for (const item of items) {
    const draft = await applySetsCatalogPricingToItem(item, lookup, manifestCache);
    out.push(draft);
  }
  return out;
}

async function resolveTcgSetPriceForCollectrItem(draft, manifestCache) {
  if (!draft || draft.type !== "single") return draft;
  if (String(draft.setLanguage || "").toLowerCase() === "japanese") return draft;
  const setCode = String(draft.setCode || "").trim().toUpperCase();
  const setName = String(draft.setName || "").trim();
  const cardNumber = String(draft.cardNumber || "").trim();
  if ((!setCode && !setName) || !cardNumber) return draft;

  const cacheKey = setCode || normalizeTcgLookupText(setName);
  if (!cacheKey) return draft;
  if (!manifestCache.has(cacheKey)) {
    try {
      manifestCache.set(cacheKey, await getSetCardPricingManifest(setCode, setName));
    } catch {
      manifestCache.set(cacheKey, null);
    }
  }
  const manifest = manifestCache.get(cacheKey);
  if (!manifest?.byCardNo) return draft;

  const keys = buildCardPricingLookupKeys(cardNumber);
  let slot = null;
  for (const key of keys) {
    if (manifest.byCardNo[key]) {
      slot = manifest.byCardNo[key];
      break;
    }
  }
  if (!slot) return draft;

  const tcgProductId = Number(slot.productId) || extractTcgplayerProductIdFromUrl(slot.tcgplayerUrl);
  const manifestPrice = Number(slot.tcgplayerPrice) || Number(slot.nearMintAddToCartPrice) || 0;
  const out = { ...draft };
  if (Number.isFinite(tcgProductId) && tcgProductId > 0) {
    out.tcgProductId = String(tcgProductId);
  }
  if (manifestPrice > 0) {
    out.marketPrice = Number(manifestPrice.toFixed(2));
    out.sourceBreakdown = {
      ...(out.sourceBreakdown || {}),
      collectr: true,
      tcgplayer: out.marketPrice
    };
    out.lastPricedAt = new Date().toISOString();
  }
  return out;
}

async function importCollectrProductsForUser(sessionUserId, products, options = {}) {
  const userId = String(sessionUserId || "").trim();
  const rawRows = Array.isArray(products) ? products : [];
  let rows = filterCollectrPokemonProducts(rawRows);
  const skippedNonPokemon = Math.max(0, rawRows.length - rows.length);
  const beforeTypeFilter = rows.length;
  rows = filterCollectrProductsByImportType(rows);
  const skippedByType = Math.max(0, beforeTypeFilter - rows.length);
  const replaceExisting = options.replaceExisting === true;
  const profileUrl = String(options.profileUrl || "").trim();
  const handle = String(options.handle || "").trim();
  const importBatchId = String(options.importBatchId || randomId()).trim();

  if (replaceExisting) {
    store.items = store.items.filter((item) => String(item.userId || "") !== userId);
  }

  const existingKeys = new Set(
    getCollectionItemsForUser(userId).map((item) =>
      itemImportKey({
        type: item.type,
        name: item.name,
        setName: item.setName,
        cardNumber: item.cardNumber,
        tcgProductId: item.tcgProductId,
        gradeCompany: item.gradeCompany,
        gradeValue: item.gradeValue,
        conditionType: item.conditionType
      })
    )
  );

  const lookup = await getShowcaseSetLookup();
  const manifestCache = new Map();
  let imported = 0;
  let skipped = 0;
  let pricedFromSets = 0;
  for (const product of rows) {
    let draft = mapCollectrProductToItem(product);
    if (!draft) {
      skipped += 1;
      continue;
    }
    draft = await applySetsCatalogPricingToItem(draft, lookup, manifestCache);
    if (draft.marketPrice > 0 && draft.sourceBreakdown?.tcgplayer) {
      pricedFromSets += 1;
    }
    const key = itemImportKey(draft);
    if (existingKeys.has(key)) {
      skipped += 1;
      continue;
    }
    const item = normalizeItem(
      {
        ...draft,
        userId,
        collectrImportBatchId: importBatchId,
        sourceBreakdown: draft.sourceBreakdown || { collectr: true }
      },
      null
    );
    item.userId = userId;
    store.items.unshift(item);
    existingKeys.add(key);
    imported += 1;
  }

  if (imported > 0) {
    await syncCollectionPricesFromSets(userId, { force: false });
  }

  const record = findStoreUserById(userId);
  if (record) {
    if (profileUrl || handle) {
      record.showcase = normalizeShowcaseSettings(
        {
          ...ensureUserShowcase(record),
          collectrProfileUrl: profileUrl || record.showcase?.collectrProfileUrl || ""
        },
        record.id
      );
    }
    if (imported > 0) {
      record.lastCollectrImport = {
        batchId: importBatchId,
        handle: handle || "",
        profileUrl: profileUrl || "",
        importedAt: new Date().toISOString(),
        itemCount: imported
      };
    }
  }

  return {
    imported,
    skipped,
    skippedNonPokemon,
    pricedFromSets,
    importBatchId,
    totalProcessed: rawRows.length
  };
}

function deleteCollectrImportBatchForUser(sessionUserId, importBatchId) {
  const userId = String(sessionUserId || "").trim();
  const batchId = String(importBatchId || "").trim();
  if (!userId || !batchId) {
    return { deleted: 0, error: "importBatchId is required" };
  }
  const before = store.items.length;
  store.items = store.items.filter(
    (item) =>
      !(String(item.userId || "") === userId && String(item.collectrImportBatchId || "") === batchId)
  );
  const deleted = before - store.items.length;
  const record = findStoreUserById(userId);
  if (record?.lastCollectrImport?.batchId === batchId) {
    record.lastCollectrImport = null;
  }
  return { deleted, batchId };
}

function getCollectionUndoSnapshot(record) {
  const snap = record?.collectionUndoSnapshot;
  if (!snap || !Array.isArray(snap.items) || !snap.items.length) return null;
  return snap;
}

function saveCollectionUndoSnapshotForUser(sessionUserId) {
  const userId = String(sessionUserId || "").trim();
  if (!userId) return;
  const record = findStoreUserById(userId);
  if (!record) return;
  const owned = getCollectionItemsForUser(userId);
  if (!owned.length) {
    record.collectionUndoSnapshot = null;
    return;
  }
  record.collectionUndoSnapshot = {
    savedAt: new Date().toISOString(),
    lastCollectrImport: record.lastCollectrImport
      ? { ...record.lastCollectrImport }
      : null,
    items: owned.map((item) => ({ ...item }))
  };
}

function deleteAllCollectionItemsForUser(sessionUserId) {
  const userId = String(sessionUserId || "").trim();
  if (!userId) {
    return { deleted: 0, error: "userId is required" };
  }
  const owned = getCollectionItemsForUser(userId);
  if (!owned.length) {
    return { deleted: 0 };
  }
  saveCollectionUndoSnapshotForUser(userId);
  const before = store.items.length;
  store.items = store.items.filter((item) => String(item.userId || "") !== userId);
  const deleted = before - store.items.length;
  const record = findStoreUserById(userId);
  if (record) {
    record.lastCollectrImport = null;
  }
  return { deleted, canUndo: Boolean(getCollectionUndoSnapshot(record)) };
}

function restoreAllCollectionItemsForUser(sessionUserId) {
  const userId = String(sessionUserId || "").trim();
  if (!userId) {
    return { restored: 0, error: "userId is required" };
  }
  const record = findStoreUserById(userId);
  const snap = getCollectionUndoSnapshot(record);
  if (!snap) {
    return { restored: 0, error: "Nothing to restore" };
  }
  store.items = store.items.filter((item) => String(item.userId || "") !== userId);
  const restoredItems = snap.items.map((item) =>
    normalizeItem({ ...item, userId }, null)
  );
  for (let i = restoredItems.length - 1; i >= 0; i -= 1) {
    store.items.unshift(restoredItems[i]);
  }
  if (record) {
    record.lastCollectrImport = snap.lastCollectrImport || null;
    record.collectionUndoSnapshot = null;
  }
  return { restored: restoredItems.length };
}

function findCollectionItemForUser(itemId, userId) {
  const id = String(itemId || "").trim();
  const ownerId = String(userId || "").trim();
  if (!id || !ownerId) return null;
  return store.items.find((item) => item.id === id && String(item.userId || "") === ownerId) || null;
}

function safeNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function getConfig(key, fallback = "") {
  const fromProcess = process.env[key];
  const fromFile = env[key];
  if (fromProcess !== undefined && fromProcess !== "") return fromProcess;
  if (fromFile !== undefined && fromFile !== "") return fromFile;
  return fallback;
}

function normalizeHeaderMap(obj) {
  const out = {};
  if (!obj || typeof obj !== "object") return out;
  for (const [key, value] of Object.entries(obj)) {
    out[String(key).toLowerCase()] = value;
  }
  return out;
}

function pickFirstNumber(payload, keys) {
  const data = normalizeHeaderMap(payload);
  for (const key of keys) {
    const value = data[String(key).toLowerCase()];
    const n = Number(value);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return null;
}

async function fetchJson(url, options = {}) {
  const response = await fetch(url, options);
  const text = await response.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = null;
  }
  return { response, data, text };
}

async function getTcgBearerToken(forceRefresh = false) {
  const publicKey = getConfig("TCGPLAYER_PUBLIC_KEY");
  const privateKey = getConfig("TCGPLAYER_PRIVATE_KEY");
  if (!publicKey || !privateKey) {
    throw new Error("TCGplayer credentials are missing");
  }

  const now = Date.now();
  if (!forceRefresh && tcgTokenCache.accessToken && now < tcgTokenCache.expiresAt - 60_000) {
    return tcgTokenCache.accessToken;
  }

  const body = new URLSearchParams({
    grant_type: "client_credentials",
    client_id: publicKey,
    client_secret: privateKey
  });

  const { response, data, text } = await fetchJson("https://api.tcgplayer.com/token", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded"
    },
    body
  });

  if (!response.ok || !data?.access_token) {
    throw new Error(`TCGplayer token request failed (${response.status}): ${text || "empty response"}`);
  }

  const expiresInSec = Number(data.expires_in || 900);
  tcgTokenCache = {
    accessToken: data.access_token,
    expiresAt: now + expiresInSec * 1000
  };
  return tcgTokenCache.accessToken;
}

async function tcgApiGet(pathname) {
  const version = getConfig("TCGPLAYER_API_VERSION", "v1.39.0");
  const token = await getTcgBearerToken(false);
  const url = `https://api.tcgplayer.com/${version}${pathname}`;

  let { response, data, text } = await fetchJson(url, {
    method: "GET",
    headers: {
      Accept: "application/json",
      Authorization: `bearer ${token}`
    }
  });

  if (response.status === 401) {
    const refreshed = await getTcgBearerToken(true);
    ({ response, data, text } = await fetchJson(url, {
      method: "GET",
      headers: {
        Accept: "application/json",
        Authorization: `bearer ${refreshed}`
      }
    }));
  }

  if (!response.ok) {
    throw new Error(`TCGplayer request failed (${response.status}): ${text || "empty response"}`);
  }
  return data;
}

async function getTcgCategories() {
  const data = await tcgApiGet("/catalog/categories");
  if (!data?.Success) {
    throw new Error(`TCGplayer categories failed: ${(data?.Errors || []).join("; ") || "unknown error"}`);
  }
  const rows = Array.isArray(data.Results) ? data.Results : [];
  return rows
    .map((row) => ({
      categoryId: Number(row?.CategoryId ?? row?.categoryId ?? row?.categoryID),
      name: String(row?.Name ?? row?.name ?? "").trim(),
      raw: row
    }))
    .filter((row) => Number.isFinite(row.categoryId) && row.name);
}

async function getTcgProductPrice(productId) {
  if (!productId) {
    throw new Error("Missing tcgProductId");
  }
  const data = await tcgApiGet(`/pricing/product/${encodeURIComponent(productId)}`);
  if (!data?.Success) {
    throw new Error(`TCGplayer pricing failed: ${(data?.Errors || []).join("; ") || "unknown error"}`);
  }

  const results = Array.isArray(data.Results) ? data.Results : [];
  for (const row of results) {
    const price = pickFirstNumber(row, ["marketPrice", "midPrice", "lowPrice", "directLowPrice"]);
    if (price) return Number(price.toFixed(2));
  }
  throw new Error("No usable TCGplayer price rows for this product");
}

function getFirstStringField(obj, keys) {
  const value = readFirstValue(obj, keys);
  return value == null ? "" : String(value).trim();
}

function getFirstNumericField(obj, keys) {
  const value = readFirstValue(obj, keys);
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function normalizeForMatch(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function scoreTcgCandidate(candidate, cardName, setCode, cardNo) {
  const name = normalizeForMatch(getFirstStringField(candidate, ["name", "productName", "cleanName"]));
  const group = normalizeForMatch(getFirstStringField(candidate, ["groupName", "setName", "group"]));
  const card = normalizeForMatch(cardName);
  const set = normalizeForMatch(setCode);
  const number = normalizeForMatch(cardNo);
  let score = 0;
  if (name.includes(card) || card.includes(name)) score += 12;
  if (set && (name.includes(set) || group.includes(set))) score += 6;
  if (number && name.includes(number)) score += 3;
  return score;
}

async function searchTcgLiveCard({ cardName = "", setCode = "", cardNo = "" }) {
  const normalizedCard = String(cardName || "").trim();
  if (!normalizedCard) {
    throw new Error("Missing card name");
  }

  const categories = await getTcgCategories();
  const pokemonCategory = categories.find((entry) => /pokemon/i.test(String(entry?.name || "")));
  if (!pokemonCategory?.categoryId) {
    throw new Error("Could not resolve TCGplayer Pokemon category");
  }

  const queryName = [normalizedCard, setCode].filter(Boolean).join(" ").trim();
  const endpoint = `/catalog/products?categoryId=${encodeURIComponent(pokemonCategory.categoryId)}&productName=${encodeURIComponent(queryName || normalizedCard)}&limit=40&offset=0&getExtendedFields=true`;
  const data = await tcgApiGet(endpoint);
  if (!data?.Success) {
    throw new Error(`TCGplayer product search failed: ${(data?.Errors || []).join("; ") || "unknown error"}`);
  }

  const results = Array.isArray(data.Results) ? data.Results : [];
  if (!results.length) {
    throw new Error("No TCGplayer products matched this card");
  }

  let best = null;
  let bestScore = -1;
  for (const row of results) {
    const score = scoreTcgCandidate(row, normalizedCard, setCode, cardNo);
    if (score > bestScore) {
      best = row;
      bestScore = score;
    }
  }
  if (!best) {
    throw new Error("Could not match a TCGplayer product");
  }

  const productId = getFirstNumericField(best, ["productId", "productID", "id"]);
  if (!productId) {
    throw new Error("Matched TCGplayer product has no productId");
  }
  const marketPrice = await getTcgProductPrice(productId);

  return {
    productId,
    marketPrice,
    currency: "USD",
    cardName: getFirstStringField(best, ["name", "productName", "cleanName"]) || normalizedCard,
    setName: getFirstStringField(best, ["groupName", "setName", "group"]),
    cardNo: getFirstStringField(best, ["number", "cardNumber"]) || String(cardNo || "").trim(),
    fetchedAt: new Date().toISOString()
  };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function toPenniesDollars(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Number((n / 100).toFixed(2));
}

function slugify(value) {
  return String(value || "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function isLikelySetCode(value) {
  return /^[a-z0-9]{2,12}$/i.test(String(value || "").trim());
}

function toEncodedImageUrl(baseRoute, relPath) {
  const encodedRel = relPath.split(path.sep).map((segment) => encodeURIComponent(segment)).join("/");
  return `/${baseRoute}/${encodedRel}`;
}

function parseSetImageStem(stemValue) {
  const stem = String(stemValue || "").trim();
  if (!stem) {
    return { left: "", right: "", parenCode: "" };
  }
  const lowerStem = stem.toLowerCase();
  const [leftRaw, ...rightParts] = lowerStem.split("--");
  const left = leftRaw.trim();
  const right = rightParts.join("--").trim();
  const codeInParens = lowerStem.match(/\(([a-z0-9-]{2,12})\)\s*$/i);
  const parenCode = codeInParens ? codeInParens[1].toLowerCase() : "";
  return { left, right, parenCode };
}

async function listImageFilesRecursive(rootDir, relativeDir = "") {
  const absoluteDir = path.join(rootDir, relativeDir);
  const entries = await fsp.readdir(absoluteDir, { withFileTypes: true });
  const out = [];

  for (const entry of entries) {
    const relPath = path.join(relativeDir, entry.name);
    if (entry.isDirectory()) {
      out.push(...await listImageFilesRecursive(rootDir, relPath));
      continue;
    }
    if (!entry.isFile()) continue;
    const ext = path.extname(entry.name).toLowerCase();
    if (!SUPPORTED_IMAGE_EXTENSIONS.has(ext)) continue;
    out.push(relPath);
  }

  return out;
}

async function getSetImageManifest() {
  const byCode = {};
  const byName = {};
  const imageFiles = await listImageFilesRecursive(SET_IMAGE_DIR);

  for (const relPath of imageFiles) {
    const absPath = path.join(SET_IMAGE_DIR, relPath);
    try {
      const head = await fsp.readFile(absPath);
      if (isLfsPointer(head)) continue;
    } catch {
      continue;
    }

    const relSegments = relPath.split(path.sep).filter(Boolean);
    const codeFromDir = relSegments.length > 1 ? String(relSegments[0]).toLowerCase().trim() : "";
    const stem = path.parse(path.basename(relPath)).name.trim();
    if (!stem) continue;

    const urlPath = toEncodedImageUrl("set-images", relPath);
    const { left, right, parenCode } = parseSetImageStem(stem);

    if (isLikelySetCode(codeFromDir) && !byCode[codeFromDir]) {
      byCode[codeFromDir] = urlPath;
    }

    if (isLikelySetCode(left) && !byCode[left]) {
      byCode[left] = urlPath;
    }
    if (parenCode && !byCode[parenCode]) {
      byCode[parenCode] = urlPath;
    }

    const rawNameCandidate = (right || stem.toLowerCase()).replace(/\([a-z0-9-]{2,12}\)\s*$/i, "").trim();
    const slugName = slugify(rawNameCandidate);
    if (slugName && !byName[slugName]) {
      byName[slugName] = urlPath;
    }
  }

  return {
    byCode,
    byName,
    totalImages: Object.keys(byCode).length + Object.keys(byName).length
  };
}

async function getSetImageManifestCached() {
  let mtimeMs = 0;
  try {
    const stat = await fsp.stat(SET_IMAGE_DIR);
    mtimeMs = stat.mtimeMs;
    if (setImageManifestMem && mtimeMs === setImageManifestMemMtime) {
      return setImageManifestMem;
    }
  } catch {
    return { byCode: {}, byName: {}, totalImages: 0 };
  }
  const manifest = await getSetImageManifest();
  setImageManifestMem = manifest;
  setImageManifestMemMtime = mtimeMs;
  return manifest;
}

function normalizeLanguage(value) {
  const key = String(value || "english").trim().toLowerCase();
  return key === "japanese" ? "japanese" : "english";
}

function normalizeTcgLookupText(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function decodeHtmlEntities(text) {
  return String(text || "")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, "\"")
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&#(\d+);/g, (_, num) => {
      const code = Number(num);
      return Number.isFinite(code) ? String.fromCharCode(code) : "";
    })
    .replace(/&#x([a-f0-9]+);/gi, (_, hex) => {
      const code = Number.parseInt(hex, 16);
      return Number.isFinite(code) ? String.fromCharCode(code) : "";
    });
}

function parseTcgPriceGuideLinksFromHtml(html = "") {
  const source = String(html || "");
  const rows = [];
  const seen = new Set();
  const anchorRe = /<a\b[^>]*href\s*=\s*"([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  let match = anchorRe.exec(source);
  while (match) {
    const hrefRaw = String(match[1] || "").trim();
    const innerRaw = String(match[2] || "").trim();
    if (!hrefRaw) {
      match = anchorRe.exec(source);
      continue;
    }
    const href = hrefRaw.startsWith("http")
      ? hrefRaw
      : `https://www.tcgplayer.com${hrefRaw.startsWith("/") ? "" : "/"}${hrefRaw}`;
    if (!/\/pokemon\/price-guides\/[^/?#]+/i.test(href)) {
      match = anchorRe.exec(source);
      continue;
    }
    let slug = "";
    try {
      const parsed = new URL(href);
      const parts = parsed.pathname.split("/").filter(Boolean);
      slug = String(parts[parts.length - 1] || "").trim().toLowerCase();
    } catch {
      slug = "";
    }
    if (!slug || slug === "price-guides") {
      match = anchorRe.exec(source);
      continue;
    }
    if (seen.has(slug)) {
      match = anchorRe.exec(source);
      continue;
    }
    seen.add(slug);
    const label = decodeHtmlEntities(innerRaw.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim());
    rows.push({
      slug,
      href: `https://www.tcgplayer.com/categories/trading-and-collectible-card-games/pokemon/price-guides/${slug}`,
      label
    });
    match = anchorRe.exec(source);
  }
  return rows;
}

function scoreTcgGuideRow(row, setCode = "", setName = "") {
  const code = String(setCode || "").trim().toLowerCase();
  const nameNorm = normalizeTcgLookupText(setName);
  const slugNorm = normalizeTcgLookupText(row?.slug || "");
  const labelNorm = normalizeTcgLookupText(row?.label || "");
  const abbrNorm = normalizeTcgLookupText(row?.abbreviation || "");
  if (!slugNorm && !labelNorm) return -1;
  let score = 0;
  if (code && (slugNorm.includes(code) || labelNorm.includes(code))) score += 10;
  if (code && (abbrNorm === code || abbrNorm.startsWith(`${code} `) || abbrNorm.includes(` ${code}`))) score += 30;
  if (nameNorm) {
    if (slugNorm === nameNorm || labelNorm === nameNorm) score += 40;
    if (slugNorm.includes(nameNorm) || labelNorm.includes(nameNorm)) score += 20;
    const words = nameNorm.split(/\s+/).filter(Boolean);
    for (const w of words) {
      if (w.length < 2) continue;
      if (slugNorm.includes(w) || labelNorm.includes(w)) score += 2;
    }
  }
  return score;
}

function pickBestTcgGuideRow(rows, setCode = "", setName = "") {
  const list = Array.isArray(rows) ? rows : [];
  if (!list.length) return null;
  let best = null;
  let bestScore = -1;
  for (const row of list) {
    const score = scoreTcgGuideRow(row, setCode, setName);
    if (score > bestScore) {
      bestScore = score;
      best = row;
    }
  }
  return bestScore > 0 ? best : null;
}

function resolveTcgGuideRowForSet(guideRows, setCode = "", setName = "") {
  const code = String(setCode || "").trim().toUpperCase();
  const forcedSlug = String(TCG_GUIDE_SLUG_BY_SET_CODE[code] || "")
    .trim()
    .toLowerCase();
  if (forcedSlug) {
    const list = Array.isArray(guideRows) ? guideRows : [];
    const hit = list.find((row) => String(row?.slug || "").trim().toLowerCase() === forcedSlug);
    if (hit) return hit;
    const label = String(setName || "").trim() || forcedSlug.replace(/-/g, " ");
    return {
      slug: forcedSlug,
      abbreviation: code,
      label,
      href: `https://www.tcgplayer.com/categories/trading-and-collectible-card-games/pokemon/price-guides/${forcedSlug}`
    };
  }
  return pickBestTcgGuideRow(guideRows, setCode, setName);
}

async function fetchTcgPriceGuideIndex(forceRefresh = false) {
  const now = Date.now();
  if (!forceRefresh && tcgPriceGuideIndexCache.expiresAt > now && Array.isArray(tcgPriceGuideIndexCache.rows)) {
    return tcgPriceGuideIndexCache.rows;
  }
  if (!forceRefresh && tcgPriceGuideIndexInFlight) return tcgPriceGuideIndexInFlight;
  const work = (async () => {
    try {
      const rows = [];
      const seen = new Set();
      const limit = 250;
      for (let offset = 0; offset < 5000; offset += limit) {
        const url = `https://mpapi.tcgplayer.com/v2/Catalog/SetNames?categoryId=3&active=true&limit=${limit}&offset=${offset}`;
        const response = await fetch(url, {
          method: "GET",
          headers: {
            Accept: "application/json, text/plain, */*",
            "User-Agent":
              "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36"
          }
        });
        const payload = await response.json().catch(() => ({}));
        if (!response.ok) {
          throw new Error(`TCGplayer SetNames request failed (${response.status})`);
        }
        const pageRows = Array.isArray(payload?.results) ? payload.results : [];
        if (!pageRows.length) break;
        for (const row of pageRows) {
          const slug = String(row?.urlName || "").trim().toLowerCase();
          if (!slug || seen.has(slug)) continue;
          seen.add(slug);
          rows.push({
            setNameId: Number(row?.setNameId || 0) || null,
            abbreviation: String(row?.abbreviation || "").trim(),
            releaseDate: String(row?.releaseDate || "").trim(),
            slug,
            label: decodeHtmlEntities(String(row?.name || row?.cleanSetName || "").trim()),
            href: `https://www.tcgplayer.com/categories/trading-and-collectible-card-games/pokemon/price-guides/${slug}`
          });
        }
        if (pageRows.length < limit) break;
      }
      if (!rows.length) throw new Error("TCGplayer guide index parse returned no links");
      tcgPriceGuideIndexCache = {
        expiresAt: Date.now() + TCG_PRICE_GUIDE_INDEX_TTL_MS,
        rows
      };
      return rows;
    } finally {
      tcgPriceGuideIndexInFlight = null;
    }
  })();
  tcgPriceGuideIndexInFlight = work;
  return work;
}

function normalizeCardNumberKey(raw) {
  const token = String(raw || "")
    .trim()
    .toUpperCase()
    .replace(/^#+/, "")
    .trim();
  if (!token) return "";
  if (/^\d+$/.test(token)) return String(Number(token));
  return token;
}

function buildTcgplayerProductUrl(productId, productUrlName, printing = "") {
  const pid = Number(productId);
  const slug = String(productUrlName || "").trim();
  const finish = String(printing || "").trim();
  if (!Number.isFinite(pid) || pid <= 0) return "";
  const base = slug
    ? `https://www.tcgplayer.com/product/${pid}/${encodeURIComponent(slug)}`
    : `https://www.tcgplayer.com/product/${pid}`;
  try {
    const parsed = new URL(base);
    parsed.searchParams.set("Language", "English");
    if (finish) parsed.searchParams.set("Printing", finish);
    return parsed.toString();
  } catch {
    if (!finish) {
      return slug
        ? `https://www.tcgplayer.com/product/${pid}/${encodeURIComponent(slug)}?Language=English`
        : `https://www.tcgplayer.com/product/${pid}?Language=English`;
    }
    const printingQs = `Printing=${encodeURIComponent(finish)}`;
    return slug
      ? `https://www.tcgplayer.com/product/${pid}/${encodeURIComponent(slug)}?Language=English&${printingQs}`
      : `https://www.tcgplayer.com/product/${pid}?Language=English&${printingQs}`;
  }
}

function extractTcgPrintingFromUrl(rawUrl = "") {
  try {
    return String(new URL(String(rawUrl || "").trim()).searchParams.get("Printing") || "")
      .trim()
      .replace(/\+/g, " ");
  } catch {
    return "";
  }
}

function normalizeTcgListingPrinting(value) {
  const raw = String(value || "").trim().replace(/\+/g, " ");
  if (!raw) return "";
  if (TCG_PRINT_FINISHES.has(raw)) return raw;
  const lower = raw.toLowerCase();
  if (lower.includes("reverse") && lower.includes("holo")) return "Reverse Holofoil";
  if (lower === "normal") return "Normal";
  if (lower.includes("holofoil")) return "Holofoil";
  return TCG_PRINT_FINISHES.has(raw) ? raw : "";
}

function isKnownTcgPrinting(printing) {
  const norm = normalizeTcgListingPrinting(printing);
  return Boolean(norm && TCG_PRINT_FINISHES.has(norm));
}

const tcgProductPrintingsDiscoveryCache = new Map();

async function discoverTcgProductPrintings(productId) {
  const pid = Number(productId);
  if (!Number.isFinite(pid) || pid <= 0) return [];
  const cacheKey = String(pid);
  if (tcgProductPrintingsDiscoveryCache.has(cacheKey)) {
    return tcgProductPrintingsDiscoveryCache.get(cacheKey);
  }

  const printings = new Set();

  try {
    const historyPayload = await fetchTcgInfiniteMarketHistoryPayload(pid, "30");
    const days = Array.isArray(historyPayload?.result) ? historyPayload.result : [];
    for (const day of days) {
      for (const row of Array.isArray(day?.variants) ? day.variants : []) {
        const key = normalizeTcgListingPrinting(String(row?.variant || "").trim());
        if (isKnownTcgPrinting(key)) printings.add(key);
      }
    }
  } catch {
    // best effort
  }

  try {
    const response = await fetch(`https://mp-search-api.tcgplayer.com/v1/product/${pid}/listings`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/plain, */*",
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36"
      },
      body: JSON.stringify({
        filters: {
          term: {
            sellerStatus: "Live",
            condition: ["Near Mint"],
            language: ["English"]
          }
        },
        sort: { field: "price", order: "asc" },
        size: 50,
        from: 0
      })
    });
    const payload = await response.json().catch(() => ({}));
    const results = Array.isArray(payload?.results) ? payload.results : [];
    const rows = results[0] && Array.isArray(results[0].results) ? results[0].results : [];
    for (const row of rows) {
      if (!isEnglishTcgListing(row)) continue;
      const key = normalizeTcgListingPrinting(row?.printing);
      if (isKnownTcgPrinting(key)) printings.add(key);
    }
  } catch {
    // best effort
  }

  const list = TCG_PRINT_SORT.filter((finish) => printings.has(finish));
  tcgProductPrintingsDiscoveryCache.set(cacheKey, list);
  return list;
}

const TCG_PRINT_SORT = [
  "Normal",
  "Holofoil",
  "Reverse Holofoil",
  "1st Edition",
  "1st Edition Holofoil",
  "Unlimited"
];

function variantsIndexHasMultiplePrintings(variantsByCardNo, cardKeys) {
  for (const key of cardKeys) {
    const list = variantsByCardNo[key];
    if (!Array.isArray(list) || list.length < 2) continue;
    const printings = new Set(
      list.map((row) => normalizeTcgListingPrinting(row?.printing || row?.label)).filter(Boolean)
    );
    if (printings.size >= 2) return true;
  }
  return false;
}

async function enrichVariantsByCardNoWithTcgPrintings(byCardNo, variantsByCardNo) {
  const productToKeys = new Map();
  for (const [key, entry] of Object.entries(byCardNo || {})) {
    const pid = Number(entry?.productId);
    if (!Number.isFinite(pid) || pid <= 0) continue;
    if (!productToKeys.has(pid)) productToKeys.set(pid, []);
    productToKeys.get(pid).push({ key, entry });
  }

  const productIdsToDiscover = [];
  for (const [pid, keyEntries] of productToKeys.entries()) {
    const cardKeys = keyEntries.map((row) => row.key);
    if (variantsIndexHasMultiplePrintings(variantsByCardNo, cardKeys)) continue;
    productIdsToDiscover.push(pid);
  }

  if (!productIdsToDiscover.length) return;

  let cursor = 0;
  const concurrency = 6;
  const workers = Array.from(
    { length: Math.min(concurrency, productIdsToDiscover.length) },
    async () => {
      while (cursor < productIdsToDiscover.length) {
        const pid = productIdsToDiscover[cursor];
        cursor += 1;
        const printings = await discoverTcgProductPrintings(pid);
        if (printings.length < 2) continue;

        for (const { key, entry } of productToKeys.get(pid) || []) {
          const existingList = variantsByCardNo[key] || [];
          const existingPrints = new Set(
            existingList
              .map((row) => normalizeTcgListingPrinting(row?.printing || row?.label))
              .filter(Boolean)
          );

          let productSlug = "";
          try {
            const parts = new URL(String(entry.tcgplayerUrl || "")).pathname.split("/").filter(Boolean);
            if (parts[0] === "product" && parts[2]) productSlug = decodeURIComponent(parts[2]);
          } catch {
            productSlug = "";
          }

          const rarity = String(entry.rarity || "").trim();
          for (const printing of printings) {
            if (existingPrints.has(printing)) continue;
            const variant = {
              productId: pid,
              rarity,
              printing,
              label: printing === "Normal" ? rarity || "Normal" : printing,
              tcgplayerUrl: buildTcgplayerProductUrl(pid, productSlug, printing),
              nearMintWithShipping: "",
              listingCondition: ""
            };
            appendTcgVariantToIndex(variantsByCardNo, key, variant);
            const altKey = normalizeCardNumberKey(String(key).replace(/^0+/, ""));
            if (altKey && altKey !== key) appendTcgVariantToIndex(variantsByCardNo, altKey, variant);
          }
        }
      }
    }
  );
  await Promise.all(workers);
}

function filterListingsByPrinting(rows, printingFilter) {
  const want = normalizeTcgListingPrinting(printingFilter);
  if (!want) return Array.isArray(rows) ? rows : [];
  return (Array.isArray(rows) ? rows : []).filter(
    (row) => normalizeTcgListingPrinting(row?.printing) === want
  );
}

/** Product URLs often use Printing=Normal while live listings are Holofoil (ex, SIR, etc.). */
function resolveListingsForPrintingFilter(rows, printingFilter) {
  const filtered = filterListingsByPrinting(rows, printingFilter);
  if (filtered.length) return filtered;
  const want = normalizeTcgListingPrinting(printingFilter);
  if (want === "Normal") {
    const holoRows = filterListingsByPrinting(rows, "Holofoil");
    if (holoRows.length) return holoRows;
  }
  return filtered;
}

async function fetchTcgProductListingRows(productId, printingFilter) {
  const pid = Number(productId);
  if (!Number.isFinite(pid) || pid <= 0) return [];

  const requestRows = async (printingTerm) => {
    const term = {
      sellerStatus: "Live",
      condition: TCG_LISTING_CONDITION_PRIORITY,
      language: ["English"]
    };
    if (printingTerm) term.printing = [printingTerm];
    const response = await fetch(`https://mp-search-api.tcgplayer.com/v1/product/${pid}/listings`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/plain, */*",
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36"
      },
      body: JSON.stringify({
        filters: { term },
        sort: { field: "price", order: "asc" },
        size: 50,
        from: 0
      })
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) return [];
    const results = Array.isArray(payload?.results) ? payload.results : [];
    return results[0] && Array.isArray(results[0].results) ? results[0].results : [];
  };

  let rows = await requestRows(printingFilter || "");
  const want = normalizeTcgListingPrinting(printingFilter);
  if (!rows.length && want === "Normal") {
    rows = await requestRows("Holofoil");
  }
  if (!rows.length && printingFilter) {
    rows = await requestRows("");
  }
  return resolveListingsForPrintingFilter(rows, printingFilter);
}

function pickTcgListingByAsLowAs(rows, asLowAsPrice) {
  const target = Number(asLowAsPrice);
  if (!Number.isFinite(target) || target <= 0) return null;
  const list = Array.isArray(rows) ? rows.filter((row) => isEnglishTcgListing(row)) : [];
  const tolerance = 0.02;

  for (const condition of TCG_LISTING_CONDITION_PRIORITY) {
    let bestRow = null;
    let bestShipping = Number.POSITIVE_INFINITY;
    let bestTotal = Number.POSITIVE_INFINITY;

    for (const row of list) {
      if (normalizeTcgListingCondition(row?.condition) !== condition) continue;
      const listingPrice = Number(row?.sellerPrice ?? row?.price);
      const shippingPrice = Number(
        row?.rankedShippingPrice ?? row?.shippingPrice ?? row?.sellerShippingPrice ?? 0
      );
      if (!Number.isFinite(listingPrice) || listingPrice <= 0) continue;
      if (Math.abs(listingPrice - target) > tolerance) continue;
      if (!Number.isFinite(shippingPrice) || shippingPrice < 0) continue;

      const total = Number((listingPrice + shippingPrice).toFixed(2));
      const isBetter =
        shippingPrice < bestShipping ||
        (shippingPrice === bestShipping && total < bestTotal);
      if (isBetter) {
        bestShipping = shippingPrice;
        bestTotal = total;
        bestRow = row;
      }
    }

    if (bestRow) return buildTcgListingPick(bestRow, condition);
  }

  return null;
}

function pickTcgListingNearAsLowAsPrice(rows, asLowAsPrice) {
  const target = Number(asLowAsPrice);
  if (!Number.isFinite(target) || target <= 0) return null;

  const exact = pickTcgListingByAsLowAs(rows, target);
  if (exact) return exact;

  const list = Array.isArray(rows) ? rows.filter((row) => isEnglishTcgListing(row)) : [];
  const listingFloor = Math.max(0.05, target - 1.25);

  for (const condition of TCG_LISTING_CONDITION_PRIORITY) {
    let bestRow = null;
    let bestPriceDelta = Number.POSITIVE_INFINITY;
    let bestShipping = Number.POSITIVE_INFINITY;
    let bestTotal = Number.POSITIVE_INFINITY;

    for (const row of list) {
      if (normalizeTcgListingCondition(row?.condition) !== condition) continue;
      const listingPrice = Number(row?.sellerPrice ?? row?.price);
      const shippingPrice = Number(
        row?.rankedShippingPrice ?? row?.shippingPrice ?? row?.sellerShippingPrice ?? 0
      );
      if (!Number.isFinite(listingPrice) || listingPrice <= 0) continue;
      if (!Number.isFinite(shippingPrice) || shippingPrice < 0) continue;
      if (listingPrice < listingFloor) continue;
      if (listingPrice < target * 0.75 && shippingPrice > 5) continue;
      if (shippingPrice > 15) continue;

      const total = Number((listingPrice + shippingPrice).toFixed(2));
      const priceDelta = Math.abs(listingPrice - target);
      const isBetter =
        priceDelta < bestPriceDelta ||
        (priceDelta === bestPriceDelta && shippingPrice < bestShipping) ||
        (priceDelta === bestPriceDelta &&
          shippingPrice === bestShipping &&
          total < bestTotal);
      if (isBetter) {
        bestPriceDelta = priceDelta;
        bestShipping = shippingPrice;
        bestTotal = total;
        bestRow = row;
      }
    }

    if (bestRow) return buildTcgListingPick(bestRow, condition);
  }

  return null;
}

function buildTcgPickFromFeaturedListing(featured, printing = "Holofoil") {
  if (!featured || !Number.isFinite(featured.price) || featured.price <= 0) return null;
  const shipping = Number.isFinite(featured.shipping) && featured.shipping >= 0 ? featured.shipping : 0;
  const price = Number(featured.price);
  const printLabel = String(printing || "").trim();
  const baseCondition = String(featured.condition || "Near Mint").trim();
  const listingCondition = printLabel ? `${baseCondition} ${printLabel}` : baseCondition;
  return {
    listingPrice: Number(price.toFixed(2)),
    shippingPrice: Number(shipping.toFixed(2)),
    totalPrice: Number((price + shipping).toFixed(2)),
    listingCondition,
    nearMintWithShipping: formatTcgListingWithShippingDisplay(price, shipping),
    sellerName: "",
    listingId: null
  };
}

function pickTcgListingForProductDisplay(rows, opts = {}) {
  const asLowAs = Number(opts.asLowAsPrice);
  if (Number.isFinite(asLowAs) && asLowAs > 0) {
    const matched = pickTcgListingNearAsLowAsPrice(rows, asLowAs);
    if (matched) return matched;
  }
  return pickCheapestTcgListingByCondition(rows, opts);
}

function tcgListingPickLooksLikeBait(pick, asLowAsPrice) {
  if (!pick || !Number.isFinite(asLowAsPrice) || asLowAsPrice <= 0) return false;
  const listing = Number(pick.listingPrice);
  const shipping = Number(pick.shippingPrice);
  if (!Number.isFinite(listing) || !Number.isFinite(shipping)) return false;
  if (listing < asLowAsPrice * 0.75 && shipping > 5) return true;
  if (Math.abs(listing - asLowAsPrice) > 1.5 && shipping > 8) return true;
  return false;
}

function tcgStorefrontPlainFromHtml(html) {
  return decodeHtmlEntities(
    String(html || "")
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
  );
}

function parseTcgStorefrontAsLowAs(plain) {
  const match = String(plain || "").match(/As low as\s*\$([0-9,]+\.[0-9]{2})/i);
  return match ? parseUsdAmount(match[1]) : null;
}

function parseTcgStorefrontNmWithShippingMatches(plain) {
  const re =
    /Near Mint(?:\s+Holofoil|\s+Normal)?\s*\$([0-9,]+\.[0-9]{2})\s*\+\s*(?:\$([0-9,]+\.[0-9]{2})\s*Shipping|Free Shipping)/gi;
  const out = [];
  let match = re.exec(String(plain || ""));
  while (match) {
    const price = parseUsdAmount(match[1]);
    let shipping = match[2] != null ? parseUsdAmount(match[2]) : null;
    if (shipping == null && /Free Shipping/i.test(match[0])) shipping = 0;
    if (Number.isFinite(price) && price > 0 && Number.isFinite(shipping) && shipping >= 0) {
      out.push({ price, shipping });
    }
    match = re.exec(String(plain || ""));
  }
  return out;
}

function selectTcgStorefrontFeaturedListing(plain) {
  const asLowAs = parseTcgStorefrontAsLowAs(plain);
  const nmMatches = parseTcgStorefrontNmWithShippingMatches(plain);
  const firstNm = nmMatches[0] || null;
  const tolerance = 0.02;

  if (Number.isFinite(asLowAs) && asLowAs > 0) {
    const atAsLow = nmMatches.filter((row) => Math.abs(row.price - asLowAs) <= tolerance);
    if (atAsLow.length) {
      atAsLow.sort((a, b) => a.shipping - b.shipping || a.price - b.price);
      return { condition: "Near Mint", price: atAsLow[0].price, shipping: atAsLow[0].shipping };
    }
    if (firstNm && asLowAs >= firstNm.price) {
      return { condition: "Near Mint", price: asLowAs, shipping: 0 };
    }
  }

  if (firstNm) {
    return { condition: "Near Mint", price: firstNm.price, shipping: firstNm.shipping };
  }

  if (Number.isFinite(asLowAs) && asLowAs > 0) {
    return { condition: "Near Mint", price: asLowAs, shipping: 0 };
  }

  return null;
}

async function fetchTcgStorefrontPlain(rawUrl = "", productId = null) {
  const preferredUrl = String(rawUrl || "").trim();
  const fallbackUrl = Number.isFinite(Number(productId))
    ? `https://www.tcgplayer.com/product/${Number(productId)}?Language=English`
    : "";
  const targetUrl = preferredUrl || fallbackUrl;
  if (!targetUrl) return "";
  try {
    const response = await fetch(targetUrl, {
      method: "GET",
      headers: {
        Accept: "text/html,application/xhtml+xml",
        "User-Agent": "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)"
      }
    });
    if (!response.ok) return "";
    const html = await response.text();
    if (!html || html.length < 10_000) return "";
    return tcgStorefrontPlainFromHtml(html);
  } catch {
    return "";
  }
}

function getTcgLinkPriceCacheKey(rawUrl = "", productId = null) {
  const pid = Number(productId) || extractTcgplayerProductIdFromUrl(rawUrl);
  if (!Number.isFinite(pid) || pid <= 0) return "";
  const printing = extractTcgPrintingFromUrl(rawUrl);
  return printing ? `${pid}::${printing.toLowerCase()}` : String(pid);
}

function extractTcgplayerProductIdFromUrl(rawUrl = "") {
  const text = String(rawUrl || "").trim();
  if (!text) return null;
  const directMatch = text.match(/\/product\/(\d+)(?:[/?#]|$)/i);
  if (directMatch) {
    const id = Number(directMatch[1]);
    return Number.isFinite(id) && id > 0 ? id : null;
  }
  try {
    const parsed = new URL(text);
    const qsProduct = parsed.searchParams.get("productLine") || parsed.searchParams.get("productId");
    const id = Number(qsProduct);
    return Number.isFinite(id) && id > 0 ? id : null;
  } catch {
    return null;
  }
}

function parseUsdAmount(value) {
  const cleaned = String(value || "").replace(/[^0-9.]+/g, "");
  const n = Number(cleaned);
  return Number.isFinite(n) && n >= 0 ? Number(n.toFixed(2)) : null;
}

const TCG_LISTING_CONDITION_PRIORITY = [
  "Near Mint",
  "Lightly Played",
  "Moderately Played",
  "Heavily Played",
  "Damaged"
];

const TCG_ENGLISH_LANGUAGE_ID = 1;
const TCG_NON_ENGLISH_LANGUAGE_CODES = new Set([
  "CN",
  "CHI",
  "CHINESE",
  "ZH",
  "ZHS",
  "ZHT",
  "ZHCN",
  "ZHTW",
  "JP",
  "JA",
  "JAPANESE",
  "KR",
  "KO",
  "KOREAN"
]);

const TCG_NON_ENGLISH_TEXT_MARKERS = [
  /\bkorean\b/i,
  /\bkorea\b/i,
  /\[\s*korean\s*\]/i,
  /\[\s*kr\s*\]/i,
  /\bjapanese\b/i,
  /\[\s*japanese\s*\]/i,
  /\[\s*jp\s*\]/i,
  /\bchinese\b/i,
  /\bsimplified\b/i,
  /\btraditional\b/i,
  /\[\s*chinese\s*\]/i,
  /\[\s*cn\s*\]/i,
  /\[\s*zh\s*\]/i,
  /\bs-chinese\b/i,
  /\bpokemon\s+japan\b/i,
  /\b日本語\b/,
  /\b韓国\b/,
  /\b中文\b/,
  /\b简体\b/,
  /\b繁体\b/
];

function textLooksNonEnglishTcg(value) {
  const text = String(value || "");
  if (!text) return false;
  return TCG_NON_ENGLISH_TEXT_MARKERS.some((pattern) => pattern.test(text));
}

function normalizeTcgListingLanguage(value) {
  return String(value || "")
    .trim()
    .toUpperCase()
    .replace(/\./g, "");
}

function isEnglishTcgSetName(setName) {
  const text = String(setName || "").trim();
  if (!text) return true;
  return !textLooksNonEnglishTcg(text);
}

function isEnglishTcgListing(row) {
  if (!row || typeof row !== "object") return false;
  const language = normalizeTcgListingLanguage(row.languageAbbreviation || row.language);
  if (language) {
    if (TCG_NON_ENGLISH_LANGUAGE_CODES.has(language)) return false;
    if (language !== "EN" && language !== "ENGLISH") return false;
  }
  const languageId = Number(row.languageId);
  if (Number.isFinite(languageId) && languageId > 0 && languageId !== TCG_ENGLISH_LANGUAGE_ID) {
    return false;
  }
  const blob = [
    row.customData?.title,
    row.customData?.description,
    row.productName,
    row.printing,
    row.listingType
  ]
    .filter(Boolean)
    .join(" ");
  if (textLooksNonEnglishTcg(blob)) return false;
  return true;
}

function isPokemonTcgProductLine(value) {
  const text = String(value || "").trim().toLowerCase();
  if (!text) return false;
  // Exact Pokemon TCG line names from TCGplayer search/details.
  return text === "pokemon" || text === "pokémon" || text.startsWith("pokemon ") || text.startsWith("pokémon ");
}

function withPokemonTcgSearchFilters(term = {}) {
  const base = term && typeof term === "object" ? { ...term } : {};
  base.productLineName = ["Pokemon"];
  return base;
}

function buildTcgPokemonSearchRequest({ q = "", setName = "", from = 0, size = 50 } = {}) {
  const term = withPokemonTcgSearchFilters({});
  const setLabel = String(setName || "").trim();
  if (setLabel) term.setName = [setLabel];
  const payload = {
    q: String(q || ""),
    filters: { term },
    from: Math.max(0, Number(from) || 0),
    size: Math.max(1, Math.min(250, Number(size) || 50))
  };
  return payload;
}

function isEnglishTcgSearchProduct(row) {
  if (!row || typeof row !== "object") return false;
  if (!isPokemonTcgProductLine(row.productLineName)) return false;
  if (!isEnglishTcgSetName(row.setName)) return false;
  const blob = [
    row.productName,
    row.setName,
    row.setUrlName,
    row.productLineName,
    row.customAttributes?.description,
    row.customAttributes?.flavorText
  ]
    .filter(Boolean)
    .join(" ");
  if (textLooksNonEnglishTcg(blob)) return false;
  const listings = Array.isArray(row.listings) ? row.listings : [];
  if (listings.length > 0 && !listings.some((listing) => isEnglishTcgListing(listing))) {
    return false;
  }
  return true;
}

function getBestEnglishListingPrice(row, { nearMintOnly = false } = {}) {
  const listings = Array.isArray(row?.listings) ? row.listings : [];
  let best = null;
  for (const listing of listings) {
    if (!isEnglishTcgListing(listing)) continue;
    const condition = String(listing?.condition || "").trim().toLowerCase();
    if (nearMintOnly && !condition.includes("near mint")) continue;
    const listingPrice = Number(listing?.sellerPrice ?? listing?.price);
    if (!Number.isFinite(listingPrice) || listingPrice <= 0) continue;
    best = best == null ? listingPrice : Math.min(best, listingPrice);
  }
  return Number.isFinite(best) && best > 0 ? Number(best.toFixed(2)) : null;
}

function normalizeTcgListingCondition(value) {
  const text = String(value || "").trim();
  if (!text) return "";
  const lower = text.toLowerCase();
  for (const condition of TCG_LISTING_CONDITION_PRIORITY) {
    if (lower.startsWith(condition.toLowerCase())) return condition;
  }
  return text;
}

function getTcgListingConditionPriority(condition) {
  const normalized = normalizeTcgListingCondition(condition);
  const idx = TCG_LISTING_CONDITION_PRIORITY.indexOf(normalized);
  return idx === -1 ? TCG_LISTING_CONDITION_PRIORITY.length : idx;
}

function formatTcgListingWithShippingDisplay(listingPrice, shippingPrice) {
  if (!Number.isFinite(listingPrice) || listingPrice <= 0) return "";
  if (!Number.isFinite(shippingPrice) || shippingPrice < 0) return "";
  return shippingPrice === 0
    ? `$${listingPrice.toFixed(2)} + Free Shipping`
    : `$${listingPrice.toFixed(2)} + $${shippingPrice.toFixed(2)} Shipping`;
}

function buildTcgListingPick(row, conditionLabel = "") {
  const listingPrice = Number(row?.sellerPrice ?? row?.price);
  const shippingPrice = Number(
    row?.rankedShippingPrice ?? row?.shippingPrice ?? row?.sellerShippingPrice ?? 0
  );
  const printing = String(row?.printing || "").trim();
  const baseCondition =
    conditionLabel || normalizeTcgListingCondition(row?.condition) || "Near Mint";
  const listingCondition = printing ? `${baseCondition} ${printing}` : baseCondition;
  const totalPrice = Number((listingPrice + shippingPrice).toFixed(2));

  return {
    listingPrice: Number(listingPrice.toFixed(2)),
    shippingPrice: Number(shippingPrice.toFixed(2)),
    totalPrice,
    listingCondition,
    nearMintWithShipping: formatTcgListingWithShippingDisplay(listingPrice, shippingPrice),
    sellerName: String(row?.sellerName || "").trim(),
    listingId: Number(row?.listingId || 0) || null
  };
}

/** Cheapest English listing: NM first, then LP → MP → HP → Damaged.
 *  Matches TCGplayer product pages: lowest item price for the condition, with that listing's shipping. */
function pickCheapestTcgListingByCondition(rows, opts = {}) {
  const list = Array.isArray(rows) ? rows.filter((row) => isEnglishTcgListing(row)) : [];
  const skipPennyWhenHigherTierExists = opts.skipPennyWhenHigherTierExists === true;
  const pennyCeiling = 0.01;
  const higherTierFloor = Number(opts.higherTierListingFloor) > 0 ? Number(opts.higherTierListingFloor) : 0.05;

  for (const condition of TCG_LISTING_CONDITION_PRIORITY) {
    let bestRow = null;
    let bestListingPrice = Number.POSITIVE_INFINITY;
    let bestTotal = Number.POSITIVE_INFINITY;
    let higherTierRow = null;
    let higherTierListingPrice = Number.POSITIVE_INFINITY;
    let higherTierTotal = Number.POSITIVE_INFINITY;

    for (const row of list) {
      if (normalizeTcgListingCondition(row?.condition) !== condition) continue;
      const listingPrice = Number(row?.sellerPrice ?? row?.price);
      const shippingPrice = Number(
        row?.rankedShippingPrice ?? row?.shippingPrice ?? row?.sellerShippingPrice ?? 0
      );
      if (!Number.isFinite(listingPrice) || listingPrice <= 0) continue;
      if (!Number.isFinite(shippingPrice) || shippingPrice < 0) continue;

      const total = Number((listingPrice + shippingPrice).toFixed(2));
      const isBetter =
        listingPrice < bestListingPrice ||
        (listingPrice === bestListingPrice && total < bestTotal);
      if (isBetter) {
        bestListingPrice = listingPrice;
        bestTotal = total;
        bestRow = row;
      }

      if (listingPrice >= higherTierFloor) {
        const tierBetter =
          listingPrice < higherTierListingPrice ||
          (listingPrice === higherTierListingPrice && total < higherTierTotal);
        if (tierBetter) {
          higherTierListingPrice = listingPrice;
          higherTierTotal = total;
          higherTierRow = row;
        }
      }
    }

    if (
      bestRow &&
      skipPennyWhenHigherTierExists &&
      bestListingPrice <= pennyCeiling &&
      higherTierRow
    ) {
      bestRow = higherTierRow;
    }

    if (bestRow) return buildTcgListingPick(bestRow, condition);
  }

  return null;
}

function pickBestTcgListing(rows) {
  return pickCheapestTcgListingByCondition(rows);
}

async function fetchTcgStorefrontFirstListing(rawUrl = "", productId = null, plainText = "") {
  const plain = String(plainText || "").trim() || (await fetchTcgStorefrontPlain(rawUrl, productId));
  if (!plain) return null;

  const featured = selectTcgStorefrontFeaturedListing(plain);
  if (!featured) return null;

  const sellerMatch = plain.match(/Sold by\s+([A-Za-z0-9 .&'/-]{2,120})/i);
  let sellerName = sellerMatch ? String(sellerMatch[1]).trim() : "";
  if (sellerName) {
    sellerName = sellerName
      .split(/\s+\d+\s+\d+\s+of\s+\d+/i)[0]
      .split(/\s+Add to Cart/i)[0]
      .split(/\s+View\s+\d+/i)[0]
      .trim();
  }

  const price = featured.price;
  const shipping = featured.shipping;
  return {
    listingCondition: featured.condition,
    nearMintPrice: Number(price.toFixed(2)),
    shippingPrice: Number(shipping.toFixed(2)),
    totalPrice: Number((price + shipping).toFixed(2)),
    nearMintWithShipping: formatTcgListingWithShippingDisplay(price, shipping),
    sellerName,
    source: "tcgplayer-storefront"
  };
}

function pickTcgPublicPriceFromPricepoints(rows) {
  const list = Array.isArray(rows) ? rows : [];
  let best = null;
  for (const row of list) {
    const candidate = [
      Number(row?.listedMedianPrice),
      Number(row?.marketPrice),
      Number(row?.buylistMarketPrice)
    ].find((n) => Number.isFinite(n) && n > 0);
    if (!Number.isFinite(candidate) || candidate <= 0) continue;
    best = best == null ? candidate : Math.min(best, candidate);
  }
  return Number.isFinite(best) && best > 0 ? Number(best.toFixed(2)) : null;
}

async function fetchTcgPriceFromProductLink(rawUrl = "", options = {}) {
  const opts = typeof options === "boolean" ? { forceRefresh: options } : options || {};
  const forceRefresh = opts.forceRefresh === true;
  const cacheOnly = opts.cacheOnly === true;
  const productId = extractTcgplayerProductIdFromUrl(rawUrl);
  if (!productId) {
    return { ok: false, productId: null, price: null, error: "Invalid or unsupported TCGplayer product URL" };
  }
  const cacheKey = getTcgLinkPriceCacheKey(rawUrl, productId) || String(productId);
  const now = Date.now();
  const cachedHit = readTcgLinkPriceFromCache(productId, rawUrl);
  if (!forceRefresh && cachedHit) {
    return cachedHit;
  }
  if (cacheOnly) {
    if (isTcgAdminPriceCachingActive()) {
      queueTcgLinkPriceBackgroundRefresh(rawUrl);
    }
    return {
      ok: false,
      productId,
      price: null,
      pending: true,
      cached: false,
      error: isTcgAdminPriceCachingActive()
        ? "Price not in server cache yet; bulk price check in progress"
        : "Price not in server cache; start “Update all TCG prices” in Admin to build the cache",
      prewarmInFlight: tcgLinkPricePrewarmInFlight,
      prewarmLastRunAt: tcgLinkPricePrewarmStatus.lastRunAt
    };
  }
  const inflight = !forceRefresh ? tcgLinkPriceInFlight.get(cacheKey) : null;
  if (inflight) return inflight;

  const work = (async () => {
    try {
      let marketPriceFromDetails = null;
      try {
        const detailsRes = await fetch(`https://mp-search-api.tcgplayer.com/v2/product/${productId}/details`, {
          method: "GET",
          headers: {
            Accept: "application/json, text/plain, */*",
            "User-Agent":
              "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36"
          }
        });
        const details = await detailsRes.json().catch(() => ({}));
        if (detailsRes.ok && details && typeof details === "object") {
          const productBlob = [
            details.productName,
            details.setName,
            details.productLineName,
            details.customAttributes?.description
          ]
            .filter(Boolean)
            .join(" ");
          if (!isPokemonTcgProductLine(details.productLineName)) {
            return {
              ok: false,
              productId,
              price: null,
              skippedNonPokemon: true,
              error: "TCGplayer product is not a Pokemon listing"
            };
          }
          if (textLooksNonEnglishTcg(productBlob) || !isEnglishTcgSetName(details.setName)) {
            return {
              ok: false,
              productId,
              price: null,
              error: "TCGplayer product is not an English card listing"
            };
          }
        }
        const market = Number(details?.marketPrice);
        if (detailsRes.ok && Number.isFinite(market) && market > 0) {
          marketPriceFromDetails = Number(market.toFixed(2));
        }
      } catch {
        marketPriceFromDetails = null;
      }

      const printingFilter = extractTcgPrintingFromUrl(rawUrl);
      const printingNorm = normalizeTcgListingPrinting(printingFilter);
      const [printingRows, storefrontPlain] = await Promise.all([
        fetchTcgProductListingRows(productId, printingFilter),
        fetchTcgStorefrontPlain(rawUrl, productId)
      ]);
      const asLowAsPrice = parseTcgStorefrontAsLowAs(storefrontPlain);
      if (Number.isFinite(asLowAsPrice) && asLowAsPrice > 0 && storefrontPlain) {
        const featured = selectTcgStorefrontFeaturedListing(storefrontPlain);
        const fromFeatured = buildTcgPickFromFeaturedListing(
          featured,
          printingNorm === "Normal" ? "Holofoil" : printingNorm || "Holofoil"
        );
        if (fromFeatured) {
          return stampTcgLinkPriceResult({
            ok: true,
            productId,
            price: fromFeatured.totalPrice,
            totalPrice: fromFeatured.totalPrice,
            nearMintPrice: fromFeatured.listingPrice,
            shippingPrice: fromFeatured.shippingPrice,
            listingCondition: fromFeatured.listingCondition,
            nearMintWithShipping: fromFeatured.nearMintWithShipping,
            sellerName: fromFeatured.sellerName,
            listingId: null,
            source: "tcgplayer-storefront",
            marketPrice: marketPriceFromDetails,
            error: ""
          });
        }
      }

      let pickRows = printingRows;
      if (printingNorm === "Reverse Holofoil") {
        const withShip = printingRows.filter((row) => {
          const ship = Number(
            row?.rankedShippingPrice ?? row?.shippingPrice ?? row?.sellerShippingPrice ?? 0
          );
          return Number.isFinite(ship) && ship >= 1 && ship <= 3;
        });
        if (withShip.length) pickRows = withShip;
      }
      let picked = pickTcgListingForProductDisplay(pickRows, {
        asLowAsPrice,
        skipPennyWhenHigherTierExists: printingNorm === "Reverse Holofoil",
        higherTierListingFloor: printingNorm === "Reverse Holofoil" ? 0.1 : 0.05
      });

      if (picked && tcgListingPickLooksLikeBait(picked, asLowAsPrice) && storefrontPlain) {
        const featured = selectTcgStorefrontFeaturedListing(storefrontPlain);
        const fromFeatured = buildTcgPickFromFeaturedListing(
          featured,
          printingNorm === "Normal" ? "Holofoil" : printingNorm || "Holofoil"
        );
        if (fromFeatured) picked = fromFeatured;
      }

      if (picked) {
        return stampTcgLinkPriceResult({
          ok: true,
          productId,
          price: picked.totalPrice,
          totalPrice: picked.totalPrice,
          nearMintPrice: picked.listingPrice,
          shippingPrice: picked.shippingPrice,
          listingCondition: picked.listingCondition,
          nearMintWithShipping: picked.nearMintWithShipping,
          sellerName: picked.sellerName,
          listingId: picked.listingId,
          source: "tcgplayer-link",
          marketPrice: marketPriceFromDetails,
          error: ""
        });
      }

      const storefrontPrimary = await fetchTcgStorefrontFirstListing(rawUrl, productId, storefrontPlain);
      if (storefrontPrimary && Number.isFinite(storefrontPrimary.totalPrice) && storefrontPrimary.totalPrice > 0) {
        return stampTcgLinkPriceResult({
          ok: true,
          productId,
          price: storefrontPrimary.totalPrice,
          totalPrice: storefrontPrimary.totalPrice,
          nearMintPrice: storefrontPrimary.nearMintPrice,
          shippingPrice: storefrontPrimary.shippingPrice,
          listingCondition: storefrontPrimary.listingCondition || "Near Mint",
          nearMintWithShipping: storefrontPrimary.nearMintWithShipping,
          sellerName: storefrontPrimary.sellerName || "",
          listingId: null,
          source: storefrontPrimary.source || "tcgplayer-storefront",
          marketPrice: marketPriceFromDetails,
          error: ""
        });
      }

      const pcFallback = await buildTcgPriceFromPriceChartingUngraded(
        productId,
        rawUrl,
        opts.priceChartingContext
      );
      if (pcFallback) return pcFallback;

      return {
        ok: false,
        productId,
        price: null,
        error: "No English listings found for supported conditions"
      };
    } catch (err) {
      const pcFallback = await buildTcgPriceFromPriceChartingUngraded(
        productId,
        rawUrl,
        opts.priceChartingContext
      );
      if (pcFallback) return pcFallback;
      return {
        ok: false,
        productId,
        price: null,
        error: err.message || "Failed to fetch TCGplayer link price"
      };
    } finally {
      tcgLinkPriceInFlight.delete(cacheKey);
    }
  })();
  tcgLinkPriceInFlight.set(cacheKey, work);
  const result = enrichTcgLinkPriceResult(await work);
  const stamped = stampTcgLinkPriceResult(result);
  if (stamped && stamped.ok && tcgLinkPriceCacheValueValid(stamped)) {
    tcgLinkPriceCache.set(cacheKey, {
      value: stamped,
      expiresAt: Date.now() + TCG_LINK_PRICE_CACHE_TTL_MS
    });
    schedulePersistTcgLinkPriceCache();
  } else if (!stamped?.ok) {
    tcgLinkPriceCache.delete(cacheKey);
  }
  return stamped || result;
}

function buildTcgSetSearchQueryCandidates(bestGuideRow, setCode = "", setName = "") {
  const out = [];
  const abbr = String(bestGuideRow?.abbreviation || "")
    .trim()
    .toUpperCase();
  const label = String(bestGuideRow?.label || "").trim();
  const slugWords = bestGuideRow?.slug ? String(bestGuideRow.slug).replace(/-/g, " ") : "";
  const code = String(setCode || "").trim().toUpperCase();
  const name = String(setName || "").trim();
  if (abbr && label) out.push(`${abbr} ${label}`);
  if (label) out.push(label);
  if (slugWords) out.push(slugWords);
  if (name && name !== label) out.push(name);
  if (code && label) out.push(`${code} ${label}`);
  if (code && name) out.push(`${code} ${name}`);
  if (code) out.push(code);
  return [...new Set(out.filter(Boolean))];
}

const TCG_PRINT_FINISHES = new Set([
  "Normal",
  "Holofoil",
  "Reverse Holofoil",
  "1st Edition",
  "Unlimited",
  "1st Edition Holofoil"
]);

const TCG_PRINT_SORT_ORDER = [
  "Normal",
  "Holofoil",
  "Reverse Holofoil",
  "1st Edition",
  "Unlimited",
  "1st Edition Holofoil"
];

function tcgPrintSortRank(printing) {
  const key = String(printing || "").trim();
  const idx = TCG_PRINT_SORT_ORDER.indexOf(key);
  return idx === -1 ? TCG_PRINT_SORT_ORDER.length + 1 : idx;
}

function compareMarketHistorySeries(a, b) {
  const srcA = String(a?.source || "").trim();
  const srcB = String(b?.source || "").trim();
  if (srcA === "pricecharting" && srcB !== "pricecharting") return -1;
  if (srcB === "pricecharting" && srcA !== "pricecharting") return 1;
  if (srcA === "pricecharting" && srcB === "pricecharting") {
    return comparePriceChartingSeries(a, b);
  }
  const printA = String(a?.printing || a?.variantKey || "").trim();
  const printB = String(b?.printing || b?.variantKey || "").trim();
  const rankA = tcgPrintSortRank(printA);
  const rankB = tcgPrintSortRank(printB);
  if (rankA !== rankB) return rankA - rankB;
  return String(a?.label || "").localeCompare(String(b?.label || ""), undefined, {
    sensitivity: "base"
  });
}

function pickTcgVariantPrintLabel(row) {
  const printing = String(row?.printing || "").trim();
  if (printing && TCG_PRINT_FINISHES.has(printing)) return printing;
  const rarity = String(row?.rarityName || row?.rarity || "").trim();
  if (rarity && TCG_PRINT_FINISHES.has(rarity)) return rarity;
  for (const finish of TCG_PRINT_FINISHES) {
    if (rarity.includes(finish)) return finish;
  }
  if (printing) return printing;
  return "Normal";
}

function appendTcgVariantToIndex(variantsByCardNo, key, variant) {
  if (!key || !variant?.productId) return;
  if (!variantsByCardNo[key]) variantsByCardNo[key] = [];
  const list = variantsByCardNo[key];
  const printKey = String(variant.printing || variant.label || "")
    .trim()
    .toLowerCase();
  const existingIdx = list.findIndex(
    (row) =>
      Number(row.productId) === Number(variant.productId) &&
      String(row.printing || row.label || "")
        .trim()
        .toLowerCase() === printKey
  );
  if (existingIdx >= 0) {
    const prev = list[existingIdx];
    if (!prev.tcgplayerUrl && variant.tcgplayerUrl) list[existingIdx] = { ...prev, ...variant };
    return;
  }
  list.push(variant);
}

function ingestTcgSearchRowsIntoByCardNo(
  rows,
  byCardNo,
  setNameNorm = "",
  setUrlNorm = "",
  variantsByCardNo = null
) {
  const list = Array.isArray(rows) ? rows : [];
  for (const row of list) {
    if (!isEnglishTcgSearchProduct(row)) continue;

    const rowSetNameNorm = normalizeTcgLookupText(row?.setName || "");
    const rowSetUrlNorm = normalizeTcgLookupText(row?.setUrlName || "");
    const matchesSet =
      (setNameNorm && rowSetNameNorm === setNameNorm) ||
      (setUrlNorm && rowSetUrlNorm === setUrlNorm) ||
      (!setNameNorm && !setUrlNorm);
    if (!matchesSet) continue;

    const rawNumber = String(row?.customAttributes?.number || "").trim();
    if (!rawNumber) continue;
    const baseNumber = rawNumber.split("/")[0].trim();
    const rawKey = normalizeCardNumberKey(baseNumber);
    if (!rawKey) continue;

    const productId = Number(row?.productId);
    const rarity = String(row?.rarityName || row?.rarity || "").trim();
    const printingLabel = pickTcgVariantPrintLabel(row);
    const buyPrice = getTcgSearchRowBuyPrice(row);
    const tcgplayerUrl = buildTcgplayerProductUrl(row?.productId, row?.productUrlName, printingLabel);
    const entry = {
      cardNumber: baseNumber,
      name: String(row?.productName || "").trim(),
      tcgplayerPrice: buyPrice ? buyPrice.tcgplayerPrice : null,
      nearMintAddToCartPrice: buyPrice ? buyPrice.nearMintAddToCartPrice : null,
      nearMintWithShipping: buyPrice ? buyPrice.nearMintWithShipping : "",
      listingCondition: buyPrice ? buyPrice.listingCondition : "",
      tcgplayerUrl,
      productId: Number.isFinite(productId) && productId > 0 ? productId : null,
      rarity,
      cardmarketPrice: null,
      cardmarketUrl: ""
    };

    const variant = {
      productId: entry.productId,
      rarity,
      printing: printingLabel,
      label: printingLabel,
      tcgplayerUrl,
      tcgplayerPrice: entry.tcgplayerPrice,
      nearMintWithShipping: buyPrice ? buyPrice.nearMintWithShipping : "",
      listingCondition: buyPrice ? buyPrice.listingCondition : "",
      marketPrice: Number(row?.marketPrice) || null
    };

    const altKey = normalizeCardNumberKey(baseNumber.replace(/^0+/, ""));
    for (const key of [rawKey, altKey]) {
      upsertSetPriceEntry(byCardNo, key, entry);
      if (variantsByCardNo) appendTcgVariantToIndex(variantsByCardNo, key, variant);
    }
  }
}

async function fetchTcgProductsByGuideSetName(bestGuideRow) {
  const guideLabel = String(bestGuideRow?.label || "").trim();
  if (!guideLabel) return null;
  const guideSlug = String(bestGuideRow?.slug || "").trim();
  const setNameNorm = normalizeTcgLookupText(guideLabel);
  const setUrlNorm = normalizeTcgLookupText(guideSlug);
  const byCardNo = {};
  const variantsByCardNo = {};
  const PAGE_SIZE = 50;
  const MAX_PAGES = 20;
  const firstPayload = await fetchTcgSearchRequest(
    buildTcgPokemonSearchRequest({ setName: guideLabel, from: 0, size: PAGE_SIZE })
  );
  const firstResult = Array.isArray(firstPayload.results) ? firstPayload.results[0] : null;
  const totalResults = Number(firstResult?.totalResults || 0);
  if (!totalResults) return null;
  const totalPages = Math.max(1, Math.min(MAX_PAGES, Math.ceil(totalResults / PAGE_SIZE) || 1));
  const pagePayloads = [firstPayload];
  if (totalPages > 1) {
    const pending = [];
    for (let page = 1; page < totalPages; page += 1) {
      pending.push(
        fetchTcgSearchRequest(
          buildTcgPokemonSearchRequest({
            setName: guideLabel,
            from: page * PAGE_SIZE,
            size: PAGE_SIZE
          })
        )
      );
    }
    if (pending.length) {
      pagePayloads.push(...(await Promise.all(pending)));
    }
  }
  for (const payload of pagePayloads) {
    const result = Array.isArray(payload?.results) ? payload.results[0] : null;
    const rows = Array.isArray(result?.results) ? result.results : [];
    ingestTcgSearchRowsIntoByCardNo(rows, byCardNo, setNameNorm, setUrlNorm, variantsByCardNo);
  }
  await enrichVariantsByCardNoWithTcgPrintings(byCardNo, variantsByCardNo);
  return {
    guideSetName: guideLabel,
    guideSetUrlValue: guideSlug,
    byCardNo,
    variantsByCardNo
  };
}

async function fetchTcgSearchRequest(payload) {
  const response = await fetch("https://mp-search-api.tcgplayer.com/v1/search/request", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/plain, */*",
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36"
    },
    body: JSON.stringify(payload || {})
  });
  const jsonData = await response.json().catch(() => ({}));
  if (!response.ok) {
    const details = JSON.stringify(jsonData || {});
    throw new Error(`TCGplayer guide search failed (${response.status}): ${details.slice(0, 220)}`);
  }
  return jsonData;
}

function pickBestGuideSetAggregation(setAggs, setCode, setName) {
  const list = Array.isArray(setAggs) ? setAggs : [];
  if (!list.length) return null;
  const code = String(setCode || "").trim().toUpperCase();
  const nameNorm = normalizeTcgLookupText(setName);

  if (code) {
    const byCode = list.find((row) =>
      String(row.value || "")
        .toUpperCase()
        .startsWith(`${code}:`)
    );
    if (byCode) return byCode;
  }

  if (nameNorm) {
    let best = null;
    let bestScore = -1;
    const words = nameNorm.split(/\s+/).filter(Boolean);
    for (const row of list) {
      const valueNorm = normalizeTcgLookupText(row.value || "");
      const urlNorm = normalizeTcgLookupText(row.urlValue || "");
      let score = 0;
      if (valueNorm === nameNorm || urlNorm === nameNorm) score += 8;
      if (valueNorm.includes(nameNorm) || nameNorm.includes(valueNorm)) score += 4;
      for (const w of words) {
        if (valueNorm.includes(w) || urlNorm.includes(w)) score += 1;
      }
      if (score > bestScore) {
        bestScore = score;
        best = row;
      }
    }
    if (best && bestScore > 0) return best;
  }

  return list[0] || null;
}

function getSetPricingCacheKey(setCode = "", setName = "") {
  const code = String(setCode || "").trim().toUpperCase();
  const name = normalizeTcgLookupText(setName);
  return `${code}::${name}::mpv${SET_PRICING_MANIFEST_VERSION}`;
}

const tcgMarketHistoryCache = new Map();
const TCG_MARKET_HISTORY_CACHE_TTL_MS = 60 * 60 * 1000;
const TCG_INFINITE_HISTORY_RANGE = {
  "30": "month",
  "90": "quarter",
  "180": "annual",
  "365": "annual"
};

function buildCardPricingLookupKeys(cardNo = "") {
  const rawCardNo = String(cardNo || "").trim();
  const trailingDigitsMatch = rawCardNo.match(/(\d{1,4})$/);
  const trailingDigits = trailingDigitsMatch ? trailingDigitsMatch[1] : "";
  const numericTail = trailingDigits ? String(Number(trailingDigits)) : "";
  return [
    rawCardNo.toUpperCase(),
    normalizeCardNumberKey(rawCardNo),
    normalizeCardNumberKey(rawCardNo.replace(/^0+/, "")),
    trailingDigits,
    numericTail
  ].filter(Boolean);
}

function pickFirstFromVariantsIndex(variantsByCardNo, cardNo) {
  const keys = buildCardPricingLookupKeys(cardNo);
  for (const key of keys) {
    const list = variantsByCardNo[key];
    if (Array.isArray(list) && list.length) return list;
  }
  return [];
}

const TCG_FINISH_VARIANT_LABELS = new Set([
  "Normal",
  "Holofoil",
  "Reverse Holofoil",
  "1st Edition",
  "Unlimited",
  "1st Edition Holofoil"
]);

function shouldIncludeMarketHistoryVariant(variantKey) {
  const key = String(variantKey || "").trim();
  return Boolean(key);
}

function pickMarketHistoryVariantLabel({ chainKey = "", tcgRarity = "", detailRarity = "" }) {
  const finish = String(chainKey || "").trim();
  const rarity = String(detailRarity || tcgRarity || "").trim();
  if (finish === "Normal" || finish === "Holofoil") {
    return rarity || finish;
  }
  if (TCG_FINISH_VARIANT_LABELS.has(finish)) return finish;
  if (rarity) return rarity;
  return finish || "Unknown";
}

function filterPositiveMarketHistoryPoints(points) {
  return (Array.isArray(points) ? points : []).filter(
    (point) => Number.isFinite(point?.price) && point.price > 0
  );
}

function computeMarketHistoryDelta(points) {
  const usable = filterPositiveMarketHistoryPoints(points);
  if (usable.length < 1) {
    return { priceChange: null, percentChange: null, startPrice: null, endPrice: null };
  }
  const first = usable[0].price;
  const last = usable[usable.length - 1].price;
  const priceChange = Number((last - first).toFixed(2));
  const percentChange =
    Number.isFinite(first) && first > 0 ? Number(((priceChange / first) * 100).toFixed(2)) : null;
  return {
    priceChange,
    percentChange,
    startPrice: first,
    endPrice: last
  };
}

function marketHistoryRangeLabel(rangeKey) {
  if (rangeKey === "all") return "All Time";
  if (rangeKey === "90") return "3 Months";
  if (rangeKey === "180") return "6 Months";
  if (rangeKey === "365") return "1 Year";
  return "30 Days";
}

function tcgInfiniteHistoryRangeParam(rangeKey) {
  if (rangeKey === "all" || rangeKey === "365" || rangeKey === "180") return "annual";
  if (rangeKey === "90") return "quarter";
  return "month";
}

async function fetchTcgInfiniteMarketHistoryPayload(productId, rangeKey) {
  const pid = Number(productId);
  if (!Number.isFinite(pid) || pid <= 0) return null;
  const apiRange = tcgInfiniteHistoryRangeParam(rangeKey);
  const cacheKey = `${pid}:${apiRange}`;
  const now = Date.now();
  const cached = tcgMarketHistoryCache.get(cacheKey);
  if (cached && cached.expiresAt > now) return cached.value;

  const url = `https://infinite-api.tcgplayer.com/price/history/${pid}?range=${encodeURIComponent(apiRange)}`;
  const response = await fetch(url, {
    method: "GET",
    headers: {
      Accept: "application/json, text/plain, */*",
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36",
      Referer: "https://www.tcgplayer.com/"
    }
  });
  const text = await response.text();
  let payload = null;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    payload = null;
  }
  if (!response.ok) {
    return null;
  }
  tcgMarketHistoryCache.set(cacheKey, {
    expiresAt: now + TCG_MARKET_HISTORY_CACHE_TTL_MS,
    value: payload
  });
  return payload;
}

function parseTcgInfiniteHistoryToSeries(payload, {
  productId,
  rangeDays = 0,
  detailRarity = "",
  tcgplayerUrl = "",
  tcgRarity = ""
} = {}) {
  const result = Array.isArray(payload?.result) ? payload.result : [];
  const applyCutoff = Number(rangeDays) > 0;
  const cutoff = applyCutoff ? Date.now() - rangeDays * 24 * 60 * 60 * 1000 : 0;
  const byVariant = new Map();

  for (const day of result) {
    const dateStr = String(day?.date || "").trim();
    if (!dateStr) continue;
    const ts = Date.parse(`${dateStr}T12:00:00Z`);
    if (!Number.isFinite(ts)) continue;
    const dayVariants = Array.isArray(day?.variants) ? day.variants : [];
    for (const row of dayVariants) {
      const variantKey = String(row?.variant || "Unknown").trim() || "Unknown";
      const rawPrice = Number(row?.marketPrice);
      if (!Number.isFinite(rawPrice) || rawPrice <= 0) continue;
      const quantity = Number(row?.quantity);
      const volume = Number.isFinite(quantity) && quantity >= 0 ? Math.round(quantity) : 0;
      if (!byVariant.has(variantKey)) byVariant.set(variantKey, []);
      byVariant.get(variantKey).push({
        date: dateStr,
        ts,
        price: Number(rawPrice.toFixed(2)),
        volume
      });
    }
  }

  const pid = Number(productId);
  const baseUrl = String(tcgplayerUrl || buildTcgplayerProductUrl(pid) || "").trim();
  let productSlug = "";
  try {
    const parts = new URL(baseUrl).pathname.split("/").filter(Boolean);
    if (parts[0] === "product" && parts[2]) productSlug = decodeURIComponent(parts[2]);
  } catch {
    productSlug = "";
  }
  const hasNormalHistory = byVariant.has("Normal");
  const hasReverseHistory = byVariant.has("Reverse Holofoil");
  const series = [];
  for (const [variantKey, allPoints] of byVariant.entries()) {
    if (!shouldIncludeMarketHistoryVariant(variantKey)) continue;
    if (variantKey === "Holofoil" && (hasNormalHistory || hasReverseHistory)) continue;

    allPoints.sort((a, b) => a.ts - b.ts);
    if (!allPoints.length) continue;

    const positive = filterPositiveMarketHistoryPoints(
      applyCutoff ? allPoints.filter((point) => point.ts >= cutoff) : allPoints
    );
    if (!positive.length) continue;

    const label = pickMarketHistoryVariantLabel({
      chainKey: variantKey,
      tcgRarity,
      detailRarity
    });
    const printing =
      variantKey === "Normal" || variantKey === "Holofoil"
        ? variantKey
        : TCG_FINISH_VARIANT_LABELS.has(label) || TCG_PRINT_FINISHES.has(label)
          ? label
          : variantKey;
    const variantUrl =
      pid && (TCG_FINISH_VARIANT_LABELS.has(printing) || TCG_PRINT_FINISHES.has(printing))
        ? buildTcgplayerProductUrl(pid, productSlug, printing)
        : baseUrl;
    const delta = computeMarketHistoryDelta(positive);
    series.push({
      id: `${pid}:${variantKey}`,
      productId: pid,
      variantKey,
      label,
      printing,
      rarity: String(tcgRarity || detailRarity || "").trim(),
      tcgplayerUrl: variantUrl,
      source: "tcgplayer",
      points: positive,
      ...delta
    });
  }
  return series;
}

async function fetchTcgMarketHistorySeriesForProduct(
  productId,
  rangeKey,
  rangeDays,
  { detailRarity = "", tcgplayerUrl = "", tcgRarity = "" } = {}
) {
  const tcgFetchRange = rangeKey === "all" || rangeKey === "365" || rangeKey === "180" ? "365" : rangeKey;
  const payload = await fetchTcgInfiniteMarketHistoryPayload(productId, tcgFetchRange);
  if (!payload) return [];
  return parseTcgInfiniteHistoryToSeries(payload, {
    productId,
    rangeDays: 0,
    detailRarity,
    tcgplayerUrl,
    tcgRarity
  });
}

async function getCardMarketHistoryManifest({
  setCode = "",
  setName = "",
  cardNo = "",
  cardName = "",
  detailRarity = "",
  rangeKey = "30",
  productId = "",
  tcgplayerUrl = "",
  sourceFilter = ""
} = {}) {
  const rangeDays = MARKET_HISTORY_RANGE_DAYS[rangeKey] || 0;
  const priceChartingOnly = String(sourceFilter || "").trim().toLowerCase() === "pricecharting";

  let pcSeries = [];
  try {
    pcSeries = await fetchPriceChartingMarketHistoryForCard({
      setCode,
      setName,
      cardNo,
      cardName,
      detailRarity,
      rangeDays: 0
    });
    if (!Array.isArray(pcSeries)) pcSeries = [];
  } catch (err) {
    console.warn(
      `[market-history] PriceCharting lookup failed for ${setCode} #${cardNo}: ${
        err && err.message ? err.message : "unknown"
      }`
    );
  }

  if (priceChartingOnly) {
    pcSeries.sort(comparePriceChartingSeries);
    return {
      ok: true,
      source: pcSeries.length ? "pricecharting" : "pricecharting",
      setCode: String(setCode || "").trim().toUpperCase(),
      cardNo: String(cardNo || "").trim(),
      rangeKey,
      rangeDays: rangeDays || null,
      rangeLabel: marketHistoryRangeLabel(rangeKey),
      series: pcSeries
    };
  }

  const productTargets = [];
  const seenProductIds = new Set();

  const addProductTarget = (rawProductId, url, rarity) => {
    const pid = Number(rawProductId) || extractTcgplayerProductIdFromUrl(url);
    if (!Number.isFinite(pid) || pid <= 0 || seenProductIds.has(pid)) return;
    seenProductIds.add(pid);
    productTargets.push({
      productId: pid,
      tcgplayerUrl: String(url || buildTcgplayerProductUrl(pid) || "").trim(),
      rarity: String(rarity || detailRarity || "").trim()
    });
  };

  addProductTarget(productId, tcgplayerUrl, detailRarity);
  addProductTarget(extractTcgplayerProductIdFromUrl(tcgplayerUrl), tcgplayerUrl, detailRarity);

  if (!productTargets.length && (setCode || cardNo)) {
    const pricingManifest = await getSetCardPricingManifest(setCode, setName);
    const variantsByCardNo =
      pricingManifest?.variantsByCardNo && typeof pricingManifest.variantsByCardNo === "object"
        ? pricingManifest.variantsByCardNo
        : {};
    let variants = pickFirstFromVariantsIndex(variantsByCardNo, cardNo);

    if (!variants.length && pricingManifest?.byCardNo) {
      const keys = buildCardPricingLookupKeys(cardNo);
      for (const key of keys) {
        const slot = pricingManifest.byCardNo[key];
        if (!slot) continue;
        const slotProductId = Number(slot.productId) || extractTcgplayerProductIdFromUrl(slot.tcgplayerUrl);
        if (!slotProductId) continue;
        variants = [
          {
            productId: slotProductId,
            rarity: String(slot.rarity || detailRarity || "").trim(),
            tcgplayerUrl: String(slot.tcgplayerUrl || "").trim()
          }
        ];
        break;
      }
    }

    for (const variant of variants) {
      addProductTarget(variant.productId, variant.tcgplayerUrl, variant.rarity || variant.label);
    }
  }

  const series = [...pcSeries];
  const seenSeries = new Set(series.map((row) => String(row?.id || "")));
  const seenTcgVariantKeys = new Set();
  for (const target of productTargets) {
    const rows = await fetchTcgMarketHistorySeriesForProduct(target.productId, rangeKey, rangeDays, {
      detailRarity,
      tcgplayerUrl: target.tcgplayerUrl,
      tcgRarity: target.rarity
    });
    for (const row of rows) {
      if (seenSeries.has(row.id)) continue;
      const variantKey = String(row?.variantKey || "").trim();
      if (variantKey) {
        const dedupeKey = `tcg:${variantKey}`;
        if (seenTcgVariantKeys.has(dedupeKey)) continue;
        seenTcgVariantKeys.add(dedupeKey);
      }
      seenSeries.add(row.id);
      series.push(row);
    }
  }

  series.sort(compareMarketHistorySeries);

  const hasPc = pcSeries.length > 0;
  const hasTcg = series.length > pcSeries.length;
  const source = hasPc && hasTcg ? "mixed" : hasPc ? "pricecharting" : "tcgplayer";

  return {
    ok: true,
    source,
    setCode: String(setCode || "").trim().toUpperCase(),
    cardNo: String(cardNo || "").trim(),
    rangeKey,
    rangeDays: rangeDays || null,
    rangeLabel: marketHistoryRangeLabel(rangeKey),
    series
  };
}

function getNearMintAddToCartPrice(row) {
  return getBestEnglishListingPrice(row, { nearMintOnly: true });
}

/** Best English NM buy price from embedded search listings (price + shipping), else market. */
function getTcgSearchRowBuyPrice(row) {
  const listings = Array.isArray(row?.listings) ? row.listings : [];
  if (listings.length) {
    const picked = pickBestTcgListing(listings);
    if (picked && Number.isFinite(picked.totalPrice) && picked.totalPrice > 0) {
      return {
        tcgplayerPrice: picked.totalPrice,
        nearMintAddToCartPrice: picked.listingPrice,
        nearMintWithShipping: picked.nearMintWithShipping,
        listingCondition: picked.listingCondition
      };
    }
  }
  const market = Number(row?.marketPrice);
  if (Number.isFinite(market) && market > 0) {
    const m = Number(market.toFixed(2));
    return {
      tcgplayerPrice: m,
      nearMintAddToCartPrice: m,
      nearMintWithShipping: `$${m.toFixed(2)} Market`,
      listingCondition: "Market"
    };
  }
  const lowest = Number(row?.lowestPrice);
  if (Number.isFinite(lowest) && lowest > 0) {
    const l = Number(lowest.toFixed(2));
    return {
      tcgplayerPrice: l,
      nearMintAddToCartPrice: l,
      nearMintWithShipping: "",
      listingCondition: ""
    };
  }
  return null;
}

function upsertSetPriceEntry(byCardNo, key, entry) {
  if (!key) return;
  const prev = byCardNo[key];
  if (!prev) {
    byCardNo[key] = entry;
    return;
  }

  const prevPrice = Number(prev.tcgplayerPrice);
  const nextPrice = Number(entry.tcgplayerPrice);
  const prevHas = Number.isFinite(prevPrice) && prevPrice > 0;
  const nextHas = Number.isFinite(nextPrice) && nextPrice > 0;
  if (nextHas && !prevHas) {
    byCardNo[key] = entry;
    return;
  }

  const prevNearMint = Number(prev.nearMintAddToCartPrice);
  const nextNearMint = Number(entry.nearMintAddToCartPrice);
  const prevNearMintHas = Number.isFinite(prevNearMint) && prevNearMint > 0;
  const nextNearMintHas = Number.isFinite(nextNearMint) && nextNearMint > 0;
  if (nextNearMintHas && !prevNearMintHas) {
    byCardNo[key] = entry;
  }
}

async function loadTcgplayerCardOverridesMap() {
  let mtimeMs = 0;
  try {
    const stat = await fsp.stat(TCGPLAYER_CARD_OVERRIDES_FILE);
    mtimeMs = stat.mtimeMs;
    if (tcgplayerCardOverridesMem && mtimeMs === tcgplayerCardOverridesMemMtime) {
      return tcgplayerCardOverridesMem;
    }
    const raw = await fsp.readFile(TCGPLAYER_CARD_OVERRIDES_FILE, "utf8");
    const parsed = JSON.parse(raw);
    tcgplayerCardOverridesMem = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
    tcgplayerCardOverridesMemMtime = mtimeMs;
    return tcgplayerCardOverridesMem;
  } catch {
    tcgplayerCardOverridesMem = {};
    tcgplayerCardOverridesMemMtime = 0;
    return tcgplayerCardOverridesMem;
  }
}

function buildTcgplayerOverridePriceEntry(override = {}) {
  const cardNumber = String(override.cardNumber || "").trim();
  const productId =
    Number(override.productId) > 0
      ? Number(override.productId)
      : extractTcgplayerProductIdFromUrl(override.tcgplayerUrl);
  const tcgplayerUrl =
    String(override.tcgplayerUrl || "").trim() ||
    (Number.isFinite(productId) && productId > 0
      ? buildTcgplayerProductUrl(productId, override.productUrlName || override.name || "")
      : "");
  return {
    cardNumber,
    name: String(override.name || "").trim(),
    tcgplayerPrice: override.tcgplayerPrice ?? null,
    nearMintAddToCartPrice: override.nearMintAddToCartPrice ?? null,
    nearMintWithShipping: String(override.nearMintWithShipping || "").trim(),
    listingCondition: String(override.listingCondition || "").trim(),
    tcgplayerUrl,
    productId: Number.isFinite(productId) && productId > 0 ? productId : null,
    rarity: String(override.rarity || "").trim(),
    cardmarketPrice: null,
    cardmarketUrl: ""
  };
}

async function applyTcgplayerCardOverridesToManifest(manifest, setCode = "") {
  if (!manifest || typeof manifest !== "object") return manifest;
  const code = String(setCode || manifest.setCode || "")
    .trim()
    .toUpperCase();
  if (!code) return manifest;

  const overridesMap = await loadTcgplayerCardOverridesMap();
  const prefix = `${code}:`;
  const byCardNo =
    manifest.byCardNo && typeof manifest.byCardNo === "object" ? { ...manifest.byCardNo } : {};
  const variantsByCardNo =
    manifest.variantsByCardNo && typeof manifest.variantsByCardNo === "object"
      ? { ...manifest.variantsByCardNo }
      : {};
  let changed = false;

  for (const [mapKey, override] of Object.entries(overridesMap)) {
    if (!String(mapKey || "").toUpperCase().startsWith(prefix)) continue;
    if (!override || typeof override !== "object") continue;

    const cardNoFromKey = String(mapKey).slice(prefix.length).trim();
    const entry = buildTcgplayerOverridePriceEntry({
      ...override,
      cardNumber: override.cardNumber || cardNoFromKey
    });
    if (!entry.tcgplayerUrl) continue;

    const keys = [
      normalizeCardNumberKey(entry.cardNumber),
      normalizeCardNumberKey(String(entry.cardNumber || "").replace(/^0+/, "")),
      normalizeCardNumberKey(cardNoFromKey),
      normalizeCardNumberKey(String(cardNoFromKey || "").replace(/^0+/, ""))
    ].filter(Boolean);
    const uniqueKeys = [...new Set(keys)];

    for (const key of uniqueKeys) {
      byCardNo[key] = { ...(byCardNo[key] || {}), ...entry };
      changed = true;
      const variant = {
        productId: entry.productId,
        rarity: entry.rarity,
        printing: "Normal",
        label: "Normal",
        tcgplayerUrl: entry.tcgplayerUrl,
        tcgplayerPrice: entry.tcgplayerPrice,
        nearMintWithShipping: entry.nearMintWithShipping,
        listingCondition: entry.listingCondition,
        marketPrice: null
      };
      const prevVariants = Array.isArray(variantsByCardNo[key]) ? variantsByCardNo[key] : [];
      const hasUrl = prevVariants.some(
        (row) => String(row?.tcgplayerUrl || "").trim() === entry.tcgplayerUrl
      );
      variantsByCardNo[key] = hasUrl ? prevVariants : [...prevVariants, variant];
    }
  }

  if (!changed) return manifest;
  return {
    ...manifest,
    ok: true,
    available: Object.keys(byCardNo).length > 0 || Boolean(manifest.available),
    byCardNo,
    variantsByCardNo
  };
}

async function getSetCardPricingManifest(setCode = "", setName = "") {
  const requestedSetCode = String(setCode || "").trim().toUpperCase();
  const requestedSetName = String(setName || "").trim();
  const cacheKey = getSetPricingCacheKey(requestedSetCode, requestedSetName);
  const now = Date.now();
  const cached = setPricingCache.get(cacheKey);
  if (cached && cached.expiresAt > now) {
    return applyTcgplayerCardOverridesToManifest(cached.value, requestedSetCode);
  }
  const inflight = setPricingInFlight.get(cacheKey);
  if (inflight) return inflight;

  if (!requestedSetCode && !requestedSetName) {
    return {
      ok: false,
      available: false,
      error: "setCode or setName is required",
      setCode: "",
      setName: "",
      guideSetName: "",
      guideSetUrlValue: "",
      byCardNo: {}
    };
  }

  const work = (async () => {
    try {
      let bestGuideRow = null;
      try {
        const guideRows = await fetchTcgPriceGuideIndex(false);
        bestGuideRow = resolveTcgGuideRowForSet(guideRows, requestedSetCode, requestedSetName);
      } catch {
        bestGuideRow = null;
      }

      if (bestGuideRow?.label) {
        const directGuide = await fetchTcgProductsByGuideSetName(bestGuideRow);
        if (directGuide && Object.keys(directGuide.byCardNo).length > 0) {
          return {
            ok: true,
            available: true,
            setCode: requestedSetCode,
            setName: requestedSetName,
            guideSetName: directGuide.guideSetName,
            guideSetUrlValue: directGuide.guideSetUrlValue,
            guideIndexUrl: bestGuideRow.href || "",
            byCardNo: directGuide.byCardNo,
            variantsByCardNo: directGuide.variantsByCardNo || {}
          };
        }
      }

      const queryCandidates = buildTcgSetSearchQueryCandidates(
        bestGuideRow,
        requestedSetCode,
        requestedSetName
      );
      const preferredSlugNorm = normalizeTcgLookupText(bestGuideRow?.slug || "");
      const preferredLabelNorm = normalizeTcgLookupText(bestGuideRow?.label || "");
      let preflight = null;
      for (const q of queryCandidates) {
        const probe = await fetchTcgSearchRequest(buildTcgPokemonSearchRequest({ q, from: 0, size: 20 }));
        const result = Array.isArray(probe.results) ? probe.results[0] : null;
        if (!result || Number(result.totalResults || 0) <= 0) continue;
        if (bestGuideRow && (preferredSlugNorm || preferredLabelNorm)) {
          const setAggs = result.aggregations?.setName || [];
          const hasGuide = Array.isArray(setAggs)
            ? setAggs.some((row) => {
                const rowUrlNorm = normalizeTcgLookupText(row?.urlValue || "");
                const rowValueNorm = normalizeTcgLookupText(row?.value || "");
                return (
                  (preferredSlugNorm && rowUrlNorm === preferredSlugNorm) ||
                  (preferredLabelNorm && rowValueNorm === preferredLabelNorm)
                );
              })
            : false;
          if (!hasGuide) continue;
        }
        preflight = { q, result };
        break;
      }

      if (!preflight) {
        return {
          ok: true,
          available: false,
          error: "No TCGplayer guide search results for this set",
          setCode: requestedSetCode,
          setName: requestedSetName,
          guideSetName: "",
          guideSetUrlValue: "",
          byCardNo: {},
          variantsByCardNo: {}
        };
      }

      const setAggs = preflight.result.aggregations?.setName || [];
      const pickedFromGuideIndex = Array.isArray(setAggs)
        ? setAggs.find((row) => {
            const rowUrlNorm = normalizeTcgLookupText(row?.urlValue || "");
            const rowValueNorm = normalizeTcgLookupText(row?.value || "");
            return (
              (preferredSlugNorm && rowUrlNorm === preferredSlugNorm) ||
              (preferredLabelNorm && rowValueNorm === preferredLabelNorm)
            );
          })
        : null;
      const pickedSet = pickedFromGuideIndex || pickBestGuideSetAggregation(setAggs, requestedSetCode, requestedSetName);
      const guideSetName = String(pickedSet?.value || "").trim();
      const guideSetUrlValue = String(pickedSet?.urlValue || "").trim();
      const setUrlNorm = normalizeTcgLookupText(guideSetUrlValue);
      const setNameNorm = normalizeTcgLookupText(guideSetName);
      const query = guideSetName || preflight.q;

      const byCardNo = {};
      const variantsByCardNo = {};
      const PAGE_SIZE = 50;
      const MAX_PAGES = 20;
      const firstPayload = await fetchTcgSearchRequest(
        buildTcgPokemonSearchRequest({ q: query, from: 0, size: PAGE_SIZE })
      );
      const firstResult = Array.isArray(firstPayload.results) ? firstPayload.results[0] : null;
      const totalResults = Number(firstResult?.totalResults || 0);
      const totalPages = Math.max(1, Math.min(MAX_PAGES, Math.ceil(totalResults / PAGE_SIZE) || 1));
      const pagePayloads = [firstPayload];
      if (totalPages > 1) {
        const pending = [];
        for (let page = 1; page < totalPages; page += 1) {
          const from = page * PAGE_SIZE;
          pending.push(fetchTcgSearchRequest(buildTcgPokemonSearchRequest({ q: query, from, size: PAGE_SIZE })));
        }
        if (pending.length) {
          const rest = await Promise.all(pending);
          pagePayloads.push(...rest);
        }
      }

      for (const payload of pagePayloads) {
        const result = Array.isArray(payload?.results) ? payload.results[0] : null;
        const rows = Array.isArray(result?.results) ? result.results : [];
        ingestTcgSearchRowsIntoByCardNo(rows, byCardNo, setNameNorm, setUrlNorm, variantsByCardNo);
      }
      await enrichVariantsByCardNoWithTcgPrintings(byCardNo, variantsByCardNo);

      return {
        ok: true,
        available: Object.keys(byCardNo).length > 0,
        setCode: requestedSetCode,
        setName: requestedSetName,
        guideSetName,
        guideSetUrlValue,
        guideIndexUrl: bestGuideRow?.href || "",
        byCardNo,
        variantsByCardNo
      };
    } catch (err) {
      return {
        ok: true,
        available: false,
        error: err.message || "TCGplayer guide lookup failed",
        setCode: requestedSetCode,
        setName: requestedSetName,
        guideSetName: "",
        guideSetUrlValue: "",
        guideIndexUrl: "",
        byCardNo: {},
        variantsByCardNo: {}
      };
    } finally {
      setPricingInFlight.delete(cacheKey);
    }
  })();

  const resultPromise = work.then((manifest) =>
    applyTcgplayerCardOverridesToManifest(manifest, requestedSetCode)
  );
  setPricingInFlight.set(cacheKey, resultPromise);
  const manifest = await work;
  const ttl = manifest && manifest.available ? SET_PRICING_CACHE_TTL_MS : SET_PRICING_ERROR_CACHE_TTL_MS;
  setPricingCache.set(cacheKey, {
    value: manifest,
    expiresAt: Date.now() + ttl
  });
  return resultPromise;
}

function decodeSetCardListNames(byCode = {}) {
  const out = {};
  for (const [code, entry] of Object.entries(byCode)) {
    if (!entry || typeof entry !== "object") {
      out[code] = entry;
      continue;
    }
    const cards = entry.cards && typeof entry.cards === "object" ? entry.cards : {};
    const decodedCards = {};
    for (const [cardNo, name] of Object.entries(cards)) {
      decodedCards[cardNo] = decodeHtmlEntities(name);
    }
    out[code] = { ...entry, cards: decodedCards };
  }
  return out;
}

async function loadSetCardListsParsed() {
  try {
    const stat = await fsp.stat(SET_CARD_LIST_FILE);
    if (setCardListsDiskCache.parsed && setCardListsDiskCache.mtimeMs === stat.mtimeMs) {
      return setCardListsDiskCache.parsed;
    }
    const raw = await fsp.readFile(SET_CARD_LIST_FILE, "utf8");
    const parsed = JSON.parse(raw);
    setCardListsDiskCache = { mtimeMs: stat.mtimeMs, parsed };
    return parsed;
  } catch (err) {
    setCardListsDiskCache = { mtimeMs: 0, parsed: null };
    throw err;
  }
}

function countEnglishSetsInParsed(parsed) {
  if (!parsed || typeof parsed !== "object") return 0;
  const languageNode = parsed.byLanguage?.english;
  if (languageNode && typeof languageNode.byCode === "object") {
    return Object.keys(languageNode.byCode).length;
  }
  if (parsed.byCode && typeof parsed.byCode === "object") {
    return Object.keys(parsed.byCode).length;
  }
  return 0;
}

async function warmSetCardListsMemoryFromDisk({ skipDiskIndex = false } = {}) {
  try {
    await loadSetCardListsParsed();
    const count = countEnglishSetsInParsed(setCardListsDiskCache.parsed);
    if (skipDiskIndex) {
      console.log(`[sets] Card manifest ready (${count} English sets, disk index deferred)`);
      return count;
    }
    const diskIndex = await getLocalCardImageIndex();
    console.log(
      `[sets] Card manifest ready (${count} English sets, ${diskIndex.size} local image folders in ${CARD_IMAGE_DIR})`
    );
    return count;
  } catch (err) {
    console.warn(
      `[sets] Card manifest not loaded: ${err && err.message ? err.message : "missing or invalid"}`
    );
    return 0;
  }
}

function formatDurationSeconds(totalSec) {
  const s = Math.max(0, Math.floor(Number(totalSec) || 0));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return `${h}h ${String(m).padStart(2, "0")}m`;
  if (m > 0) return `${m}m ${String(sec).padStart(2, "0")}s`;
  return `${sec}s`;
}

let detailsImportStartedAtPinned = null;

async function readCardDetailsImportStatusFromDisk() {
  try {
    const raw = await fsp.readFile(SET_CARD_DETAILS_IMPORT_STATUS_FILE, "utf8");
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

async function buildCardDetailsImportStatusResponse() {
  const status = await readCardDetailsImportStatusFromDisk();
  if (status.running && !status.startedAt) {
    if (!detailsImportStartedAtPinned) {
      detailsImportStartedAtPinned = new Date().toISOString();
    }
    status.startedAt = detailsImportStartedAtPinned;
  }
  if (!status.running) {
    detailsImportStartedAtPinned = null;
  }
  const parsed = setCardDetailsDiskCache.parsed || (await loadSetCardDetailsParsed().catch(() => null));
  const imported = countEnglishDetailSetsInParsed(parsed);
  const localized = isDetailsCatalogComplete(parsed, MIN_ENGLISH_DETAIL_SETS_FOR_COMPLETE);
  return enrichCardDetailsImportStatus({
    imported,
    localized,
    complete: localized,
    minSetsForComplete: MIN_ENGLISH_DETAIL_SETS_FOR_COMPLETE,
    runtimeSource: localized ? "local" : "pkmncards",
    ...status
  });
}

function enrichCardDetailsImportStatus(status) {
  const row = status && typeof status === "object" ? { ...status } : {};
  const now = Date.now();
  let startedMs = row.startedAt ? Date.parse(row.startedAt) : 0;
  if ((!Number.isFinite(startedMs) || startedMs <= 0) && row.updatedAt) {
    startedMs = Date.parse(row.updatedAt);
  }
  const elapsedSec =
    Number.isFinite(startedMs) && startedMs > 0 ? Math.max(0, Math.floor((now - startedMs) / 1000)) : 0;
  const total = Number(row.total || 0);
  const processed = Number(
    row.processed != null ? row.processed : row.imported != null ? row.imported : 0
  );
  let etaSec = null;
  if (row.running && total > 0 && processed > 0 && processed < total && elapsedSec > 0) {
    etaSec = Math.round((elapsedSec / processed) * (total - processed));
  }
  if (row.running || !Number.isFinite(Number(row.elapsedSec))) {
    row.elapsedSec = elapsedSec;
  } else {
    row.elapsedSec = Number(row.elapsedSec);
  }
  row.etaSec = etaSec;
  row.elapsedLabel = formatDurationSeconds(row.elapsedSec);
  row.etaLabel = etaSec != null ? formatDurationSeconds(etaSec) : null;
  row.progressPercent = total > 0 ? Math.min(100, Math.round((processed / total) * 100)) : null;
  return row;
}

async function warmSetCardDetailsFromDisk() {
  try {
    let count = 0;
    try {
      const entries = await fsp.readdir(SET_CARD_DETAILS_BY_CODE_DIR);
      count = entries.filter((name) => name.endsWith(".json")).length;
    } catch {
      await loadSetCardDetailsParsed();
      count = countEnglishDetailSetsInParsed(setCardDetailsDiskCache.parsed);
    }
    console.log(`[sets] Card details ready (${count} sets)`);
    return count;
  } catch (err) {
    console.warn(
      `[sets] Card details not loaded: ${err && err.message ? err.message : "missing or invalid"}`
    );
    return 0;
  }
}

const setCardDetailsByCodeFileCache = new Map();

async function loadSetCardDetailsEntryForCode(setCode) {
  const code = String(setCode || "").trim().toUpperCase();
  if (!code) return null;
  const filePath = path.join(SET_CARD_DETAILS_BY_CODE_DIR, `${code}.json`);
  try {
    const stat = await fsp.stat(filePath);
    const cacheKey = `${code}:${stat.mtimeMs}`;
    if (setCardDetailsByCodeFileCache.has(cacheKey)) {
      return setCardDetailsByCodeFileCache.get(cacheKey);
    }
    const raw = await fsp.readFile(filePath, "utf8");
    const entry = JSON.parse(raw);
    setCardDetailsByCodeFileCache.set(cacheKey, entry);
    return entry;
  } catch {
    const parsed = await loadSetCardDetailsParsed();
    const byCode = parsed && parsed.byCode && typeof parsed.byCode === "object" ? parsed.byCode : {};
    return byCode[code] || null;
  }
}

async function getSetCardImportStatus() {
  try {
    const raw = await fsp.readFile(SET_CARD_IMPORT_STATUS_FILE, "utf8");
    return JSON.parse(raw);
  } catch {
    const parsed = setCardListsDiskCache.parsed;
    const imported = countEnglishSetsInParsed(parsed);
    return {
      running: Boolean(englishSetCardsImportChild),
      phase: englishSetCardsImportChild ? "sets" : imported > 0 ? "idle" : "pending",
      imported,
      total: null
    };
  }
}

function maybeKickoffEnglishSetCardsImport() {
  if (isSelfHosted()) return;
  if (englishSetCardsImportChild) return;
  const imported = countEnglishSetsInParsed(setCardListsDiskCache.parsed);
  if (imported >= MIN_ENGLISH_SETS_FOR_COMPLETE) return;
  if (!fs.existsSync(SET_CARD_IMPORT_SCRIPT)) {
    console.warn(`[catalog-import] Missing script: ${SET_CARD_IMPORT_SCRIPT}`);
    return;
  }
  console.log(
    `[catalog-import] Starting background import (${imported}/${MIN_ENGLISH_SETS_FOR_COMPLETE}+ sets); cards/images prioritized over pricing`
  );
  englishSetCardsImportChild = spawn(process.execPath, [SET_CARD_IMPORT_SCRIPT], {
    cwd: __dirname,
    stdio: "inherit",
    env: { ...process.env, NODE_OPTIONS: process.env.NODE_OPTIONS || "" }
  });
  englishSetCardsImportChild.on("exit", (code) => {
    englishSetCardsImportChild = null;
    setCardListsDiskCache = { mtimeMs: 0, parsed: null };
    warmSetCardListsMemoryFromDisk().catch(() => {});
    console.log(`[catalog-import] Background import exited (code=${code ?? "?"})`);
  });
}

async function getLocalCardImageIndex({ allowBuild = true } = {}) {
  if (localCardImageIndexCache.index) {
    return localCardImageIndexCache.index;
  }
  if (!allowBuild) {
    return new Map();
  }
  if (localCardImageIndexInFlight) {
    return localCardImageIndexInFlight;
  }
  localCardImageIndexInFlight = (async () => {
    try {
      const stat = await fsp.stat(CARD_IMAGE_DIR);
      if (localCardImageIndexCache.index && localCardImageIndexCache.mtimeMs === stat.mtimeMs) {
        return localCardImageIndexCache.index;
      }
      const index = await buildLocalImageIndexFromDisk(CARD_IMAGE_DIR);
      localCardImageIndexCache = { mtimeMs: stat.mtimeMs, index };
      console.log(
        `[sets] Local card image index ready (${index.size} sets in ${CARD_IMAGE_DIR})`
      );
      return index;
    } catch {
      return new Map();
    } finally {
      localCardImageIndexInFlight = null;
    }
  })();
  return localCardImageIndexInFlight;
}

async function loadSetCardDetailsParsed() {
  try {
    const stat = await fsp.stat(SET_CARD_DETAILS_FILE);
    if (setCardDetailsDiskCache.parsed && setCardDetailsDiskCache.mtimeMs === stat.mtimeMs) {
      return setCardDetailsDiskCache.parsed;
    }
    const raw = await fsp.readFile(SET_CARD_DETAILS_FILE, "utf8");
    const parsed = JSON.parse(raw);
    setCardDetailsDiskCache = { mtimeMs: stat.mtimeMs, parsed };
    return parsed;
  } catch (err) {
    setCardDetailsDiskCache = { mtimeMs: 0, parsed: null };
    throw err;
  }
}

function countEnglishDetailSetsInParsed(parsed) {
  if (!parsed || typeof parsed !== "object" || !parsed.byCode) return 0;
  return Object.keys(parsed.byCode).length;
}

function maybeKickoffEnglishSetDetailsImport() {
  if (isSelfHosted()) return;
  if (englishSetDetailsImportChild) return;
  if (isDetailsCatalogComplete(setCardDetailsDiskCache.parsed, MIN_ENGLISH_DETAIL_SETS_FOR_COMPLETE)) {
    return;
  }
  let detailSets = 0;
  try {
    detailSets = countEnglishDetailSetsInParsed(setCardDetailsDiskCache.parsed);
  } catch {
    detailSets = 0;
  }
  if (detailSets >= MIN_ENGLISH_DETAIL_SETS_FOR_COMPLETE) {
    finalizeLocalCardDetailsFile({ minSets: MIN_ENGLISH_DETAIL_SETS_FOR_COMPLETE })
      .then((fin) => {
        if (fin.ok) {
          setCardDetailsDiskCache = { mtimeMs: 0, parsed: null };
          console.log(
            `[details-local] Finalized local card-details (${fin.setCount} sets, ${fin.cardCount} cards)`
          );
        }
      })
      .catch((err) => {
        console.warn(`[details-local] Finalize failed: ${err.message}`);
      });
    return;
  }
  if (!fs.existsSync(SET_CARD_DETAILS_IMPORT_SCRIPT)) {
    console.warn(`[details-import] Missing script: ${SET_CARD_DETAILS_IMPORT_SCRIPT}`);
    return;
  }
  console.log(
    `[details-import] Starting background card-details import (${detailSets}/${MIN_ENGLISH_DETAIL_SETS_FOR_COMPLETE}+ sets)`
  );
  englishSetDetailsImportChild = spawn(process.execPath, [SET_CARD_DETAILS_IMPORT_SCRIPT], {
    cwd: __dirname,
    stdio: "inherit"
  });
  englishSetDetailsImportChild.on("exit", (code) => {
    englishSetDetailsImportChild = null;
    setCardDetailsDiskCache = { mtimeMs: 0, parsed: null };
    loadSetCardDetailsParsed()
      .then(async (parsed) => {
        const sets = countEnglishDetailSetsInParsed(parsed);
        console.log(`[details-import] Finished (code=${code ?? "?"}); sets=${sets}`);
        if (sets >= MIN_ENGLISH_DETAIL_SETS_FOR_COMPLETE && !isDetailsCatalogComplete(parsed)) {
          const fin = await finalizeLocalCardDetailsFile({
            minSets: MIN_ENGLISH_DETAIL_SETS_FOR_COMPLETE
          });
          if (fin.ok) {
            setCardDetailsDiskCache = { mtimeMs: 0, parsed: null };
            console.log(
              `[details-local] Saved local-only card-details (${fin.setCount} sets, ${fin.cardCount} cards)`
            );
          }
        }
      })
      .catch(() => {
        console.log(`[details-import] Finished (code=${code ?? "?"}); details file still invalid`);
      });
  });
}

async function getSetCardManifest(language = "english", setCodeFilter = "") {
  const normalizedLanguage = normalizeLanguage(language);
  const codeFilter = String(setCodeFilter || "").trim().toUpperCase();
  try {
    const parsed = await loadSetCardListsParsed();
    const languageNode = parsed?.byLanguage?.[normalizedLanguage];
    const byCodeRaw =
      languageNode && typeof languageNode.byCode === "object"
        ? languageNode.byCode
        : parsed && typeof parsed.byCode === "object"
          ? parsed.byCode
          : {};
    let byCode = decodeSetCardListNames(byCodeRaw);
    if (normalizedLanguage === "english") {
      const diskIndex =
        localCardImageIndexCache.index && localCardImageIndexCache.index.size
          ? localCardImageIndexCache.index
          : new Map();
      byCode = hydrateByCodeWithDiskImages(byCode, diskIndex);
    }
    const clientByCode = {};
    const sourceEntries = codeFilter
      ? byCode[codeFilter]
        ? [[codeFilter, byCode[codeFilter]]]
        : []
      : Object.entries(byCode);
    for (const [code, entry] of sourceEntries) {
      clientByCode[code] = sanitizeManifestEntryForClient(entry, code);
    }
    const catalogByEra =
      languageNode && languageNode.catalogByEra && typeof languageNode.catalogByEra === "object"
        ? languageNode.catalogByEra
        : null;
    return {
      ok: true,
      language: normalizedLanguage,
      generatedAt: parsed.generatedAt || null,
      byCode: clientByCode,
      catalogByEra
    };
  } catch (err) {
    console.warn(
      `[sets] Failed to load ${SET_CARD_LIST_FILE}: ${err && err.message ? err.message : "parse error"}`
    );
    return {
      ok: false,
      language: normalizedLanguage,
      generatedAt: null,
      byCode: {},
      catalogByEra: null,
      error: err && err.message ? err.message : "Failed to load set card lists"
    };
  }
}

function collectCardSkyUrlsFromDiskIndex(diskIndex, limit, setCodeFilter = null) {
  const urls = [];
  const seen = new Set();
  if (!diskIndex || !diskIndex.size) return urls;
  const filter =
    setCodeFilter == null
      ? null
      : new Set(setCodeFilter.map((c) => String(c || "").toUpperCase()).filter(Boolean));
  if (filter && filter.size === 0) return urls;
  for (const [code, localImages] of diskIndex.entries()) {
    const codeKey = String(code || "").toUpperCase();
    if (filter && !filter.has(codeKey)) continue;
    if (!localImages || typeof localImages !== "object") continue;
    for (const raw of Object.values(localImages)) {
      const s = String(raw || "").trim();
      if (!s.startsWith("/card-images/") || seen.has(s)) continue;
      seen.add(s);
      urls.push(s);
    }
  }
  for (let i = urls.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [urls[i], urls[j]] = [urls[j], urls[i]];
  }
  const cap = parseCardSkyUrlLimit(limit, urls.length);
  return cap >= urls.length ? urls : urls.slice(0, cap);
}

function parseCardSkyUrlLimit(limit, total) {
  const raw = String(limit ?? "").trim().toLowerCase();
  if (raw === "all" || raw === "0" || raw === "none") return total;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return Math.min(400, Math.max(50, 250));
  return Math.min(total, Math.min(50000, Math.floor(n)));
}

function collectCardSkyUrlsFromParsed(parsed, limit = 250, diskIndex = null, setCodeFilter = null) {
  if (diskIndex && diskIndex.size > 0) {
    return collectCardSkyUrlsFromDiskIndex(diskIndex, limit, setCodeFilter);
  }
  const cap = parseCardSkyUrlLimit(limit, Number.POSITIVE_INFINITY);
  const langNode = parsed?.byLanguage?.english;
  const byCode =
    langNode && typeof langNode.byCode === "object"
      ? langNode.byCode
      : parsed && typeof parsed.byCode === "object"
        ? parsed.byCode
        : {};
  const filter =
    setCodeFilter == null
      ? null
      : new Set(setCodeFilter.map((c) => String(c || "").toUpperCase()).filter(Boolean));
  if (filter && filter.size === 0) return [];
  const urls = [];
  const seen = new Set();
  for (const [code, entry] of Object.entries(byCode)) {
    const codeKey = String(code || "").toUpperCase();
    if (filter && !filter.has(codeKey)) continue;
    const localImages =
      entry && entry.localImages && typeof entry.localImages === "object" ? entry.localImages : {};
    const images = entry && entry.images && typeof entry.images === "object" ? entry.images : {};
    const cards = entry && entry.cards && typeof entry.cards === "object" ? entry.cards : {};
    const merged = { ...images, ...localImages };
    if (!Object.keys(merged).length && Object.keys(cards).length) {
      Object.assign(merged, synthesizeLocalImagesFromCards(codeKey, cards));
    }
    for (const raw of Object.values(merged)) {
      const s = String(raw || "").trim();
      if (!s.startsWith("/card-images/") || seen.has(s)) continue;
      seen.add(s);
      urls.push(s);
    }
  }
  for (let i = urls.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [urls[i], urls[j]] = [urls[j], urls[i]];
  }
  const sliceCap = Number.isFinite(cap) ? cap : urls.length;
  return sliceCap >= urls.length ? urls : urls.slice(0, sliceCap);
}

async function getSetCardDetailsManifest(setCode = "") {
  const codeFilter = String(setCode || "").trim().toUpperCase();
  try {
    if (codeFilter) {
      const entry = await loadSetCardDetailsEntryForCode(codeFilter);
      return {
        ok: true,
        generatedAt: null,
        source: "",
        byCode: entry ? { [codeFilter]: entry } : {}
      };
    }
    const parsed = await loadSetCardDetailsParsed();
    const byCode = parsed && parsed.byCode && typeof parsed.byCode === "object" ? parsed.byCode : {};
    return {
      ok: true,
      generatedAt: parsed.generatedAt || null,
      source: parsed.source || "",
      byCode
    };
  } catch (err) {
    console.warn(
      `[sets] Failed to load ${SET_CARD_DETAILS_FILE}: ${err && err.message ? err.message : "parse error"}`
    );
    return {
      ok: false,
      generatedAt: null,
      source: "",
      byCode: {},
      error: err && err.message ? err.message : "Failed to load set card details"
    };
  }
}

async function rateLimitPriceCharting() {
  // PriceCharting docs specify max 1 request per second.
  const elapsed = Date.now() - priceChartingLastCallMs;
  if (elapsed < 1000) {
    await sleep(1000 - elapsed);
  }
  priceChartingLastCallMs = Date.now();
}

async function getPriceChartingProduct(params) {
  const token = getConfig("PRICECHARTING_API_TOKEN");
  if (!token) {
    throw new Error("PriceCharting API token is missing");
  }

  const query = new URLSearchParams({ t: token });
  if (params.id) query.set("id", String(params.id));
  else if (params.upc) query.set("upc", String(params.upc));
  else if (params.q) query.set("q", String(params.q));
  else throw new Error("Provide PriceCharting id, upc, or q");

  await rateLimitPriceCharting();
  const { response, data, text } = await fetchJson(`https://www.pricecharting.com/api/product?${query.toString()}`);
  if (!response.ok || !data) {
    throw new Error(`PriceCharting request failed (${response.status}): ${text || "empty response"}`);
  }
  if (data.status !== "success") {
    throw new Error(`PriceCharting error: ${data["error-message"] || "unknown error"}`);
  }
  return data;
}

function readFirstValue(obj, keys) {
  if (!obj || typeof obj !== "object") return null;
  const normalized = normalizeHeaderMap(obj);
  for (const key of keys) {
    const value = normalized[String(key).toLowerCase()];
    if (value !== undefined && value !== null && String(value).trim() !== "") {
      return value;
    }
  }
  return null;
}

async function getPsaCertData(certNumber) {
  const token = getConfig("PSA_ACCESS_TOKEN");
  if (!token) {
    throw new Error("PSA access token is missing");
  }
  if (!certNumber) {
    throw new Error("Missing PSA cert number");
  }

  const encoded = encodeURIComponent(String(certNumber).trim());
  const { response, data, text } = await fetchJson(`https://api.psacard.com/publicapi/cert/GetByCertNumber/${encoded}`, {
    method: "GET",
    headers: {
      Accept: "application/json",
      Authorization: `bearer ${token}`
    }
  });

  if (!response.ok || !data) {
    throw new Error(`PSA cert request failed (${response.status}): ${text || "empty response"}`);
  }
  return data;
}

function mapPsaSnapshot(psaPayload) {
  const gradeRaw = readFirstValue(psaPayload, ["Grade", "CardGrade", "GradeDescription", "NumericGrade"]);
  const certNumber = readFirstValue(psaPayload, ["CertNumber", "CertNo", "CertificationNumber"]);
  const setName = readFirstValue(psaPayload, ["SetName", "Set", "Brand", "Category"]);
  const cardName = readFirstValue(psaPayload, ["Subject", "CardName", "Description", "Player"]);
  const year = readFirstValue(psaPayload, ["Year", "IssueDate"]);
  const population = readFirstValue(psaPayload, ["Population", "TotalPop", "PopulationThisGrade", "SpecPopulation"]);

  const gradeNum = Number(gradeRaw);
  const gradeLabel = Number.isFinite(gradeNum) ? `PSA ${gradeNum}` : String(gradeRaw || "PSA");

  return {
    isValidRequest: Boolean(readFirstValue(psaPayload, ["IsValidRequest"]) !== false),
    serverMessage: String(readFirstValue(psaPayload, ["ServerMessage"]) || ""),
    gradeLabel,
    certNumber: certNumber ? String(certNumber) : null,
    cardName: cardName ? String(cardName) : null,
    setName: setName ? String(setName) : null,
    year: year ? String(year) : null,
    population: population != null ? String(population) : null
  };
}

function extractPriceChartingValue(product) {
  // Prices are returned in pennies, convert to dollars.
  return (
    toPenniesDollars(product["loose-price"]) ||
    toPenniesDollars(product["new-price"]) ||
    toPenniesDollars(product["graded-price"]) ||
    toPenniesDollars(product["cib-price"]) ||
    null
  );
}

function normalizeItem(input, existing = null) {
  const type = input.type === "sealed" ? "sealed" : "single";
  const conditionType = input.conditionType === "graded" ? "graded" : "raw";
  const quantity = Math.max(0, safeNumber(input.quantity, existing?.quantity || 1));
  const costBasis = Math.max(0, safeNumber(input.costBasis, existing?.costBasis || 0));
  const manualPrice = input.manualPrice === "" || input.manualPrice === null || input.manualPrice === undefined
    ? null
    : Math.max(0, safeNumber(input.manualPrice, 0));

  return {
    id: existing?.id || randomId(),
    type,
    name: String(input.name || existing?.name || "").trim(),
    setName: String(input.setName || existing?.setName || "").trim(),
    cardNumber: String(input.cardNumber || existing?.cardNumber || "").trim(),
    setCode: String(input.setCode ?? existing?.setCode ?? "").trim().toUpperCase(),
    setLanguage:
      String(input.setLanguage ?? existing?.setLanguage ?? "").trim().toLowerCase() === "japanese"
        ? "japanese"
        : "english",
    imageUrl: String(input.imageUrl ?? existing?.imageUrl ?? "").trim(),
    tcgProductId: String(input.tcgProductId || existing?.tcgProductId || "").trim(),
    psaCertNumber: String(input.psaCertNumber || existing?.psaCertNumber || "").trim(),
    priceChartingId: String(input.priceChartingId || existing?.priceChartingId || "").trim(),
    upc: String(input.upc || existing?.upc || "").trim(),
    conditionType,
    condition: String(input.condition || existing?.condition || "").trim(),
    gradeCompany: String(input.gradeCompany || existing?.gradeCompany || "").trim(),
    gradeValue: String(input.gradeValue || existing?.gradeValue || "").trim(),
    quantity,
    costBasis,
    currency: String(input.currency || existing?.currency || DEFAULT_CURRENCY).trim() || DEFAULT_CURRENCY,
    notes: String(input.notes || existing?.notes || "").trim(),
    marketPrice: safeNumber(
      input.marketPrice,
      existing?.marketPrice !== undefined && existing?.marketPrice !== null
        ? existing.marketPrice
        : 0
    ),
    manualPrice,
    sourceBreakdown:
      input.sourceBreakdown && typeof input.sourceBreakdown === "object"
        ? input.sourceBreakdown
        : existing?.sourceBreakdown || {},
    lastPricedAt: input.lastPricedAt || existing?.lastPricedAt || null,
    userId: String(input.userId || existing?.userId || "").trim(),
    collectrImportBatchId: String(
      input.collectrImportBatchId || existing?.collectrImportBatchId || ""
    ).trim(),
    createdAt: existing?.createdAt || new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
}

function summarizeDashboard(userId) {
  const items = getCollectionItemsForUser(userId);
  const byType = {
    sealed: items.filter((i) => i.type === "sealed"),
    single: items.filter((i) => i.type === "single")
  };

  const totals = items.reduce(
    (acc, item) => {
      const effectivePrice = item.manualPrice ?? item.marketPrice ?? 0;
      const value = effectivePrice * item.quantity;
      const cost = item.costBasis * item.quantity;
      acc.marketValue += value;
      acc.costBasis += cost;
      acc.totalItems += item.quantity;
      acc.lineItems += 1;
      return acc;
    },
    { marketValue: 0, costBasis: 0, totalItems: 0, lineItems: 0 }
  );

  const pnl = totals.marketValue - totals.costBasis;

  const record = userId ? findStoreUserById(userId) : null;
  const preferences = record ? ensureUserPreferences(record) : defaultUserPreferences();

  return {
    kpis: {
      marketValue: Number(totals.marketValue.toFixed(2)),
      costBasis: Number(totals.costBasis.toFixed(2)),
      unrealizedPnL: Number(pnl.toFixed(2)),
      totalItems: totals.totalItems,
      lineItems: totals.lineItems
    },
    preferences: { ...preferences },
    counts: {
      sealed: byType.sealed.length,
      singles: byType.single.length
    },
    lastCollectrImport: record?.lastCollectrImport || null,
    canUndoCollection: Boolean(getCollectionUndoSnapshot(record)),
    collectionUndoCount: getCollectionUndoSnapshot(record)?.items?.length || 0,
    refreshedAt: store.refreshedAt,
    activities: store.activities
      .filter((row) => !userId || String(row.userId || "") === String(userId))
      .slice(0, 20)
  };
}

async function listRestockRetailers() {
  try {
    const raw = await fsp.readFile(RESTOCK_TRACKER_FILE, "utf8");
    const parsed = JSON.parse(raw);
    const items = Array.isArray(parsed.items) ? parsed.items : [];
    const counts = new Map();
    for (const item of items) {
      const name = String(item?.retailer || "").trim() || "Unknown";
      counts.set(name, (counts.get(name) || 0) + 1);
    }
    return [...counts.entries()]
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
  } catch {
    return [];
  }
}

function normalizeRestockRetailerSelection(input) {
  if (input == null) return null;
  const list = Array.isArray(input)
    ? input
    : String(input || "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
  const cleaned = [...new Set(list.map((s) => String(s || "").trim()).filter(Boolean))];
  return cleaned.length ? cleaned : null;
}

function restockRetailerAllowed(retailerName, selectedSet) {
  if (!selectedSet) return true;
  return selectedSet.has(String(retailerName || "").trim());
}

function isRestockRefreshCancelled() {
  return restockRefreshCancelRequested;
}

function clearRestockRefreshCancelFlag() {
  restockRefreshCancelRequested = false;
}

function requestRestockRefreshCancel() {
  restockRefreshCancelRequested = true;
}

async function refreshRestockTrackerHourlyTick(options = {}) {
  if (restockRefreshInFlight) {
    return;
  }
  restockRefreshInFlight = true;
  clearRestockRefreshCancelFlag();
  const selectedRetailers = normalizeRestockRetailerSelection(options.retailers);
  const selectedSet = selectedRetailers ? new Set(selectedRetailers) : null;
  const startedAt = new Date().toISOString();
  restockRefreshMeta = {
    ...restockRefreshMeta,
    lastStartedAt: startedAt,
    lastError: null,
    lastSelectedRetailers: selectedRetailers
  };
  setRestockRefreshProgress({
    phase: "starting",
    label: selectedRetailers
      ? `Starting refresh (${selectedRetailers.length} retailer${selectedRetailers.length === 1 ? "" : "s"})…`
      : "Starting restock refresh…",
    current: 0,
    total: 0,
    percent: 0
  });
  try {
    clearHourlyPricingCaches();
    const raw = await fsp.readFile(RESTOCK_TRACKER_FILE, "utf8");
    const parsed = JSON.parse(raw);
    const items = Array.isArray(parsed.items) ? parsed.items : [];
    restockRefreshMeta.itemCount = items.length;
    if (!items.length) {
      restockRefreshMeta.lastFinishedAt = new Date().toISOString();
      restockRefreshMeta.lastInStockStamped = 0;
      restockRefreshMeta.lastAmazonStatusUpdates = 0;
      restockRefreshMeta.lastPriceUpdates = 0;
      setRestockRefreshProgress({
        phase: "done",
        label: "No tracked products",
        current: 0,
        total: 0,
        percent: 100
      });
      return;
    }

    const nowIso = new Date().toISOString();
    const stampTargets = items.filter((item) => restockRetailerAllowed(item.retailer, selectedSet));

    setRestockRefreshProgress({
      phase: "stamping",
      label: "Stamping in-stock timestamps…",
      current: 0,
      total: stampTargets.length || items.length,
      percent: 2
    });

    // Stamp lastAvailable immediately for selected in-stock items.
    let inStockStamped = 0;
    for (let i = 0; i < stampTargets.length; i += 1) {
      if (isRestockRefreshCancelled()) break;
      const item = stampTargets[i];
      if (String(item.status || "").toLowerCase() === "in_stock") {
        item.lastAvailable = nowIso;
        inStockStamped += 1;
      }
      if (i === stampTargets.length - 1 || i % 25 === 0) {
        setRestockRefreshProgress({
          phase: "stamping",
          label: "Stamping in-stock timestamps…",
          current: i + 1,
          total: stampTargets.length,
          percent: Math.round(2 + ((i + 1) / Math.max(1, stampTargets.length)) * 6)
        });
      }
    }

    // Save the timestamp right away so the UI sees it even if live checks are slow.
    parsed.items = items;
    parsed.autoRefreshedAt = nowIso;
    await fsp.writeFile(RESTOCK_TRACKER_FILE, JSON.stringify(parsed, null, 2), "utf8");
    restockRefreshMeta.autoRefreshedAt = nowIso;
    restockRefreshMeta.lastInStockStamped = inStockStamped;
    console.log(
      `[restock-hourly] stamped lastAvailable on ${inStockStamped} in-stock items` +
        (selectedRetailers ? ` (retailers=${selectedRetailers.join(", ")})` : "")
    );

    let smokeStatusCount = 0;
    let smokePriceCount = 0;
    let pokeNeStatusCount = 0;
    let pokeNePriceCount = 0;
    let amazonStatusCount = 0;
    let priceCount = 0;
    let stopped = isRestockRefreshCancelled();

    // Smoke & Mirrors / PokeNE: use retailer catalog APIs (HTML scrapes are unreliable).
    if (!stopped && restockRetailerAllowed("Smoke & Mirrors Hobby", selectedSet)) {
      try {
        setRestockRefreshProgress({
          phase: "smoke",
          label: "Refreshing Smoke & Mirrors catalog…",
          current: 0,
          total: 1,
          percent: 10
        });
        const smoke = await refreshSmokeAndMirrorsCatalog(items, {
          nowIso,
          onProgress: ({ label, percent }) => {
            setRestockRefreshProgress({
              phase: "smoke",
              label: label || "Refreshing Smoke & Mirrors…",
              current: 1,
              total: 1,
              percent: 10 + Math.round((Number(percent) || 0) * 0.12)
            });
          }
        });
        smokeStatusCount = smoke.statusUpdates;
        smokePriceCount = smoke.priceUpdates;
        console.log(
          `[restock-hourly] Smoke & Mirrors: status=${smoke.statusUpdates}, price=${smoke.priceUpdates}, added=${smoke.added}, catalog=${smoke.catalogCount}`
        );
      } catch (err) {
        console.warn(`[restock-hourly] Smoke & Mirrors catalog refresh failed: ${err.message}`);
      }
      stopped = isRestockRefreshCancelled();
    }

    if (!stopped && restockRetailerAllowed("PokeNE", selectedSet)) {
      try {
        setRestockRefreshProgress({
          phase: "pokene",
          label: "Refreshing PokeNE catalog…",
          current: 0,
          total: 1,
          percent: 22
        });
        const pokeNe = await refreshPokeNeCatalog(items, {
          nowIso,
          onProgress: ({ label, percent }) => {
            setRestockRefreshProgress({
              phase: "pokene",
              label: label || "Refreshing PokeNE…",
              current: 1,
              total: 1,
              percent: 22 + Math.round((Number(percent) || 0) * 0.13)
            });
          }
        });
        pokeNeStatusCount = pokeNe.statusUpdates;
        pokeNePriceCount = pokeNe.priceUpdates;
        console.log(
          `[restock-hourly] PokeNE: status=${pokeNe.statusUpdates}, price=${pokeNe.priceUpdates}, added=${pokeNe.added}, catalog=${pokeNe.catalogCount}`
        );
      } catch (err) {
        console.warn(`[restock-hourly] PokeNE catalog refresh failed: ${err.message}`);
      }
      stopped = isRestockRefreshCancelled();
    }

    // Re-verify Amazon in-stock listings to catch sellouts and price changes.
    if (!stopped && restockRetailerAllowed("Amazon", selectedSet)) {
      try {
        setRestockRefreshProgress({
          phase: "amazon",
          label: "Checking Amazon listings…",
          current: 0,
          total: 0,
          percent: 36
        });
        const amazonStatusUpdates = await refreshAmazonItems(items, {
          verifyStatuses: ["in_stock"],
          delayMs: 250,
          shouldCancel: isRestockRefreshCancelled,
          onProgress: ({ current, total, name }) => {
            const pct = total > 0 ? 36 + Math.round((current / total) * 24) : 36;
            setRestockRefreshProgress({
              phase: "amazon",
              label: name
                ? `Amazon ${current}/${total}: ${name}`
                : `Checking Amazon (${current}/${total})`,
              current,
              total,
              percent: pct
            });
          }
        });
        amazonStatusCount = amazonStatusUpdates.length;
        for (const u of amazonStatusUpdates) {
          console.log(`[restock-hourly]   Amazon ${u.asin} ${u.name}: ${u.from} -> ${u.to}`);
        }
      } catch (err) {
        console.warn(`[restock-hourly] Amazon status check failed: ${err.message}`);
      }
      stopped = isRestockRefreshCancelled();
    }

    // Re-check tracked product pages (best-effort by retailer) for status + price drift.
    // Smoke & Mirrors / PokeNE are handled via catalog APIs above.
    const pageScrapeRetailers = [
      "Amazon",
      "Target",
      "Walmart",
      "Troll and Toad",
      "Derium",
      "Wholesale Gaming"
    ];
    const pageRetailersToRun = selectedSet
      ? pageScrapeRetailers.filter((name) => selectedSet.has(name))
      : pageScrapeRetailers;
    if (!stopped && pageRetailersToRun.length) {
      try {
        setRestockRefreshProgress({
          phase: "prices",
          label: "Checking retailer prices…",
          current: 0,
          total: 0,
          percent: 60
        });
        const priceUpdates = await refreshInStockPrices(items, {
          onlyMissing: false,
          verifyStatuses: ["in_stock", "preorder", "out_of_stock"],
          delayMs: 120,
          onlyRetailers: pageRetailersToRun,
          skipRetailers: ["Smoke & Mirrors Hobby", "PokeNE"],
          shouldCancel: isRestockRefreshCancelled,
          onProgress: ({ current, total, name, retailer }) => {
            const pct = total > 0 ? 60 + Math.round((current / total) * 35) : 60;
            const who = retailer ? `${retailer} ` : "";
            setRestockRefreshProgress({
              phase: "prices",
              label: name
                ? `${who}${current}/${total}: ${name}`
                : `Checking prices (${current}/${total})`,
              current,
              total,
              percent: pct
            });
          }
        });
        priceCount = priceUpdates.length;
      } catch (err) {
        console.warn(`[restock-hourly] price refresh failed: ${err.message}`);
      }
      stopped = isRestockRefreshCancelled();
    }

    setRestockRefreshProgress({
      phase: "saving",
      label: stopped ? "Saving restock cache (stopped)…" : "Saving restock cache…",
      current: 1,
      total: 1,
      percent: 97
    });

    // Persist any status/price changes from live checks.
    const finishedAt = new Date().toISOString();
    parsed.items = items;
    parsed.autoRefreshedAt = finishedAt;
    await fsp.writeFile(RESTOCK_TRACKER_FILE, JSON.stringify(parsed, null, 2), "utf8");

    restockRefreshMeta = {
      ...restockRefreshMeta,
      lastFinishedAt: finishedAt,
      lastError: null,
      lastInStockStamped: inStockStamped,
      lastAmazonStatusUpdates: amazonStatusCount,
      lastPriceUpdates: priceCount,
      lastSmokeStatusUpdates: smokeStatusCount,
      lastSmokePriceUpdates: smokePriceCount,
      lastPokeNeStatusUpdates: pokeNeStatusCount,
      lastPokeNePriceUpdates: pokeNePriceCount,
      lastSelectedRetailers: selectedRetailers,
      autoRefreshedAt: finishedAt,
      itemCount: items.length
    };
    setRestockRefreshProgress({
      phase: stopped ? "stopped" : "done",
      label: stopped
        ? "Refresh stopped"
        : selectedRetailers
          ? `Refresh complete (${selectedRetailers.join(", ")})`
          : "Refresh complete",
      current: 1,
      total: 1,
      percent: stopped ? restockRefreshMeta.progress?.percent || 97 : 100
    });

    console.log(
      `[restock-hourly] ${stopped ? "stopped" : "done"}: inStock=${inStockStamped}, amazonStatus=${amazonStatusCount}, priceUpdates=${priceCount}, smoke=${smokeStatusCount}/${smokePriceCount}, pokene=${pokeNeStatusCount}/${pokeNePriceCount}` +
        (selectedRetailers ? `, retailers=${selectedRetailers.join("|")}` : "")
    );

    // TCG link prices are refreshed only from Admin → Update all TCG prices (avoid racing admin jobs).
  } catch (err) {
    restockRefreshMeta.lastFinishedAt = new Date().toISOString();
    restockRefreshMeta.lastError = err.message || String(err);
    setRestockRefreshProgress({
      phase: "error",
      label: restockRefreshMeta.lastError,
      percent: restockRefreshMeta.progress?.percent || 0
    });
    console.warn(`[restock-hourly] skipped: ${err.message}`);
  } finally {
    restockRefreshInFlight = false;
    clearRestockRefreshCancelFlag();
  }
}

function getMsUntilNextTopOfHour(now = new Date()) {
  const next = new Date(now.getTime());
  next.setHours(next.getHours() + 1, 0, 0, 0);
  return Math.max(0, next.getTime() - now.getTime());
}

function clearHourlyPricingCaches() {
  const setCount = setPricingCache.size;
  setPricingCache.clear();
  if (setCount) {
    console.log(`[pricing-hourly] set manifest cache reset at HH:00 (cleared=${setCount})`);
  } else {
    console.log("[pricing-hourly] set manifest cache reset at HH:00 (empty)");
  }
}

function startRestockHourlyRefreshLoop() {
  if (restockRefreshTimer || restockRefreshKickoffTimer) return;

  readRestockTrackerMeta()
    .then((meta) => {
      restockRefreshMeta.autoRefreshedAt = meta.autoRefreshedAt;
      restockRefreshMeta.itemCount = meta.itemCount;
    })
    .catch(() => {});

  const initialDelayMs = getMsUntilNextTopOfHour();
  const nextRunAt = new Date(Date.now() + initialDelayMs).toISOString();
  console.log(
    `[restock-hourly] next run at ${nextRunAt} (aligned to HH:00, in ${Math.round(initialDelayMs / 1000)}s)`
  );

  restockRefreshKickoffTimer = setTimeout(() => {
    restockRefreshKickoffTimer = null;
    refreshRestockTrackerHourlyTick().catch(() => {});
    restockRefreshTimer = setInterval(() => {
      refreshRestockTrackerHourlyTick().catch(() => {});
    }, RESTOCK_AUTO_REFRESH_MS);
  }, initialDelayMs);
}

async function fetchProviderPrices(item) {
  if (item?.type === "single") {
    const hasManual =
      item.manualPrice !== null &&
      item.manualPrice !== undefined &&
      Number.isFinite(Number(item.manualPrice)) &&
      Number(item.manualPrice) > 0;
    if (!hasManual) {
      try {
        const lookup = await getShowcaseSetLookup();
        const manifestCache = new Map();
        const priced = await applySetsCatalogPricingToItem(item, lookup, manifestCache);
        if (Number(priced.marketPrice) > 0) {
          return {
            marketPrice: Number(priced.marketPrice),
            sourceBreakdown: priced.sourceBreakdown || { tcgplayer: priced.marketPrice },
            lastPricedAt: priced.lastPricedAt || new Date().toISOString()
          };
        }
      } catch {
        // fall through to legacy provider mix
      }
    }
  }

  const seededBase = Math.max(item.costBasis || 1, 1);
  const randomFactor = () => 0.92 + Math.random() * 0.2;
  const fallback = {
    ebay: Number((seededBase * randomFactor()).toFixed(2)),
    tcgplayer: Number((seededBase * randomFactor()).toFixed(2)),
    pokedata: Number((seededBase * randomFactor()).toFixed(2)),
    pricecharting: Number((seededBase * randomFactor()).toFixed(2))
  };

  // This MVP preserves provider wiring with env keys and safe fallback.
  // Real integrations can replace these blocks with authenticated API calls.
  let tcgPrice = fallback.tcgplayer;
  const hasTcgKeys = Boolean(getConfig("TCGPLAYER_PUBLIC_KEY") && getConfig("TCGPLAYER_PRIVATE_KEY"));
  if (hasTcgKeys && item.tcgProductId) {
    try {
      tcgPrice = await getTcgProductPrice(item.tcgProductId);
    } catch {
      tcgPrice = fallback.tcgplayer;
    }
  }

  let priceChartingPrice = fallback.pricecharting;
  if (getConfig("PRICECHARTING_API_TOKEN")) {
    try {
      const queryText = [item.name, item.setName, item.cardNumber].filter(Boolean).join(" ").trim();
      const product = await getPriceChartingProduct({
        id: item.priceChartingId || undefined,
        upc: item.upc || undefined,
        q: queryText || undefined
      });
      priceChartingPrice = extractPriceChartingValue(product) || fallback.pricecharting;
    } catch {
      priceChartingPrice = fallback.pricecharting;
    }
  }

  const providers = {
    ebay: getConfig("EBAY_APP_ID") ? fallback.ebay : fallback.ebay,
    tcgplayer: tcgPrice,
    pokedata: getConfig("POKEDATA_API_KEY") ? fallback.pokedata : fallback.pokedata,
    pricecharting: priceChartingPrice
  };

  const values = Object.values(providers).filter((v) => Number.isFinite(v) && v > 0);
  const market = values.length
    ? Number((values.reduce((a, b) => a + b, 0) / values.length).toFixed(2))
    : 0;

  return {
    marketPrice: market,
    sourceBreakdown: providers,
    lastPricedAt: new Date().toISOString()
  };
}

async function refreshPrices(itemId = null, userId = null) {
  let updated = 0;
  for (const item of store.items) {
    if (userId && String(item.userId || "") !== String(userId)) continue;
    if (itemId && item.id !== itemId) continue;
    const quote = await fetchProviderPrices(item);
    item.marketPrice = quote.marketPrice;
    item.sourceBreakdown = quote.sourceBreakdown;
    item.lastPricedAt = quote.lastPricedAt;
    item.updatedAt = new Date().toISOString();
    updated += 1;
  }
  store.refreshedAt = new Date().toISOString();
  await persistStore();
  return updated;
}

const STATIC_CACHE_CONTROL = "public, max-age=86400, stale-while-revalidate=604800";
const API_CATALOG_CACHE_CONTROL = "public, max-age=3600, stale-while-revalidate=86400";

function makeSyntheticCardImageUrl(setCode, cardNo) {
  const code = String(setCode || "").trim().toUpperCase();
  const no = String(cardNo || "").trim();
  if (!code || !no) return "";
  return `/card-images/${encodeURIComponent(code)}/${encodeURIComponent(no)}.jpg`;
}

/**
 * When card art lives on R2 (Cloudflare) there is no local card-images disk tree.
 * Build the same /card-images/{SET}/{no}.jpg map the frontend expects from card keys.
 */
function synthesizeLocalImagesFromCards(setCode, cards) {
  const out = {};
  if (!cards || typeof cards !== "object") return out;
  for (const cardNo of Object.keys(cards)) {
    const url = makeSyntheticCardImageUrl(setCode, cardNo);
    if (!url) continue;
    out[cardNo] = url;
    const n = Number(cardNo);
    if (Number.isFinite(n)) {
      out[String(n)] = url;
      out[String(n).padStart(3, "0")] = url;
    }
  }
  return out;
}

function sanitizeManifestEntryForClient(entry, setCode = "") {
  if (!entry || typeof entry !== "object") return entry;
  let localImages =
    entry.localImages && typeof entry.localImages === "object" ? { ...entry.localImages } : {};
  const cards = entry.cards && typeof entry.cards === "object" ? entry.cards : {};
  if (!Object.keys(localImages).length && Object.keys(cards).length) {
    localImages = synthesizeLocalImagesFromCards(setCode || entry.setCode || "", cards);
  }
  const { images, sourceHref, ...rest } = entry;
  const out = { ...rest };
  if (Object.keys(localImages).length) {
    out.localImages = localImages;
    out.images = { ...localImages };
  }
  return out;
}

function sendStatic(req, res, pathname) {
  const requestPath = pathname === "/" ? "/home.html" : pathname;
  const filePath = path.normalize(path.join(FRONTEND_DIR, requestPath));
  if (!filePath.startsWith(FRONTEND_DIR)) {
    notFound(res);
    return;
  }

  const baseName = path.basename(filePath).toLowerCase();
  const isAdminHtml = baseName === "admin.html";
  const isAdminJs = baseName === "admin.js";
  const isAdminDenied = baseName === "admin-denied.html";
  if (isAdminHtml || isAdminJs || isAdminDenied) {
    if (!isRequestAdmin(req)) {
      if (isAdminJs) {
        notFound(res);
        return;
      }
      redirectHome(res);
      return;
    }
    if (isAdminDenied) {
      // Admins hitting the old denied URL go to the real dashboard.
      sendPrivateAdminFile(res, "admin.html", "text/html; charset=utf-8");
      return;
    }
    // Real admin UI lives outside the public frontend folder.
    if (isAdminHtml) {
      sendPrivateAdminFile(res, "admin.html", "text/html; charset=utf-8");
      return;
    }
    sendPrivateAdminFile(res, "admin.js", "application/javascript; charset=utf-8");
    return;
  }

  fs.readFile(filePath, (err, data) => {
    if (err) {
      notFound(res);
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    const typeMap = {
      ".html": "text/html; charset=utf-8",
      ".css": "text/css; charset=utf-8",
      ".js": "application/javascript; charset=utf-8",
      ".json": "application/json; charset=utf-8"
    };
    const headers = {
      "Content-Type": typeMap[ext] || "application/octet-stream",
      // Lets Google sign-in popups postMessage back to this tab (avoids a second blank window).
      "Cross-Origin-Opener-Policy": "same-origin-allow-popups"
    };
    if (
      ext === ".html" ||
      path.basename(filePath) === "collectr-import-client.js" ||
      path.basename(filePath) === "showcase.js" ||
      path.basename(filePath) === "account-ui.js"
    ) {
      headers["Cache-Control"] = "no-store";
    } else if (ext === ".css" || ext === ".js" || ext === ".json") {
      headers["Cache-Control"] = STATIC_CACHE_CONTROL;
    }
    res.writeHead(200, headers);
    res.end(data);
  });
}

function sendPrivateAdminFile(res, fileName, contentType) {
  const filePath = path.join(PRIVATE_ADMIN_DIR, fileName);
  fs.readFile(filePath, (err, data) => {
    if (err) {
      json(res, 500, { ok: false, error: "Admin UI unavailable" });
      return;
    }
    res.writeHead(200, {
      "Content-Type": contentType,
      "Cache-Control": "no-store",
      "X-Robots-Tag": "noindex, nofollow",
      "Cross-Origin-Opener-Policy": "same-origin-allow-popups"
    });
    res.end(data);
  });
}

function redirectHome(res) {
  res.writeHead(302, {
    Location: "/",
    "Cache-Control": "no-store",
    "X-Robots-Tag": "noindex, nofollow"
  });
  res.end();
}

function isAdminPagePath(pathname) {
  let decoded = String(pathname || "");
  try {
    decoded = decodeURIComponent(decoded);
  } catch {
    // keep raw
  }
  const normalized = decoded.replace(/\\/g, "/").toLowerCase().replace(/\/+$/, "") || "/";
  return normalized === "/admin" || normalized === "/admin.html";
}

function isAdminScriptPath(pathname) {
  let decoded = String(pathname || "");
  try {
    decoded = decodeURIComponent(decoded);
  } catch {
    // keep raw
  }
  const normalized = decoded.replace(/\\/g, "/").toLowerCase();
  return normalized === "/admin.js";
}

function isAdminDeniedPath(pathname) {
  let decoded = String(pathname || "");
  try {
    decoded = decodeURIComponent(decoded);
  } catch {
    // keep raw
  }
  const normalized = decoded.replace(/\\/g, "/").toLowerCase();
  return normalized === "/admin-denied.html";
}

async function sendImageFromDir(res, pathname, routePrefix, rootDir) {
  const rel = pathname.replace(new RegExp(`^/${routePrefix}/`), "");
  let decodedRel = rel;
  try {
    decodedRel = decodeURIComponent(rel);
  } catch {
    decodedRel = rel;
  }
  const rootResolved = path.resolve(rootDir);
  const filePath = path.resolve(path.join(rootResolved, decodedRel));
  if (!filePath.startsWith(rootResolved + path.sep) && filePath !== rootResolved) {
    notFound(res);
    return;
  }

  let data;
  try {
    data = await fsp.readFile(filePath);
  } catch {
    if (routePrefix === "card-images" || routePrefix === "card-images-japanese") {
      try {
        data = await fetchCardImageBytes(pathname, getConfig);
      } catch {
        data = null;
      }
      if (!data) {
        notFound(res);
        return;
      }
    } else if (routePrefix === "pokesymbols") {
      if (isSelfHosted()) {
        notFound(res);
        return;
      }
      try {
        data = await fetchPokesymbolBytes(decodedRel, { cachePath: filePath });
      } catch (err) {
        console.warn(`[pokesymbols] CDN fetch failed for ${decodedRel}: ${err.message}`);
        notFound(res);
        return;
      }
    } else {
      notFound(res);
      return;
    }
  }

  if (isLfsPointer(data)) {
    try {
      data = await materializeLfsFile(filePath, data);
    } catch (err) {
      if (routePrefix === "pokesymbols") {
        if (isSelfHosted()) {
          notFound(res);
          return;
        }
        try {
          data = await fetchPokesymbolBytes(decodedRel, { cachePath: filePath });
        } catch (cdnErr) {
          console.warn(`[pokesymbols] CDN fetch failed for ${decodedRel}: ${cdnErr.message}`);
          notFound(res);
          return;
        }
      } else {
        console.warn(`[lfs] Failed to materialize ${filePath}: ${err.message}`);
        notFound(res);
        return;
      }
    }
  }

  const ext = path.extname(filePath).toLowerCase();
  const headers = { "Content-Type": IMAGE_CONTENT_TYPES[ext] || "application/octet-stream" };
  if (routePrefix === "pokesymbols" || routePrefix === "card-images" || routePrefix === "card-images-japanese") {
    headers["Cache-Control"] = "public, max-age=31536000, immutable";
  }
  res.writeHead(200, headers);
  res.end(data);
}

const POWER_PACKS_CHASE_PREFIX = "/api/power-packs/chase";
const DIRECT_CHASE_PREFIX = "/api/chase";

function getChaseUpstreams() {
  const primaryOrigin = String(getConfig("POWER_PACKS_CHASE_ORIGIN", "https://powerpacks.gamestop.com")).replace(
    /\/$/,
    ""
  );
  const mirrorOrigin = String(getConfig("CHASE_MIRROR_ORIGIN", ""))
    .trim()
    .replace(/\/$/, "");
  const out = [{ name: "powerpacks", origin: primaryOrigin }];
  if (mirrorOrigin && /^https?:\/\//i.test(mirrorOrigin)) {
    out.push({ name: "mirror", origin: mirrorOrigin });
  }
  return out;
}

function buildChaseUpstreamHeaders() {
  const origin = String(getConfig("POWER_PACKS_CHASE_ORIGIN", "https://powerpacks.gamestop.com")).replace(/\/$/, "");
  const headers = {
    Accept: "application/json, text/plain, */*",
    "Accept-Language": "en-US,en;q=0.9",
    "User-Agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36",
    Referer: `${origin}/packs`,
    Origin: origin,
    "Sec-Ch-Ua": '"Chromium";v="136", "Google Chrome";v="136", "Not.A/Brand";v="99"',
    "Sec-Ch-Ua-Mobile": "?0",
    "Sec-Ch-Ua-Platform": '"Windows"',
    "Sec-Fetch-Dest": "empty",
    "Sec-Fetch-Mode": "cors",
    "Sec-Fetch-Site": "same-origin"
  };
  const cookie = String(getConfig("POWER_PACKS_COOKIE", "")).trim();
  if (cookie) headers.Cookie = cookie;
  return headers;
}

function isBlockedStatus(statusCode) {
  return statusCode === 401 || statusCode === 403 || statusCode === 429 || statusCode >= 500;
}

/** Chase JSON uses host-relative slab paths like `/img/hex…`; rewrite for same-origin proxy. */
function rewriteChaseJsonImagePaths(node) {
  if (node == null) return;
  if (Array.isArray(node)) {
    for (const el of node) rewriteChaseJsonImagePaths(el);
    return;
  }
  if (typeof node !== "object") return;
  for (const [k, val] of Object.entries(node)) {
    if (
      (k === "image" || k === "image_back") &&
      typeof val === "string" &&
      /^\/img\/[a-f0-9]+$/i.test(val.trim())
    ) {
      const hash = val.trim().slice("/img/".length);
      node[k] = `/api/power-packs/chase/slab-img/${hash}`;
    } else if (val && typeof val === "object") {
      rewriteChaseJsonImagePaths(val);
    }
  }
}

function chaseCachePathFor(upstreamPath) {
  const key = Buffer.from(String(upstreamPath || ""), "utf8").toString("base64url");
  return path.join(POWER_PACKS_CACHE_DIR, `${key}.json`);
}

async function writeChaseCache(upstreamPath, payload) {
  try {
    const file = chaseCachePathFor(upstreamPath);
    await fsp.writeFile(
      file,
      JSON.stringify({ cachedAt: new Date().toISOString(), upstreamPath, payload }, null, 2),
      "utf8"
    );
  } catch {
    /* cache writes are best effort */
  }
}

async function readChaseCache(upstreamPath) {
  try {
    const raw = await fsp.readFile(chaseCachePathFor(upstreamPath), "utf8");
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return null;
    if (!parsed.payload || typeof parsed.payload !== "object") return null;
    return parsed;
  } catch {
    return null;
  }
}

async function proxyChaseSlabImg(res, hash16) {
  const rel = `/img/${hash16}`;
  const headers = {
    ...buildChaseUpstreamHeaders(),
    Accept: "image/avif,image/webp,image/apng,image/*,*/*;q=0.8"
  };
  const attemptErrors = [];
  for (const upstream of getChaseUpstreams()) {
    const url = upstream.origin + rel;
    try {
      const r = await fetch(url, { method: "GET", headers });
      if (isBlockedStatus(r.status)) {
        attemptErrors.push(`${upstream.name}:${r.status}`);
        continue;
      }
      const buf = Buffer.from(await r.arrayBuffer());
      let ct = r.headers.get("content-type") || "image/jpeg";
      if (!ct.includes("image/")) ct = "image/jpeg";
      res.writeHead(200, {
        "Content-Type": ct,
        "Cache-Control": "public, max-age=86400",
        "Access-Control-Allow-Origin": "*",
        "X-Chase-Upstream": upstream.name
      });
      res.end(buf);
      return;
    } catch (err) {
      attemptErrors.push(`${upstream.name}:${String(err.message || "network error")}`);
    }
  }
  res.writeHead(502, { "Content-Type": "text/plain; charset=utf-8" });
  res.end(`Slab image unavailable (${attemptErrors.join("; ")})`);
}

async function proxyChaseFromTail(res, tail, search) {
  const upstreamPath = "/api/chase" + tail + (search || "");
  const attemptErrors = [];

  for (const upstream of getChaseUpstreams()) {
    const url = upstream.origin + upstreamPath;
    try {
      const r = await fetch(url, {
        method: "GET",
        headers: buildChaseUpstreamHeaders()
      });

      if (isBlockedStatus(r.status)) {
        attemptErrors.push(`${upstream.name}:${r.status}`);
        continue;
      }

      const buf = Buffer.from(await r.arrayBuffer());
      let ct = r.headers.get("content-type") || "application/json; charset=utf-8";
      if (ct.includes("application/json") && !/charset=/i.test(ct)) {
        ct = "application/json; charset=utf-8";
      }
      let outBuf = buf;
      if (ct.includes("application/json")) {
        try {
          const parsed = JSON.parse(buf.toString("utf8"));
          rewriteChaseJsonImagePaths(parsed);
          await writeChaseCache(upstreamPath, parsed);
          outBuf = Buffer.from(JSON.stringify(parsed), "utf8");
        } catch (_) {
          /* pass through raw body */
        }
      }
      res.writeHead(r.status, {
        "Content-Type": ct,
        "Access-Control-Allow-Origin": "*",
        "Cache-Control": "no-store",
        "X-Chase-Upstream": upstream.name
      });
      res.end(outBuf);
      return;
    } catch (err) {
      attemptErrors.push(`${upstream.name}:${String(err.message || "network error")}`);
    }
  }

  const cached = await readChaseCache(upstreamPath);
  if (cached && cached.payload) {
    const payload = {
      ...cached.payload,
      stale: true,
      staleReason:
        "Live upstream unavailable (Cloudflare/403). Serving last cached Power Packs response.",
      cachedAt: cached.cachedAt || null,
      attempts: attemptErrors
    };
    res.writeHead(200, {
      "Content-Type": "application/json; charset=utf-8",
      "Access-Control-Allow-Origin": "*",
      "Cache-Control": "no-store",
      "X-Chase-Upstream": "cache"
    });
    res.end(JSON.stringify(payload));
    return;
  }

  json(res, 502, {
    ok: false,
    error:
      "Failed to reach chase upstreams. GameStop often returns 403 from cloud/datacenter IPs; run the server on a home connection, set POWER_PACKS_COOKIE from a logged-in browser session, or set CHASE_MIRROR_ORIGIN to a compatible mirror.",
    attempts: attemptErrors
  });
}

async function proxyPowerPacksChase(req, res, pathname, search) {
  if (pathname.startsWith(POWER_PACKS_CHASE_PREFIX)) {
    const tail = pathname.slice(POWER_PACKS_CHASE_PREFIX.length);
    await proxyChaseFromTail(res, tail, search);
    return;
  }
  if (pathname.startsWith(DIRECT_CHASE_PREFIX)) {
    const tail = pathname.slice(DIRECT_CHASE_PREFIX.length);
    await proxyChaseFromTail(res, tail, search);
    return;
  }
  notFound(res);
}

async function route(req, res) {
  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET,POST,PUT,PATCH,DELETE,OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type"
    });
    res.end();
    return;
  }

  const parsedUrl = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  const pathname = parsedUrl.pathname;

  const slabMatch =
    req.method === "GET" &&
    (pathname.match(/^\/api\/power-packs\/chase\/slab-img\/([a-f0-9]+)$/i) ||
      pathname.match(/^\/api\/chase\/slab-img\/([a-f0-9]+)$/i));
  if (slabMatch) {
    await proxyChaseSlabImg(res, slabMatch[1]);
    return;
  }

  if ((pathname.startsWith(POWER_PACKS_CHASE_PREFIX) || pathname.startsWith(DIRECT_CHASE_PREFIX)) && req.method === "GET") {
    await proxyPowerPacksChase(req, res, pathname, parsedUrl.search || "");
    return;
  }

  if (pathname === "/api/power-packs/chase/local-images" && req.method === "POST") {
    try {
      const body = await readBody(req);
      const raw = body && Array.isArray(body.items) ? body.items : [];
      const items = raw
        .filter((x) => x && x.id != null && String(x.id).length > 0)
        .slice(0, 800)
        .map((x) => ({
          id: String(x.id),
          title: String(x.title || ""),
          subtitle: String(x.subtitle || ""),
          category_slug: String(x.category_slug || ""),
          category: String(x.category || "")
        }));
      const byId = await resolveChaseLocalImagesBatch(items, getSetCardManifest);
      json(res, 200, { ok: true, byId });
    } catch (err) {
      json(res, 400, { ok: false, error: err.message || "Bad request" });
    }
    return;
  }

  if (pathname === "/api/health" && req.method === "GET") {
    const now = Date.now();
    json(res, 200, {
      ok: true,
      port: PORT,
      region: DEFAULT_REGION,
      currency: DEFAULT_CURRENCY,
      hasKeys: {
        ebay: Boolean(getConfig("EBAY_APP_ID")),
        tcgplayer: Boolean(getConfig("TCGPLAYER_PUBLIC_KEY") && getConfig("TCGPLAYER_PRIVATE_KEY")),
        pokedata: Boolean(getConfig("POKEDATA_API_KEY")),
        pricecharting: Boolean(getConfig("PRICECHARTING_API_TOKEN")),
        psa: Boolean(getConfig("PSA_ACCESS_TOKEN")),
        googleOAuth: Boolean(getConfig("GOOGLE_CLIENT_ID")),
        passwordResetMail: isEmailConfigured({ ...env, ...process.env })
      },
      tcgplayerAuth: {
        tokenCached: Boolean(tcgTokenCache.accessToken && now < tcgTokenCache.expiresAt),
        tokenExpiresAt: tcgTokenCache.expiresAt ? new Date(tcgTokenCache.expiresAt).toISOString() : null
      }
    });
    return;
  }

  if (pathname === "/api/auth/me" && req.method === "GET") {
    const user = getCurrentUser(req);
    json(res, 200, {
      ok: true,
      signedIn: Boolean(user),
      user
    });
    return;
  }

  if (pathname === "/api/auth/signup" && req.method === "POST") {
    try {
      const body = await readBody(req);
      const email = normalizeEmail(body.email);
      const username = normalizeUsername(body.username);
      const password = String(body.password || "");
      const name = String(body.name || "").trim();
      if (!email || !email.includes("@")) {
        json(res, 400, { ok: false, error: "Valid email is required" });
        return;
      }
      if (!isValidUsername(username)) {
        json(
          res,
          400,
          { ok: false, error: "Username must be 3-24 characters (letters, numbers, underscore)" }
        );
        return;
      }
      if (password.length < 8) {
        json(res, 400, { ok: false, error: "Password must be at least 8 characters" });
        return;
      }
      const emailExists = store.users.find((entry) => normalizeEmail(entry.email) === email);
      if (emailExists) {
        json(res, 409, { ok: false, error: "Email already registered" });
        return;
      }
      const usernameExists = store.users.find((entry) => normalizeUsername(entry.username) === username);
      if (usernameExists) {
        json(res, 409, { ok: false, error: "Username already taken" });
        return;
      }
      const user = {
        id: randomId(),
        email,
        username,
        name,
        passwordHash: hashPassword(password),
        showcase: defaultShowcaseSettings(),
        createdAt: new Date().toISOString(),
        lastLoginAt: new Date().toISOString()
      };
      store.users.push(user);
      await persistStore();
      const { cookie: sessionCookie } = issueAuthSession(user.id, true);
      json(res, 201, { ok: true, user: publicUserPayload(user) }, { "Set-Cookie": sessionCookie });
    } catch (err) {
      json(res, 400, { ok: false, error: err.message || "Bad request" });
    }
    return;
  }

  if (pathname === "/api/auth/signin" && req.method === "POST") {
    try {
      const body = await readBody(req);
      const login = String(body.login ?? body.email ?? "").trim();
      const email = normalizeEmail(login);
      const username = normalizeUsername(login);
      const password = String(body.password || "");
      const user = store.users.find((entry) => {
        const entryEmail = normalizeEmail(entry.email);
        const entryUsername = normalizeUsername(entry.username);
        return entryEmail === email || (username && entryUsername === username);
      });
      if (!user) {
        json(res, 401, { ok: false, error: "Invalid email/username or password" });
        return;
      }
      if (user.googleSub && (user.passwordHash == null || user.passwordHash === "")) {
        json(res, 401, {
          ok: false,
          error: "This account uses Google sign-in. Use Continue with Google below."
        });
        return;
      }
      if (!verifyPassword(password, user.passwordHash)) {
        json(res, 401, { ok: false, error: "Invalid email/username or password" });
        return;
      }
      user.lastLoginAt = new Date().toISOString();
      await persistStore();
      const rememberMe = parseRememberMe(body.rememberMe);
      const { cookie: sessionCookie } = issueAuthSession(user.id, rememberMe);
      json(res, 200, { ok: true, user: publicUserPayload(user) }, { "Set-Cookie": sessionCookie });
    } catch (err) {
      json(res, 400, { ok: false, error: err.message || "Bad request" });
    }
    return;
  }

  if (pathname === "/api/auth/signout" && req.method === "POST") {
    const cookies = parseCookies(req);
    const token = cookies[SESSION_COOKIE_NAME];
    if (token) sessions.delete(token);
    json(res, 200, { ok: true }, { "Set-Cookie": buildClearedSessionCookie() });
    return;
  }

  if (pathname === "/api/auth/forgot-password" && req.method === "POST") {
    try {
      const body = await readBody(req);
      const result = await requestPasswordReset({
        email: body.email,
        users: store.users,
        resetFilePath: PASSWORD_RESET_FILE,
        req,
        env: { ...env, ...process.env }
      });
      if (!result.ok) {
        json(res, 400, { ok: false, error: result.error || "Could not send reset email" });
        return;
      }
      json(res, 200, {
        ok: true,
        message: result.message,
        emailSent: Boolean(result.emailSent),
        mailConfigured: isEmailConfigured({ ...env, ...process.env })
      });
    } catch (err) {
      console.warn(`[auth] forgot-password failed: ${err.message}`);
      json(res, 500, { ok: false, error: "Could not send reset email. Try again later." });
    }
    return;
  }

  if (pathname === "/api/auth/reset-password" && req.method === "POST") {
    try {
      const body = await readBody(req);
      const result = await completePasswordReset({
        token: body.token,
        newPassword: body.password || body.newPassword,
        users: store.users,
        resetFilePath: PASSWORD_RESET_FILE
      });
      if (!result.ok) {
        json(res, 400, { ok: false, error: result.error || "Could not reset password" });
        return;
      }
      const user = store.users.find((entry) => entry.id === result.userId);
      if (!user) {
        json(res, 400, { ok: false, error: "Account not found" });
        return;
      }
      user.passwordHash = hashPassword(String(body.password || body.newPassword || ""));
      await persistStore();
      json(res, 200, { ok: true, message: "Password updated. You can sign in with your new password." });
    } catch (err) {
      json(res, 400, { ok: false, error: err.message || "Could not reset password" });
    }
    return;
  }

  if (pathname === "/api/auth/profile" && (req.method === "PATCH" || req.method === "POST")) {
    try {
      const sessionUser = getCurrentUser(req);
      if (!sessionUser) {
        json(res, 401, { ok: false, error: "Not signed in" });
        return;
      }
      const user = store.users.find((u) => u.id === sessionUser.id);
      if (!user) {
        json(res, 401, { ok: false, error: "Not signed in" });
        return;
      }
      const body = await readBody(req);
      const hasName = Object.prototype.hasOwnProperty.call(body, "name");
      const hasDisplayName = Object.prototype.hasOwnProperty.call(body, "displayName");
      const hasEmail = Object.prototype.hasOwnProperty.call(body, "email");
      const hasUsername = Object.prototype.hasOwnProperty.call(body, "username");
      const hasShowCostBasis = Object.prototype.hasOwnProperty.call(body, "showCostBasis");
      const hasShowUnrealizedPnL = Object.prototype.hasOwnProperty.call(body, "showUnrealizedPnL");
      if (
        !hasName &&
        !hasDisplayName &&
        !hasEmail &&
        !hasUsername &&
        !hasShowCostBasis &&
        !hasShowUnrealizedPnL
      ) {
        json(res, 400, { ok: false, error: "Nothing to update" });
        return;
      }
      if (hasName || hasDisplayName) {
        const raw = hasName ? body.name : body.displayName;
        user.name = String(raw ?? "").trim().slice(0, 80);
      }
      if (hasEmail) {
        const email = normalizeEmail(body.email);
        if (!email || !email.includes("@")) {
          json(res, 400, { ok: false, error: "Valid email is required" });
          return;
        }
        const taken = store.users.some((u) => u.id !== user.id && normalizeEmail(u.email) === email);
        if (taken) {
          json(res, 409, { ok: false, error: "Email already in use" });
          return;
        }
        user.email = email;
      }
      if (hasUsername) {
        const username = normalizeUsername(body.username);
        if (!isValidUsername(username)) {
          json(
            res,
            400,
            { ok: false, error: "Username must be 3-24 characters (letters, numbers, underscore)" }
          );
          return;
        }
        const takenUser = store.users.find(
          (u) => u.id !== user.id && normalizeUsername(u.username) === username
        );
        if (takenUser) {
          json(res, 409, { ok: false, error: "Username already taken" });
          return;
        }
        user.username = username;
      }
      if (hasShowCostBasis || hasShowUnrealizedPnL) {
        const prefs = ensureUserPreferences(user);
        if (hasShowCostBasis) prefs.showCostBasis = body.showCostBasis === true;
        if (hasShowUnrealizedPnL) prefs.showUnrealizedPnL = body.showUnrealizedPnL === true;
      }
      ensureDefaultAdminRoles(store, adminUsernames);
      await persistStore();
      json(res, 200, { ok: true, user: publicUserPayload(user) });
    } catch (err) {
      json(res, 400, { ok: false, error: err.message || "Bad request" });
    }
    return;
  }

  if (pathname === "/api/auth/password" && req.method === "POST") {
    try {
      const sessionUser = getCurrentUser(req);
      if (!sessionUser) {
        json(res, 401, { ok: false, error: "Not signed in" });
        return;
      }
      const user = store.users.find((u) => u.id === sessionUser.id);
      if (!user) {
        json(res, 401, { ok: false, error: "Not signed in" });
        return;
      }
      const body = await readBody(req);
      const newPassword = String(body.newPassword || "");
      const currentPassword = String(body.currentPassword || "");
      if (newPassword.length < 8) {
        json(res, 400, { ok: false, error: "New password must be at least 8 characters" });
        return;
      }
      const hasPw = Boolean(user.passwordHash);
      if (hasPw) {
        if (!currentPassword || !verifyPassword(currentPassword, user.passwordHash)) {
          json(res, 401, { ok: false, error: "Current password is incorrect" });
          return;
        }
      }
      user.passwordHash = hashPassword(newPassword);
      await persistStore();
      json(res, 200, { ok: true });
    } catch (err) {
      json(res, 400, { ok: false, error: err.message || "Bad request" });
    }
    return;
  }

  if (pathname === "/api/auth/google-config" && req.method === "GET") {
    const clientId = getConfig("GOOGLE_CLIENT_ID") || "";
    json(res, 200, { ok: true, clientId });
    return;
  }

  if (pathname === "/api/auth/google" && req.method === "POST") {
    try {
      if (!getConfig("GOOGLE_CLIENT_ID")) {
        json(res, 503, { ok: false, error: "Google sign-in is not configured on this server" });
        return;
      }
      const body = await readBody(req);
      const credential = String(body.credential || "").trim();
      if (!credential) {
        json(res, 400, { ok: false, error: "Missing Google credential" });
        return;
      }
      const profile = await verifyGoogleIdToken(credential);

      // Prefer an existing account with the same Google subject, then same email
      // (links Google to email/password accounts without creating a duplicate).
      const bySub = store.users.find((u) => u.googleSub === profile.sub);
      const byEmail = store.users.find((u) => normalizeEmail(u.email) === profile.email);
      let user = bySub || null;
      let linkedByEmail = false;

      if (!user && byEmail) {
        if (byEmail.googleSub && byEmail.googleSub !== profile.sub) {
          json(res, 409, { ok: false, error: "This email is linked to a different Google account" });
          return;
        }
        user = byEmail;
        user.googleSub = profile.sub;
        linkedByEmail = true;
        if (profile.picture) user.picture = profile.picture;
        if (profile.name && !user.name) user.name = profile.name;
      }

      // Same Google account already signed in earlier under a different row than the
      // email/password account — merge into the email match and drop the empty Google-only row.
      if (user && byEmail && user.id !== byEmail.id && normalizeEmail(byEmail.email) === profile.email) {
        if (!byEmail.googleSub || byEmail.googleSub === profile.sub) {
          byEmail.googleSub = profile.sub;
          if (profile.picture) byEmail.picture = profile.picture;
          if (profile.name && !byEmail.name) byEmail.name = profile.name;
          if (!byEmail.passwordHash && user.passwordHash) byEmail.passwordHash = user.passwordHash;
          store.users = store.users.filter((u) => u.id !== user.id);
          user = byEmail;
          linkedByEmail = true;
        }
      }

      if (!user) {
        const username = allocateUniqueUsernameForGoogle(profile.email);
        user = {
          id: randomId(),
          email: profile.email,
          username,
          name: profile.name || "",
          picture: profile.picture || "",
          googleSub: profile.sub,
          passwordHash: null,
          showcase: defaultShowcaseSettings(),
          createdAt: new Date().toISOString(),
          lastLoginAt: new Date().toISOString()
        };
        store.users.push(user);
      } else {
        user.lastLoginAt = new Date().toISOString();
        if (profile.picture) user.picture = profile.picture;
        if (profile.name && !user.name) user.name = profile.name;
      }

      if (ensureDefaultAdminRoles(store, adminUsernames)) {
        /* role may update for ADMIN_USERNAMES matches */
      }

      await persistStore();
      const rememberMe = parseRememberMe(body.rememberMe);
      const { cookie: sessionCookie } = issueAuthSession(user.id, rememberMe);
      json(
        res,
        200,
        { ok: true, linkedByEmail, user: publicUserPayload(user) },
        { "Set-Cookie": sessionCookie }
      );
    } catch (err) {
      const code = err.code;
      if (code === "NO_GOOGLE") {
        json(res, 503, { ok: false, error: err.message || "Google sign-in unavailable" });
        return;
      }
      if (code === "UNVERIFIED") {
        json(res, 400, { ok: false, error: err.message || "Email not verified" });
        return;
      }
      if (code === "BAD_TOKEN") {
        json(res, 401, { ok: false, error: err.message || "Invalid Google credential" });
        return;
      }
      json(res, 400, { ok: false, error: err.message || "Google sign-in failed" });
    }
    return;
  }

  if (pathname === "/api/providers/tcgplayer/categories" && req.method === "GET") {
    try {
      const categories = await getTcgCategories();
      json(res, 200, { ok: true, categories });
    } catch (err) {
      json(res, 502, { ok: false, error: err.message || "TCGplayer categories failed" });
    }
    return;
  }

  if (pathname === "/api/providers/tcgplayer/live-card" && req.method === "GET") {
    try {
      if (!getConfig("TCGPLAYER_PUBLIC_KEY") || !getConfig("TCGPLAYER_PRIVATE_KEY")) {
        json(res, 503, { ok: false, error: "TCGplayer credentials are not configured on the server" });
        return;
      }
      const cardName = parsedUrl.searchParams.get("card") || parsedUrl.searchParams.get("name") || "";
      const setCode = parsedUrl.searchParams.get("setCode") || parsedUrl.searchParams.get("set") || "";
      const cardNo = parsedUrl.searchParams.get("cardNo") || parsedUrl.searchParams.get("number") || "";
      const live = await searchTcgLiveCard({ cardName, setCode, cardNo });
      json(res, 200, { ok: true, live });
    } catch (err) {
      json(res, 502, { ok: false, error: err.message || "TCGplayer live card request failed" });
    }
    return;
  }

  if (pathname === "/api/providers/pricecharting/live-card" && req.method === "GET") {
    try {
      const cardName = parsedUrl.searchParams.get("card") || parsedUrl.searchParams.get("cardName") || parsedUrl.searchParams.get("name") || "";
      const setCode = parsedUrl.searchParams.get("setCode") || parsedUrl.searchParams.get("set") || "";
      const cardNo = parsedUrl.searchParams.get("cardNo") || parsedUrl.searchParams.get("number") || "";
      const setName = parsedUrl.searchParams.get("setName") || parsedUrl.searchParams.get("name") || "";
      const pc = await fetchPriceChartingUngradedPriceForCard({ setCode, setName, cardNo, cardName });
      if (!pc?.ok || !Number(pc.ungradedPrice) || pc.ungradedPrice <= 0) {
        json(res, 404, {
          ok: false,
          error: pc?.error || "Could not read Ungraded price from PriceCharting",
          live: null
        });
        return;
      }
      json(res, 200, {
        ok: true,
        live: {
          marketPrice: Number(pc.ungradedPrice),
          productUrl: String(pc.productUrl || "").trim(),
          source: "pricecharting-ungraded"
        }
      });
    } catch (err) {
      json(res, 502, { ok: false, error: err.message || "PriceCharting live card request failed" });
    }
    return;
  }

  if (pathname === "/api/providers/pricecharting/product" && req.method === "GET") {
    try {
      const id = parsedUrl.searchParams.get("id");
      const upc = parsedUrl.searchParams.get("upc");
      const q = parsedUrl.searchParams.get("q");
      const product = await getPriceChartingProduct({ id, upc, q });
      json(res, 200, { ok: true, product });
    } catch (err) {
      json(res, 502, { ok: false, error: err.message || "PriceCharting request failed" });
    }
    return;
  }

  if (pathname.startsWith("/api/providers/psa/cert/") && req.method === "GET") {
    try {
      const certNumber = decodeURIComponent(pathname.split("/").pop() || "").trim();
      const certPayload = await getPsaCertData(certNumber);
      const snapshot = mapPsaSnapshot(certPayload);
      json(res, 200, { ok: true, snapshot, raw: certPayload });
    } catch (err) {
      json(res, 502, { ok: false, error: err.message || "PSA cert request failed" });
    }
    return;
  }

  if (pathname === "/api/showcase/me" && req.method === "GET") {
    const sessionUser = requireSignedInUser(req, res);
    if (!sessionUser) return;
    const record = findStoreUserById(sessionUser.id);
    if (!record) {
      json(res, 401, { ok: false, error: "Not signed in" });
      return;
    }
    const showcase = ensureUserShowcase(record);
    const enriched = await enrichCollectionItemsForShowcase(
      getCollectionItemsForUser(record.id)
    );
    json(res, 200, {
      ok: true,
      profile: publicShowcaseProfilePayload(record),
      stats: summarizeShowcaseCollection(enriched, showcase),
      itemCount: enriched.length
    });
    return;
  }

  if (pathname === "/api/showcase/settings" && (req.method === "PATCH" || req.method === "POST")) {
    try {
      const sessionUser = requireSignedInUser(req, res);
      if (!sessionUser) return;
      const record = findStoreUserById(sessionUser.id);
      if (!record) {
        json(res, 401, { ok: false, error: "Not signed in" });
        return;
      }
      const body = await readBody(req);
      const current = ensureUserShowcase(record);
      const truthy = (value) => value === true || value === "true" || value === 1 || value === "1";
      const falsy = (value) => value === false || value === "false" || value === 0 || value === "0";
      const boolField = (value, fallback) => {
        if (truthy(value)) return true;
        if (falsy(value)) return false;
        return fallback;
      };
      let nextAvatarUrl = current.avatarUrl;
      if (Object.prototype.hasOwnProperty.call(body, "avatarUrl")) {
        nextAvatarUrl = normalizeShowcaseAvatarUrl(body.avatarUrl, record.id);
        if (nextAvatarUrl.startsWith("/showcase-avatars/")) {
          // keep uploaded file path only
        } else if (!nextAvatarUrl && current.avatarUrl && current.avatarUrl.startsWith("/showcase-avatars/")) {
          await removeShowcaseAvatarFiles(SHOWCASE_AVATAR_DIR, record.id);
        } else if (
          nextAvatarUrl &&
          current.avatarUrl &&
          current.avatarUrl.startsWith("/showcase-avatars/") &&
          nextAvatarUrl !== current.avatarUrl
        ) {
          await removeShowcaseAvatarFiles(SHOWCASE_AVATAR_DIR, record.id);
        }
      }
      record.showcase = normalizeShowcaseSettings(
        {
          isPublic: Object.prototype.hasOwnProperty.call(body, "isPublic")
            ? boolField(body.isPublic, current.isPublic)
            : current.isPublic,
          bio: Object.prototype.hasOwnProperty.call(body, "bio") ? body.bio : current.bio,
          showValues: Object.prototype.hasOwnProperty.call(body, "showValues")
            ? boolField(body.showValues, current.showValues)
            : current.showValues,
          showCost: Object.prototype.hasOwnProperty.call(body, "showCost")
            ? boolField(body.showCost, current.showCost)
            : current.showCost,
          collectrProfileUrl: Object.prototype.hasOwnProperty.call(body, "collectrProfileUrl")
            ? body.collectrProfileUrl
            : current.collectrProfileUrl,
          avatarUrl: nextAvatarUrl
        },
        record.id
      );
      await persistStore();
      json(res, 200, {
        ok: true,
        profile: publicShowcaseProfilePayload(record),
        showcase: record.showcase
      });
    } catch (err) {
      json(res, 400, { ok: false, error: err.message || "Bad request" });
    }
    return;
  }

  if (pathname === "/api/showcase/avatar" && req.method === "POST") {
    try {
      const sessionUser = requireSignedInUser(req, res);
      if (!sessionUser) return;
      const record = findStoreUserById(sessionUser.id);
      if (!record) {
        json(res, 401, { ok: false, error: "Not signed in" });
        return;
      }
      const body = await readBody(req, 900_000);
      const current = ensureUserShowcase(record);

      if (body.clear === true || body.clear === "true") {
        if (current.avatarUrl && current.avatarUrl.startsWith("/showcase-avatars/")) {
          await removeShowcaseAvatarFiles(SHOWCASE_AVATAR_DIR, record.id);
        }
        record.showcase = normalizeShowcaseSettings({ ...current, avatarUrl: "" }, record.id);
        await persistStore();
        json(res, 200, {
          ok: true,
          profile: publicShowcaseProfilePayload(record),
          showcase: record.showcase
        });
        return;
      }

      if (body.imageData) {
        const avatarPath = await saveShowcaseAvatarUpload(
          SHOWCASE_AVATAR_DIR,
          record.id,
          body.imageData
        );
        record.showcase = normalizeShowcaseSettings(
          { ...current, avatarUrl: avatarPath },
          record.id
        );
        await persistStore();
        json(res, 200, {
          ok: true,
          profile: publicShowcaseProfilePayload(record),
          showcase: record.showcase
        });
        return;
      }

      if (Object.prototype.hasOwnProperty.call(body, "avatarUrl")) {
        const nextUrl = normalizeShowcaseAvatarUrl(body.avatarUrl, record.id);
        if (
          current.avatarUrl &&
          current.avatarUrl.startsWith("/showcase-avatars/") &&
          nextUrl !== current.avatarUrl
        ) {
          await removeShowcaseAvatarFiles(SHOWCASE_AVATAR_DIR, record.id);
        }
        record.showcase = normalizeShowcaseSettings({ ...current, avatarUrl: nextUrl }, record.id);
        await persistStore();
        json(res, 200, {
          ok: true,
          profile: publicShowcaseProfilePayload(record),
          showcase: record.showcase
        });
        return;
      }

      json(res, 400, { ok: false, error: "Provide imageData, avatarUrl, or clear: true" });
    } catch (err) {
      json(res, 400, { ok: false, error: err.message || "Bad request" });
    }
    return;
  }

  const showcaseProfileMatch = pathname.match(/^\/api\/showcase\/profile\/([^/]+)\/?$/i);
  if (showcaseProfileMatch && req.method === "GET") {
    try {
      const record = findStoreUserByUsername(decodeURIComponent(showcaseProfileMatch[1]));
      if (!record) {
        json(res, 404, { ok: false, error: "Collector not found", profile: null, items: [] });
        return;
      }
      const showcase = ensureUserShowcase(record);
      const sessionUser = getCurrentUser(req);
      const isOwner = Boolean(sessionUser && sessionUser.id === record.id);
      if (!showcase.isPublic && !isOwner) {
        json(res, 403, {
          ok: false,
          error: "This showcase is private",
          profile: {
            username: record.username,
            name: String(record.name || record.username).trim(),
            showcase: { isPublic: false }
          },
          items: []
        });
        return;
      }
      const enriched = await enrichCollectionItemsForShowcase(
        getCollectionItemsForUser(record.id)
      );
      const showcaseReturnPath = showcasePathForUsername(record.username);
      const items = enriched.map((item) =>
        publicShowcaseItemPayload({ ...item, showcaseReturnPath }, showcase)
      );
      items.sort((a, b) => {
        const valueA = Number(a.totalValue ?? a.unitValue ?? 0);
        const valueB = Number(b.totalValue ?? b.unitValue ?? 0);
        if (valueB !== valueA) return valueB - valueA;
        return String(a.name || "").localeCompare(String(b.name || ""));
      });
      json(res, 200, {
        ok: true,
        isOwner,
        profile: publicShowcaseProfilePayload(record),
        stats: summarizeShowcaseCollection(enriched, showcase),
        items
      });
    } catch (err) {
      json(res, 500, { ok: false, error: err.message || "Failed to load showcase", items: [] });
    }
    return;
  }

  if (pathname === "/api/collectr/showcase/catalog" && req.method === "POST") {
    try {
      const sessionUser = requireSignedInUser(req, res);
      if (!sessionUser) return;
      const body = await readBody(req);
      const link = String(body.url || body.collectrProfileUrl || body.collectrUrl || "").trim();
      const parsedLink = parseCollectrProfileUrl(link);
      if (!parsedLink.ok) {
        json(res, 400, { ok: false, error: parsedLink.error });
        return;
      }
      const catalog = await fetchCollectrShowcaseCatalog(parsedLink.handle, {
        maxItems: Math.min(25_000, Number(body.maxItems) || 20_000),
        useBrowser: body.useBrowser !== false
      });
      if (!catalog.ok) {
        json(res, 400, {
          ok: false,
          error: catalog.error || catalog.reason || "Failed to load Collectr showcase"
        });
        return;
      }
      const products = filterCollectrPokemonProducts(catalog.products || []);
      json(res, 200, {
        ok: true,
        handle: catalog.handle,
        profileUrl: catalog.profileUrl,
        profile: catalog.profile,
        source: catalog.source,
        partial: catalog.partial,
        pokemonOnly: true,
        totalCards: catalog.totalCards || 0,
        totalSealed: catalog.totalSealed || 0,
        expectedTotal: catalog.expectedTotal || null,
        totalFound: products.length,
        filteredOutNonPokemon: Math.max(
          0,
          Number(catalog.filteredOutNonPokemon) ||
            (Array.isArray(catalog.products) ? catalog.products.length - products.length : 0)
        ),
        products
      });
    } catch (err) {
      json(res, 502, { ok: false, error: err.message || "Collectr catalog fetch failed" });
    }
    return;
  }

  if (pathname === "/api/collectr/import/preview" && req.method === "POST") {
    try {
      const sessionUser = requireSignedInUser(req, res);
      if (!sessionUser) return;
      const body = await readBody(req);
      const link = String(body.url || body.collectrProfileUrl || body.collectrUrl || "").trim();
      const parsedLink = parseCollectrProfileUrl(link);
      if (!parsedLink.ok) {
        json(res, 400, { ok: false, error: parsedLink.error });
        return;
      }
      const catalog = await fetchCollectrShowcaseCatalog(parsedLink.handle, {
        maxItems: Math.min(25_000, Number(body.maxItems) || 20_000)
      });
      if (!catalog.ok) {
        json(res, 400, { ok: false, error: catalog.error || "Failed to load Collectr showcase" });
        return;
      }
      const mapped = catalog.products
        .map((row) => mapCollectrProductToItem(row))
        .filter(Boolean);
      json(res, 200, {
        ok: true,
        handle: catalog.handle,
        profileUrl: catalog.profileUrl,
        profile: catalog.profile,
        source: catalog.source,
        partial: catalog.partial,
        needsBrowserFetch: catalog.needsBrowserFetch === true,
        totalFound: mapped.length,
        totalCards: catalog.totalCards || 0,
        totalSealed: catalog.totalSealed || 0,
        expectedTotal: catalog.expectedTotal || null,
        sample: mapped.slice(0, 8)
      });
    } catch (err) {
      json(res, 502, { ok: false, error: err.message || "Collectr preview failed" });
    }
    return;
  }

  if (pathname === "/api/collectr/import" && req.method === "POST") {
    try {
      const sessionUser = requireSignedInUser(req, res);
      if (!sessionUser) return;
      const body = await readBody(req);
      const link = String(body.url || body.collectrProfileUrl || body.collectrUrl || "").trim();
      const parsedLink = parseCollectrProfileUrl(link);
      if (!parsedLink.ok) {
        json(res, 400, { ok: false, error: parsedLink.error });
        return;
      }
      const replaceExisting = body.replaceExisting === true || body.replace === true;
      const catalog = await fetchCollectrShowcaseCatalog(parsedLink.handle, {
        maxItems: Math.min(25_000, Number(body.maxItems) || 20_000)
      });
      if (!catalog.ok) {
        json(res, 400, { ok: false, error: catalog.error || "Failed to load Collectr showcase" });
        return;
      }

      const importBatchId = String(body.importBatchId || randomId()).trim();
      const importSingles = body.importSingles !== false;
      const importSealed = body.importSealed !== false;
      const result = await importCollectrProductsForUser(sessionUser.id, catalog.products, {
        replaceExisting,
        importSingles,
        importSealed,
        profileUrl: parsedLink.profileUrl,
        handle: catalog.handle,
        importBatchId
      });
      if (result.error) {
        json(res, 400, { ok: false, error: result.error });
        return;
      }

      addActivity(
        "created",
        null,
        `Imported ${result.imported} item(s) from Collectr @${catalog.handle}`,
        sessionUser.id
      );
      await persistStore();

      json(res, 200, {
        ok: true,
        ...result,
        totalFound: catalog.products.length,
        handle: catalog.handle,
        profileUrl: catalog.profileUrl,
        source: catalog.source,
        partial: catalog.partial,
        needsBrowserFetch: catalog.needsBrowserFetch === true,
        totalCards: catalog.totalCards || 0,
        totalSealed: catalog.totalSealed || 0,
        expectedTotal: catalog.expectedTotal || null,
        replacedExisting: replaceExisting
      });
    } catch (err) {
      json(res, 502, { ok: false, error: err.message || "Collectr import failed" });
    }
    return;
  }

  if (pathname === "/api/collectr/import/bulk" && req.method === "POST") {
    try {
      const sessionUser = requireSignedInUser(req, res);
      if (!sessionUser) return;
      const body = await readBody(req, 12_000_000);
      const products = Array.isArray(body.products) ? body.products : [];
      if (!products.length && body.finalBatch !== true) {
        json(res, 400, { ok: false, error: "products array is required" });
        return;
      }
      if (!products.length && body.finalBatch === true) {
        const handle = String(body.handle || "").trim();
        const profileUrl = String(body.profileUrl || body.url || "").trim();
        const runImported = Number(body.runImported);
        const importBatchId = String(body.importBatchId || "").trim();
        const record = findStoreUserById(sessionUser.id);
        if (record && importBatchId && Number.isFinite(runImported) && runImported > 0) {
          record.lastCollectrImport = {
            batchId: importBatchId,
            handle,
            profileUrl,
            importedAt: new Date().toISOString(),
            itemCount: runImported
          };
        }
        if (Number.isFinite(runImported) && runImported > 0) {
          addActivity(
            "created",
            null,
            `Imported ${runImported} item(s) from Collectr${handle ? ` @${handle}` : ""} (Pokemon only)`,
            sessionUser.id
          );
          await persistStore();
        } else {
          await persistStore();
        }
        json(res, 200, {
          ok: true,
          imported: 0,
          skipped: 0,
          batchSize: 0,
          finalBatch: true,
          importBatchId,
          itemCount: Number.isFinite(runImported) ? runImported : 0
        });
        return;
      }
      const replaceExisting = body.replaceExisting === true || body.replace === true;
      const importSingles = body.importSingles !== false;
      const importSealed = body.importSealed !== false;
      const profileUrl = String(body.profileUrl || body.url || "").trim();
      const handle = String(body.handle || "").trim();
      const importBatchId = String(body.importBatchId || randomId()).trim();
      const result = await importCollectrProductsForUser(sessionUser.id, products, {
        replaceExisting,
        importSingles,
        importSealed,
        profileUrl,
        handle,
        importBatchId
      });
      if (result.error) {
        json(res, 400, { ok: false, error: result.error });
        return;
      }
      await persistStore();
      json(res, 200, {
        ok: true,
        ...result,
        batchSize: products.length,
        finalBatch: body.finalBatch === true
      });
    } catch (err) {
      json(res, 400, { ok: false, error: err.message || "Collectr bulk import failed" });
    }
    return;
  }

  if (pathname === "/api/collectr/import/delete" && req.method === "POST") {
    try {
      const sessionUser = requireSignedInUser(req, res);
      if (!sessionUser) return;
      const body = await readBody(req);
      const importBatchId = String(body.importBatchId || "").trim();
      const record = findStoreUserById(sessionUser.id);
      const batchId = importBatchId || record?.lastCollectrImport?.batchId || "";
      if (!batchId) {
        json(res, 400, { ok: false, error: "No Collectr import batch to delete" });
        return;
      }
      const result = deleteCollectrImportBatchForUser(sessionUser.id, batchId);
      if (result.deleted > 0) {
        addActivity(
          "deleted",
          null,
          `Removed ${result.deleted} item(s) from last Collectr import`,
          sessionUser.id
        );
      }
      await persistStore();
      json(res, 200, { ok: true, ...result });
    } catch (err) {
      json(res, 400, { ok: false, error: err.message || "Collectr delete failed" });
    }
    return;
  }

  if (pathname === "/api/collection/delete-all" && req.method === "POST") {
    try {
      const sessionUser = requireSignedInUser(req, res);
      if (!sessionUser) return;
      const existing = getCollectionItemsForUser(sessionUser.id);
      if (!existing.length) {
        json(res, 400, { ok: false, error: "Your collection is already empty" });
        return;
      }
      const result = deleteAllCollectionItemsForUser(sessionUser.id);
      if (result.deleted > 0) {
        addActivity(
          "deleted",
          null,
          `Cleared personal collection (${result.deleted} item(s))`,
          sessionUser.id
        );
      }
      await persistStore();
      json(res, 200, { ok: true, ...result });
    } catch (err) {
      json(res, 400, { ok: false, error: err.message || "Could not clear collection" });
    }
    return;
  }

  if (pathname === "/api/collection/undo-delete-all" && req.method === "POST") {
    try {
      const sessionUser = requireSignedInUser(req, res);
      if (!sessionUser) return;
      const result = restoreAllCollectionItemsForUser(sessionUser.id);
      if (result.error) {
        json(res, 400, { ok: false, error: result.error });
        return;
      }
      if (result.restored > 0) {
        addActivity(
          "created",
          null,
          `Restored personal collection (${result.restored} item(s))`,
          sessionUser.id
        );
      }
      await persistStore();
      json(res, 200, { ok: true, ...result });
    } catch (err) {
      json(res, 400, { ok: false, error: err.message || "Could not restore collection" });
    }
    return;
  }

  if (pathname === "/api/poke-view/watchlist" && req.method === "GET") {
    const sessionUser = requireSignedInUser(req, res);
    if (!sessionUser) return;
    json(res, 200, {
      ok: true,
      cards: getPokeViewWatchlistForUser(sessionUser.id)
    });
    return;
  }

  if (pathname === "/api/poke-view/watchlist" && (req.method === "PUT" || req.method === "POST")) {
    try {
      const sessionUser = requireSignedInUser(req, res);
      if (!sessionUser) return;
      const body = await readBody(req);
      const cards = setPokeViewWatchlistForUser(sessionUser.id, body?.cards);
      await persistStore();
      json(res, 200, { ok: true, cards });
    } catch (err) {
      json(res, 400, { ok: false, error: err.message || "Could not save watchlist" });
    }
    return;
  }

  if (pathname === "/api/items" && req.method === "GET") {
    try {
      const sessionUser = requireSignedInUser(req, res);
      if (!sessionUser) return;
      const type = parsedUrl.searchParams.get("type");
      const syncPrices = parsedUrl.searchParams.get("syncPrices") !== "0";
      if (syncPrices) {
        const needsPrice = getCollectionItemsForUser(sessionUser.id).some(
          (item) =>
            item.type === "single" &&
            !(Number(item.manualPrice) > 0) &&
            !(Number(item.marketPrice) > 0) &&
            String(item.setName || "").trim() &&
            String(item.cardNumber || "").trim()
        );
        if (needsPrice) {
          const sync = await syncCollectionPricesFromSets(sessionUser.id);
          if (sync.updated > 0) await persistStore();
        }
      }
      let list = getCollectionItemsForUser(sessionUser.id);
      if (type) list = list.filter((item) => item.type === type);
      json(res, 200, { items: list });
    } catch (err) {
      json(res, 500, { error: err.message || "Failed to load items" });
    }
    return;
  }

  if (pathname === "/api/sets/images" && req.method === "GET") {
    try {
      const manifest = await getSetImageManifestCached();
      json(
        res,
        200,
        {
          ok: true,
          folder: "backend/data/set-images",
          namingHint: "Use {setCode}/cover.png (preferred) or legacy {setCode}.png / {setCode}--{set-name}.jpg",
          ...manifest
        },
        { "Cache-Control": API_CATALOG_CACHE_CONTROL }
      );
    } catch (err) {
      json(res, 500, { ok: false, error: err.message || "Failed to load set images" });
    }
    return;
  }

  if (pathname === "/api/sets/card-sky-urls" && req.method === "GET") {
    try {
      const limit = parsedUrl.searchParams.get("limit") || "250";
      const localOnly =
        parsedUrl.searchParams.get("localOnly") === "1" ||
        parsedUrl.searchParams.get("source") === "disk";
      const setCodesRaw = parsedUrl.searchParams.get("setCodes") || parsedUrl.searchParams.get("sets") || "";
      const setCodeFilter = setCodesRaw
        .split(",")
        .map((s) => String(s || "").trim().toUpperCase())
        .filter(Boolean);
      const diskIndex = await getLocalCardImageIndex();
      let urls;
      if (diskIndex && diskIndex.size > 0 && (localOnly || String(limit).trim().toLowerCase() === "all")) {
        urls = collectCardSkyUrlsFromDiskIndex(
          diskIndex,
          limit,
          setCodeFilter.length ? setCodeFilter : null
        );
      } else if (localOnly || String(limit).trim().toLowerCase() === "all") {
        // No local card-images tree (e.g. Cloudflare + R2): synthesize from catalog card numbers.
        const parsed = await loadSetCardListsParsed();
        urls = collectCardSkyUrlsFromParsed(
          parsed,
          limit,
          null,
          setCodeFilter.length ? setCodeFilter : null
        );
      } else {
        const parsed = await loadSetCardListsParsed();
        urls = collectCardSkyUrlsFromParsed(
          parsed,
          limit,
          diskIndex,
          setCodeFilter.length ? setCodeFilter : null
        );
      }
      json(
        res,
        200,
        { ok: true, count: urls.length, urls },
        {
          "Cache-Control":
            localOnly || String(limit).trim().toLowerCase() === "all"
              ? "no-store"
              : API_CATALOG_CACHE_CONTROL
        }
      );
    } catch (err) {
      json(res, 500, { ok: false, error: err.message || "Failed to load card sky URLs" });
    }
    return;
  }

  if (pathname === "/api/sets/cards" && req.method === "GET") {
    try {
      const language = parsedUrl.searchParams.get("language") || parsedUrl.searchParams.get("lang") || "english";
      const setCode = parsedUrl.searchParams.get("setCode") || parsedUrl.searchParams.get("code") || "";
      const manifest = await getSetCardManifest(language, setCode);
      json(res, 200, manifest, { "Cache-Control": API_CATALOG_CACHE_CONTROL });
    } catch (err) {
      json(res, 500, { ok: false, error: err.message || "Failed to load set cards" });
    }
    return;
  }

  if (pathname === "/api/sets/import-status" && req.method === "GET") {
    try {
      const status = await getSetCardImportStatus();
      const imported = countEnglishSetsInParsed(setCardListsDiskCache.parsed);
      json(res, 200, {
        ok: true,
        imported,
        complete: imported >= MIN_ENGLISH_SETS_FOR_COMPLETE,
        minSetsForComplete: MIN_ENGLISH_SETS_FOR_COMPLETE,
        ...status
      });
    } catch (err) {
      json(res, 500, { ok: false, error: err.message || "Failed to load import status" });
    }
    return;
  }

  if (pathname === "/api/sets/card-details-import-status" && req.method === "GET") {
    try {
      const enriched = await buildCardDetailsImportStatusResponse();
      json(res, 200, { ok: true, ...enriched });
    } catch (err) {
      json(res, 500, { ok: false, error: err.message || "Failed to load card details import status" });
    }
    return;
  }

  if (pathname === "/api/sets/catalog" && req.method === "GET") {
    try {
      const language = parsedUrl.searchParams.get("language") || parsedUrl.searchParams.get("lang") || "english";
      const parsed = await loadSetCardListsParsed();
      const normalizedLanguage = normalizeLanguage(language);
      const languageNode = parsed?.byLanguage?.[normalizedLanguage];
      const catalogByEra =
        languageNode && languageNode.catalogByEra && typeof languageNode.catalogByEra === "object"
          ? languageNode.catalogByEra
          : {};
      json(res, 200, {
        ok: true,
        language: normalizedLanguage,
        generatedAt: parsed?.generatedAt || null,
        catalogByEra
      });
    } catch (err) {
      json(res, 500, { ok: false, error: err.message || "Failed to load set catalog" });
    }
    return;
  }

  if (pathname === "/api/sets/card-details" && req.method === "GET") {
    try {
      const setCode = parsedUrl.searchParams.get("setCode") || parsedUrl.searchParams.get("code") || "";
      const manifest = await getSetCardDetailsManifest(setCode);
      const cacheHeader =
        setCode && manifest.ok
          ? { "Cache-Control": API_CATALOG_CACHE_CONTROL }
          : setCode
            ? {}
            : { "Cache-Control": "no-store" };
      json(res, manifest.ok ? 200 : 500, manifest, cacheHeader);
    } catch (err) {
      json(res, 500, { ok: false, error: err.message || "Failed to load set card details" });
    }
    return;
  }

  if (pathname === "/api/sets/pricing" && req.method === "GET") {
    try {
      const setCode = parsedUrl.searchParams.get("setCode") || parsedUrl.searchParams.get("code") || "";
      const setName = parsedUrl.searchParams.get("setName") || parsedUrl.searchParams.get("name") || "";
      if (!setCode) {
        json(res, 400, { ok: false, error: "setCode is required", byCardNo: {} });
        return;
      }
      const manifest = await getSetCardPricingManifest(setCode, setName);
      json(res, manifest.ok ? 200 : 400, manifest);
    } catch (err) {
      json(res, 500, { ok: false, error: err.message || "Failed to load set pricing", byCardNo: {} });
    }
    return;
  }

  if (pathname === "/api/sets/market-history" && req.method === "GET") {
    try {
      const setCode = parsedUrl.searchParams.get("setCode") || parsedUrl.searchParams.get("code") || "";
      const setName = parsedUrl.searchParams.get("setName") || parsedUrl.searchParams.get("name") || "";
      const cardNo = parsedUrl.searchParams.get("cardNo") || parsedUrl.searchParams.get("number") || "";
      const cardName = parsedUrl.searchParams.get("cardName") || "";
      const range = parsedUrl.searchParams.get("range") || "30";
      const detailRarity = parsedUrl.searchParams.get("rarity") || "";
      const productId = parsedUrl.searchParams.get("productId") || "";
      const tcgplayerUrl = parsedUrl.searchParams.get("tcgplayerUrl") || parsedUrl.searchParams.get("url") || "";
      const sourceFilter = parsedUrl.searchParams.get("source") || "";
      const hasLink = Boolean(extractTcgplayerProductIdFromUrl(tcgplayerUrl) || Number(productId));
      if ((!setCode || !cardNo) && !hasLink && String(sourceFilter).trim().toLowerCase() !== "pricecharting") {
        json(res, 400, {
          ok: false,
          error: "setCode and cardNo, or a TCGplayer product link, is required",
          series: []
        });
        return;
      }
      if (String(sourceFilter).trim().toLowerCase() === "pricecharting" && (!setCode || !cardNo)) {
        json(res, 400, {
          ok: false,
          error: "setCode and cardNo are required for PriceCharting history",
          series: []
        });
        return;
      }
      const payload = await getCardMarketHistoryManifest({
        setCode,
        setName,
        cardNo,
        cardName,
        detailRarity,
        rangeKey: range,
        productId,
        tcgplayerUrl,
        sourceFilter
      });
      json(res, 200, payload);
    } catch (err) {
      json(res, 500, { ok: false, error: err.message || "Failed to load market history", series: [] });
    }
    return;
  }

  if (pathname === "/api/sets/pricecharting-card-details" && req.method === "GET") {
    try {
      const setCode = parsedUrl.searchParams.get("setCode") || parsedUrl.searchParams.get("code") || "";
      const setName = parsedUrl.searchParams.get("setName") || parsedUrl.searchParams.get("name") || "";
      const cardNo = parsedUrl.searchParams.get("cardNo") || parsedUrl.searchParams.get("number") || "";
      const cardName = parsedUrl.searchParams.get("cardName") || "";
      if (!setCode || !cardNo) {
        json(res, 400, {
          ok: false,
          error: "setCode and cardNo are required",
          soldListings: [],
          gradedGuides: []
        });
        return;
      }
      const forceRefresh = String(parsedUrl.searchParams.get("refresh") || "").trim() === "1";
      const cacheOnly = forceRefresh
        ? false
        : String(parsedUrl.searchParams.get("cacheOnly") || "1").trim() !== "0";
      const payload = await getOrFetchPriceChartingCardDetails(
        { setCode, setName, cardNo, cardName },
        { forceRefresh, cacheOnly }
      );
      const status = payload.ok ? 200 : payload.pending ? 202 : 404;
      json(res, status, payload);
    } catch (err) {
      json(res, 500, {
        ok: false,
        error: err.message || "Failed to load PriceCharting card details",
        soldListings: [],
        gradedGuides: []
      });
    }
    return;
  }

  if (pathname === "/api/sets/link-prices" && req.method === "GET") {
    try {
      const setCode = parsedUrl.searchParams.get("setCode") || parsedUrl.searchParams.get("code") || "";
      const setName = parsedUrl.searchParams.get("setName") || parsedUrl.searchParams.get("name") || "";
      if (!setCode) {
        json(res, 400, { ok: false, error: "setCode is required", byUrl: {} });
        return;
      }
      const payload = await buildSetLinkPricesPayload(setCode, setName);
      json(res, 200, payload);
    } catch (err) {
      json(res, 500, { ok: false, error: err.message || "Failed to load set link prices", byUrl: {} });
    }
    return;
  }

  if (pathname === "/api/tcgplayer/link-cache-meta" && req.method === "GET") {
    json(res, 200, { ok: true, ...getTcgLinkCacheMeta() });
    return;
  }

  if (pathname === "/api/tcgplayer/price-from-link" && req.method === "GET") {
    try {
      const url = parsedUrl.searchParams.get("url") || "";
      const forceRefresh = String(parsedUrl.searchParams.get("refresh") || "").trim() === "1";
      const cacheOnly = forceRefresh
        ? false
        : String(parsedUrl.searchParams.get("cacheOnly") || "1").trim() !== "0";
      const setCode = parsedUrl.searchParams.get("setCode") || "";
      const setName = parsedUrl.searchParams.get("setName") || "";
      const cardNo = parsedUrl.searchParams.get("cardNo") || "";
      const cardName = parsedUrl.searchParams.get("cardName") || "";
      const priceChartingContext =
        setCode && cardNo
          ? {
              setCode,
              setName,
              cardNo,
              cardName
            }
          : null;
      if (!url) {
        json(res, 400, { ok: false, error: "url is required", price: null });
        return;
      }
      const resolved = await fetchTcgPriceFromProductLink(url, {
        forceRefresh,
        cacheOnly,
        priceChartingContext
      });
      const status = resolved.ok ? 200 : resolved.pending ? 202 : 502;
      json(res, status, resolved);
    } catch (err) {
      json(res, 500, { ok: false, error: err.message || "Failed to resolve TCGplayer link price", price: null });
    }
    return;
  }

  if (pathname === "/api/tcgplayer/price-guides" && req.method === "GET") {
    try {
      const forceRefresh = String(parsedUrl.searchParams.get("refresh") || "").trim() === "1";
      const rows = await fetchTcgPriceGuideIndex(forceRefresh);
      json(res, 200, {
        ok: true,
        total: rows.length,
        rows
      });
    } catch (err) {
      json(res, 500, { ok: false, error: err.message || "Failed to load TCGplayer price guides", rows: [] });
    }
    return;
  }

  if (pathname === "/api/items" && req.method === "POST") {
    try {
      const sessionUser = requireSignedInUser(req, res);
      if (!sessionUser) return;
      const body = await readBody(req);
      let item = normalizeItem({ ...body, userId: sessionUser.id });
      if (!item.name) {
        json(res, 400, { error: "Name is required" });
        return;
      }
      const lookup = await getShowcaseSetLookup();
      const manifestCache = new Map();
      const priced = await applySetsCatalogPricingToItem(item, lookup, manifestCache);
      item = normalizeItem({ ...priced, userId: sessionUser.id }, item);
      item.userId = sessionUser.id;
      store.items.unshift(item);
      addActivity("created", item.id, `${item.name} added`, sessionUser.id);
      await persistStore();
      json(res, 201, { item });
    } catch (err) {
      json(res, 400, { error: err.message || "Bad request" });
    }
    return;
  }

  if (pathname.startsWith("/api/items/")) {
    const sessionUser = requireSignedInUser(req, res);
    if (!sessionUser) return;
    const id = pathname.split("/").pop();
    const existing = findCollectionItemForUser(id, sessionUser.id);
    if (!existing) {
      notFound(res);
      return;
    }

    if (req.method === "PUT") {
      try {
        const body = await readBody(req);
        const updated = normalizeItem({ ...body, userId: sessionUser.id }, existing);
        updated.userId = sessionUser.id;
        Object.assign(existing, updated);
        addActivity("updated", existing.id, `${existing.name} updated`, sessionUser.id);
        await persistStore();
        json(res, 200, { item: existing });
      } catch (err) {
        json(res, 400, { error: err.message || "Bad request" });
      }
      return;
    }

    if (req.method === "DELETE") {
      store.items = store.items.filter(
        (item) => !(item.id === id && String(item.userId || "") === sessionUser.id)
      );
      addActivity("deleted", id, `${existing.name} removed`, sessionUser.id);
      await persistStore();
      json(res, 200, { ok: true });
      return;
    }

    if (req.method === "POST" && pathname.endsWith("/refresh")) {
      const count = await refreshPrices(id, sessionUser.id);
      addActivity("refreshed", id, `${existing.name} repriced`, sessionUser.id);
      await persistStore();
      json(res, 200, { ok: true, updated: count });
      return;
    }

    json(res, 405, { error: "Method not allowed" });
    return;
  }

  if (pathname === "/api/prices/refresh" && req.method === "POST") {
    try {
      const sessionUser = requireSignedInUser(req, res);
      if (!sessionUser) return;
      const setsSync = await syncCollectionPricesFromSets(sessionUser.id, { force: true });
      const count = await refreshPrices(null, sessionUser.id);
      addActivity(
        "refreshed",
        null,
        `Refreshed ${count} items (${setsSync.priced} from Sets/TCGplayer)`,
        sessionUser.id
      );
      await persistStore();
      json(res, 200, {
        ok: true,
        updated: count,
        pricedFromSets: setsSync.priced,
        refreshedAt: store.refreshedAt
      });
    } catch (err) {
      json(res, 500, { ok: false, error: err.message || "Price refresh failed" });
    }
    return;
  }

  if (pathname === "/api/collection/sync-set-prices" && req.method === "POST") {
    try {
      const sessionUser = requireSignedInUser(req, res);
      if (!sessionUser) return;
      const body = await readBody(req);
      const sync = await syncCollectionPricesFromSets(sessionUser.id, {
        force: body.force === true
      });
      if (sync.updated > 0) {
        addActivity(
          "refreshed",
          null,
          `Imported Sets prices for ${sync.priced} card(s)`,
          sessionUser.id
        );
        await persistStore();
      }
      json(res, 200, { ok: true, ...sync });
    } catch (err) {
      json(res, 500, { ok: false, error: err.message || "Could not sync collection prices" });
    }
    return;
  }

  if (pathname === "/api/card-nicknames" && req.method === "GET") {
    try {
      const nicknames = await getCardNicknamesCached();
      json(res, 200, {
        ok: true,
        nicknames: nicknames.map((row) => publicNicknamePayload(row)).filter(Boolean)
      });
    } catch (err) {
      json(res, 500, { ok: false, error: err.message || "Failed to load card nicknames", nicknames: [] });
    }
    return;
  }

  if (pathname === "/api/dashboard" && req.method === "GET") {
    const sessionUser = requireSignedInUser(req, res);
    if (!sessionUser) return;
    json(res, 200, summarizeDashboard(sessionUser.id));
    return;
  }

  if (pathname === "/api/scan/status" && req.method === "GET") {
    try {
      const status = await pokeScanner.getStatus();
      json(res, 200, status);
    } catch (err) {
      json(res, 500, { ok: false, available: false, error: err.message || "Scanner status failed" });
    }
    return;
  }

  if (pathname === "/api/scan/match" && req.method === "POST") {
    try {
      const body = await readBody(req);
      const limit = Math.min(24, Math.max(1, Number(body.limit) || 8));
      const q = String(body.q || body.query || "").trim();
      if (q) {
        const result = await pokeScanner.searchByText(q, limit);
        json(res, result.ok ? 200 : 503, result);
        return;
      }
      const embedding = pokeScanner.parseEmbeddingBody(body);
      if (embedding) {
        const result = await pokeScanner.searchByEmbedding(embedding, limit);
        json(res, result.ok ? 200 : 503, result);
        return;
      }
      json(res, 400, { ok: false, error: "Provide q (text) or embedding (512 floats / embeddingB64)" });
    } catch (err) {
      json(res, 500, { ok: false, error: err.message || "Scan match failed" });
    }
    return;
  }

  if (pathname === "/api/restock-tracker" && req.method === "GET") {
    try {
      const payload = await getRestockTrackerPayload();
      json(res, 200, payload);
    } catch (err) {
      json(res, 500, { ok: false, error: err.message || "Failed to load restock tracker" });
    }
    return;
  }

  if (pathname === "/api/admin/status" && req.method === "GET") {
    const admin = requireAdmin(req, res);
    if (!admin) return;
    const manualItems = await loadRestockManualItems(RESTOCK_MANUAL_ITEMS_FILE);
    const restockFileMeta = await readRestockTrackerMeta();
    const restockRetailers = await listRestockRetailers();
    const tcgLive = syncTcgBulkPriceCheckCacheCount();
    json(res, 200, {
      ok: true,
      user: admin.sessionUser,
      tcgPriceCache: {
        ...tcgBulkPriceCheckMeta,
        ...tcgLive,
        prewarm: tcgLinkPricePrewarmStatus,
        inFlight: isTcgBulkPriceCheckInFlight(),
        logicVersion: TCG_LINK_PRICE_LOGIC_VERSION,
        failLinkCount: tcgLinkPriceFailLinks.size
      },
      priceChartingCache: getPriceChartingAdminMeta(),
      restock: {
        manualItemCount: manualItems.length,
        trackerFile: RESTOCK_TRACKER_FILE,
        inFlight: restockRefreshInFlight,
        itemCount: restockFileMeta.itemCount || restockRefreshMeta.itemCount || 0,
        importedAt: restockFileMeta.importedAt || null,
        autoRefreshedAt: restockRefreshMeta.autoRefreshedAt || restockFileMeta.autoRefreshedAt || null,
        lastStartedAt: restockRefreshMeta.lastStartedAt,
        lastFinishedAt: restockRefreshMeta.lastFinishedAt,
        lastError: restockRefreshMeta.lastError,
        lastInStockStamped: restockRefreshMeta.lastInStockStamped,
        lastAmazonStatusUpdates: restockRefreshMeta.lastAmazonStatusUpdates,
        lastPriceUpdates: restockRefreshMeta.lastPriceUpdates,
        lastSmokeStatusUpdates: restockRefreshMeta.lastSmokeStatusUpdates,
        lastSmokePriceUpdates: restockRefreshMeta.lastSmokePriceUpdates,
        lastPokeNeStatusUpdates: restockRefreshMeta.lastPokeNeStatusUpdates,
        lastPokeNePriceUpdates: restockRefreshMeta.lastPokeNePriceUpdates,
        lastSelectedRetailers: restockRefreshMeta.lastSelectedRetailers || null,
        retailers: restockRetailers,
        progress: restockRefreshMeta.progress || null
      },
      site: {
        userCount: store.users.length,
        collectionItemCount: store.items.length,
        activityCount: store.activities.length,
        refreshedAt: store.refreshedAt,
        cardNicknameCount: (await getCardNicknamesCached()).length
      }
    });
    return;
  }

  if (pathname === "/api/admin/tcg-price-check" && req.method === "GET") {
    const admin = requireAdmin(req, res);
    if (!admin) return;
    const live = syncTcgBulkPriceCheckCacheCount();
    json(res, 200, {
      ok: true,
      meta: {
        ...tcgBulkPriceCheckMeta,
        ...live,
        failLinkCount: tcgLinkPriceFailLinks.size
      },
      prewarm: tcgLinkPricePrewarmStatus,
      inFlight: isTcgBulkPriceCheckInFlight()
    });
    return;
  }

  if (pathname === "/api/admin/tcg-price-check/sets" && req.method === "GET") {
    const admin = requireAdmin(req, res);
    if (!admin) return;
    const sets = await listEnglishSetPricingTargets();
    json(res, 200, {
      ok: true,
      sets: sets
        .filter((row) => row.setCode)
        .sort((a, b) => String(a.setName || a.setCode).localeCompare(String(b.setName || b.setCode)))
    });
    return;
  }

  if (pathname === "/api/admin/tcg-price-check/run" && req.method === "POST") {
    const admin = requireAdmin(req, res);
    if (!admin) return;
    if (isTcgBulkPriceCheckInFlight()) {
      json(res, 409, {
        ok: false,
        error: "A TCG price check is already running. Wait for it to finish or click Stop.",
        meta: tcgBulkPriceCheckMeta,
        inFlight: true
      });
      return;
    }
    const label = admin.sessionUser.username || admin.sessionUser.name || admin.sessionUser.email;
    runAdminBulkTcgPriceCheck(label).catch(() => {});
    json(res, 202, {
      ok: true,
      message: "Bulk TCG price check started",
      meta: tcgBulkPriceCheckMeta,
      inFlight: true
    });
    return;
  }

  if (pathname === "/api/admin/tcg-price-check/run-set" && req.method === "POST") {
    const admin = requireAdmin(req, res);
    if (!admin) return;
    if (isTcgBulkPriceCheckInFlight()) {
      json(res, 409, {
        ok: false,
        error: "A TCG price check is already running. Wait for it to finish or click Stop.",
        meta: tcgBulkPriceCheckMeta,
        inFlight: true
      });
      return;
    }
    try {
      const parsed = (await readBody(req)) || {};
      const setCode = String(parsed.setCode || "").trim().toUpperCase();
      const setName = String(parsed.setName || "").trim();
      if (!setCode) {
        json(res, 400, { ok: false, error: "setCode is required" });
        return;
      }
      const label = admin.sessionUser.username || admin.sessionUser.name || admin.sessionUser.email;
      runAdminTcgPriceCheckForSet(setCode, setName, label).catch(() => {});
      json(res, 202, {
        ok: true,
        message: `TCG price check started for ${setCode}`,
        meta: tcgBulkPriceCheckMeta,
        inFlight: true
      });
    } catch (err) {
      json(res, 400, { ok: false, error: err.message || "Failed to start set price check" });
    }
    return;
  }

  if (pathname === "/api/admin/tcg-price-check/stop" && req.method === "POST") {
    const admin = requireAdmin(req, res);
    if (!admin) return;
    const stop = requestStopTcgPriceCheck();
    if (!stop.ok) {
      json(res, 409, {
        ok: false,
        error: "No TCG price check is running",
        meta: tcgBulkPriceCheckMeta
      });
      return;
    }
    json(res, 202, {
      ok: true,
      message: "Stop requested; workers will finish after current requests",
      meta: tcgBulkPriceCheckMeta,
      stopRequested: true
    });
    return;
  }

  if (pathname === "/api/admin/pricecharting-details" && req.method === "GET") {
    const admin = requireAdmin(req, res);
    if (!admin) return;
    json(res, 200, {
      ok: true,
      meta: getPriceChartingAdminMeta(),
      inFlight: isPriceChartingDetailsPrewarmInFlight()
    });
    return;
  }

  if (pathname === "/api/admin/pricecharting-details/run" && req.method === "POST") {
    const admin = requireAdmin(req, res);
    if (!admin) return;
    if (isPriceChartingDetailsPrewarmInFlight()) {
      json(res, 409, {
        ok: false,
        error: "A PriceCharting details refresh is already running.",
        meta: getPriceChartingAdminMeta(),
        inFlight: true
      });
      return;
    }
    const label = admin.sessionUser.username || admin.sessionUser.name || admin.sessionUser.email;
    runPriceChartingDetailsPrewarmBackground(label);
    json(res, 202, {
      ok: true,
      message: "PriceCharting details refresh started",
      meta: getPriceChartingAdminMeta(),
      inFlight: true
    });
    return;
  }

  if (pathname === "/api/admin/pricecharting-details/run-set" && req.method === "POST") {
    const admin = requireAdmin(req, res);
    if (!admin) return;
    if (isPriceChartingDetailsPrewarmInFlight()) {
      json(res, 409, {
        ok: false,
        error: "A PriceCharting details refresh is already running.",
        meta: getPriceChartingAdminMeta(),
        inFlight: true
      });
      return;
    }
    try {
      const parsed = (await readBody(req)) || {};
      const setCode = String(parsed.setCode || "").trim().toUpperCase();
      const setName = String(parsed.setName || "").trim();
      if (!setCode) {
        json(res, 400, { ok: false, error: "setCode is required" });
        return;
      }
      const label = admin.sessionUser.username || admin.sessionUser.name || admin.sessionUser.email;
      runPriceChartingDetailsPrewarmBackground(label, { setCode, setName });
      json(res, 202, {
        ok: true,
        message: `PriceCharting details refresh started for ${setCode}`,
        meta: getPriceChartingAdminMeta(),
        inFlight: true
      });
    } catch (err) {
      json(res, 400, { ok: false, error: err.message || "Failed to start set PriceCharting refresh" });
    }
    return;
  }

  if (pathname === "/api/admin/pricecharting-details/stop" && req.method === "POST") {
    const admin = requireAdmin(req, res);
    if (!admin) return;
    const stop = requestStopPriceChartingDetailsCheck();
    if (!stop.ok) {
      json(res, 409, {
        ok: false,
        error: "No PriceCharting details refresh is running",
        meta: getPriceChartingAdminMeta()
      });
      return;
    }
    json(res, 202, {
      ok: true,
      message: "Stop requested; PriceCharting workers will finish after current requests",
      meta: getPriceChartingAdminMeta(),
      stopRequested: true
    });
    return;
  }

  if (pathname === "/api/admin/pricecharting-details/fail-links" && req.method === "GET") {
    const admin = requireAdmin(req, res);
    if (!admin) return;
    const links = getPriceChartingFailLinksList();
    json(res, 200, { ok: true, count: links.length, links });
    return;
  }

  if (pathname === "/api/admin/pricecharting-details/fail-links/dismiss" && req.method === "POST") {
    const admin = requireAdmin(req, res);
    if (!admin) return;
    try {
      const parsed = (await readBody(req)) || {};
      const removed = removePriceChartingFailLink(parsed.setCode, parsed.cardNo);
      if (removed) await flushPersistPriceChartingFailLinks();
      json(res, 200, { ok: true, removed, failLinkCount: priceChartingFailLinks.size });
    } catch (err) {
      json(res, 400, { ok: false, error: err.message || "Failed to dismiss link" });
    }
    return;
  }

  if (pathname === "/api/admin/pricecharting-details/fail-links/resolve" && req.method === "POST") {
    const admin = requireAdmin(req, res);
    if (!admin) return;
    try {
      const parsed = (await readBody(req)) || {};
      const setCode = String(parsed.setCode || "").trim().toUpperCase();
      const cardNo = String(parsed.cardNo || "").trim();
      const productUrl = String(
        parsed.productUrl || parsed.priceUrl || parsed.priceLink || parsed.link || ""
      ).trim();
      if (!setCode || !cardNo) {
        json(res, 400, { ok: false, error: "setCode and cardNo are required" });
        return;
      }
      if (!isPriceChartingProductUrl(productUrl)) {
        json(res, 400, { ok: false, error: "Paste a PriceCharting product page URL" });
        return;
      }
      const failRow = priceChartingFailLinks.get(priceChartingFailLinkKey(setCode, cardNo)) || {};
      const details = await fetchPriceChartingCardDetailsFromProductUrl(productUrl, {
        cardName: String(parsed.cardName || failRow.cardName || "").trim(),
        cardNo
      });
      if (!details?.ok) {
        json(res, 400, {
          ok: false,
          error: details?.error || "Could not load PriceCharting details from that URL"
        });
        return;
      }
      const written = writeCachedCardDetails(setCode, cardNo, details);
      if (!written) {
        json(res, 400, { ok: false, error: "Could not write PriceCharting details to cache" });
        return;
      }
      removePriceChartingFailLink(setCode, cardNo);
      await persistPriceChartingCardDetailsCacheNow();
      await flushPersistPriceChartingFailLinks();
      const meta = getPriceChartingCardDetailsCacheMeta();
      json(res, 200, {
        ok: true,
        setCode,
        cardNo,
        productUrl: details.productUrl,
        soldListings: Array.isArray(details.soldListings) ? details.soldListings.length : 0,
        gradedGuides: Array.isArray(details.gradedGuides) ? details.gradedGuides.length : 0,
        failLinkCount: priceChartingFailLinks.size,
        ...meta
      });
    } catch (err) {
      json(res, 400, { ok: false, error: err.message || "Failed to save PriceCharting details" });
    }
    return;
  }

  if (pathname === "/api/admin/pricecharting-details/fail-links/clear" && req.method === "POST") {
    const admin = requireAdmin(req, res);
    if (!admin) return;
    try {
      await clearPriceChartingFailLinks();
      json(res, 200, { ok: true, failLinkCount: 0, links: [] });
    } catch (err) {
      json(res, 500, { ok: false, error: err.message || "Failed to clear PriceCharting fail links" });
    }
    return;
  }

  if (pathname === "/api/admin/tcg-price-check/fail-links" && req.method === "GET") {
    const admin = requireAdmin(req, res);
    if (!admin) return;
    const links = getTcgLinkPriceFailLinksList();
    json(res, 200, { ok: true, count: links.length, links });
    return;
  }

  if (pathname === "/api/admin/tcg-price-check/fail-links/prune-non-pokemon" && req.method === "POST") {
    const admin = requireAdmin(req, res);
    if (!admin) return;
    try {
      const parsed = (await readBody(req)) || {};
      const result = await pruneNonPokemonTcgFailLinks({
        concurrency: Number(parsed.concurrency) || 4,
        max: Number(parsed.max) || 300
      });
      json(res, 200, {
        ok: true,
        ...result,
        failLinkCount: tcgLinkPriceFailLinks.size,
        links: getTcgLinkPriceFailLinksList()
      });
    } catch (err) {
      json(res, 500, { ok: false, error: err.message || "Failed to prune non-Pokemon fail links" });
    }
    return;
  }

  if (pathname === "/api/admin/tcg-price-check/fail-links/resolve" && req.method === "POST") {
    const admin = requireAdmin(req, res);
    if (!admin) return;
    try {
      const parsed = (await readBody(req)) || {};
      const url = normalizeTcgFailLinkUrl(parsed.url || parsed.tcgplayerUrl || "");
      if (!url) {
        json(res, 400, { ok: false, error: "url is required" });
        return;
      }
      const priceUrl = String(
        parsed.priceUrl || parsed.priceLink || parsed.sourceUrl || parsed.link || ""
      ).trim();
      const entry = priceUrl
        ? await resolveFailLinkPriceFromSourceUrl(url, priceUrl)
        : storeManualTcgLinkPriceForUrl(url, parsed.listingPrice ?? parsed.nearMintPrice, parsed.shippingPrice);
      await enqueuePersistTcgLinkPriceCacheNow();
      await flushPersistTcgLinkPriceFailLinks();
      json(res, 200, {
        ok: true,
        url,
        nearMintWithShipping: entry.nearMintWithShipping,
        totalPrice: entry.totalPrice,
        failLinkCount: tcgLinkPriceFailLinks.size
      });
    } catch (err) {
      json(res, 400, { ok: false, error: err.message || "Failed to save manual price" });
    }
    return;
  }

  if (pathname === "/api/admin/tcg-price-check/fail-links/dismiss" && req.method === "POST") {
    const admin = requireAdmin(req, res);
    if (!admin) return;
    try {
      const parsed = (await readBody(req)) || {};
      const url = normalizeTcgFailLinkUrl(parsed.url || parsed.tcgplayerUrl || "");
      const productId = Number(parsed.productId) || null;
      if (!url && !productId) {
        json(res, 400, { ok: false, failed: false, error: "url or productId is required" });
        return;
      }
      const removed = removeTcgLinkPriceFailLink(url, productId);
      if (removed) await flushPersistTcgLinkPriceFailLinks();
      json(res, 200, { ok: true, removed, failLinkCount: tcgLinkPriceFailLinks.size });
    } catch (err) {
      json(res, 400, { ok: false, error: err.message || "Failed to dismiss link" });
    }
    return;
  }

  if (pathname === "/api/admin/restock/manual-items" && req.method === "GET") {
    const admin = requireAdmin(req, res);
    if (!admin) return;
    const items = await loadRestockManualItems(RESTOCK_MANUAL_ITEMS_FILE);
    json(res, 200, { ok: true, items });
    return;
  }

  if (pathname === "/api/admin/restock/manual-items" && req.method === "POST") {
    const admin = requireAdmin(req, res);
    if (!admin) return;
    try {
      const body = await readBody(req);
      const item = await addRestockManualItem(RESTOCK_MANUAL_ITEMS_FILE, {
        name: body.name,
        productUrl: body.productUrl,
        retailer: body.retailer,
        status: body.status,
        lastPrice: body.lastPrice,
        addedBy: admin.sessionUser.username || admin.sessionUser.name
      });
      json(res, 201, { ok: true, item });
    } catch (err) {
      json(res, 400, { ok: false, error: err.message || "Failed to add restock item" });
    }
    return;
  }

  if (pathname === "/api/admin/card-nicknames" && req.method === "GET") {
    const admin = requireAdmin(req, res);
    if (!admin) return;
    const nicknames = await getCardNicknamesCached();
    json(res, 200, { ok: true, nicknames });
    return;
  }

  if (pathname === "/api/admin/card-nicknames" && req.method === "POST") {
    const admin = requireAdmin(req, res);
    if (!admin) return;
    try {
      const body = await readBody(req);
      const entry = await addCardNickname(CARD_NICKNAMES_FILE, body);
      invalidateCardNicknamesCache();
      json(res, 201, { ok: true, nickname: entry });
    } catch (err) {
      json(res, 400, { ok: false, error: err.message || "Failed to add card nickname" });
    }
    return;
  }

  const adminNicknameDeleteMatch = pathname.match(/^\/api\/admin\/card-nicknames\/([^/]+)$/);
  if (adminNicknameDeleteMatch && req.method === "DELETE") {
    const admin = requireAdmin(req, res);
    if (!admin) return;
    try {
      const result = await removeCardNickname(CARD_NICKNAMES_FILE, adminNicknameDeleteMatch[1]);
      invalidateCardNicknamesCache();
      json(res, 200, { ok: true, ...result });
    } catch (err) {
      json(res, 404, { ok: false, error: err.message || "Failed to remove nickname" });
    }
    return;
  }

  const adminRestockDeleteMatch = pathname.match(/^\/api\/admin\/restock\/manual-items\/([^/]+)$/);
  if (adminRestockDeleteMatch && req.method === "DELETE") {
    const admin = requireAdmin(req, res);
    if (!admin) return;
    try {
      const result = await removeRestockManualItem(RESTOCK_MANUAL_ITEMS_FILE, adminRestockDeleteMatch[1]);
      json(res, 200, { ok: true, ...result });
    } catch (err) {
      json(res, 404, { ok: false, error: err.message || "Failed to remove item" });
    }
    return;
  }

  if (pathname === "/api/admin/restock/refresh" && req.method === "POST") {
    const admin = requireAdmin(req, res);
    if (!admin) return;
    if (restockRefreshInFlight) {
      json(res, 409, {
        ok: false,
        error: "Restock refresh already in progress",
        inFlight: true,
        meta: restockRefreshMeta
      });
      return;
    }
    const body = await readBody(req);
    let retailers = null;
    if (Object.prototype.hasOwnProperty.call(body || {}, "retailers")) {
      if (!Array.isArray(body.retailers) || body.retailers.length === 0) {
        json(res, 400, { ok: false, error: "Select at least one retailer to refresh" });
        return;
      }
      retailers = normalizeRestockRetailerSelection(body.retailers);
      if (!retailers) {
        json(res, 400, { ok: false, error: "Select at least one retailer to refresh" });
        return;
      }
    }
    refreshRestockTrackerHourlyTick({ retailers }).catch(() => {});
    json(res, 202, {
      ok: true,
      message: retailers
        ? `Restock tracker refresh started (${retailers.join(", ")})`
        : "Restock tracker refresh started",
      inFlight: true,
      retailers,
      meta: restockRefreshMeta
    });
    return;
  }

  if (pathname === "/api/admin/restock/stop" && req.method === "POST") {
    const admin = requireAdmin(req, res);
    if (!admin) return;
    if (!restockRefreshInFlight) {
      json(res, 200, {
        ok: true,
        stopped: false,
        message: "No restock refresh is running",
        inFlight: false,
        meta: restockRefreshMeta
      });
      return;
    }
    requestRestockRefreshCancel();
    json(res, 200, {
      ok: true,
      stopped: true,
      message: "Stop requested. Finishing the current restock check…",
      inFlight: true,
      meta: restockRefreshMeta
    });
    return;
  }

  if (pathname === "/api/admin/activities/clear" && req.method === "POST") {
    const admin = requireAdmin(req, res);
    if (!admin) return;
    const removed = store.activities.length;
    store.activities = [];
    await persistStore();
    json(res, 200, { ok: true, removed });
    return;
  }

  if (pathname === "/api/admin/users" && req.method === "GET") {
    const admin = requireAdmin(req, res);
    if (!admin) return;
    json(res, 200, {
      ok: true,
      users: store.users.map((user) =>
        withAdminFlag(
          {
            id: user.id,
            email: user.email,
            username: user.username || "",
            name: user.name || "",
            role: user.role || "",
            hasPassword: Boolean(user.passwordHash),
            createdAt: user.createdAt || null,
            lastLoginAt: user.lastLoginAt || null
          },
          adminUsernames
        )
      )
    });
    return;
  }

  const adminUserEditMatch = pathname.match(/^\/api\/admin\/users\/([^/]+)$/);
  if (adminUserEditMatch && (req.method === "PATCH" || req.method === "POST")) {
    const admin = requireAdmin(req, res);
    if (!admin) return;
    try {
      const body = await readBody(req);
      const target = store.users.find((entry) => entry.id === adminUserEditMatch[1]);
      if (!target) {
        json(res, 404, { ok: false, error: "User not found" });
        return;
      }

      if (Object.prototype.hasOwnProperty.call(body, "username")) {
        const username = normalizeUsername(body.username);
        if (!isValidUsername(username)) {
          json(res, 400, {
            ok: false,
            error: "Username must be 3-24 characters (letters, numbers, underscore)"
          });
          return;
        }
        const taken = store.users.some(
          (u) => u.id !== target.id && normalizeUsername(u.username) === username
        );
        if (taken) {
          json(res, 409, { ok: false, error: "Username already taken" });
          return;
        }
        target.username = username;
      }

      if (Object.prototype.hasOwnProperty.call(body, "email")) {
        const email = normalizeEmail(body.email);
        if (!email || !email.includes("@")) {
          json(res, 400, { ok: false, error: "Valid email is required" });
          return;
        }
        const taken = store.users.some(
          (u) => u.id !== target.id && normalizeEmail(u.email) === email
        );
        if (taken) {
          json(res, 409, { ok: false, error: "Email already in use" });
          return;
        }
        target.email = email;
      }

      if (Object.prototype.hasOwnProperty.call(body, "name")) {
        target.name = String(body.name ?? "").trim().slice(0, 80);
      }

      ensureDefaultAdminRoles(store, adminUsernames);
      await persistStore();
      json(res, 200, {
        ok: true,
        user: withAdminFlag(
          {
            id: target.id,
            email: target.email,
            username: target.username || "",
            name: target.name || "",
            role: target.role || "",
            hasPassword: Boolean(target.passwordHash),
            createdAt: target.createdAt || null,
            lastLoginAt: target.lastLoginAt || null
          },
          adminUsernames
        )
      });
    } catch (err) {
      json(res, 400, { ok: false, error: err.message || "Failed to update user" });
    }
    return;
  }

  const adminUserRoleMatch = pathname.match(/^\/api\/admin\/users\/([^/]+)\/role$/);
  if (adminUserRoleMatch && req.method === "POST") {
    const admin = requireAdmin(req, res);
    if (!admin) return;
    try {
      const body = await readBody(req);
      const role = String(body.role || "").trim().toLowerCase();
      if (!["admin", "user", ""].includes(role)) {
        json(res, 400, { ok: false, error: "Role must be admin or user" });
        return;
      }
      const target = store.users.find((entry) => entry.id === adminUserRoleMatch[1]);
      if (!target) {
        json(res, 404, { ok: false, error: "User not found" });
        return;
      }
      if (role) target.role = role;
      else delete target.role;
      await persistStore();
      json(res, 200, { ok: true, user: publicUserPayload(target) });
    } catch (err) {
      json(res, 400, { ok: false, error: err.message || "Failed to update role" });
    }
    return;
  }

  if (pathname === "/api/pokesymbols/by-code" && req.method === "GET") {
    try {
      const parsed = await getPokesymbolsManifestCached();
      json(
        res,
        200,
        {
          ok: true,
          source: parsed.source,
          generatedAt: parsed.generatedAt,
          symbolCount: parsed.symbolCount,
          byCode: parsed.byCode && typeof parsed.byCode === "object" ? parsed.byCode : {}
        },
        { "Cache-Control": POKESYMBOLS_JSON_CACHE_CONTROL }
      );
    } catch {
      json(
        res,
        200,
        {
          ok: false,
          source: "https://pokesymbols.com/tcg/sets",
          byCode: {},
          message: "Run: node backend/scripts/download-pokesymbols-set-art.js"
        },
        { "Cache-Control": POKESYMBOLS_JSON_CACHE_CONTROL }
      );
    }
    return;
  }

  if (pathname === "/api/pokesymbols/manifest" && req.method === "GET") {
    try {
      const parsed = await getPokesymbolsManifestCached();
      json(res, 200, { ok: true, ...parsed }, { "Cache-Control": POKESYMBOLS_JSON_CACHE_CONTROL });
    } catch {
      json(
        res,
        200,
        {
          ok: false,
          source: "https://pokesymbols.com/tcg/sets",
          byCode: {},
          bySlug: {},
          message: "Run: node backend/scripts/download-pokesymbols-set-art.js"
        },
        { "Cache-Control": POKESYMBOLS_JSON_CACHE_CONTROL }
      );
    }
    return;
  }

  if (pathname.startsWith("/pokesymbols/") && req.method === "GET") {
    await sendImageFromDir(res, pathname, "pokesymbols", POKESYMBOLS_DIR);
    return;
  }

  if (pathname.startsWith("/set-images/") && req.method === "GET") {
    await sendImageFromDir(res, pathname, "set-images", SET_IMAGE_DIR);
    return;
  }

  if (pathname.startsWith("/card-images/") && req.method === "GET") {
    await sendImageFromDir(res, pathname, "card-images", CARD_IMAGE_DIR);
    return;
  }

  if (pathname.startsWith("/card-images-japanese/") && req.method === "GET") {
    await sendImageFromDir(res, pathname, "card-images-japanese", CARD_IMAGE_JAPANESE_DIR);
    return;
  }

  if (pathname.startsWith("/showcase-avatars/") && req.method === "GET") {
    await sendImageFromDir(res, pathname, "showcase-avatars", SHOWCASE_AVATAR_DIR);
    return;
  }

  const showcasePageMatch = pathname.match(/^\/showcase\/@?([a-z0-9_]{3,24})\/?$/i);
  if (showcasePageMatch && req.method === "GET") {
    sendStatic(req, res, "/showcase.html");
    return;
  }

  if ((pathname === "/showcase" || pathname === "/showcase/") && req.method === "GET") {
    sendStatic(req, res, "/showcase.html");
    return;
  }

  if (isAdminPagePath(pathname) && req.method === "GET") {
    if (!isRequestAdmin(req)) {
      redirectHome(res);
      return;
    }
    sendPrivateAdminFile(res, "admin.html", "text/html; charset=utf-8");
    return;
  }

  if (isAdminDeniedPath(pathname) && req.method === "GET") {
    if (!isRequestAdmin(req)) {
      redirectHome(res);
      return;
    }
    sendPrivateAdminFile(res, "admin.html", "text/html; charset=utf-8");
    return;
  }

  if (isAdminScriptPath(pathname) && req.method === "GET") {
    if (!isRequestAdmin(req)) {
      notFound(res);
      return;
    }
    sendPrivateAdminFile(res, "admin.js", "application/javascript; charset=utf-8");
    return;
  }

  sendStatic(req, res, pathname);
}

async function startDeferredBackgroundWork() {
  markTcgCatalogPriorityWindow(TCG_CATALOG_PRIORITY_MS);
  startRestockHourlyRefreshLoop();
  startTcgLinkPriceHourlyRefreshLoop();
  setTimeout(() => {
    maybeKickoffEnglishSetCardsImport();
    maybeKickoffEnglishSetDetailsImport();
  }, SET_CATALOG_IMPORT_KICKOFF_DELAY_MS);
}

async function bootstrapServer({ hosted = false } = {}) {
  loadEnvFile();
  setPricingCacheR2Env(env);
  markTcgCatalogPriorityWindow(TCG_CATALOG_PRIORITY_MS);
  await ensureStore();
  if (hosted) {
    // Defer all heavy catalog / cache IO so Passenger can start immediately.
    setImmediate(() => {
      warmSetCardListsMemoryFromDisk({ skipDiskIndex: true }).catch((err) => {
        console.warn(`[startup] Deferred set lists warm failed: ${err.message}`);
      });
      warmSetCardDetailsFromDisk().catch((err) => {
        console.warn(`[startup] Deferred card details warm failed: ${err.message}`);
      });
      loadPersistedTcgLinkPriceCache().catch(() => {});
      loadPersistedPriceChartingCardDetailsCache().catch(() => {});
      loadPersistedPriceChartingMarketHistoryCache().catch(() => {});
      loadPersistedTcgLinkPriceFailLinks()
        .then(() => pruneNonPokemonTcgFailLinks({ concurrency: 4, max: 300 }))
        .then((result) => {
          if (result?.removed > 0) {
            console.log(
              `[pricing-cache] pruned ${result.removed} non-Pokemon fail link(s); ${result.kept} kept`
            );
          }
        })
        .catch(() => {});
      loadPersistedPriceChartingFailLinks().catch(() => {});
      getPokesymbolsManifestCached().catch(() => {});
      getLocalCardImageIndex().catch((err) => {
        console.warn(`[startup] Deferred image index failed: ${err.message}`);
      });
      materializeDirectoryIfNeeded(SET_IMAGE_DIR, { label: "set-images" }).catch((err) => {
        console.warn(`[startup] Deferred set-image LFS materialize failed: ${err.message}`);
      });
      if (!isSelfHosted()) {
        hydratePokesymbolsFromCdnIfNeeded(POKESYMBOLS_DIR, { label: "pokesymbols" }).catch((err) => {
          console.warn(`[startup] Deferred pokesymbols CDN hydrate failed: ${err.message}`);
        });
      }
    });
    return;
  }
  await warmSetCardListsMemoryFromDisk();
  await warmSetCardDetailsFromDisk();
  await loadPersistedTcgLinkPriceCache().catch(() => {});
  await loadPersistedPriceChartingCardDetailsCache().catch(() => {});
  await loadPersistedPriceChartingMarketHistoryCache().catch(() => {});
  await loadPersistedTcgLinkPriceFailLinks().catch(() => {});
  loadPersistedPriceChartingFailLinks().catch(() => {});
  pruneNonPokemonTcgFailLinks({ concurrency: 4, max: 300 })
    .then((result) => {
      if (result?.removed > 0) {
        console.log(
          `[pricing-cache] pruned ${result.removed} non-Pokemon fail link(s); ${result.kept} kept`
        );
      }
    })
    .catch(() => {});
  getPokesymbolsManifestCached().catch(() => {});
  materializeDirectoryIfNeeded(SET_IMAGE_DIR, { label: "set-images" }).catch((err) => {
    console.warn(`[startup] Set-image LFS materialize failed: ${err.message}`);
  });
  if (!isSelfHosted()) {
    hydratePokesymbolsFromCdnIfNeeded(POKESYMBOLS_DIR, { label: "pokesymbols" }).catch((err) => {
      console.warn(`[startup] Pokesymbols CDN hydrate failed: ${err.message}`);
    });
  }
}

function onServerListening() {
  // eslint-disable-next-line no-console
  console.log(`PokemonView running at http://localhost:${PORT}`);
  console.log(
    `[restock-hourly] enabled (interval=${Math.round(RESTOCK_AUTO_REFRESH_MS / 60000)}m)`
  );
  console.log(
    "[startup] TCG link prices serve from disk cache; Admin → Update all re-fetches every link; hourly job refreshes entries older than 24h"
  );
  startDeferredBackgroundWork().catch((err) => {
    console.warn(`[startup] Deferred background work failed: ${err.message}`);
  });
}

function handleRequest(req, res) {
  route(req, res).catch((err) => {
    json(res, 500, { error: err.message || "Server error" });
  });
}

function isPassengerRuntime() {
  // Only true cPanel/Passenger — avoid false positives on PaaS sandboxes.
  return Boolean(
    process.env.PASSENGER_APP_ENV ||
    String(process.env.PHUSION_PASSENGER || "").toLowerCase() === "true" ||
    String(process.env.PHUSION_PASSENGER || "") === "1"
  );
}

function shouldDeferHeavyStartup() {
  if (isPassengerRuntime()) return true;
  const flag = String(process.env.DEFER_HEAVY_STARTUP || "").toLowerCase();
  if (flag === "0" || flag === "false" || flag === "no") return false;
  if (flag === "1" || flag === "true" || flag === "yes") return true;
  // Local dev sets PORT from backend/.env; PaaS injects PORT without a matching .env value.
  return !env.PORT || String(process.env.PORT) !== String(env.PORT);
}

async function bootstrapAfterListen() {
  // Used by app.js when the HTTP port is already bound (Cloudflare Containers cold start).
  await bootstrapServer({ hosted: shouldDeferHeavyStartup() });
  onServerListening();
}

async function startProductionServer() {
  // GoDaddy PaaS injects PORT — never override with backend/.env when already set.
  if (!process.env.PORT && env.PORT) {
    process.env.PORT = String(env.PORT);
  }
  const port = Number(process.env.PORT);
  if (!Number.isFinite(port) || port <= 0) {
    throw new Error(
      `PORT must be set by the host (process.env.PORT). Got: ${JSON.stringify(process.env.PORT)}`
    );
  }
  // eslint-disable-next-line no-console
  console.log(`[startup] Binding to process.env.PORT=${port}`);
  const server = http.createServer(handleRequest);

  await new Promise((resolve, reject) => {
    server.listen(port, "0.0.0.0", () => {
      // eslint-disable-next-line no-console
      console.log(`PokemonView listening on 0.0.0.0:${port}`);
      resolve();
    });
    server.on("error", reject);
  });

  // Listen first so the platform health check passes; warm catalogs in the background.
  bootstrapAfterListen().catch((err) => {
    // eslint-disable-next-line no-console
    console.error("[startup] Bootstrap failed:", err);
  });

  return server;
}

handleRequest.handleRequest = handleRequest;
handleRequest.startProductionServer = startProductionServer;
handleRequest.bootstrapAfterListen = bootstrapAfterListen;
handleRequest.bootstrapServer = bootstrapServer;
handleRequest.onServerListening = onServerListening;
handleRequest.isPassengerRuntime = isPassengerRuntime;
module.exports = handleRequest;

// node backend/server.js (local dev — PORT optional, defaults to 3000)
if (require.main === module) {
  if (!process.env.PORT) process.env.PORT = String(env.PORT || 3000);
  startProductionServer().catch((err) => {
    // eslint-disable-next-line no-console
    console.error(err);
    process.exit(1);
  });
} else if (isPassengerRuntime()) {
  // cPanel Passenger: export handler only; defer heavy startup.
  setImmediate(() => {
    bootstrapServer({ hosted: shouldDeferHeavyStartup() })
      .then(() => onServerListening())
      .catch((err) => {
        // eslint-disable-next-line no-console
        console.error("[startup] Bootstrap failed:", err);
      });
  });
}

