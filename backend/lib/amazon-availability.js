const https = require("https");
const zlib = require("zlib");
const { URL } = require("url");

const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

function getWalmartCookieHeader() {
  const raw = String(process.env.WALMART_COOKIE || "").trim();
  return raw || null;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function extractAsin(url) {
  if (!url) return null;
  const match = String(url).match(/\/dp\/([A-Z0-9]{10})(?:[/?]|$)/i);
  return match ? match[1].toUpperCase() : null;
}

function fetchHtmlWithRedirects(url, options = {}, depth = 0) {
  const maxRedirects = options.maxRedirects ?? 6;
  const timeoutMs = options.timeoutMs ?? 25000;
  return new Promise((resolve, reject) => {
    const req = https.get(
      url,
      {
        headers: {
          "User-Agent": USER_AGENT,
          "Accept-Language": "en-US,en;q=0.9",
          Accept: "text/html",
          ...(options.headers || {})
        }
      },
      (res) => {
        if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          if (depth >= maxRedirects) {
            reject(new Error(`too many redirects (${maxRedirects}) for ${url}`));
            res.resume();
            return;
          }
          const nextUrl = new URL(res.headers.location, url).href;
          fetchHtmlWithRedirects(nextUrl, options, depth + 1).then(resolve).catch(reject);
          res.resume();
          return;
        }
        if (res.statusCode !== 200) {
          reject(new Error(`HTTP ${res.statusCode} for ${url}`));
          res.resume();
          return;
        }
        const chunks = [];
        res.on("data", (chunk) => {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        });
        res.on("end", () => {
          try {
            const rawBuffer = Buffer.concat(chunks);
            const encoding = String(res.headers["content-encoding"] || "").toLowerCase();
            let decoded = rawBuffer;
            if (encoding.includes("br")) decoded = zlib.brotliDecompressSync(rawBuffer);
            else if (encoding.includes("gzip")) decoded = zlib.gunzipSync(rawBuffer);
            else if (encoding.includes("deflate")) decoded = zlib.inflateSync(rawBuffer);
            resolve({ html: decoded.toString("utf8"), finalUrl: url });
          } catch (err) {
            reject(new Error(`decode failed for ${url}: ${err.message}`));
          }
        });
      }
    );
    req.on("error", reject);
    req.setTimeout(timeoutMs, () => req.destroy(new Error("timeout")));
  });
}

function fetchAmazonHtml(asin) {
  return new Promise((resolve, reject) => {
    fetchHtmlWithRedirects(`https://www.amazon.com/dp/${asin}`)
      .then((result) => resolve(result.html))
      .catch(reject);
  });
}

function stripTags(html) {
  return String(html || "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeUsd(raw) {
  const s = String(raw || "").trim();
  if (!s) return null;
  const m = s.match(/\$?\s*([\d,]+(?:\.\d{2})?)/);
  if (!m) return null;
  const amount = Number(m[1].replace(/,/g, ""));
  if (!Number.isFinite(amount) || amount <= 0) return null;
  return `$${amount.toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  })}`;
}

function decodeHtmlEntities(raw) {
  return String(raw || "")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\\u0026/gi, "&")
    .replace(/\\\//g, "/");
}

function extractAmazonReleaseDate(text) {
  const raw = String(text || "").replace(/\s+/g, " ").trim();
  if (!raw) return null;
  const patterns = [
    /released on\s+([A-Za-z]+\s+\d{1,2},\s+\d{4})/i,
    /available on\s+([A-Za-z]+\s+\d{1,2},\s+\d{4})/i,
    /release date[:\s]+([A-Za-z]+\s+\d{1,2},\s+\d{4})/i
  ];
  for (const re of patterns) {
    const m = raw.match(re);
    if (m && m[1]) return m[1].trim();
  }
  return null;
}

function extractAmazonPreorderDate(primaryRaw = "", buyboxRaw = "") {
  const fromPrimary = extractAmazonReleaseDate(primaryRaw);
  if (fromPrimary) return fromPrimary;
  const fromBuybox = extractAmazonReleaseDate(buyboxRaw);
  if (fromBuybox) return fromBuybox;
  return null;
}

function extractAmazonPrice(html) {
  const raw = String(html || "");
  if (!raw) return null;

  const patterns = [
    /id="priceblock_(?:ourprice|dealprice|saleprice)"[^>]*>\s*([^<]+)/i,
    /id="tp_price_block_total_price_ww"[\s\S]{0,800}?class="a-offscreen">\s*([^<]+)/i,
    /priceToPay[\s\S]{0,1200}?class="a-offscreen">\s*([^<]+)/i,
    /class="a-price aok-align-center[^"]*"[\s\S]{0,600}?class="a-offscreen">\s*([^<]+)/i
  ];
  for (const re of patterns) {
    const m = raw.match(re);
    const usd = normalizeUsd(m && m[1] ? m[1] : "");
    if (usd) return usd;
  }

  const cartIdx = raw.search(/id="add-to-cart-button"/i);
  if (cartIdx !== -1) {
    const buybox = raw.slice(Math.max(0, cartIdx - 50000), cartIdx + 12000);
    const nearest = buybox.match(/\$[\d,]+(?:\.\d{2})?/);
    const usd = normalizeUsd(nearest ? nearest[0] : "");
    if (usd) return usd;
  }
  return null;
}

