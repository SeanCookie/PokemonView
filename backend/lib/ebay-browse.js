/**
 * eBay Browse API helpers (client-credentials OAuth).
 */
const TOKEN_URL = "https://api.ebay.com/identity/v1/oauth2/token";
const BROWSE_SEARCH_URL = "https://api.ebay.com/buy/browse/v1/item_summary/search";
const DEFAULT_SCOPE = "https://api.ebay.com/oauth/api_scope";

/** Pokémon TCG Individual Cards (EBAY_US). */
const POKEMON_CATEGORY_ID = "261009";
/** Broader CCG Individual Cards fallback. */
const CCG_INDIVIDUAL_CATEGORY_ID = "183454";

let cachedToken = { accessToken: "", expiresAt: 0 };

function getEbayCredentials(env = {}) {
  const clientId = String(env.EBAY_CLIENT_ID || process.env.EBAY_CLIENT_ID || "").trim();
  const clientSecret = String(env.EBAY_CLIENT_SECRET || process.env.EBAY_CLIENT_SECRET || "").trim();
  const appId = String(env.EBAY_APP_ID || process.env.EBAY_APP_ID || "").trim();
  return {
    clientId: clientId || appId,
    clientSecret,
    configured: Boolean((clientId || appId) && clientSecret)
  };
}

