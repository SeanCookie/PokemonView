"use strict";

const COLLECTR_PROFILE_RE =
  /^(?:https?:\/\/)?(?:app\.)?getcollectr\.com\/showcase\/profile\/@?([a-z0-9_]{3,24})\/?(?:\?.*)?$/i;
const COLLECTR_HANDLE_RE = /^@?([a-z0-9_]{3,24})$/i;
const COLLECTR_API_ORIGIN = "https://api-v2.getcollectr.com";
const COLLECTR_ANON_USERNAME = "00000000-0000-0000-0000-000000000000";
const COLLECTR_DEFAULT_PAGE_SIZE = 100;
const COLLECTR_PAGE_DELAY_MS = 120;
const { fetchCollectrShowcaseCatalogViaBrowser, COLLECTR_IMPORT_FILTERS_PARAM, buildShowcaseProfileUrl } = require("./collectr-browser");
const {
  isCollectrPokemonProduct,
  filterCollectrPokemonProducts
} = require("./collectr-pokemon-filter");

function summarizeCollectrErrorDetail(reason = "") {
  try {
    const { summarizeFailureReason } = require("./collectr-browser");
    return summarizeFailureReason(reason);
  } catch {
    return String(reason || "")
      .split(/Browser logs:/i)[0]
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 180);
  }
}

function parseCollectrProfileUrl(rawUrl = "") {
  const text = String(rawUrl || "").trim();
  if (!text) return { ok: false, error: "Collectr profile URL is required" };
  const urlMatch = text.match(COLLECTR_PROFILE_RE);
  if (urlMatch) {
    const handle = urlMatch[1].toLowerCase();
    return {
      ok: true,
      handle,
      profileUrl: `https://app.getcollectr.com/showcase/profile/@${handle}`
    };
  }
  const handleMatch = text.match(COLLECTR_HANDLE_RE);
  if (handleMatch) {
    const handle = handleMatch[1].toLowerCase();
    return {
      ok: true,
      handle,
      profileUrl: `https://app.getcollectr.com/showcase/profile/@${handle}`
    };
  }
  return {
    ok: false,
    error: "Enter a Collectr username, @username, or showcase link."
  };
}

function buildCollectrShowcaseApiUrl(handle, offset = 0, limit = COLLECTR_DEFAULT_PAGE_SIZE) {
  const params = new URLSearchParams({
    searchString: "",
    offset: String(Math.max(0, Number(offset) || 0)),
    limit: String(Math.min(100, Math.max(1, Number(limit) || COLLECTR_DEFAULT_PAGE_SIZE))),
    id: "",
    sortType: "",
    sortOrder: "",
    groupId: "",
    filters: COLLECTR_IMPORT_FILTERS_PARAM,
    unstackedView: "true",
    username: COLLECTR_ANON_USERNAME
  });
  const slug = String(handle || "")
    .trim()
    .toLowerCase()
    .replace(/^@+/, "");
  return `${COLLECTR_API_ORIGIN}/data/showcase/@${encodeURIComponent(slug)}?${params}`;
}

function collectrFetchHeaders(handle) {
  const profileUrl = `https://app.getcollectr.com/showcase/profile/@${handle}`;
  return {
    Accept: "application/json, text/plain, */*",
    "Accept-Language": "en-US,en;q=0.9",
    "User-Agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    Referer: profileUrl,
    Origin: "https://app.getcollectr.com"
  };
}