function resolveAmazonOfferListingUrl(html, asin) {
  const raw = String(html || "");
  if (!raw || !asin) return null;
  const patterns = [
    /href="([^"]*\/gp\/offer-listing\/[A-Z0-9]{10}[^"]*)"/i,
    /"all_offers_display"[\s\S]{0,400}?"url"\s*:\s*"([^"]+)"/i,
    /"allBuyingOptionsUrl"\s*:\s*"([^"]+)"/i,
    /(\/gp\/offer-listing\/[A-Z0-9]{10}[^\s"'\\]*)/i
  ];
  for (const re of patterns) {
    const m = raw.match(re);
    const piece = decodeHtmlEntities(m && (m[1] || m[0]) ? (m[1] || m[0]) : "").trim();
    if (!piece) continue;
    if (/^https?:\/\//i.test(piece)) return piece;
    if (piece.startsWith("/")) return `https://www.amazon.com${piece}`;
  }
  return `https://www.amazon.com/gp/offer-listing/${asin}?th=1&psc=1`;
}

function extractAmazonOfferPriceAndSeller(html) {
  const raw = String(html || "");
  if (!raw) return { price: null, seller: null };

  const pricePatterns = [
    /class="olpOfferPrice"[^>]*>\s*([^<]+)/i,
    /class="a-price-whole"[^>]*>\s*([\d,]+)\s*<\/span>[\s\S]{0,80}class="a-price-fraction"[^>]*>\s*(\d{2})/i,
    /class="a-price"[\s\S]{0,500}?class="a-offscreen">\s*([^<]+)/i,
    /class="aod-price-amount"[\s\S]{0,500}?class="a-offscreen">\s*([^<]+)/i
  ];

  let price = null;
  let priceIdx = -1;
  for (const re of pricePatterns) {
    const m = raw.match(re);
    if (!m) continue;
    const normalized = m[2] ? normalizeUsd(`${m[1]}.${m[2]}`) : normalizeUsd(m[1] || m[0]);
    if (!normalized) continue;
    price = normalized;
    priceIdx = raw.search(re);
    break;
  }

  const window =
    priceIdx >= 0
      ? raw.slice(Math.max(0, priceIdx - 12000), Math.min(raw.length, priceIdx + 18000))
      : raw;
  const sellerPatterns = [
    /id="aod-offer-soldBy"[\s\S]{0,1500}?<a[^>]*>([\s\S]*?)<\/a>/i,
    /class="olpSellerName"[\s\S]{0,600}?<a[^>]*>([\s\S]*?)<\/a>/i,
    /Ships from and sold by[\s\S]{0,200}?<[^>]*>([\s\S]*?)<\/a>/i,
    /Ships from and sold by\s*([^.<\n]+)/i
  ];

  let seller = null;
  for (const re of sellerPatterns) {
    const m = window.match(re) || raw.match(re);
    const cleaned = stripTags(decodeHtmlEntities(m && m[1] ? m[1] : "")).trim();
    if (!cleaned) continue;
    seller = cleaned.replace(/\s+/g, " ");
    break;
  }

  return { price, seller };
}

async function fetchAmazonOfferPriceAndSeller(asin, productHtml) {
  const html = String(productHtml || "");
  if (!/see all buying options/i.test(html)) {
    return { price: null, seller: null, fromOfferListing: false };
  }
  const referer = `https://www.amazon.com/dp/${asin}`;

  // Most reliable path: Amazon's AOD endpoint includes add-to-cart offer labels with seller + price.
  try {
    const aodUrl = `https://www.amazon.com/gp/product/ajax/aodAjaxMain?asin=${asin}&pc=dp`;
    const aodPage = await fetchHtmlWithRedirects(aodUrl, {
      headers: {
        Referer: referer,
        Accept: "text/html,*/*;q=0.8",
        "X-Requested-With": "XMLHttpRequest"
      }
    });
    const offerRows = [];
    const offerRe =
      /aria-label="Add to Cart from seller\s+([^"]+?)\s+and price\s+\$?([\d,]+(?:\.\d{2})?)\s*"/gi;
    let m = null;
    while ((m = offerRe.exec(aodPage.html))) {
      const seller = stripTags(decodeHtmlEntities(m[1] || "")).replace(/\s+/g, " ").trim();
      const price = normalizeUsd(m[2] || "");
      if (seller && price) {
        offerRows.push({ seller, price });
      }
    }
    if (offerRows.length) {
      // Preserve Amazon's offer ordering (typically reflects best landed offer, incl. shipping).
      const first = offerRows[0];
      return { price: first.price, seller: first.seller, fromOfferListing: true };
    }
  } catch (err) {
    // Fall through to legacy offer-listing paths.
  }

  const offerUrl = resolveAmazonOfferListingUrl(html, asin);
  if (offerUrl) {
    try {
      const offerPage = await fetchHtmlWithRedirects(offerUrl, {
        headers: {
          Referer: referer,
          Accept:
            "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8"
        }
      });
      const parsed = extractAmazonOfferPriceAndSeller(offerPage.html);
      if (parsed.price || parsed.seller) return { ...parsed, fromOfferListing: true };
    } catch (err) {
      // Fall through to AJAX listing fallback.
    }
  }

  try {
    const ajaxUrl =
      `https://www.amazon.com/gp/product/ajax/ref=dp_aod_ALL_mbc?asin=${asin}&pc=dp&experienceId=aodAjaxMain`;
    const ajaxPage = await fetchHtmlWithRedirects(ajaxUrl, {
      headers: {
        Referer: referer,
        Accept: "text/html,*/*;q=0.8",
        "X-Requested-With": "XMLHttpRequest"
      }
    });
    const parsed = extractAmazonOfferPriceAndSeller(ajaxPage.html);
    if (parsed.price || parsed.seller) return { ...parsed, fromOfferListing: true };
  } catch (err) {
    return { price: null, seller: null, fromOfferListing: true };
  }
  return { price: null, seller: null, fromOfferListing: true };
}

