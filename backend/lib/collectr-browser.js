"use strict";

const fs = require("fs");

const COLLECTR_ANON_USERNAME = "00000000-0000-0000-0000-000000000000";
/** Collectr showcase infinite query pages exactly 30 rows (see getNextPageParam: 30*pages). */
const API_PAGE_SIZE = 30;
const PAGE_DELAY_MS = 120;
const COLLECTR_LOADER_VERSION = "2026-07-13-nav-paging-v8";
const STEALTH_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

/** Collectr filter ids: Cards Only, Ungraded Cards, Pokemon category. */
const COLLECTR_IMPORT_FILTER_IDS = ["cards", "ungraded", "3"];
const COLLECTR_IMPORT_FILTERS_PARAM = COLLECTR_IMPORT_FILTER_IDS.join(",");

function showcaseApiPath(handle) {
  const slug = String(handle || "")
    .trim()
    .toLowerCase()
    .replace(/^@+/, "");
  // Collectr profile routes use @handle in the showcase API path.
  return `@${encodeURIComponent(slug)}`;
}

function buildShowcaseApiUrl(handle, offset = 0, limit = API_PAGE_SIZE) {
  const params = new URLSearchParams({
    searchString: "",
    offset: String(Math.max(0, Number(offset) || 0)),
    limit: String(API_PAGE_SIZE),
    id: "",
    sortType: "",
    sortOrder: "",
    groupId: "",
    filters: COLLECTR_IMPORT_FILTERS_PARAM,
    unstackedView: "true",
    username: COLLECTR_ANON_USERNAME
  });
  // limit is fixed at Collectr's page size; ignore callers asking for other sizes.
  void limit;
  return `https://api-v2.getcollectr.com/data/showcase/${showcaseApiPath(handle)}?${params}`;
}

function buildShowcaseProfileUrl(handle) {
  const slug = String(handle || "")
    .trim()
    .toLowerCase()
    .replace(/^@+/, "");
  const params = new URLSearchParams({
    selectedFilters: COLLECTR_IMPORT_FILTERS_PARAM
  });
  return `https://app.getcollectr.com/showcase/profile/@${encodeURIComponent(slug)}?${params}`;
}

function productKey(row) {
  return `${row?.product_id || ""}::${row?.grade_id || ""}::${row?.product_sub_type || ""}`;
}

function mergeProductsByKey(byKey, rows) {
  if (!byKey || !Array.isArray(rows)) return 0;
  let added = 0;
  for (const row of rows) {
    if (!row?.product_id) continue;
    const key = productKey(row);
    if (byKey.has(key)) continue;
    byKey.set(key, row);
    added += 1;
  }
  return added;
}

function isShowcaseApiUrl(url, handle) {
  const text = String(url || "");
  if (!text.includes("api-v2.getcollectr.com/data/showcase/")) return false;
  const path = showcaseApiPath(handle);
  return text.includes(`/data/showcase/${path}`) || text.includes(`/data/showcase/@${handle}`);
}

function summarizeFailureReason(reason = "") {
  return String(reason || "")
    .split(/Browser logs:/i)[0]
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 180);
}

function isDebianChromiumWrapper(filePath) {
  const normalized = String(filePath || "").replace(/\\/g, "/").toLowerCase();
  if (normalized === "/usr/bin/chromium" || normalized === "/usr/bin/chromium-browser") {
    return true;
  }
  try {
    const head = fs.readFileSync(filePath, { encoding: "utf8", flag: "r" }).slice(0, 200);
    return head.startsWith("#!") && /chromium/i.test(head);
  } catch {
    return false;
  }
}

function resolveChromiumExecutablePath() {
  try {
    const { chromium } = require("playwright-core");
    const bundled = String(chromium.executablePath?.() || "").trim();
    if (bundled && fs.existsSync(bundled) && !isDebianChromiumWrapper(bundled)) {
      return bundled;
    }
  } catch {
    // ignore
  }

  const fromEnv = String(
    process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ||
      process.env.CHROME_PATH ||
      process.env.CHROMIUM_PATH ||
      ""
  ).trim();
  if (fromEnv && fs.existsSync(fromEnv) && !isDebianChromiumWrapper(fromEnv)) {
    return fromEnv;
  }

  const candidates =
    process.platform === "win32"
      ? [
          `${process.env.PROGRAMFILES || "C:\\Program Files"}\\Google\\Chrome\\Application\\chrome.exe`,
          `${process.env["PROGRAMFILES(X86)"] || "C:\\Program Files (x86)"}\\Google\\Chrome\\Application\\chrome.exe`,
          `${process.env.LOCALAPPDATA || ""}\\Google\\Chrome\\Application\\chrome.exe`,
          `${process.env["PROGRAMFILES(X86)"] || "C:\\Program Files (x86)"}\\Microsoft\\Edge\\Application\\msedge.exe`,
          `${process.env.PROGRAMFILES || "C:\\Program Files"}\\Microsoft\\Edge\\Application\\msedge.exe`
        ]
      : [
          "/usr/local/bin/playwright-chromium",
          "/usr/lib/chromium/chromium",
          "/usr/lib/chromium-browser/chromium",
          "/usr/bin/google-chrome-stable",
          "/usr/bin/google-chrome"
        ];

  for (const candidate of candidates) {
    if (!candidate) continue;
    try {
      if (fs.existsSync(candidate) && !isDebianChromiumWrapper(candidate)) return candidate;
    } catch {
      // ignore
    }
  }
  return "";
}

