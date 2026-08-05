/**
 * Aggregate collection market-value history from PriceCharting series.
 * Marks current holdings to historical prices (qty today × price at/before t).
 */

const {
  fetchPriceChartingMarketHistoryForCard
} = require("./pricecharting-market-history");
const { getOrFetchPriceChartingSealedDetails } = require("./pricecharting-card-details-cache");
const { readSealedCatalog, getSealedProductsForSetCode } = require("./pricecharting-sealed");

const RANGE_DAYS = {
  "30": 30,
  "90": 90,
  "180": 180,
  "365": 365,
  all: 0,
  ytd: null
};

const RANGE_LABELS = {
  all: "All Time",
  "30": "30 Days",
  "90": "3 Months",
  "180": "6 Months",
  ytd: "YTD",
  "365": "1 Year"
};

const FETCH_CONCURRENCY = 5;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

function normalizeRangeKey(raw) {
  const key = String(raw || "all").trim().toLowerCase();
  if (key === "ytd") return "ytd";
  if (Object.prototype.hasOwnProperty.call(RANGE_DAYS, key)) return key;
  return "all";
}

function rangeLabel(rangeKey) {
  return RANGE_LABELS[rangeKey] || "All Time";
}

function rangeCutoffTs(rangeKey, now = Date.now()) {
  const key = normalizeRangeKey(rangeKey);
  if (key === "all") return 0;
  if (key === "ytd") {
    const d = new Date(now);
    return new Date(d.getFullYear(), 0, 1).getTime();
  }
  const days = Number(RANGE_DAYS[key]) || 0;
  if (!days) return 0;
  return now - days * MS_PER_DAY;
}

function dayStartTs(ts) {
  const d = new Date(ts);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

function formatDay(ts) {
  return new Date(ts).toISOString().slice(0, 10);
}

function parseProductUrlFromNotes(notes = "") {
  const m = String(notes || "").match(/https?:\/\/(?:www\.)?pricecharting\.com\/game\/[^\s]+/i);
  return m ? m[0].replace(/[.,;)]+$/, "") : "";
}

async function resolveSealedProductUrl(item, catalogCache) {
  const fromNotes = parseProductUrlFromNotes(item?.notes);
  if (fromNotes) return fromNotes;
  const productId = String(item?.priceChartingId || "").trim();
  const setCode = String(item?.setCode || "").trim().toUpperCase();
  if (!productId) return "";
  try {
    if (!catalogCache.value) {
      catalogCache.value = await readSealedCatalog();
    }
    const products = getSealedProductsForSetCode(catalogCache.value, setCode);
    const match = products.find((p) => String(p.productId || "") === productId);
    if (match?.productUrl) return String(match.productUrl);
    // Fallback: scan all sets for the product id
    const byCode = catalogCache.value?.byCode || {};
    for (const row of Object.values(byCode)) {
      const list = Array.isArray(row?.products) ? row.products : [];
      const hit = list.find((p) => String(p.productId || "") === productId);
      if (hit?.productUrl) return String(hit.productUrl);
    }
  } catch {
    /* ignore catalog errors */
  }
  return "";
}

function pickPreferredSeries(series, item) {
  const list = Array.isArray(series) ? series.filter((row) => Array.isArray(row?.points) && row.points.length) : [];
  if (!list.length) return null;

  const graded = String(item?.conditionType || "").toLowerCase() === "graded";
  if (graded) {
    const company = String(item?.gradeCompany || "PSA").trim() || "PSA";
    const grade = String(item?.gradeValue || "").trim();
    const wantExact = grade ? `${company} ${grade}`.toLowerCase() : "";
    const wantPsa10 = "psa 10";
    const exact =
      (wantExact &&
        list.find((row) => String(row.label || "").trim().toLowerCase() === wantExact)) ||
      null;
    if (exact) return exact;
    const psa10 = list.find((row) => String(row.label || "").trim().toLowerCase() === wantPsa10);
    if (psa10) return psa10;
    const gradedKey = list.find(
      (row) =>
        String(row.variantKey || "").toLowerCase() === "manualonly" ||
        String(row.variantKey || "").toLowerCase() === "graded"
    );
    if (gradedKey) return gradedKey;
  }

  const ungraded =
    list.find((row) => String(row.label || "").trim().toLowerCase() === "ungraded") ||
    list.find((row) => String(row.variantKey || "").toLowerCase() === "used");
  return ungraded || list[0];
}

function normalizePoints(points) {
  return (Array.isArray(points) ? points : [])
    .map((point) => ({
      ts: Number(point.ts),
      price: Number(point.price),
      date: String(point.date || "").trim() || formatDay(Number(point.ts))
    }))
    .filter((point) => Number.isFinite(point.ts) && Number.isFinite(point.price) && point.price > 0)
    .sort((a, b) => a.ts - b.ts);
}