function extractTargetPrice(html) {
  const raw = String(html || "");
  if (!raw) return null;
  const patterns = [
    /"formatted_current_price"\s*:\s*"(\$[^"]+)"/i,
    /"current_retail"\s*:\s*([0-9]+(?:\.[0-9]+)?)/i,
    /"currentPrice"\s*:\s*\{\s*"value"\s*:\s*([0-9]+(?:\.[0-9]+)?)/i
  ];
  for (const re of patterns) {
    const m = raw.match(re);
    const usd = normalizeUsd(m && m[1] ? m[1] : "");
    if (usd) return usd;
  }
  return null;
}

function extractWalmartPrice(html) {
  const raw = String(html || "");
  if (!raw) return null;
  const patterns = [
    /"priceString"\s*:\s*"(\$[^"]+)"/i,
    /"currentPrice"\s*:\s*\{\s*"price"\s*:\s*([0-9]+(?:\.[0-9]+)?)/i,
    /"price"\s*:\s*"([0-9]+(?:\.[0-9]+)?)"/i
  ];
  for (const re of patterns) {
    const m = raw.match(re);
    const usd = normalizeUsd(m && m[1] ? m[1] : "");
    if (usd) return usd;
  }
  return null;
}

function extractTrollAndToadPrice(html) {
  const raw = String(html || "");
  if (!raw) return null;
  const patterns = [
    /Regular price\s*[^$]*\$\s*([\d,]+(?:\.\d{2})?)/i,
    /Current price\s*[^$]*\$\s*([\d,]+(?:\.\d{2})?)/i,
    /"price"\s*:\s*"([\d,]+(?:\.\d{2})?)"/i
  ];
  for (const re of patterns) {
    const m = raw.match(re);
    const usd = normalizeUsd(m && m[1] ? `$${m[1]}` : "");
    if (usd) return usd;
  }
  return null;
}

function extractTrollAndToadRemaining(html) {
  const raw = String(html || "");
  if (!raw) return null;
  return extractRemainingQtyFromHtml(raw);
}

function extractRemainingQtyFromHtml(html) {
  const raw = String(html || "");
  if (!raw) return null;
  const patterns = [
    /only\s+(\d{1,4})\s+left\s+in\s+stock/i,
    /(\d{1,4})\s+left\s+in\s+stock/i,
    /(\d{1,4})\s+in\s+stock/i,
    /only\s+(\d{1,4})\s+left!/i,
    /limited to\s+(\d{1,4})\s+(?:items?|units?)\s+left/i,
    /(\d{1,4})\s+(?:items?|units?)\s+left\s+in\s+stock/i
  ];
  for (const re of patterns) {
    const m = raw.match(re);
    const qty = Number(m && m[1] ? m[1] : NaN);
    if (Number.isFinite(qty) && qty > 0 && qty <= 10000) return qty;
  }
  return null;
}

/**
 * Read Amazon buybox availability from product HTML.
 * @returns {{ status: string, statusLabel: string } | null}
 */