function isClosedError(err) {
  const msg = String(err?.message || err || "").toLowerCase();
  return (
    msg.includes("has been closed") ||
    msg.includes("target closed") ||
    msg.includes("browser has been closed") ||
    msg.includes("connection closed") ||
    msg.includes("protocol error")
  );
}

async function launchStealthBrowser() {
  let chromium;
  try {
    chromium = require("playwright-core").chromium;
  } catch {
    return { ok: false, reason: "playwright-core not installed" };
  }

  const launchOptions = {
    headless: true,
    args: [
      "--disable-blink-features=AutomationControlled",
      "--no-sandbox",
      "--disable-dev-shm-usage",
      "--disable-gpu",
      "--disable-extensions",
      "--disable-background-networking",
      "--disable-default-apps",
      "--disable-sync",
      "--disable-translate",
      "--mute-audio",
      "--no-first-run",
      "--renderer-process-limit=1",
      "--js-flags=--max-old-space-size=256"
    ]
  };

  const executablePath = resolveChromiumExecutablePath();
  if (executablePath) {
    launchOptions.executablePath = executablePath;
  } else {
    return {
      ok: false,
      reason:
        "Playwright Chromium is not installed in this container (refusing Debian /usr/bin/chromium wrapper)"
    };
  }

  if (isDebianChromiumWrapper(executablePath)) {
    return {
      ok: false,
      reason: "Refusing Debian Chromium wrapper; Playwright Chromium is required"
    };
  }

  try {
    return { ok: true, browser: await chromium.launch(launchOptions), executablePath };
  } catch (err) {
    try {
      return {
        ok: true,
        browser: await chromium.launch({
          headless: true,
          args: launchOptions.args.filter((a) => a !== "--renderer-process-limit=1")
        }),
        executablePath: ""
      };
    } catch (err2) {
      return {
        ok: false,
        reason: summarizeFailureReason(err2.message || err.message || "Could not launch browser")
      };
    }
  }
}

async function newStealthContext(browser) {
  const context = await browser.newContext({
    userAgent: STEALTH_USER_AGENT,
    viewport: { width: 800, height: 600 },
    javaScriptEnabled: true,
    extraHTTPHeaders: {
      "sec-ch-ua": '"Not_A Brand";v="8", "Chromium";v="120", "Google Chrome";v="120"',
      "sec-ch-ua-mobile": "?0",
      "sec-ch-ua-platform": '"Linux"',
      "Accept-Language": "en-US,en;q=0.9"
    }
  });
  await context.addInitScript(() => {
    Object.defineProperty(navigator, "webdriver", { get: () => undefined });
  });

  // Keep only document shells + showcase JSON. Abort the Collectr SPA so Chromium
  // does not OOM on their profile page.
  await context.route("**/*", async (route) => {
    const req = route.request();
    const type = req.resourceType();
    const url = req.url();
    if (url.includes("api-v2.getcollectr.com/data/showcase/")) {
      await route.continue({
        headers: {
          ...req.headers(),
          Accept: "application/json, text/plain, */*",
          Origin: "https://app.getcollectr.com",
          Referer: req.headers().referer || "https://app.getcollectr.com/"
        }
      });
      return;
    }
    if (type === "document") {
      await route.continue();
      return;
    }
    await route.abort();
  });

  return { context };
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
    while (searchFrom < String(html || "").length) {
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
              const key = productKey(row);
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
      if (!advanced) searchFrom = arrStart;
    }
  }
  return [...byKey.values()];
}

