"use strict";

const fs = require("fs");

const COLLECTR_ANON_USERNAME = "00000000-0000-0000-0000-000000000000";
const API_PAGE_SIZE = 100;
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

async function newStealthContext(browser) {
  const context = await browser.newContext({
    userAgent: STEALTH_USER_AGENT,
    viewport: { width: 1100, height: 800 },
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

  // Block heavy assets so the SPA does not OOM the container. Showcase JSON stays intact.
  await context.route("**/*", async (route) => {
    const req = route.request();
    const type = req.resourceType();
    const url = req.url();
    if (url.includes("api-v2.getcollectr.com/data/showcase/")) {
      await route.continue();
      return;
    }
    if (type === "image" || type === "media" || type === "font" || type === "stylesheet") {
      await route.abort();
      return;
    }
    if (
      /google-analytics|googletagmanager|doubleclick|facebook\.net|hotjar|segment\.io|googleapis\.com\/gcm|sentry\.io|intercom/i.test(
        url
      )
    ) {
      await route.abort();
      return;
    }
    await route.continue();
  });

  return { context };
}

async function fetchShowcasePageInBrowser(page, handle, offset) {
  const apiUrl = buildShowcaseApiUrl(handle, offset, API_PAGE_SIZE);
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
    const routed = await newStealthContext(browser);
    context = routed.context;
    page = await context.newPage();

    // Capture SPA responses too (first paint), then we page the rest via in-page fetch.
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
      if (!closingIntentionally && !crashReason) {
        crashReason = "Showcase page closed during load";
      }
    });
    browser.on("disconnected", () => {
      if (!closingIntentionally && !crashReason) {
        crashReason = "Browser disconnected during load";
      }
    });

    await page.goto(profileUrl, { waitUntil: "domcontentloaded", timeout: 90_000 });

    try {
      await page.waitForResponse(
        (res) => isShowcaseApiUrl(res.url(), slug) && res.ok(),
        { timeout: 30_000 }
      );
    } catch {
      // First paint may not hit API if SSR-only; in-page fetch below still runs.
    }
    await page.waitForTimeout(500);
    report();

    // Leave the heavy showcase DOM behind while keeping getcollectr.com cookies/origin.
    try {
      await page.goto("https://app.getcollectr.com/", {
        waitUntil: "domcontentloaded",
        timeout: 45_000
      });
      await page.waitForTimeout(300);
    } catch (err) {
      if (isClosedError(err)) throw err;
      // Stay on profile page and continue paging from there.
    }

    // Own the pagination explicitly (filters forced on each URL). No DOM scrolling.
    let offset = 0;
    let consecutiveEmpty = 0;
    const maxPages = Math.ceil(maxItems / API_PAGE_SIZE) + 5;

    for (let pageIdx = 0; pageIdx < maxPages && byKey.size < maxItems && !exhausted; pageIdx += 1) {
      if (page.isClosed() || !browser.isConnected()) {
        crashReason = crashReason || "Browser closed during Collectr paging";
        break;
      }

      let payload = null;
      try {
        payload = await fetchShowcasePageInBrowser(page, slug, offset);
      } catch (err) {
        const msg = String(err?.message || err || "");
        if (isClosedError(err)) {
          crashReason = summarizeFailureReason(msg);
          break;
        }
        // One soft retry after a short pause (WAF / transient).
        await page.waitForTimeout(750);
        try {
          payload = await fetchShowcasePageInBrowser(page, slug, offset);
        } catch (err2) {
          crashReason = summarizeFailureReason(err2?.message || msg || "Collectr API fetch failed");
          break;
        }
      }

      const before = byKey.size;
      ingestPayload(payload);
      if (byKey.size === before) {
        consecutiveEmpty += 1;
        if (consecutiveEmpty >= 2) {
          exhausted = true;
          break;
        }
      } else {
        consecutiveEmpty = 0;
      }

      if (exhausted) break;
      offset += API_PAGE_SIZE;
      await page.waitForTimeout(120);
    }

    if (!crashReason && byKey.size > 0 && !exhausted && byKey.size < maxItems) {
      // Reached max pages without a short final page — treat as incomplete.
      crashReason = "";
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
  COLLECTR_IMPORT_FILTERS_PARAM
};