function detectAmazonAvailability(html) {
  if (!html) return null;

  const primaryMatch = html.match(
    /primary-availability-message[^>]*>([\s\S]*?)<\/span>/i
  );
  const primaryRaw = stripTags(primaryMatch ? primaryMatch[1] : "");
  const primaryText = primaryRaw.toLowerCase();
  const cartIdx = html.search(/id="add-to-cart-button"/i);
  const buyboxRaw =
    cartIdx !== -1
      ? stripTags(html.slice(Math.max(0, cartIdx - 35000), cartIdx + 10000))
      : "";
  const buyboxText = buyboxRaw.toLowerCase();
  const preorderDate = extractAmazonPreorderDate(primaryRaw, buyboxRaw);
  const preorderLabel = preorderDate ? `Preorder - ${preorderDate}` : "Preorder";

  if (primaryText.includes("in stock") || /only \d+ left/.test(primaryText)) {
    return { status: "in_stock", statusLabel: "In Stock" };
  }
  if (
    primaryText.includes("pre-order") ||
    primaryText.includes("preorder") ||
    primaryText.includes("released on")
  ) {
    return { status: "preorder", statusLabel: preorderLabel };
  }
  if (
    primaryText.includes("currently unavailable") ||
    primaryText.includes("out of stock") ||
    primaryText.includes("unavailable")
  ) {
    return { status: "out_of_stock", statusLabel: "Out of Stock" };
  }

  if (cartIdx !== -1) {
    if (
      buyboxText.includes("pre-order") ||
      buyboxText.includes("preorder") ||
      buyboxText.includes("released on")
    ) {
      return { status: "preorder", statusLabel: preorderLabel };
    }
    if (
      buyboxText.includes("currently unavailable") ||
      buyboxText.includes("out of stock") ||
      buyboxText.includes("unavailable")
    ) {
      return { status: "out_of_stock", statusLabel: "Out of Stock" };
    }
    return { status: "in_stock", statusLabel: "In Stock" };
  }

  if (
    html.includes("Ships from and sold by Amazon.com") &&
    !/Currently unavailable/i.test(html.slice(0, 250000))
  ) {
    return { status: "in_stock", statusLabel: "In Stock" };
  }

  if (/Currently unavailable/i.test(html.slice(0, 250000))) {
    return { status: "out_of_stock", statusLabel: "Out of Stock" };
  }

  return null;
}

async function fetchAmazonAvailability(asin) {
  const html = await fetchAmazonHtml(asin);
  return detectAmazonAvailability(html);
}

function detectTargetAvailability(html) {
  if (!html) return null;
  const s = String(html).toLowerCase();
  if (s.includes("out of stock") || s.includes("sold out") || s.includes("temporarily out of stock")) {
    return { status: "out_of_stock", statusLabel: "Out of Stock" };
  }
  if (
    s.includes("add to cart") ||
    s.includes("pickup not available") ||
    s.includes("shipping available")
  ) {
    return { status: "in_stock", statusLabel: "In Stock" };
  }
  return null;
}

function detectWalmartAvailability(html) {
  if (!html) return null;
  const s = String(html).toLowerCase();
  if (
    s.includes("out of stock") ||
    s.includes("sold out") ||
    s.includes("currently unavailable")
  ) {
    return { status: "out_of_stock", statusLabel: "Out of Stock" };
  }
  if (
    s.includes("add to cart") ||
    s.includes("buy now") ||
    s.includes('"availabilitystatus":"instock"')
  ) {
    return { status: "in_stock", statusLabel: "In Stock" };
  }
  return null;
}

function detectTrollAndToadAvailability(html) {
  if (!html) return null;
  const s = String(html).toLowerCase();
  const hasExplicitInStock =
    s.includes("add to cart") ||
    /only\s+\d+\s+left\s+in\s+stock/i.test(s) ||
    /\d+\s+in\s+stock/i.test(s);
  if (hasExplicitInStock) {
    return { status: "in_stock", statusLabel: "In Stock" };
  }
  if (/pre[\s-]?order/i.test(s)) {
    return { status: "preorder", statusLabel: "Preorder" };
  }
  if (s.includes("sold out") || s.includes("out of stock")) {
    return { status: "out_of_stock", statusLabel: "Out of Stock" };
  }
  return null;
}

function extractDeriumPrice(html) {
  const raw = String(html || "");
  if (!raw) return null;
  const patterns = [
    /Current price\s*[^$]*\$\s*([\d,]+(?:\.\d{2})?)/i,
    /Regular price\s*[^$]*\$\s*([\d,]+(?:\.\d{2})?)/i,
    /"price"\s*:\s*"([\d,]+(?:\.\d{2})?)"/i
  ];
  for (const re of patterns) {
    const m = raw.match(re);
    const usd = normalizeUsd(m && m[1] ? `$${m[1]}` : "");
    if (usd) return usd;
  }
  return null;
}