async function mapPool(items, concurrency, worker) {
  const list = Array.isArray(items) ? items : [];
  const results = new Array(list.length);
  let next = 0;
  const runners = Array.from({ length: Math.min(concurrency, Math.max(1, list.length)) }, async () => {
    while (next < list.length) {
      const index = next;
      next += 1;
      results[index] = await worker(list[index], index);
    }
  });
  await Promise.all(runners);
  return results;
}

async function loadItemPriceSeries(item, sealedCatalogCache, { requireQuantity = true } = {}) {
  const qty = Math.max(0, Math.floor(Number(item?.quantity) || 0));
  if (requireQuantity && !qty) return null;
  const quantity = qty > 0 ? qty : 1;

  if (String(item?.type || "") === "sealed") {
    const productId = String(item.priceChartingId || "").trim();
    const productUrl = await resolveSealedProductUrl(item, sealedCatalogCache);
    if (!productId && !productUrl) return null;
    try {
      const payload = await getOrFetchPriceChartingSealedDetails({
        setCode: item.setCode || "",
        productUrl,
        productId,
        productTitle: item.name || "",
        setName: item.setName || ""
      });
      const series = pickPreferredSeries(payload?.series, item);
      const points = normalizePoints(series?.points);
      if (!points.length) return null;
      return { itemId: item.id, quantity, points };
    } catch {
      return null;
    }
  }

  const setCode = String(item.setCode || "").trim();
  const cardNo = String(item.cardNumber || "").trim();
  if (!setCode || !cardNo) return null;
  try {
    const seriesList = await fetchPriceChartingMarketHistoryForCard({
      setCode,
      setName: item.setName || "",
      cardNo,
      cardName: item.name || "",
      rangeDays: 0
    });
    const series = pickPreferredSeries(seriesList, item);
    const points = normalizePoints(series?.points);
    if (!points.length) return null;
    return { itemId: item.id, quantity, points };
  } catch {
    return null;
  }
}

function parseCostBasisDate(dateStr) {
  const match = String(dateStr || "")
    .trim()
    .match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (!Number.isFinite(year) || !Number.isFinite(month) || !Number.isFinite(day)) return null;
  const endTs = Date.UTC(year, month - 1, day, 23, 59, 59, 999);
  if (!Number.isFinite(endTs)) return null;
  return { date: match[0], endTs };
}

function pickPriceOnOrBefore(points, endTs) {
  const list = Array.isArray(points) ? points : [];
  let best = null;
  for (const point of list) {
    if (!point || !Number.isFinite(point.ts) || point.ts > endTs) continue;
    if (!best || point.ts >= best.ts) best = point;
  }
  return best;
}

/**
 * Resolve a single item's PriceCharting unit price on/before a YYYY-MM-DD date.
 * @returns {Promise<{ ok: boolean, price?: number, date?: string, sourceDate?: string, error?: string }>}
 */
async function getItemHistoricalPriceOnDate(item, dateStr) {
  const parsed = parseCostBasisDate(dateStr);
  if (!parsed) {
    return { ok: false, error: "date must be YYYY-MM-DD" };
  }
  if (!item) {
    return { ok: false, error: "Item is required" };
  }
  try {
    const loaded = await loadItemPriceSeries(item, { value: null }, { requireQuantity: false });
    if (!loaded || !Array.isArray(loaded.points) || !loaded.points.length) {
      return { ok: false, date: parsed.date, error: "No historical price for that date" };
    }
    const hit = pickPriceOnOrBefore(loaded.points, parsed.endTs);
    if (!hit || !(Number(hit.price) > 0)) {
      return { ok: false, date: parsed.date, error: "No historical price for that date" };
    }
    return {
      ok: true,
      date: parsed.date,
      sourceDate: String(hit.date || formatDay(hit.ts)),
      price: Number(Number(hit.price).toFixed(2))
    };
  } catch (err) {
    return {
      ok: false,
      date: parsed.date,
      error: err?.message || "Failed to load historical price"
    };
  }
}

