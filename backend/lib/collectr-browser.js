"use strict";

const fs = require("fs");

const COLLECTR_ANON_USERNAME = "00000000-0000-0000-0000-000000000000";
const API_PAGE_SIZE = 100;
const SCROLL_PAUSE_MS = 250;
const MAX_SCROLL_ROUNDS = 200;
const STALE_SCROLL_ROUNDS = 12;
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

function buildShowcaseApiUrl(handle, offset = 0, limit = API_PAGE_SIZE) {
  const params = new URLSearchParams({
    offset: String(Math.max(0, Number(offset) || 0)),
    limit: String(Math.min(100, Math.max(1, Number(limit) || API_PAGE_SIZE))),
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
  // Prefer Playwright bundled Chromium. Never use Debian's /usr/bin/chromium wrapper.
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
      "--renderer-process-limit=2",
      "--js-flags=--max-old-space-size=384"
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
      // Retry with Playwright default path resolution (no explicit executablePath).
      return {
        ok: true,
        browser: await chromium.launch({
          headless: true,
          args: launchOptions.args
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

async function newStealthContext(browser, { slug, onApiPage } = {}) {
  const context = await browser.newContext({
    userAgent: STEALTH_USER_AGENT,
    viewport: { width: 1100, height: 800 },
    javaScriptEnabled: true,
    extraHTTPHeaders: {
      "sec-ch-ua": '"Not_A Brand";v="8", "Chromium";v="120", "Google Chrome";v="120"',
      "sec-ch-ua-mobile": "?0",
      "sec-ch-ua-platform": '"Linux"'
    }
  });
  await context.addInitScript(() => {
    Object.defineProperty(navigator, "webdriver", { get: () => undefined });
  });

  // Rewrite showcase page requests to our own offset/limit sequence.
  // route.continue keeps the browser TLS fingerprint (route.fetch is WAF-blocked).
  let nextOffset = 0;
  let rewriteEnabled = true;
  await context.route("**/api-v2.getcollectr.com/data/showcase/**", async (route) => {
    try {
      const req = route.request();
      const url = new URL(req.url());
      if (!rewriteEnabled || !isShowcaseApiUrl(url.toString(), slug)) {
        await route.continue();
        return;
      }
      url.searchParams.set("offset", String(nextOffset));
      url.searchParams.set("limit", String(API_PAGE_SIZE));
      // Always force Cards Only + Ungraded + Pokemon — reduces load and matches import rules.
      url.searchParams.set("filters", COLLECTR_IMPORT_FILTERS_PARAM);
      url.searchParams.set("unstackedView", "true");
      if (!url.searchParams.get("username")) {
        url.searchParams.set("username", COLLECTR_ANON_USERNAME);
      }
      const assignedOffset = nextOffset;
      nextOffset += API_PAGE_SIZE;
      if (typeof onApiPage === "function") {
        onApiPage({ offset: assignedOffset, limit: API_PAGE_SIZE });
      }
      await route.continue({ url: url.toString() });
    } catch {
      try {
        await route.continue();
      } catch {
        // page closing
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
    if (type === "image" || type === "media" || type === "font") {
      await route.abort();
      return;
    }
    if (/google-analytics|googletagmanager|doubleclick|facebook\.net|hotjar|segment\.io|googleapis\.com\/gcm/i.test(url)) {
      await route.abort();
      return;
    }
    await route.continue();
  });

  return {
    context,
    stopRewrite: () => {
      rewriteEnabled = false;
    },
    getNextOffset: () => nextOffset
  };
}

async function nudgeScroll(page) {
  // Avoid mouse.move — it fails loudly if Chromium already died mid-harvest.
  try {
    await page.mouse.wheel(0, 2800);
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
  exhausted = false,
  lastPageSize = 0
}) {
  if (!byKey.size) {
    return {
      ok: false,
      reason: summarizeFailureReason(crashReason) || "Browser load returned no products"
    };
  }

  // Filtered imports must not treat unfiltered showcase totals (cards+sealed) as the target.
  const capped = byKey.size >= maxItems;
  const complete = exhausted || capped || (lastPageSize > 0 && lastPageSize < API_PAGE_SIZE);
  const partial = Boolean(crashReason) || (!complete && !capped);

  return {
    ok: true,
    handle: slug,
    profileUrl,
    profile: profile || { handle: slug, displayName: slug, profilePhoto: null },
    products: [...byKey.values()].slice(0, maxItems),
    totalCards: byKey.size,
    totalSealed: 0,
    expectedTotal: complete ? byKey.size : byKey.size,
    showcaseTotalCards: totalCards,
    showcaseTotalSealed: totalSealed,
    filters: COLLECTR_IMPORT_FILTER_IDS.slice(),
    filteredImport: true,
    partial,
    crashReason: summarizeFailureReason(crashReason),
    source: "collectr-browser"
  };
}

async function fetchCollectrShowcaseCatalogViaBrowser(handle, options = {}) {
  const launched = await launchStealthBrowser();
  if (!launched.ok) return launched;

  const slug = String(handle || "")
    .trim()
    .toLowerCase()
    .replace(/^@+/, "");
  if (!slug) return { ok: false, reason: "invalid handle" };

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
  let stopRewrite = () => {};
  let exhausted = false;
  let lastPageSize = 0;

  const report = () => {
    if (!onProgress) return;
    onProgress({
      loaded: byKey.size,
      totalCards: byKey.size,
      totalSealed: 0,
      expectedTotal: null,
      filters: COLLECTR_IMPORT_FILTER_IDS.slice()
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
    if (rows.length > 0 && rows.length < API_PAGE_SIZE) {
      exhausted = true;
    } else if (rows.length === 0 && byKey.size > 0) {
      exhausted = true;
    }
    if (added > 0) report();
    return added;
  };

  try {
    const routed = await newStealthContext(browser, { slug });
    context = routed.context;
    stopRewrite = routed.stopRewrite;
    page = await context.newPage();

    page.on("response", async (response) => {
      try {
        const url = response.url();
        if (!isShowcaseApiUrl(url, slug) || !response.ok()) return;
        const payload = await response.json().catch(() => null);
        ingestPayload(payload);
      } catch {
        // ignore navigation / body races
      }
    });

    page.on("close", () => {
      if (!crashReason) crashReason = "Showcase page closed during load";
    });
    browser.on("disconnected", () => {
      if (!crashReason) crashReason = "Browser disconnected during load";
    });

    await page.goto(profileUrl, { waitUntil: "domcontentloaded", timeout: 120_000 });

    try {
      await page.waitForResponse(
        (res) => isShowcaseApiUrl(res.url(), slug) && res.ok(),
        { timeout: 25_000 }
      );
    } catch {
      // continue
    }
    await page.waitForTimeout(800);
    report();

    let staleRounds = 0;
    let lastSize = byKey.size;
    // Filtered set is smaller than full showcase; still pad rounds for large card portfolios.
    const maxRounds = Math.max(MAX_SCROLL_ROUNDS, Math.ceil(maxItems / API_PAGE_SIZE) + 20);

    for (let round = 0; round < maxRounds && byKey.size < maxItems; round += 1) {
      if (page.isClosed() || !browser.isConnected()) {
        crashReason = crashReason || "Browser closed during showcase scroll";
        break;
      }
      if (exhausted) break;

      try {
        await nudgeScroll(page);
        await page.waitForTimeout(SCROLL_PAUSE_MS);
      } catch (err) {
        crashReason = summarizeFailureReason(err?.message || String(err));
        break;
      }

      if (byKey.size === lastSize) {
        staleRounds += 1;
        if (staleRounds >= STALE_SCROLL_ROUNDS) {
          exhausted = true;
          break;
        }
      } else {
        staleRounds = 0;
        lastSize = byKey.size;
      }
    }
  } catch (err) {
    crashReason = summarizeFailureReason(err.message || "Browser load failed");
  } finally {
    try {
      stopRewrite();
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
  COLLECTR_IMPORT_FILTERS_PARAM
};