function detectDeriumAvailability(html) {
  if (!html) return null;
  const s = String(html).toLowerCase();
  const hasExplicitInStock =
    s.includes("add to cart") ||
    s.includes("low stock") ||
    /only\s+\d+\s+left/i.test(s) ||
    /\d+\s+in stock/i.test(s);
  if (hasExplicitInStock) {
    return { status: "in_stock", statusLabel: "In Stock" };
  }
  if (/pre[\s-]?order/i.test(s)) {
    return { status: "preorder", statusLabel: "Preorder" };
  }
  if (s.includes("sold out") || s.includes("out of stock")) {
    return { status: "out_of_stock", statusLabel: "Out of Stock" };
  }
  return null;
}

function extractSmokeAndMirrorsPrice(html) {
  const raw = String(html || "");
  if (!raw) return null;
  const patterns = [
    /Current price\s*[^$]*\$\s*([\d,]+(?:\.\d{2})?)/i,
    /Regular price\s*[^$]*\$\s*([\d,]+(?:\.\d{2})?)/i,
    /class="price-item[^"]*"[^>]*>\s*\$?\s*([\d,]+(?:\.\d{2})?)/i,
    /"price"\s*:\s*"?([\d,]+(?:\.\d{2})?)"?/i
  ];
  for (const re of patterns) {
    const m = raw.match(re);
    const usd = normalizeUsd(m && m[1] ? `$${m[1]}` : "");
    if (usd) return usd;
  }
  return null;
}

function detectSmokeAndMirrorsAvailability(html) {
  if (!html) return null;
  // Prefer structured Shopify / schema signals — theme HTML always contains "sold out".
  const schema = html.match(
    /"availability"\s*:\s*"(https?:\/\/schema\.org\/(InStock|OutOfStock|PreOrder|LimitedAvailability)[^"]*)"/i
  );
  if (schema) {
    const kind = String(schema[2] || "").toLowerCase();
    if (kind === "instock" || kind === "limitedavailability") {
      return { status: "in_stock", statusLabel: "In Stock" };
    }
    if (kind === "preorder") return { status: "preorder", statusLabel: "Preorder" };
    if (kind === "outofstock") return { status: "out_of_stock", statusLabel: "Out of Stock" };
  }
  const availableTrue = (html.match(/"available"\s*:\s*true/gi) || []).length;
  const availableFalse = (html.match(/"available"\s*:\s*false/gi) || []).length;
  if (availableTrue > 0 && availableFalse === 0) {
    return { status: "in_stock", statusLabel: "In Stock" };
  }
  if (availableFalse > 0 && availableTrue === 0) {
    return { status: "out_of_stock", statusLabel: "Out of Stock" };
  }
  if (/name="add"[^>]*disabled|class="[^"]*sold-out[^"]*"|Sold out<\/button>/i.test(html)) {
    return { status: "out_of_stock", statusLabel: "Out of Stock" };
  }
  if (/name="add"(?![^>]*disabled)|>\s*Add to cart\s*</i.test(html)) {
    return { status: "in_stock", statusLabel: "In Stock" };
  }
  return null;
}

function extractWholesaleGamingPrice(html) {
  const raw = String(html || "");
  if (!raw) return null;
  const patterns = [
    /class="price"[^>]*>\s*\$?\s*([\d,]+(?:\.\d{2})?)/i,
    /"price"\s*:\s*"?\$?([\d,]+(?:\.\d{2})?)"?/i,
    /\$[\d,]+(?:\.\d{2})?/
  ];
  for (const re of patterns) {
    const m = raw.match(re);
    const token = m && m[1] ? `$${m[1]}` : m && m[0] ? m[0] : "";
    const usd = normalizeUsd(token);
    if (usd) return usd;
  }
  return null;
}

function detectWholesaleGamingAvailability(html) {
  if (!html) return null;
  const s = String(html).toLowerCase();
  if (s.includes("out of stock") || s.includes("sold out")) {
    return { status: "out_of_stock", statusLabel: "Out of Stock" };
  }
  if (/pre[\s-]?order/i.test(s)) {
    return { status: "preorder", statusLabel: "Preorder" };
  }
  if (s.includes("add to cart") || s.includes("add to basket")) {
    return { status: "in_stock", statusLabel: "In Stock" };
  }
  return null;
}

function extractPokeNePrice(html) {
  const raw = String(html || "");
  if (!raw) return null;
  const patterns = [
    /"formattedPrice"\s*:\s*"(\$[\d,]+(?:\.\d{2})?)"/i,
    /"formattedDiscountedPrice"\s*:\s*"(\$[\d,]+(?:\.\d{2})?)"/i,
    /Price\s*\$([\d,]+(?:\.\d{2})?)/i,
    /Current price\s*\$([\d,]+(?:\.\d{2})?)/i,
    /"price"\s*:\s*"?\$?([\d,]+(?:\.\d{2})?)"?/i
  ];
  for (const re of patterns) {
    const m = raw.match(re);
    const token = m && m[1] ? (String(m[1]).startsWith("$") ? m[1] : `$${m[1]}`) : "";
    const usd = normalizeUsd(token);
    if (usd) return usd;
  }
  return null;
}

