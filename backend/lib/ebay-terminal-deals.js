/**
 * eBay Terminal deal feed — server-side snapshot model (no eBay API required).
 *
 * Flow mirrors Cardboard Terminal's architecture:
 *   upstream Pokémon feed → normalize/enrich → in-memory snapshot (+ disk) → /api/ebay-terminal/deals
 *
 * Upstream default: cardboardterminal.app Pokémon vertical (auctions + BIN).
 * Optional eBay Browse path remains if credentials ever appear.
 */
const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");
const {
  getEbayCredentials,
  searchPokemonListings,
  normalizeEbayItem
} = require("./ebay-browse");

const CARDBOARD_LIVE_URL = "https://cardboardterminal.app/api/live";
const CARDBOARD_BINS_URL = "https://cardboardterminal.app/api/live_bins";
const DATA_DIR = path.join(__dirname, "..", "data");
const SNAPSHOT_FILE = path.join(DATA_DIR, "ebay-terminal-snapshot.json");

const POLL_MS = Math.max(30_000, Number(process.env.EBAY_TERMINAL_POLL_MS) || 45_000);
const UPSTREAM_LIMIT = Math.max(100, Math.min(1000, Number(process.env.EBAY_TERMINAL_UPSTREAM_LIMIT) || 1000));
const FETCH_HEADERS = {
  Accept: "application/json",
  "User-Agent": "PokemonView/1.0 (eBay Terminal deal feed)"
};

/** @type {{ auction: object[], bin: object[], fetchedAt: string|null, source: string, liveTracked: number, error: string }} */
let snapshot = {
  auction: [],
  bin: [],
  fetchedAt: null,
  source: "cardboardterminal",
  liveTracked: 0,
  error: ""
};

let pollTimer = null;
let pollInFlight = null;
let enrichers = {
  getPriceChartingProduct: null,
  getPsaCertData: null
};

const estimateCache = new Map();
const ESTIMATE_TTL_MS = 30 * 60 * 1000;

function cacheGet(map, key) {
  const hit = map.get(key);
  if (!hit) return null;
  if (hit.expiresAt <= Date.now()) {
    map.delete(key);
    return null;
  }
  return hit.value;
}

function cacheSet(map, key, value, ttlMs) {
  map.set(key, { value, expiresAt: Date.now() + ttlMs });
}

function toPenniesDollars(raw) {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Number((n / 100).toFixed(2));
}

function pctOfValue(price, estimate) {
  const p = Number(price);
  const e = Number(estimate);
  if (!Number.isFinite(p) || p < 0 || !Number.isFinite(e) || e <= 0) return null;
  return Math.round((p / e) * 100);
}

function extractEstimateFromProduct(product, grade) {
  if (!product || typeof product !== "object") return null;
  const graded = toPenniesDollars(product["graded-price"]);
  const loose = toPenniesDollars(product["loose-price"]);
  const cib = toPenniesDollars(product["cib-price"]);
  const manual = toPenniesDollars(product["manual-only-price"]);
  const g = Number(grade);
  if (Number.isFinite(g) && g >= 9 && graded) return graded;
  if (Number.isFinite(g) && g >= 7 && (manual || graded)) return manual || graded;
  return loose || cib || graded || manual || null;
}