async function getEbayAppToken(env = {}) {
  const { clientId, clientSecret, configured } = getEbayCredentials(env);
  if (!configured) {
    throw new Error("eBay API credentials missing (EBAY_CLIENT_ID / EBAY_CLIENT_SECRET)");
  }
  const now = Date.now();
  if (cachedToken.accessToken && cachedToken.expiresAt > now + 60_000) {
    return cachedToken.accessToken;
  }

  const basic = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");
  const body = new URLSearchParams({
    grant_type: "client_credentials",
    scope: DEFAULT_SCOPE
  });
  const response = await fetch(TOKEN_URL, {
    method: "POST",
    headers: {
      Authorization: `Basic ${basic}`,
      "Content-Type": "application/x-www-form-urlencoded"
    },
    body
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok || !payload?.access_token) {
    const detail = payload?.error_description || payload?.error || `HTTP ${response.status}`;
    throw new Error(`eBay OAuth failed: ${detail}`);
  }
  const expiresIn = Number(payload.expires_in) || 7200;
  cachedToken = {
    accessToken: String(payload.access_token),
    expiresAt: now + expiresIn * 1000
  };
  return cachedToken.accessToken;
}

/**
 * @param {object} options
 * @param {"auction"|"bin"|"all"} [options.mode]
 * @param {string} [options.sort] endingSoonest | price | -price | bestMatch
 * @param {number} [options.limit]
 * @param {number} [options.offset]
 * @param {string} [options.q]
 * @param {object} [options.env]
 */
async function searchPokemonListings(options = {}) {
  const {
    mode = "auction",
    sort = "endingSoonest",
    limit = 50,
    offset = 0,
    q = "",
    env = {}
  } = options;

  const token = await getEbayAppToken(env);
  const params = new URLSearchParams();
  const query = String(q || "").trim();
  // Category is Pokemon TCG; keep a light keyword when empty so L1-ish categories stay valid.
  params.set("q", query || "pokemon");
  params.set("category_ids", POKEMON_CATEGORY_ID);
  params.set("limit", String(Math.max(1, Math.min(200, Number(limit) || 50))));
  params.set("offset", String(Math.max(0, Number(offset) || 0)));

  const filters = ["deliveryCountry:US"];
  if (mode === "auction") filters.push("buyingOptions:{AUCTION}");
  else if (mode === "bin") filters.push("buyingOptions:{FIXED_PRICE}");
  params.set("filter", filters.join(","));

  const sortKey = String(sort || "endingSoonest");
  if (["endingSoonest", "price", "-price", "newlyListed", "bestMatch"].includes(sortKey)) {
    params.set("sort", sortKey);
  }

  async function runSearch(categoryId) {
    const searchParams = new URLSearchParams(params);
    searchParams.set("category_ids", categoryId);
    const response = await fetch(`${BROWSE_SEARCH_URL}?${searchParams.toString()}`, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${token}`,
        "X-EBAY-C-MARKETPLACE-ID": "EBAY_US",
        Accept: "application/json"
      }
    });
    const payload = await response.json().catch(() => null);
    return { response, payload };
  }

  let { response, payload } = await runSearch(POKEMON_CATEGORY_ID);
  // Some apps/taxonomies resolve Pokemon under the broader CCG bucket.
  if ((!response.ok || !Array.isArray(payload?.itemSummaries) || !payload.itemSummaries.length) &&
      response.status !== 401) {
    const fallback = await runSearch(CCG_INDIVIDUAL_CATEGORY_ID);
    if (fallback.response.ok && Array.isArray(fallback.payload?.itemSummaries)) {
      response = fallback.response;
      payload = fallback.payload;
    }
  }

  if (!response.ok) {
    const detail = payload?.errors?.[0]?.message || payload?.error || `HTTP ${response.status}`;
    throw new Error(`eBay Browse search failed: ${detail}`);
  }

  const items = Array.isArray(payload?.itemSummaries) ? payload.itemSummaries : [];
  return {
    total: Number(payload?.total) || items.length,
    href: payload?.href || "",
    items
  };
}

function moneyFromEbayAmount(amount) {
  if (!amount || typeof amount !== "object") return null;
  const n = Number(amount.value);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

function parseGradeFromTitle(title) {
  const text = String(title || "");
  const psa = text.match(/\bPSA\s*([0-9]{1,2}(?:\.[0-9])?)\b/i);
  if (psa) return { company: "PSA", grade: Number(psa[1]), label: `PSA ${psa[1]}` };
  const cgc = text.match(/\bCGC\s*([0-9]{1,2}(?:\.[0-9])?)\b/i);
  if (cgc) return { company: "CGC", grade: Number(cgc[1]), label: `CGC ${cgc[1]}` };
  const bgs = text.match(/\bBGS\s*([0-9]{1,2}(?:\.[0-9])?)\b/i);
  if (bgs) return { company: "BGS", grade: Number(bgs[1]), label: `BGS ${bgs[1]}` };
  return { company: "", grade: null, label: "" };
}

function normalizeEbayItem(summary) {
  const title = String(summary?.title || "").trim();
  const grade = parseGradeFromTitle(title);
  const currentBid = moneyFromEbayAmount(summary?.currentBidPrice);
  const price = moneyFromEbayAmount(summary?.price);
  const buyingOptions = Array.isArray(summary?.buyingOptions) ? summary.buyingOptions : [];
  const isAuction = buyingOptions.includes("AUCTION");
  const currentPrice = isAuction && currentBid != null ? currentBid : price;
  const endDate = String(summary?.itemEndDate || "").trim();
  const endsAt = endDate ? Date.parse(endDate) : NaN;
  const secondsLeft = Number.isFinite(endsAt) ? Math.max(0, Math.round((endsAt - Date.now()) / 1000)) : null;
  const image =
    summary?.image?.imageUrl ||
    summary?.thumbnailImages?.[0]?.imageUrl ||
    summary?.additionalImages?.[0]?.imageUrl ||
    "";

  return {
    itemId: String(summary?.itemId || "").trim(),
    title,
    url: String(summary?.itemWebUrl || summary?.itemHref || "").trim(),
    imageUrl: String(image || "").trim(),
    condition: String(summary?.condition || "").trim(),
    buyingOptions,
    isAuction,
    currentPrice,
    bidCount: Number(summary?.bidCount) || 0,
    currency: String(summary?.price?.currency || summary?.currentBidPrice?.currency || "USD"),
    endsAt: Number.isFinite(endsAt) ? new Date(endsAt).toISOString() : null,
    secondsLeft,
    seller: String(summary?.seller?.username || "").trim(),
    sellerFeedbackPct: summary?.seller?.feedbackPercentage != null
      ? String(summary.seller.feedbackPercentage)
      : "",
    sellerFeedbackScore: Number(summary?.seller?.feedbackScore) || 0,
    sellerCountry: String(summary?.itemLocation?.country || "").trim(),
    categories: Array.isArray(summary?.categories)
      ? summary.categories.map((c) => String(c.categoryName || c.categoryId || "")).filter(Boolean)
      : [],
    gradeLabel: grade.label,
    grade: grade.grade,
    gradeCompany: grade.company
  };
}

module.exports = {
  POKEMON_CATEGORY_ID,
  getEbayCredentials,
  getEbayAppToken,
  searchPokemonListings,
  normalizeEbayItem,
  parseGradeFromTitle
};