function detectPokeNeAvailability(html) {
  if (!html) return null;
  const og = html.match(/property="og:availability"\s+content="([^"]+)"/i);
  if (og) {
    const value = String(og[1] || "").toLowerCase();
    if (value.includes("instock") || value === "in stock") {
      return { status: "in_stock", statusLabel: "In Stock" };
    }
    if (value.includes("preorder") || value.includes("pre-order")) {
      return { status: "preorder", statusLabel: "Preorder" };
    }
    if (value.includes("outofstock") || value.includes("out of stock") || value.includes("soldout")) {
      return { status: "out_of_stock", statusLabel: "Out of Stock" };
    }
  }
  if (/"isInStock"\s*:\s*true/i.test(html)) {
    return { status: "in_stock", statusLabel: "In Stock" };
  }
  if (/"isInStock"\s*:\s*false/i.test(html)) {
    return { status: "out_of_stock", statusLabel: "Out of Stock" };
  }
  return null;
}

async function fetchTargetAvailability(url) {
  const result = await fetchHtmlWithRedirects(url, {
    headers: {
      Referer: "https://www.target.com/",
      Accept:
        "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8"
    }
  });
  return detectTargetAvailability(result.html);
}

async function fetchWalmartAvailability(url) {
  const cookie = getWalmartCookieHeader();
  const result = await fetchHtmlWithRedirects(url, {
    headers: {
      Referer: "https://www.walmart.com/",
      Accept:
        "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
      ...(cookie ? { Cookie: cookie } : {})
    }
  });
  return detectWalmartAvailability(result.html);
}