function buildDailyPortfolioPoints(itemSeries, rangeStartTs, nowTs, { currentMarketValue = 0, snapToLive = false } = {}) {
  const series = (Array.isArray(itemSeries) ? itemSeries : []).filter(
    (row) => row && Array.isArray(row.points) && row.points.length
  );
  if (!series.length) return [];

  let earliest = Infinity;
  for (const row of series) {
    earliest = Math.min(earliest, row.points[0].ts);
  }
  if (!Number.isFinite(earliest)) return [];

  const startDay = dayStartTs(Math.max(rangeStartTs || earliest, earliest));
  const endDay = dayStartTs(nowTs);
  if (endDay < startDay) return [];

  const cursors = series.map(() => -1);
  const lastPrices = series.map(() => null);
  const points = [];

  for (let day = startDay; day <= endDay; day += MS_PER_DAY) {
    let total = 0;
    let priced = 0;
    for (let i = 0; i < series.length; i += 1) {
      const row = series[i];
      while (
        cursors[i] + 1 < row.points.length &&
        row.points[cursors[i] + 1].ts <= day + MS_PER_DAY - 1
      ) {
        cursors[i] += 1;
        lastPrices[i] = row.points[cursors[i]].price;
      }
      if (Number.isFinite(lastPrices[i]) && lastPrices[i] > 0) {
        total += lastPrices[i] * row.quantity;
        priced += 1;
      }
    }
    if (priced <= 0 || !(total > 0)) continue;
    points.push({
      date: formatDay(day),
      ts: day,
      price: Number(total.toFixed(2))
    });
  }

  if (!points.length) return points;

  // Only snap when history covers every item so end matches live Market Value KPI.
  if (snapToLive && Number.isFinite(currentMarketValue) && currentMarketValue > 0) {
    const last = points[points.length - 1];
    points[points.length - 1] = {
      ...last,
      price: Number(Number(currentMarketValue).toFixed(2))
    };
  }

  return points;
}

/**
 * @param {object} options
 * @param {Array} options.items - collection items for the user
 * @param {string} options.rangeKey
 * @param {number} options.currentMarketValue - live dashboard market value
 */
async function buildCollectionValueHistory({
  items = [],
  rangeKey = "all",
  currentMarketValue = 0
} = {}) {
  const key = normalizeRangeKey(rangeKey);
  const label = rangeLabel(key);
  const now = Date.now();
  const cutoff = rangeCutoffTs(key, now);
  const list = Array.isArray(items) ? items : [];
  const totalItemCount = list.length;

  if (!totalItemCount) {
    return {
      ok: true,
      rangeKey: key,
      rangeLabel: label,
      currentMarketValue: Number(Number(currentMarketValue || 0).toFixed(2)),
      startValue: 0,
      endValue: 0,
      priceChange: 0,
      percentChange: null,
      points: [],
      itemStarts: {},
      pricedItemCount: 0,
      totalItemCount: 0,
      incomplete: false
    };
  }

  const sealedCatalogCache = { value: null };
  const loaded = await mapPool(list, FETCH_CONCURRENCY, (item) =>
    loadItemPriceSeries(item, sealedCatalogCache)
  );
  const itemSeries = loaded.filter(Boolean);
  const pricedItemCount = itemSeries.length;
  const incomplete = pricedItemCount < totalItemCount;

  const points = buildDailyPortfolioPoints(itemSeries, cutoff, now, {
    currentMarketValue: Number(currentMarketValue) || 0,
    snapToLive: !incomplete && pricedItemCount > 0
  });

  // Per-item unit price at range start (earliest point for All Time; on/before cutoff otherwise).
  const itemStarts = {};
  const rangeEndTs =
    key === "all" ? null : dayStartTs(cutoff) + MS_PER_DAY - 1;
  for (const row of itemSeries) {
    const id = String(row.itemId || "").trim();
    if (!id || !row.points.length) continue;
    const hit =
      key === "all"
        ? row.points[0]
        : pickPriceOnOrBefore(row.points, rangeEndTs);
    if (!hit || !(Number(hit.price) > 0)) continue;
    itemStarts[id] = {
      startUnitPrice: Number(Number(hit.price).toFixed(2)),
      startDate: String(hit.date || formatDay(hit.ts))
    };
  }

  const startValue = points.length ? points[0].price : null;
  const endValue = points.length
    ? points[points.length - 1].price
    : Number.isFinite(currentMarketValue)
      ? Number(currentMarketValue)
      : null;
  const priceChange =
    Number.isFinite(startValue) && Number.isFinite(endValue)
      ? Number((endValue - startValue).toFixed(2))
      : null;
  const percentChange =
    Number.isFinite(startValue) && startValue > 0 && Number.isFinite(priceChange)
      ? Number(((priceChange / startValue) * 100).toFixed(2))
      : null;

  return {
    ok: true,
    rangeKey: key,
    rangeLabel: label,
    currentMarketValue: Number(Number(currentMarketValue || 0).toFixed(2)),
    startValue: Number.isFinite(startValue) ? Number(startValue) : null,
    endValue: Number.isFinite(endValue) ? Number(endValue) : null,
    priceChange,
    percentChange,
    points,
    itemStarts,
    pricedItemCount,
    totalItemCount,
    incomplete
  };
}

module.exports = {
  buildCollectionValueHistory,
  getItemHistoricalPriceOnDate,
  normalizeRangeKey,
  rangeLabel,
  rangeCutoffTs,
  RANGE_LABELS
};