function cleanQueryFromTitle(title) {
  return String(title || "")
    .replace(/\b(PSA|CGC|BGS)\s*[0-9]{1,2}(?:\.[0-9])?\b/gi, " ")
    .replace(/\b(GEM\s*MINT|MINT|NM-?MT|NM|LP|MP|HP|DMG)\b/gi, " ")
    .replace(/\b(auction|buy\s*it\s*now|best\s*offer|free\s*shipping|new\s*listing)\b/gi, " ")
    .replace(/[^\w\s#.\-']/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120);
}

async function runPool(items, worker, concurrency) {
  const list = Array.isArray(items) ? items : [];
  if (!list.length) return;
  let index = 0;
  async function run() {
    while (index < list.length) {
      const i = index;
      index += 1;
      await worker(list[i], i);
    }
  }
  await Promise.all(
    Array.from({ length: Math.max(1, Math.min(concurrency, list.length)) }, () => run())
  );
}

function ebayItemNumericId(itemId) {
  const raw = String(itemId || "");
  const browse = raw.match(/^v1\|(\d+)\|/i);
  if (browse) return browse[1];
  const plain = raw.match(/(\d{9,})/);
  return plain ? plain[1] : "";
}

function normalizeUpstreamRow(row, { isBin = false } = {}) {
  const title = String(row?.title || row?.match_label || "").trim();
  const currentPrice = Number(row?.current_bid);
  const estValue = Number(row?.comp_median);
  const pct = Number(row?.pct_of_comp);
  const grade = Number(row?.grade);
  const secondsLeft = Number(row?.seconds_left);
  const hasCountdown = Number.isFinite(secondsLeft) && secondsLeft >= 0;
  const endsAt = hasCountdown ? new Date(Date.now() + secondsLeft * 1000).toISOString() : null;
  const itemId = String(row?.item_id || "").trim();
  const numericId = ebayItemNumericId(itemId);
  let url = String(row?.url || "").trim();
  if (!url && numericId) url = `https://www.ebay.com/itm/${numericId}`;

  const binFlag = isBin || row?.bin === true;
  return {
    itemId: itemId || numericId || url || title,
    title,
    url,
    imageUrl: String(row?.image_url || row?.picture || "").trim(),
    condition: "",
    buyingOptions: binFlag ? ["FIXED_PRICE"] : ["AUCTION"],
    isAuction: !binFlag,
    isBin: binFlag,
    bestOffer: row?.best_offer === true,
    currentPrice: Number.isFinite(currentPrice) ? currentPrice : null,
    bidCount: Number(row?.bid_count) || 0,
    currency: String(row?.currency || "USD"),
    endsAt,
    secondsLeft: hasCountdown ? Math.max(0, Math.round(secondsLeft)) : null,
    seller: String(row?.seller || "").trim(),
    sellerFeedbackPct: row?.seller_feedback_pct != null ? String(row.seller_feedback_pct) : "",
    sellerFeedbackScore: Number(row?.seller_feedback) || 0,
    sellerCountry: String(row?.seller_country || "").trim(),
    categories: ["Pokémon"],
    gradeLabel: Number.isFinite(grade) ? `PSA ${grade}` : "",
    grade: Number.isFinite(grade) ? grade : null,
    gradeCompany: Number.isFinite(grade) ? "PSA" : "",
    psaCert: row?.psa_cert != null ? String(row.psa_cert).trim() : "",
    psaEstimate: Number.isFinite(Number(row?.psa_estimate)) ? Number(row.psa_estimate) : null,
    psaPopulation: row?.psa_population != null ? Number(row.psa_population) : null,
    estValue: Number.isFinite(estValue) ? estValue : null,
    pctOfValue: Number.isFinite(pct) ? Math.round(pct) : null,
    estimateMethod: String(row?.estimate_method || "").trim(),
    matchLabel: String(row?.match_label || row?.card_name || "").trim(),
    cardName: String(row?.card_name || "").trim(),
    cardNumber: String(row?.card_number || "").trim(),
    setName: String(row?.set_name || "").trim(),
    setYear: row?.set_year != null ? Number(row.set_year) : null,
    language: String(row?.language || "").trim(),
    lowVol: row?.low_vol === true,
    cardId: row?.card_id != null ? String(row.card_id) : "",
    vertical: String(row?.vertical || "pokemon").trim() || "pokemon"
  };
}

function refreshCountdowns(rows) {
  const now = Date.now();
  return (rows || []).map((row) => {
    if (!row?.endsAt) return row;
    const t = Date.parse(row.endsAt);
    if (!Number.isFinite(t)) return row;
    return { ...row, secondsLeft: Math.max(0, Math.round((t - now) / 1000)) };
  });
}

function sortRows(rows, sort) {
  const list = refreshCountdowns(rows);
  if (sort === "deal") {
    list.sort((a, b) => {
      const ap = Number.isFinite(a.pctOfValue) ? a.pctOfValue : Number.POSITIVE_INFINITY;
      const bp = Number.isFinite(b.pctOfValue) ? b.pctOfValue : Number.POSITIVE_INFINITY;
      if (ap !== bp) return ap - bp;
      return (a.secondsLeft ?? Infinity) - (b.secondsLeft ?? Infinity);
    });
  } else if (sort === "priceHigh") {
    list.sort((a, b) => (Number(b.currentPrice) || 0) - (Number(a.currentPrice) || 0));
  } else if (sort === "priceLow") {
    list.sort((a, b) => (Number(a.currentPrice) || Infinity) - (Number(b.currentPrice) || Infinity));
  } else {
    list.sort((a, b) => (a.secondsLeft ?? Infinity) - (b.secondsLeft ?? Infinity));
  }
  return list;
}

async function fetchJson(url) {
  const response = await fetch(url, { headers: FETCH_HEADERS });
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(`Upstream HTTP ${response.status} for ${url}`);
  }
  return payload;
}

async function pullUpstreamPokemonFeeds() {
  const auctionParams = new URLSearchParams({
    hours: "24",
    limit: String(UPSTREAM_LIMIT),
    vertical: "pokemon"
  });
  const binParams = new URLSearchParams({
    hours: "168",
    limit: String(UPSTREAM_LIMIT),
    vertical: "pokemon"
  });

  const [auctionPayload, binPayload, analyzedPayload] = await Promise.all([
    fetchJson(`${CARDBOARD_LIVE_URL}?${auctionParams}`),
    fetchJson(`${CARDBOARD_BINS_URL}?${binParams}`).catch(() => ({ rows: [] })),
    fetchJson("https://cardboardterminal.app/api/analyzed?vertical=pokemon").catch(() => null)
  ]);

  const auctionRows = (Array.isArray(auctionPayload?.rows) ? auctionPayload.rows : [])
    .map((row) => normalizeUpstreamRow(row, { isBin: false }))
    .filter((row) => row.title && row.url);

  const binRows = (Array.isArray(binPayload?.rows) ? binPayload.rows : [])
    .map((row) => normalizeUpstreamRow(row, { isBin: true }))
    .filter((row) => row.title && row.url);

  return {
    auction: auctionRows,
    bin: binRows,
    liveTracked: Number(analyzedPayload?.live_tracked) || auctionRows.length,
    source: "cardboardterminal"
  };
}

async function maybeEnrichRows(rows) {
  const list = Array.isArray(rows) ? rows.slice() : [];
  if (!list.length) return list;

  // Prefer upstream comps; fill gaps with PriceCharting / PSA when configured.
  const needEstimate = list.filter((row) => !Number.isFinite(row.estValue)).slice(0, 20);
  if (needEstimate.length && typeof enrichers.getPriceChartingProduct === "function") {
    await runPool(
      needEstimate,
      async (row) => {
        const q = cleanQueryFromTitle(row.title || row.matchLabel);
        if (q.length < 6) return;
        const cacheKey = `${q}|${row.gradeLabel || ""}`;
        const cached = cacheGet(estimateCache, cacheKey);
        let hit = cached;
        if (!hit) {
          try {
            const product = await enrichers.getPriceChartingProduct({ q });
            hit = {
              estimate: extractEstimateFromProduct(product, row.grade),
              productName: String(product["product-name"] || "").trim(),
              setName: String(product["console-name"] || "").trim()
            };
          } catch {
            hit = { estimate: null, productName: "", setName: "" };
          }
          cacheSet(estimateCache, cacheKey, hit, ESTIMATE_TTL_MS);
        }
        if (hit?.estimate) {
          row.estValue = hit.estimate;
          row.estimateMethod = row.estimateMethod || "pricecharting";
          if (!row.matchLabel && hit.productName) row.matchLabel = hit.productName;
          if (!row.setName && hit.setName) row.setName = hit.setName;
          row.pctOfValue = pctOfValue(row.currentPrice, row.estValue);
        }
      },
      2
    );
  }

  const needPsa = list
    .filter((row) => row.psaCert && (!row.psaPopulation || !row.gradeLabel))
    .slice(0, 8);
  if (needPsa.length && typeof enrichers.getPsaCertData === "function") {
    await runPool(
      needPsa,
      async (row) => {
        try {
          const psa = await enrichers.getPsaCertData(row.psaCert);
          const gradeRaw = psa?.Grade ?? psa?.CardGrade ?? psa?.NumericGrade;
          const gradeNum = Number(gradeRaw);
          if (Number.isFinite(gradeNum)) {
            row.grade = gradeNum;
            row.gradeLabel = `PSA ${gradeNum}`;
            row.gradeCompany = "PSA";
          }
          const pop = psa?.Population ?? psa?.TotalPop ?? psa?.SpecPopulation;
          if (pop != null && Number.isFinite(Number(pop))) row.psaPopulation = Number(pop);
        } catch {
          /* optional */
        }
      },
      2
    );
  }

  return list.map((row) => ({
    ...row,
    pctOfValue: row.pctOfValue ?? pctOfValue(row.currentPrice, row.estValue)
  }));
}

async function persistSnapshot() {
  try {
    await fsp.mkdir(DATA_DIR, { recursive: true });
    const body = `${JSON.stringify({
      fetchedAt: snapshot.fetchedAt,
      source: snapshot.source,
      liveTracked: snapshot.liveTracked,
      auction: snapshot.auction,
      bin: snapshot.bin
    })}\n`;
    await fsp.writeFile(SNAPSHOT_FILE, body, "utf8");
  } catch (err) {
    console.warn(`[ebay-terminal] snapshot persist failed: ${err.message || err}`);
  }
}

async function loadSnapshotFromDisk() {
  try {
    const raw = await fsp.readFile(SNAPSHOT_FILE, "utf8");
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return false;
    snapshot = {
      auction: Array.isArray(parsed.auction) ? parsed.auction : [],
      bin: Array.isArray(parsed.bin) ? parsed.bin : [],
      fetchedAt: parsed.fetchedAt || null,
      source: parsed.source || "cardboardterminal",
      liveTracked: Number(parsed.liveTracked) || 0,
      error: ""
    };
    return snapshot.auction.length > 0 || snapshot.bin.length > 0;
  } catch {
    return false;
  }
}

async function pullEbayBrowseFeeds(env = {}) {
  const [auctionSearch, binSearch] = await Promise.all([
    searchPokemonListings({ mode: "auction", sort: "endingSoonest", limit: 120, env }),
    searchPokemonListings({ mode: "bin", sort: "newlyListed", limit: 120, env }).catch(() => ({
      items: [],
      total: 0
    }))
  ]);
  const auction = (auctionSearch.items || [])
    .map(normalizeEbayItem)
    .filter((row) => row.itemId && row.title)
    .filter((row) => /pok[eé]mon|pocket monsters|tcg/i.test(`${row.title} ${row.categories.join(" ")}`))
    .map((row) => ({
      ...row,
      isBin: false,
      estValue: null,
      pctOfValue: null,
      matchLabel: "",
      setName: "",
      psaCert: ""
    }));
  const bin = (binSearch.items || [])
    .map(normalizeEbayItem)
    .filter((row) => row.itemId && row.title)
    .filter((row) => /pok[eé]mon|pocket monsters|tcg/i.test(`${row.title} ${row.categories.join(" ")}`))
    .map((row) => ({
      ...row,
      isAuction: false,
      isBin: true,
      estValue: null,
      pctOfValue: null,
      matchLabel: "",
      setName: "",
      psaCert: ""
    }));
  return {
    auction: await maybeEnrichRows(auction),
    bin: await maybeEnrichRows(bin),
    liveTracked: auction.length + bin.length,
    source: "ebay"
  };
}

async function refreshEbayTerminalSnapshot({ force = false } = {}) {
  if (pollInFlight) return pollInFlight;
  pollInFlight = (async () => {
    try {
      const env = { ...process.env };
      const creds = getEbayCredentials(env);
      let next;
      // Prefer upstream Pokémon deal feed unless explicitly forced to eBay.
      const forceEbay = String(process.env.EBAY_TERMINAL_FORCE_EBAY || "").trim() === "1";
      if (forceEbay && creds.configured) {
        next = await pullEbayBrowseFeeds(env);
      } else {
        next = await pullUpstreamPokemonFeeds();
        next.auction = await maybeEnrichRows(next.auction);
        next.bin = await maybeEnrichRows(next.bin);
      }

      snapshot = {
        auction: next.auction,
        bin: next.bin,
        fetchedAt: new Date().toISOString(),
        source: next.source,
        liveTracked: next.liveTracked,
        error: ""
      };
      await persistSnapshot();
      console.log(
        `[ebay-terminal] snapshot ok source=${snapshot.source} auctions=${snapshot.auction.length} bins=${snapshot.bin.length} tracked=${snapshot.liveTracked}`
      );
      return snapshot;
    } catch (err) {
      snapshot.error = err.message || String(err);
      console.warn(`[ebay-terminal] refresh failed: ${snapshot.error}`);
      if (!snapshot.auction.length && !snapshot.bin.length) {
        await loadSnapshotFromDisk();
      }
      return snapshot;
    } finally {
      pollInFlight = null;
    }
  })();
  return pollInFlight;
}

function setEbayTerminalEnrichers(next = {}) {
  enrichers = {
    getPriceChartingProduct:
      typeof next.getPriceChartingProduct === "function" ? next.getPriceChartingProduct : null,
    getPsaCertData: typeof next.getPsaCertData === "function" ? next.getPsaCertData : null
  };
}

function startEbayTerminalPoller() {
  if (pollTimer) return;
  void loadSnapshotFromDisk().then((had) => {
    if (had) {
      console.log(
        `[ebay-terminal] restored disk snapshot auctions=${snapshot.auction.length} bins=${snapshot.bin.length}`
      );
    }
    void refreshEbayTerminalSnapshot();
  });
  pollTimer = setInterval(() => {
    void refreshEbayTerminalSnapshot();
  }, POLL_MS);
  if (typeof pollTimer.unref === "function") pollTimer.unref();
  console.log(`[ebay-terminal] background poll every ${Math.round(POLL_MS / 1000)}s`);
}

function stopEbayTerminalPoller() {
  if (!pollTimer) return;
  clearInterval(pollTimer);
  pollTimer = null;
}

function getEbayTerminalMeta() {
  return {
    fetchedAt: snapshot.fetchedAt,
    source: snapshot.source,
    liveTracked: snapshot.liveTracked,
    auctionCount: snapshot.auction.length,
    binCount: snapshot.bin.length,
    error: snapshot.error || "",
    pollMs: POLL_MS
  };
}

/**
 * Serve deals from the warm snapshot (instant). Optionally kick a refresh.
 */
async function getEbayTerminalDeals(options = {}) {
  const {
    mode = "auction",
    sort = "ending",
    limit = 60,
    q = "",
    refresh = false
  } = options;

  if (refresh || (!snapshot.fetchedAt && !snapshot.auction.length && !snapshot.bin.length)) {
    await refreshEbayTerminalSnapshot();
  } else if (
    snapshot.fetchedAt &&
    Date.now() - Date.parse(snapshot.fetchedAt) > POLL_MS * 2
  ) {
    void refreshEbayTerminalSnapshot();
  }

  const sourceRows =
    mode === "bin" ? snapshot.bin : mode === "all" ? [...snapshot.auction, ...snapshot.bin] : snapshot.auction;

  let rows = sortRows(sourceRows, sort);
  const needle = String(q || "").trim().toLowerCase();
  if (needle) {
    rows = rows.filter((row) =>
      `${row.title} ${row.matchLabel} ${row.setName} ${row.seller} ${row.cardName}`
        .toLowerCase()
        .includes(needle)
    );
  }
  const capped = rows.slice(0, Math.max(1, Math.min(200, Number(limit) || 60)));

  return {
    ok: true,
    configured: true,
    source: snapshot.source,
    category: "pokemon",
    mode,
    sort,
    total: rows.length,
    count: capped.length,
    liveTracked: snapshot.liveTracked,
    fetchedAt: snapshot.fetchedAt || new Date().toISOString(),
    pollMs: POLL_MS,
    error: snapshot.error || "",
    rows: capped
  };
}

module.exports = {
  getEbayTerminalDeals,
  getEbayCredentials,
  getEbayTerminalMeta,
  refreshEbayTerminalSnapshot,
  startEbayTerminalPoller,
  stopEbayTerminalPoller,
  setEbayTerminalEnrichers
};