function extractTotalsFromCollectrHtml(html) {
  const totalCardsMatch = String(html || "").match(/total_cards\\":\\"(\d+)\\"/);
  const totalSealedMatch = String(html || "").match(/total_sealed\\":\\"(\d+)\\"/);
  return {
    totalCards: totalCardsMatch ? Number(totalCardsMatch[1]) : 0,
    totalSealed: totalSealedMatch ? Number(totalSealedMatch[1]) : 0
  };
}

/**
 * Collectr WAF/CORS blocks page.evaluate(fetch) from a blank shell.
 * Prefer Chromium document navigation; fall back to the browser context request API.
 */
async function fetchShowcasePageViaNavigation(page, handle, offset) {
  const apiUrl = buildShowcaseApiUrl(handle, offset, API_PAGE_SIZE);
  const profileUrl = buildShowcaseProfileUrl(handle);
  const response = await page.goto(apiUrl, {
    waitUntil: "domcontentloaded",
    timeout: 45_000,
    referer: profileUrl
  });
  if (!response) {
    throw new Error("No response from Collectr API");
  }
  const status = response.status();
  const text = await response.text();
  if (status >= 400) {
    throw new Error(`Collectr API ${status}`);
  }
  const trimmed = String(text || "").trim();
  if (!trimmed || trimmed.startsWith("<")) {
    throw new Error(`Collectr API returned non-JSON (${status})`);
  }
  return JSON.parse(trimmed);
}

async function fetchShowcasePageViaContextRequest(context, handle, offset) {
  const apiUrl = buildShowcaseApiUrl(handle, offset, API_PAGE_SIZE);
  const profileUrl = buildShowcaseProfileUrl(handle);
  const response = await context.request.get(apiUrl, {
    headers: {
      Accept: "application/json, text/plain, */*",
      Origin: "https://app.getcollectr.com",
      Referer: profileUrl
    }
  });
  if (!response.ok()) {
    throw new Error(`Collectr API ${response.status()}`);
  }
  return response.json();
}

async function fetchShowcaseApiPage(page, context, handle, offset) {
  try {
    return await fetchShowcasePageViaNavigation(page, handle, offset);
  } catch (navErr) {
    try {
      return await fetchShowcasePageViaContextRequest(context, handle, offset);
    } catch {
      throw navErr;
    }
  }
}

function buildCatalogResult({
  slug,
  profileUrl,
  profile,
  byKey,
  totalCards,
  totalSealed,
  maxItems,
  crashReason = "",
  exhausted = false,
  lastPageSize = 0
}) {
  if (!byKey.size) {
    return {
      ok: false,
      reason: summarizeFailureReason(crashReason) || "Browser load returned no products",
      loaderVersion: COLLECTR_LOADER_VERSION
    };
  }

  const capped = byKey.size >= maxItems;
  // Collectr ends the infinite query when a page has zero products — not when length < limit.
  const complete = exhausted || capped;
  const partial = Boolean(crashReason) || (!complete && !capped);

  return {
    ok: true,
    handle: slug,
    profileUrl,
    profile: profile || { handle: slug, displayName: slug, profilePhoto: null },
    products: [...byKey.values()].slice(0, maxItems),
    totalCards: byKey.size,
    totalSealed: 0,
    expectedTotal: byKey.size,
    showcaseTotalCards: totalCards,
    showcaseTotalSealed: totalSealed,
    filters: COLLECTR_IMPORT_FILTER_IDS.slice(),
    filteredImport: true,
    partial,
    crashReason: summarizeFailureReason(crashReason),
    source: "collectr-browser",
    loaderVersion: COLLECTR_LOADER_VERSION
  };
}

async function fetchCollectrShowcaseCatalogViaBrowser(handle, options = {}) {
  const launched = await launchStealthBrowser();
  if (!launched.ok) {
    return { ...launched, loaderVersion: COLLECTR_LOADER_VERSION };
  }

  const slug = String(handle || "")
    .trim()
    .toLowerCase()
    .replace(/^@+/, "");
  if (!slug) return { ok: false, reason: "invalid handle", loaderVersion: COLLECTR_LOADER_VERSION };

  const maxItems = Math.min(25_000, Math.max(1, Number(options.maxItems) || 20_000));
  const onProgress = typeof options.onProgress === "function" ? options.onProgress : null;
  const profileUrl = buildShowcaseProfileUrl(slug);
  const byKey = new Map();
  let totalCards = 0;
  let totalSealed = 0;
  let profile = null;
  let browser = launched.browser;
  let context;
  let page;
  let crashReason = "";
  let exhausted = false;
  let lastPageSize = 0;
  let closingIntentionally = false;

  const report = () => {
    if (!onProgress) return;
    onProgress({
      loaded: byKey.size,
      totalCards: byKey.size,
      totalSealed: 0,
      expectedTotal: null,
      filters: COLLECTR_IMPORT_FILTER_IDS.slice(),
      loaderVersion: COLLECTR_LOADER_VERSION
    });
  };

  const ingestPayload = (payload) => {
    if (!payload || typeof payload !== "object") return 0;
    if (!profile) {
      profile = {
        handle: payload.handle || slug,
        displayName: payload.user || payload.displayName || slug,
        profilePhoto: payload.profile_photo || payload.profilePhoto || null
      };
    }
    if (payload.total_cards) totalCards = Number(payload.total_cards) || totalCards;
    if (payload.total_sealed) totalSealed = Number(payload.total_sealed) || totalSealed;
    const rows = Array.isArray(payload.products)
      ? payload.products
      : Array.isArray(payload.data)
        ? payload.data
        : [];
    lastPageSize = rows.length;
    const added = mergeProductsByKey(byKey, rows);
    // Match Collectr getNextPageParam: stop only when products is empty.
    if (rows.length === 0) {
      exhausted = true;
    }
    if (added > 0) report();
    return added;
  };

  try {
    const routed = await newStealthContext(browser);
    context = routed.context;
    page = await context.newPage();

    page.on("close", () => {
      if (!closingIntentionally && !crashReason) {
        crashReason = "Browser page closed unexpectedly";
      }
    });
    browser.on("disconnected", () => {
      if (!closingIntentionally && !crashReason) {
        crashReason = "Browser disconnected unexpectedly";
      }
    });

    // Profile HTML shell only (SPA assets aborted). Gives cookies/referer + first ~30 rows.
    await page.goto(profileUrl, {
      waitUntil: "domcontentloaded",
      timeout: 90_000
    });
    await page.waitForTimeout(200);
    try {
      const html = await page.content();
      const totals = extractTotalsFromCollectrHtml(html);
      if (totals.totalCards) totalCards = totals.totalCards;
      if (totals.totalSealed) totalSealed = totals.totalSealed;
      const ssrRows = extractProductsFromCollectrHtml(html);
      if (ssrRows.length) {
        mergeProductsByKey(byKey, ssrRows);
        lastPageSize = ssrRows.length;
        report();
      }
    } catch {
      // continue with API navigation paging
    }

    // Collectr infinite query: offset = 0, 30, 60, ... until products is empty.
    // Prefer Chromium document navigation (not page.evaluate fetch — WAF/CORS fails that).
    let startPageIdx = byKey.size > 0 ? 1 : 0;
    let consecutiveEmpty = 0;
    const maxPages = Math.ceil(maxItems / API_PAGE_SIZE) + 5;

    for (let pageIdx = startPageIdx; pageIdx < maxPages && byKey.size < maxItems && !exhausted; pageIdx += 1) {
      if (page.isClosed() || !browser.isConnected()) {
        crashReason = crashReason || "Browser closed during Collectr paging";
        break;
      }

      const offset = API_PAGE_SIZE * pageIdx;
      let payload = null;
      try {
        payload = await fetchShowcaseApiPage(page, context, slug, offset);
      } catch (err) {
        const msg = String(err?.message || err || "");
        if (isClosedError(err)) {
          crashReason = summarizeFailureReason(msg);
          break;
        }
        await page.waitForTimeout(900);
        try {
          payload = await fetchShowcaseApiPage(page, context, slug, offset);
        } catch (err2) {
          crashReason = summarizeFailureReason(err2?.message || msg || "Collectr API fetch failed");
          break;
        }
      }

      const before = byKey.size;
      const pageCount = Array.isArray(payload?.products)
        ? payload.products.length
        : Array.isArray(payload?.data)
          ? payload.data.length
          : 0;
      ingestPayload(payload);

      if (pageCount === 0 || byKey.size === before) {
        consecutiveEmpty += 1;
        if (consecutiveEmpty >= 2 || pageCount === 0) {
          exhausted = true;
          break;
        }
      } else {
        consecutiveEmpty = 0;
      }

      if (exhausted) break;
      await page.waitForTimeout(PAGE_DELAY_MS);
    }
  } catch (err) {
    crashReason = summarizeFailureReason(err.message || "Browser load failed");
  } finally {
    closingIntentionally = true;
    await page?.close().catch(() => {});
    await context?.close().catch(() => {});
    await browser?.close().catch(() => {});
  }

  return buildCatalogResult({
    slug,
    profileUrl,
    profile,
    byKey,
    totalCards,
    totalSealed,
    maxItems,
    crashReason,
    exhausted,
    lastPageSize
  });
}

module.exports = {
  fetchCollectrShowcaseCatalogViaBrowser,
  showcaseApiPath,
  buildShowcaseApiUrl,
  buildShowcaseProfileUrl,
  summarizeFailureReason,
  COLLECTR_IMPORT_FILTER_IDS,
  COLLECTR_IMPORT_FILTERS_PARAM,
  COLLECTR_LOADER_VERSION
};