async function refreshInStockPrices(items, options = {}) {
  const delayMs = options.delayMs ?? 500;
  const onlyMissing = options.onlyMissing ?? true;
  const verifyStatuses = Array.isArray(options.verifyStatuses) && options.verifyStatuses.length
    ? new Set(options.verifyStatuses.map((s) => String(s || "").toLowerCase()))
    : new Set(["in_stock"]);
  const skipRetailers = new Set(
    (Array.isArray(options.skipRetailers) ? options.skipRetailers : []).map((s) => String(s || ""))
  );
  const onlyRetailers = Array.isArray(options.onlyRetailers)
    ? new Set(options.onlyRetailers.map((s) => String(s || "")).filter(Boolean))
    : null;
  const updated = [];
  const statusReliableRetailers = new Set([
    "Amazon",
    "Target",
    "Walmart",
    "Troll and Toad",
    "Derium",
    "Smoke & Mirrors Hobby",
    "Wholesale Gaming",
    "PokeNE"
  ]);

  const candidates = items.filter((item) => {
    const retailer = String(item.retailer || "");
    if (skipRetailers.has(retailer)) return false;
    if (onlyRetailers && !onlyRetailers.has(retailer)) return false;
    if (
      retailer !== "Amazon" &&
      retailer !== "Target" &&
      retailer !== "Walmart" &&
      retailer !== "Troll and Toad" &&
      retailer !== "Derium" &&
      retailer !== "Smoke & Mirrors Hobby" &&
      retailer !== "Wholesale Gaming" &&
      retailer !== "PokeNE"
    ) {
      return false;
    }
    const status = String(item.status || "").toLowerCase();
    if (!verifyStatuses.has(status)) return false;
    if (!item.productUrl && !item.statusUrl) return false;
    if (!onlyMissing || status !== "in_stock") return true;
    return !/^\$[\d,]+(?:\.\d{2})?$/.test(String(item.lastPrice || "").trim());
  });

  const onProgress = typeof options.onProgress === "function" ? options.onProgress : null;
  if (onProgress) {
    onProgress({ current: 0, total: candidates.length, name: "", retailer: "" });
  }

  for (let index = 0; index < candidates.length; index += 1) {
    const item = candidates[index];
    const url = String(item.productUrl || item.statusUrl || "");
    try {
      let html = "";
      let price = null;
      let amazonOfferSeller = null;
      let parsedRemainingQty = null;
      let live = null;

      if (item.retailer === "Amazon") {
        const asin = extractAsin(url);
        if (!asin) {
          if (onProgress) {
            onProgress({
              current: index + 1,
              total: candidates.length,
              name: item.name || "",
              retailer: item.retailer || ""
            });
          }
          continue;
        }
        html = await fetchAmazonHtml(asin);
        price = extractAmazonPrice(html);
        parsedRemainingQty = extractRemainingQtyFromHtml(html);
        live = detectAmazonAvailability(html);
        if (!price) {
          const offerFallback = await fetchAmazonOfferPriceAndSeller(asin, html);
          if (offerFallback.price) price = offerFallback.price;
          if (offerFallback.seller) amazonOfferSeller = offerFallback.seller;
          if (!offerFallback.seller && offerFallback.price && offerFallback.fromOfferListing) {
            amazonOfferSeller = "Seller not listed";
          }
        }
        item.amazonVerifiedAt = new Date().toISOString();
      } else if (item.retailer === "Target") {
        const result = await fetchHtmlWithRedirects(url, {
          headers: {
            Referer: "https://www.target.com/",
            Accept:
              "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8"
          }
        });
        html = result.html;
        price = extractTargetPrice(html);
        parsedRemainingQty = extractRemainingQtyFromHtml(html);
        live = detectTargetAvailability(html);
        item.targetVerifiedAt = new Date().toISOString();
      } else if (item.retailer === "Walmart") {
        const cookie = getWalmartCookieHeader();
        const result = await fetchHtmlWithRedirects(url, {
          headers: {
            Referer: "https://www.walmart.com/",
            Accept:
              "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
            ...(cookie ? { Cookie: cookie } : {})
          }
        });
        html = result.html;
        price = extractWalmartPrice(html);
        parsedRemainingQty = extractRemainingQtyFromHtml(html);
        live = detectWalmartAvailability(html);
        item.walmartVerifiedAt = new Date().toISOString();
      } else if (item.retailer === "Troll and Toad") {
        const result = await fetchHtmlWithRedirects(url, {
          headers: {
            Referer: "https://www.trollandtoad.com/",
            Accept:
              "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8"
          }
        });
        html = result.html;
        price = extractTrollAndToadPrice(html);
        parsedRemainingQty = extractTrollAndToadRemaining(html);
        live = detectTrollAndToadAvailability(html);
      } else if (item.retailer === "Derium") {
        const result = await fetchHtmlWithRedirects(url, {
          headers: {
            Referer: "https://deriumandwifey.com/",
            Accept:
              "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8"
          }
        });
        html = result.html;
        price = extractDeriumPrice(html);
        parsedRemainingQty = extractRemainingQtyFromHtml(html);
        live = detectDeriumAvailability(html);
      } else if (item.retailer === "Smoke & Mirrors Hobby") {
        const result = await fetchHtmlWithRedirects(url, {
          headers: {
            Referer: "https://smokeandmirrorshobby.com/",
            Accept:
              "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8"
          }
        });
        html = result.html;
        price = extractSmokeAndMirrorsPrice(html);
        parsedRemainingQty = extractRemainingQtyFromHtml(html);
        live = detectSmokeAndMirrorsAvailability(html);
      } else if (item.retailer === "Wholesale Gaming") {
        const result = await fetchHtmlWithRedirects(url, {
          headers: {
            Referer: "https://wholesalegaming.com/",
            Accept:
              "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8"
          }
        });
        html = result.html;
        price = extractWholesaleGamingPrice(html);
        parsedRemainingQty = extractRemainingQtyFromHtml(html);
        live = detectWholesaleGamingAvailability(html);
      } else if (item.retailer === "PokeNE") {
        const result = await fetchHtmlWithRedirects(url, {
          headers: {
            Referer: "https://www.pokene.com/",
            Accept:
              "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8"
          }
        });
        html = result.html;
        price = extractPokeNePrice(html);
        parsedRemainingQty = extractRemainingQtyFromHtml(html);
        live = detectPokeNeAvailability(html);
      }

      const prevPrice = item.lastPrice || null;
      const nextPrice = price || item.lastPrice || null;
      const prevSeller = item.lastSeller || null;
      const nextSeller =
        item.retailer === "Amazon" && amazonOfferSeller ? amazonOfferSeller : item.lastSeller || null;
      const priceChanged = Boolean(nextPrice && nextPrice !== prevPrice);
      const sellerChanged = Boolean(nextSeller && nextSeller !== prevSeller);
      const prevRemaining = Number(item.remainingQty || 0);
      if (Number.isFinite(parsedRemainingQty) && parsedRemainingQty > 0) {
        item.remainingQty = parsedRemainingQty;
      }
      const nextRemaining = Number(item.remainingQty || 0);
      const remainingChanged = nextRemaining !== prevRemaining;
      if (priceChanged) item.lastPrice = nextPrice;
      if (sellerChanged) item.lastSeller = nextSeller;
      const prevStatus = String(item.status || "");
      let statusChanged = false;
      const canUpdateStatus = statusReliableRetailers.has(String(item.retailer || ""));
      if (canUpdateStatus && live && live.status && live.status !== item.status) {
        item.status = live.status;
        item.statusLabel = live.statusLabel || item.statusLabel || "";
        statusChanged = true;
      } else if (canUpdateStatus && live && live.statusLabel) {
        item.statusLabel = live.statusLabel;
      }
      if (item.status === "in_stock") {
        item.lastAvailable = new Date().toISOString();
      } else if (item.status !== "in_stock" && Number(item.remainingQty || 0) > 0) {
        delete item.remainingQty;
      }

      if (priceChanged || sellerChanged || remainingChanged || statusChanged) {
        updated.push({
          retailer: item.retailer,
          name: item.name,
          statusFrom: prevStatus || null,
          statusTo: item.status || null,
          from: prevPrice,
          to: nextPrice,
          seller: nextSeller,
          remainingQty: Number.isFinite(nextRemaining) && nextRemaining > 0 ? nextRemaining : null,
          url
        });
      }
    } catch (err) {
      console.warn(`${item.retailer} price refresh skipped ${url}: ${err.message}`);
    }
    if (onProgress) {
      onProgress({
        current: index + 1,
        total: candidates.length,
        name: item.name || "",
        retailer: item.retailer || ""
      });
    }
    if (delayMs > 0) await sleep(delayMs);
  }

  return updated;
}