function extractEscapedJsonArray(html, marker, endMarker) {
  const start = html.indexOf(marker);
  if (start < 0) return [];
  const arrStart = start + marker.length;
  const end = html.indexOf(endMarker, arrStart);
  if (end < 0) return [];
  const escaped = html.slice(arrStart, end);
  try {
    const unescaped = escaped.replace(/\\"/g, '"').replace(/\\\\/g, "\\");
    const parsed = JSON.parse(`[${unescaped}]`);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function extractProfileTotalsFromHtml(html) {
  const totalCardsMatch = String(html || "").match(/total_cards\\":\\"(\d+)\\"/);
  const totalSealedMatch = String(html || "").match(/total_sealed\\":\\"(\d+)\\"/);
  return {
    totalCards: totalCardsMatch ? Number(totalCardsMatch[1]) : 0,
    totalSealed: totalSealedMatch ? Number(totalSealedMatch[1]) : 0
  };
}

function extractProfileMetaFromHtml(html, handle) {
  const userMatch = html.match(/\\"user\\":\\"([^"\\]+)\\"/);
  const handleMatch = html.match(/\\"handle\\":\\"([^"\\]+)\\"/);
  const photoMatch = html.match(/\\"profile_photo\\":\\"([^"\\]+)\\"/);
  return {
    handle: (handleMatch?.[1] || handle || "").toLowerCase(),
    displayName: userMatch?.[1] || handleMatch?.[1] || handle,
    profilePhoto: photoMatch?.[1]?.replace(/\\u0026/g, "&") || null
  };
}

function extractProductsFromCollectrHtml(html) {
  const markers = ['\\"products\\":[', '"products":['];
  const endMarkers = [
    '],\\"verified\\"',
    '],"verified"',
    '],\\"badges\\"',
    '],"badges"',
    '],\\"total_cards\\"',
    '],"total_cards"'
  ];
  const byKey = new Map();

  for (const marker of markers) {
    let searchFrom = 0;
    while (searchFrom < html.length) {
      const start = html.indexOf(marker, searchFrom);
      if (start < 0) break;
      const arrStart = start + marker.length;
      let advanced = false;
      for (const endMarker of endMarkers) {
        const end = html.indexOf(endMarker, arrStart);
        if (end < 0) continue;
        const slice = html.slice(arrStart, end);
        try {
          const unescaped = slice.replace(/\\"/g, '"').replace(/\\\\/g, "\\");
          const rows = JSON.parse(`[${unescaped}]`);
          if (Array.isArray(rows)) {
            for (const row of rows) {
              const key = `${row?.product_id || ""}::${row?.grade_id || ""}::${row?.product_sub_type || ""}`;
              if (!row?.product_id || byKey.has(key)) continue;
              byKey.set(key, row);
            }
          }
        } catch {
          // try next end marker
        }
        searchFrom = end + endMarker.length;
        advanced = true;
        break;
      }
      if (!advanced) {
        searchFrom = arrStart;
      }
    }
  }

  return [...byKey.values()];
}

async function fetchCollectrShowcaseApiPage(handle, offset = 0, limit = COLLECTR_DEFAULT_PAGE_SIZE) {
  const url = buildCollectrShowcaseApiUrl(handle, offset, limit);
  try {
    const response = await fetch(url, { headers: collectrFetchHeaders(handle) });
    if (!response.ok) return null;
    const payload = await response.json();
    if (!payload || typeof payload !== "object") return null;
    const products = Array.isArray(payload.products)
      ? payload.products
      : Array.isArray(payload.data)
        ? payload.data
        : [];
    return {
      profile: {
        handle: payload.handle || handle,
        displayName: payload.user || payload.displayName || handle,
        profilePhoto: payload.profile_photo || payload.profilePhoto || null
      },
      products,
      totalCards: Number(payload.total_cards) || 0,
      totalSealed: Number(payload.total_sealed) || 0
    };
  } catch {
    return null;
  }
}

function mergeCollectrProductsIntoMap(byKey, rows) {
  if (!byKey || !Array.isArray(rows)) return;
  for (const row of rows) {
    const key = `${row?.product_id || ""}::${row?.grade_id || ""}::${row?.product_sub_type || ""}`;
    if (!row?.product_id || byKey.has(key)) continue;
    byKey.set(key, row);
  }
}

async function fetchCollectrShowcaseRscPage(handle) {
  const slug = String(handle || "").trim().toLowerCase();
  const path = `/showcase/profile/@${encodeURIComponent(slug)}?selectedFilters=${encodeURIComponent(COLLECTR_IMPORT_FILTERS_PARAM)}`;
  try {
    const response = await fetch(`https://app.getcollectr.com${path}`, {
      headers: {
        RSC: "1",
        "Next-Url": path,
        Accept: "text/x-component",
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
      }
    });
    if (!response.ok) return { products: [], totalCards: 0, totalSealed: 0 };
    const text = await response.text();
    const totals = extractProfileTotalsFromHtml(text);
    return {
      products: extractProductsFromCollectrHtml(text),
      totalCards: totals.totalCards,
      totalSealed: totals.totalSealed
    };
  } catch {
    return { products: [], totalCards: 0, totalSealed: 0 };
  }
}

async function fetchCollectrShowcaseHtmlPage(handle) {
  const profileUrl = buildShowcaseProfileUrl(handle);
  const response = await fetch(profileUrl, { headers: collectrFetchHeaders(handle) });
  if (!response.ok) {
    throw new Error(`Collectr profile returned ${response.status}`);
  }
  const html = await response.text();
  if (!html || html.length < 1000) {
    throw new Error("Collectr profile page was empty");
  }
  if (html.includes("Collector not found") || html.includes("Page not found")) {
    throw new Error("Collectr profile not found");
  }
  const totals = extractProfileTotalsFromHtml(html);
  return {
    profile: extractProfileMetaFromHtml(html, handle),
    products: extractProductsFromCollectrHtml(html),
    profileUrl,
    totalCards: totals.totalCards,
    totalSealed: totals.totalSealed
  };
}

async function fetchCollectrShowcaseCatalog(handle, options = {}) {
  const parsed = parseCollectrProfileUrl(handle);
  if (!parsed.ok) return parsed;
  const slug = parsed.handle;
  const maxItems = Math.min(25_000, Math.max(1, Number(options.maxItems) || 20_000));
  const useBrowser = options.useBrowser !== false;
  let browserFailureReason = "";

  if (useBrowser) {
    const browserResult = await fetchCollectrShowcaseCatalogViaBrowser(slug, {
      maxItems,
      onProgress: options.onProgress
    });
    if (browserResult?.ok && browserResult.products?.length) {
      const filtered = applyPokemonFilterToCatalogResult(
        {
          ok: true,
          handle: slug,
          profileUrl: parsed.profileUrl,
          profile: browserResult.profile,
          products: browserResult.products,
          totalCards: browserResult.totalCards || 0,
          totalSealed: browserResult.totalSealed || 0,
          expectedTotal: browserResult.expectedTotal || null,
          filteredOutNonPokemon: Number(browserResult.filteredOutNonPokemon) || 0,
          source: browserResult.source,
          partial: Boolean(browserResult.partial),
          needsBrowserFetch: false,
          crashReason: browserResult.crashReason || ""
        },
        maxItems
      );

      const expected = Number(filtered.expectedTotal) || 0;
      const loaded = Array.isArray(filtered.products) ? filtered.products.length : 0;
      // Filtered imports: only fail when the harvest is tiny and clearly crashed.
      const tooSmall = loaded < 100 && Boolean(browserResult.crashReason);

      if (filtered.partial && tooSmall) {
        return {
          ok: false,
          error: `Collectr only returned ${loaded.toLocaleString()} filtered items for @${slug}${
            browserResult.crashReason ? ` (${summarizeCollectrErrorDetail(browserResult.crashReason)})` : ""
          }. Try again in a minute.`,
          partial: true,
          source: browserResult.source,
          products: filtered.products,
          expectedTotal: expected || null
        };
      }

      return {
        ...filtered,
        warning:
          filtered.partial && loaded > 0
            ? `Loaded ${loaded.toLocaleString()} Cards Only / Ungraded / Pokemon items${
                browserResult.crashReason ? " before browser stopped" : ""
              }. You can import these now and re-run later for the rest.`
            : ""
      };
    }
    browserFailureReason = summarizeCollectrErrorDetail(
      browserResult?.reason || browserResult?.error || ""
    );
  }

  const byKey = new Map();
  let profile = null;
  let totalCards = 0;
  let totalSealed = 0;

  // Collectr's showcase API returns 403 without a real browser session.
  const [htmlPage, rscPage] = await Promise.all([
    fetchCollectrShowcaseHtmlPage(slug),
    fetchCollectrShowcaseRscPage(slug)
  ]);
  profile = htmlPage.profile;
  mergeCollectrProductsIntoMap(byKey, htmlPage.products);
  mergeCollectrProductsIntoMap(byKey, rscPage.products);
  totalCards = htmlPage.totalCards || rscPage.totalCards || 0;
  totalSealed = htmlPage.totalSealed || rscPage.totalSealed || 0;
  let source =
    byKey.size > htmlPage.products.length && byKey.size > rscPage.products.length
      ? "collectr-rsc"
      : byKey.size > htmlPage.products.length
        ? "collectr-html+rsc"
        : "collectr-html";

  if (!byKey.size) {
    return {
      ok: false,
      error: browserFailureReason
        ? `Could not load Collectr showcase (@${slug}): ${browserFailureReason}`
        : "Could not read this Collectr showcase. Check the link is public and try again."
    };
  }

  if (!profile) {
    profile = { handle: slug, displayName: slug, profilePhoto: null };
  }

  const expectedTotal = totalCards + totalSealed;
  const partial = expectedTotal > 0 ? byKey.size < Math.min(expectedTotal, maxItems) * 0.9 : true;

  // SSR HTML only embeds the first ~30 showcase rows. Large collections need the browser path.
  if (partial && expectedTotal > 50) {
    return {
      ok: false,
      error: browserFailureReason
        ? `Collectr showcase @${slug} has ~${expectedTotal.toLocaleString()} items, but full loading is unavailable (${browserFailureReason}).`
        : `Collectr showcase @${slug} has ~${expectedTotal.toLocaleString()} items, but only the first page could be loaded. Full import needs the server browser loader.`,
      partial: true,
      source,
      browserUnavailable: true,
      expectedTotal,
      products: [...byKey.values()].slice(0, maxItems)
    };
  }

  return applyPokemonFilterToCatalogResult(
    {
      ok: true,
      handle: slug,
      profileUrl: parsed.profileUrl,
      profile,
      products: [...byKey.values()].slice(0, maxItems),
      totalCards,
      totalSealed,
      expectedTotal: expectedTotal || null,
      source,
      partial,
      needsBrowserFetch: partial,
      browserUnavailable: useBrowser
    },
    maxItems
  );
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function summarizeCollectrProductQuantities(products) {
  const rows = Array.isArray(products) ? products : [];
  let cards = 0;
  let sealed = 0;
  for (const row of rows) {
    const qty = Math.max(1, Number(row?.quantity) || 1);
    if (row?.is_card === false) sealed += qty;
    else cards += qty;
  }
  return { cards, sealed, lineItems: rows.length };
}

function applyPokemonFilterToCatalogResult(result, maxItems) {
  if (!result?.ok) return result;
  const raw = Array.isArray(result.products) ? result.products : [];
  // Browser already requested Cards Only + Ungraded + Pokemon; local filter is a safety net.
  const products = (
    result.filteredImport
      ? raw.filter((row) => {
          if (row?.is_card === false) return false;
          if (String(row?.grade_company || "").trim()) return false;
          return isCollectrPokemonProduct(row);
        })
      : filterCollectrPokemonProducts(raw)
  ).slice(0, maxItems);
  const totals = summarizeCollectrProductQuantities(products);
  const priorFiltered = Number(result.filteredOutNonPokemon) || 0;
  const passFiltered = Math.max(0, raw.length - products.length);

  const filteredImport = Boolean(result.filteredImport);
  const showcaseTotalCards = Number(result.showcaseTotalCards || result.totalCards) || 0;
  const showcaseTotalSealed = Number(result.showcaseTotalSealed || result.totalSealed) || 0;
  // For filtered browser harvests, expected = what we loaded (or loaded so far), not full showcase size.
  const showcaseExpected = filteredImport
    ? products.length || null
    : Number(result.expectedTotal) > 0
      ? Number(result.expectedTotal)
      : showcaseTotalCards + showcaseTotalSealed > 0
        ? showcaseTotalCards + showcaseTotalSealed
        : null;
  const incomplete = filteredImport
    ? Boolean(result.partial)
    : Boolean(result.partial) ||
      (showcaseExpected > 0 && raw.length < Math.min(showcaseExpected, maxItems) * 0.9);

  return {
    ...result,
    products,
    totalCards: filteredImport ? totals.cards : showcaseTotalCards || totals.cards,
    totalSealed: filteredImport ? 0 : showcaseTotalSealed || totals.sealed,
    expectedTotal: showcaseExpected,
    filteredCardCount: totals.cards,
    filteredSealedCount: totals.sealed,
    pokemonOnly: true,
    filteredOutNonPokemon: priorFiltered + passFiltered,
    partial: incomplete,
    needsBrowserFetch: incomplete && result.source !== "collectr-browser"
  };
}

function detectSetLanguage(product) {
  const group = String(product?.catalog_group || "");
  const name = String(product?.product_name || "");
  const blob = `${group} ${name}`;
  if (/\(japanese\)|\(jp\)|japanese/i.test(blob)) return "japanese";
  return "english";
}

function isCollectrGradedProduct(product) {
  // Collectr uses grade_id for raw condition tiers too (e.g. 52 = Near Mint).
  // Treat as graded only when a grading company is present (PSA, BGS, CGC, etc.).
  const gradeCompany = String(product?.grade_company || "").trim();
  return Boolean(gradeCompany);
}

function isCollectrUngradedPokemonCard(product) {
  if (!isCollectrPokemonProduct(product)) return false;
  if (product?.is_card === false) return false;
  return !isCollectrGradedProduct(product);
}

function mapCollectrProductToItem(product) {
  if (!isCollectrUngradedPokemonCard(product)) return null;
  const name = String(product?.product_name || "").trim();
  if (!name) return null;
  const qty = Math.max(1, Number(product?.quantity) || 1);
  const market = Number(product?.market_price);

  return {
    type: "single",
    name,
    setName: String(product?.catalog_group || "").trim(),
    cardNumber: String(product?.card_number || "").trim(),
    setCode: "",
    setLanguage: detectSetLanguage(product),
    imageUrl: String(product?.image_url || "")
      .replace(/\\u0026/g, "&")
      .trim(),
    tcgProductId: String(product?.product_id || "").trim(),
    conditionType: "raw",
    condition: String(product?.card_condition || "").trim() || "Near Mint",
    gradeCompany: "",
    gradeValue: "",
    quantity: qty,
    costBasis: 0,
    currency: "USD",
    notes: product?.product_sub_type
      ? `Imported from Collectr (${product.product_sub_type})`
      : "Imported from Collectr",
    marketPrice: Number.isFinite(market) && market > 0 ? Number(market.toFixed(2)) : 0,
    manualPrice: null,
    sourceBreakdown: { collectr: true },
    lastPricedAt: null
  };
}

function itemImportKey(item) {
  return [
    item.type,
    item.name.toLowerCase(),
    item.setName.toLowerCase(),
    item.cardNumber.toLowerCase(),
    item.tcgProductId,
    item.gradeCompany.toLowerCase(),
    item.gradeValue,
    item.conditionType
  ].join("::");
}

function filterCollectrProductsByImportType(products, options = {}) {
  void options;
  // Always import ungraded Pokémon singles only (no sealed, graded, or other TCGs).
  return (Array.isArray(products) ? products : []).filter(isCollectrUngradedPokemonCard);
}

module.exports = {
  COLLECTR_ANON_USERNAME,
  parseCollectrProfileUrl,
  fetchCollectrShowcaseCatalog,
  isCollectrPokemonProduct,
  filterCollectrPokemonProducts,
  filterCollectrProductsByImportType,
  isCollectrGradedProduct,
  isCollectrUngradedPokemonCard,
  mapCollectrProductToItem,
  itemImportKey,
  mergeCollectrProductsIntoMap
};
