"use strict";

const fs = require("fs");

const COLLECTR_ANON_USERNAME = "00000000-0000-0000-0000-000000000000";
/** Collectr showcase infinite query pages exactly 30 rows (see getNextPageParam: 30*pages). */
const API_PAGE_SIZE = 30;
const PAGE_DELAY_MS = 140;
const SCROLL_PAUSE_MS = 280;
const STALE_SCROLL_ROUNDS = 18;
const COLLECTR_LOADER_VERSION = "2026-07-13-spa-xhr-paging-v9";
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
  return `@${encodeURIComponent(slug)}`;
}

function buildShowcaseApiUrl(handle, offset = 0) {
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
      : ["/usr/local/bin/playwright-chromium", "/usr/bin/google-chrome-stable", "/usr/bin/google-chrome"];

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
      "--js-flags=--max-old-space-size=384"
    ]
  };

  const executablePath = resolveChromiumExecutablePath();
  if (!executablePath || isDebianChromiumWrapper(executablePath)) {
    return {
      ok: false,
      reason: "Playwright Chromium is not installed in this container (refusing Debian wrapper)"
    };
  }
  launchOptions.executablePath = executablePath;

  try {
    return { ok: true, browser: await chromium.launch(launchOptions), executablePath };
  } catch (err) {
    try {
      return {
        ok: true,
        browser: await chromium.launch({ headless: true, args: launchOptions.args }),
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

/**
 * Allow Collectr SPA JS (needed for WAF-passing XHR). Abort heavy assets that OOM the container.
 * Optional offset rewrite forces sequential paging when the SPA requests the next page.
 */
async function newStealthContext(browser, { slug, rewriteOffsets = false } = {}) {
  const context = await browser.newContext({
    userAgent: STEALTH_USER_AGENT,
    viewport: { width: 900, height: 720 },
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

  let nextOffset = 0;
  let rewriteEnabled = Boolean(rewriteOffsets);

  await context.route("**/api-v2.getcollectr.com/data/showcase/**", async (route) => {
    try {
      const req = route.request();
      if (!rewriteEnabled || !isShowcaseApiUrl(req.url(), slug)) {
        await route.continue();
        return;
      }
      const url = new URL(req.url());
      url.searchParams.set("offset", String(nextOffset));
      url.searchParams.set("limit", String(API_PAGE_SIZE));
      url.searchParams.set("filters", COLLECTR_IMPORT_FILTERS_PARAM);
      url.searchParams.set("unstackedView", "true");
      if (!url.searchParams.get("username")) {
        url.searchParams.set("username", COLLECTR_ANON_USERNAME);
      }
      nextOffset += API_PAGE_SIZE;
      await route.continue({ url: url.toString() });
    } catch {
      try {
        await route.continue();
      } catch {
        // closing
      }
    }
  });

  await context.route("**/*", async (route) => {
    const req = route.request();
    const type = req.resourceType();
    const url = req.url();
    if (url.includes("api-v2.getcollectr.com/data/showcase/")) {
      await route.fallback();
      return;
    }
    // Keep scripts/xhr/fetch/document so Collectr SPA can talk to the API through WAF.
    if (type === "document" || type === "script" || type === "xhr" || type === "fetch" || type === "websocket") {
      await route.continue();
      return;
    }
    if (
      type === "image" ||
      type === "media" ||
      type === "font" ||
      type === "stylesheet" ||
      /google-analytics|googletagmanager|doubleclick|facebook\.net|hotjar|segment\.io|sentry\.io|intercom/i.test(url)
    ) {
      await route.abort();
      return;
    }
    await route.continue();
  });

  return {
    context,
    enableRewrite: () => {
      rewriteEnabled = true;
    },
    disableRewrite: () => {
      rewriteEnabled = false;
    },
    setNextOffset: (n) => {
      nextOffset = Math.max(0, Number(n) || 0);
    },
    getNextOffset: () => nextOffset
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

/** In-page XHR from the warmed Collectr SPA origin (passes WAF; Node/context.request does not). */
async function fetchShowcasePageViaPageXhr(page, handle, offset) {
  const apiUrl = buildShowcaseApiUrl(handle, offset);
  return page.evaluate(async (url) => {
    const res = await fetch(url, {
      credentials: "include",
      headers: {
        Accept: "application/json, text/plain, */*",
        "Accept-Language": "en-US,en;q=0.9"
      }
    });
    if (!res.ok) {
      const err = new Error(`Collectr API ${res.status}`);
      err.status = res.status;
      throw err;
    }
    return res.json();
  }, apiUrl);
}

async function pruneCollectrDom(page) {
  try {
    await page.evaluate(() => {
      document.querySelectorAll("img, video, canvas, iframe").forEach((el) => el.remove());
      // Keep the app shell; strip bulky card grid nodes when present.
      const mains = document.querySelectorAll("main img, [class*='grid'] img, [class*='virtual'] *");
      mains.forEach((el) => {
        try {
          el.remove();
        } catch {
          // ignore
        }
      });
      if (typeof window.gc === "function") window.gc();
    });
  } catch {
    // ignore
  }
}

async function nudgeScroll(page) {
  try {
    await page.mouse.wheel(0, 3200);
  } catch (err) {
    if (isClosedError(err)) throw err;
  }
  try {
    await page.keyboard.press("PageDown");
  } catch (err) {
    if (isClosedError(err)) throw err;
  }
  try {
    await page.keyboard.press("End");
  } catch (err) {
    if (isClosedError(err)) throw err;
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
  exhausted = false
}) {
  if (!byKey.size) {
    return {
      ok: false,
      reason: summarizeFailureReason(crashReason) || "Browser load returned no products",
      loaderVersion: COLLECTR_LOADER_VERSION
    };
  }

  const capped = byKey.size >= maxItems;
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
  let closingIntentionally = false;
  let routed = null;

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
    const added = mergeProductsByKey(byKey, rows);
    if (rows.length === 0) exhausted = true;
    if (added > 0) report();
    return added;
  };

  try {
    // Start with rewrite off so the SPA's first page owns offset 0.
    routed = await newStealthContext(browser, { slug, rewriteOffsets: false });
    context = routed.context;
    page = await context.newPage();

    page.on("response", async (response) => {
      try {
        if (!isShowcaseApiUrl(response.url(), slug) || !response.ok()) return;
        const payload = await response.json().catch(() => null);
        ingestPayload(payload);
      } catch {
        // ignore body races
      }
    });

    page.on("close", () => {
      if (!closingIntentionally && !crashReason) crashReason = "Browser page closed unexpectedly";
    });
    browser.on("disconnected", () => {
      if (!closingIntentionally && !crashReason) crashReason = "Browser disconnected unexpectedly";
    });

    await page.goto(profileUrl, { waitUntil: "domcontentloaded", timeout: 90_000 });

    try {
      const html = await page.content();
      const totals = extractTotalsFromCollectrHtml(html);
      if (totals.totalCards) totalCards = totals.totalCards;
      if (totals.totalSealed) totalSealed = totals.totalSealed;
      mergeProductsByKey(byKey, extractProductsFromCollectrHtml(html));
      report();
    } catch {
      // ignore
    }

    try {
      await page.waitForResponse(
        (res) => isShowcaseApiUrl(res.url(), slug) && res.ok(),
        { timeout: 35_000 }
      );
    } catch {
      // SSR may already have the first page
    }
    await page.waitForTimeout(600);
    report();

    // Path A: page remaining offsets via in-page XHR from the warmed SPA (Chromium TLS/WAF).
    let xhrWorks = false;
    if (!exhausted && byKey.size < maxItems) {
      const probeOffset = Math.ceil(byKey.size / API_PAGE_SIZE) * API_PAGE_SIZE;
      try {
        const probe = await fetchShowcasePageViaPageXhr(page, slug, probeOffset);
        xhrWorks = true;
        ingestPayload(probe);
      } catch {
        xhrWorks = false;
      }

      if (xhrWorks) {
        let offset = Math.ceil(byKey.size / API_PAGE_SIZE) * API_PAGE_SIZE;
        let emptyStreak = 0;
        const maxPages = Math.ceil(maxItems / API_PAGE_SIZE) + 5;
        for (let i = 0; i < maxPages && byKey.size < maxItems && !exhausted; i += 1) {
          if (page.isClosed() || !browser.isConnected()) {
            crashReason = crashReason || "Browser closed during Collectr paging";
            break;
          }
          // Skip the offset we just probed when size landed exactly on a page boundary.
          if (offset < byKey.size) {
            offset = Math.ceil(byKey.size / API_PAGE_SIZE) * API_PAGE_SIZE;
          }
          try {
            const payload = await fetchShowcasePageViaPageXhr(page, slug, offset);
            const before = byKey.size;
            const count = Array.isArray(payload?.products) ? payload.products.length : 0;
            ingestPayload(payload);
            if (count === 0 || byKey.size === before) {
              emptyStreak += 1;
              if (emptyStreak >= 2 || count === 0) {
                exhausted = true;
                crashReason = "";
                break;
              }
            } else {
              emptyStreak = 0;
            }
            offset += API_PAGE_SIZE;
            if (i % 10 === 0) await pruneCollectrDom(page);
            await page.waitForTimeout(PAGE_DELAY_MS);
          } catch (err) {
            crashReason = summarizeFailureReason(err?.message || String(err));
            break;
          }
        }
      }
    }

    // Path B: SPA infinite scroll + offset rewrite (Chromium continue). Prune DOM to avoid OOM.
    if (!exhausted && byKey.size < maxItems) {
      routed.enableRewrite();
      routed.setNextOffset(Math.ceil(byKey.size / API_PAGE_SIZE) * API_PAGE_SIZE);
      crashReason = "";

      let staleRounds = 0;
      let lastSize = byKey.size;
      const maxRounds = Math.max(40, Math.ceil(maxItems / API_PAGE_SIZE) + 20);

      for (let round = 0; round < maxRounds && byKey.size < maxItems && !exhausted; round += 1) {
        if (page.isClosed() || !browser.isConnected()) {
          crashReason = crashReason || "Browser closed during Collectr scroll";
          break;
        }
        try {
          await nudgeScroll(page);
          await page.waitForTimeout(SCROLL_PAUSE_MS);
          if (round % 4 === 0) await pruneCollectrDom(page);
        } catch (err) {
          crashReason = summarizeFailureReason(err?.message || String(err));
          break;
        }

        if (byKey.size === lastSize) {
          staleRounds += 1;
          if (staleRounds >= STALE_SCROLL_ROUNDS) {
            exhausted = byKey.size > 0;
            if (exhausted) crashReason = "";
            break;
          }
        } else {
          staleRounds = 0;
          lastSize = byKey.size;
        }
      }
    }
  } catch (err) {
    crashReason = summarizeFailureReason(err.message || "Browser load failed");
  } finally {
    closingIntentionally = true;
    try {
      routed?.disableRewrite?.();
    } catch {
      // ignore
    }
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
    exhausted
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