/**
 * Reconcile Amazon rows against live product pages (NowInStock preorder labels are often stale).
 */
async function refreshAmazonItems(items, options = {}) {
  const verifyStatuses = Array.isArray(options.verifyStatuses) && options.verifyStatuses.length
    ? new Set(options.verifyStatuses.map((s) => String(s || "").toLowerCase()))
    : new Set(["preorder", "out_of_stock"]);
  const delayMs = options.delayMs ?? 450;
  const updated = [];

  const candidates = items.filter((item) => {
    if (item.retailer !== "Amazon") return false;
    const asin = extractAsin(item.productUrl || item.statusUrl);
    if (!asin) return false;
    const status = String(item.status || "").toLowerCase();
    if (!verifyStatuses.has(status)) return false;
    return true;
  });

  const onProgress = typeof options.onProgress === "function" ? options.onProgress : null;
  if (onProgress) {
    onProgress({ current: 0, total: candidates.length, name: "" });
  }

  for (let index = 0; index < candidates.length; index += 1) {
    const item = candidates[index];
    const asin = extractAsin(item.productUrl || item.statusUrl);
    try {
      const live = await fetchAmazonAvailability(asin);
      if (live && live.status !== item.status) {
        const prev = item.status;
        item.status = live.status;
        item.statusLabel = live.statusLabel;
        item.amazonVerifiedAt = new Date().toISOString();
        updated.push({ asin, name: item.name, from: prev, to: live.status });
      } else if (live) {
        item.statusLabel = live.statusLabel;
        item.amazonVerifiedAt = new Date().toISOString();
      }
    } catch (err) {
      console.warn(`Amazon verify skipped ${asin}: ${err.message}`);
    }
    if (onProgress) {
      onProgress({
        current: index + 1,
        total: candidates.length,
        name: item.name || ""
      });
    }
    if (delayMs > 0) await sleep(delayMs);
  }

  return updated;
}

/**
 * Reconcile Target + Walmart stale statuses against live product pages.
 * Target relies on nowinstock mavely links and may not always resolve.
 */
async function refreshTargetWalmartItems(items, options = {}) {
  const verifyStatuses = Array.isArray(options.verifyStatuses) && options.verifyStatuses.length
    ? new Set(options.verifyStatuses.map((s) => String(s || "").toLowerCase()))
    : new Set(["preorder", "out_of_stock"]);
  const delayMs = options.delayMs ?? 550;
  const updated = [];

  const candidates = items.filter((item) => {
    const retailer = String(item.retailer || "");
    if (retailer !== "Target" && retailer !== "Walmart") return false;
    const status = String(item.status || "").toLowerCase();
    if (!verifyStatuses.has(status)) return false;
    const url = item.statusUrl || item.productUrl;
    return Boolean(url && /^https?:\/\//i.test(String(url)));
  });

  for (const item of candidates) {
    const url = String(item.statusUrl || item.productUrl || "");
    try {
      const live =
        item.retailer === "Target"
          ? await fetchTargetAvailability(url)
          : await fetchWalmartAvailability(url);
      if (live && live.status !== item.status) {
        const prev = item.status;
        item.status = live.status;
        item.statusLabel = live.statusLabel;
        if (item.retailer === "Target") item.targetVerifiedAt = new Date().toISOString();
        if (item.retailer === "Walmart") item.walmartVerifiedAt = new Date().toISOString();
        updated.push({
          retailer: item.retailer,
          name: item.name,
          from: prev,
          to: live.status,
          url
        });
      } else if (live) {
        item.statusLabel = live.statusLabel;
        if (item.retailer === "Target") item.targetVerifiedAt = new Date().toISOString();
        if (item.retailer === "Walmart") item.walmartVerifiedAt = new Date().toISOString();
      }
    } catch (err) {
      console.warn(`${item.retailer} verify skipped ${url}: ${err.message}`);
    }
    if (delayMs > 0) await sleep(delayMs);
  }

  return updated;
}

module.exports = {
  extractAsin,
  detectAmazonAvailability,
  fetchAmazonAvailability,
  refreshAmazonItems,
  detectTargetAvailability,
  detectWalmartAvailability,
  refreshTargetWalmartItems,
  refreshInStockPrices
};
