"use strict";

const COLLECTR_ANON_USERNAME = "00000000-0000-0000-0000-000000000000";
const PAGE_SIZE = 30;
const SCROLL_PAUSE_MS = 350;
const MAX_SCROLL_ROUNDS = 500;
const STALE_SCROLL_ROUNDS = 24;
const STEALTH_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

function showcaseApiPath(handle) {
  const slug = String(handle || "")
    .trim()
    .toLowerCase()
    .replace(/^@+/, "");
  return `@${encodeURIComponent(slug)}`;
}

function buildShowcaseApiUrl(handle, offset = 0, limit = PAGE_SIZE) {
  // Match the query shape Collectr's own web app uses (WAF is picky).
  const params = new URLSearchParams({
    offset: String(Math.max(0, Number(offset) || 0)),
    limit: String(Math.min(100, Math.max(1, Number(limit) || PAGE_SIZE))),
    filters: "",
    unstackedView: "true",
    username: COLLECTR_ANON_USERNAME
  });
  return `https://api-v2.getcollectr.com/data/showcase/${showcaseApiPath(handle)}?${params}`;
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

function resolveChromiumExecutablePath() {
  const fromEnv = String(
    process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ||
      process.env.CHROME_PATH ||
      process.env.CHROMIUM_PATH ||
      ""
  ).trim();
  if (fromEnv) return fromEnv;

  const candidates =
    process.platform === "win32"
      ? [
          `${process.env.PROGRAMFILES || "C:\\Program Files"}\\Google\\Chrome\\Application\\chrome.exe`,
          `${process.env["PROGRAMFILES(X86)"] || "C:\\Program Files (x86)"}\\Google\\Chrome\\Application\\chrome.exe`,
          `${process.env.LOCALAPPDATA || ""}\\Google\\Chrome\\Application\\chrome.exe`,
          `${process.env["PROGRAMFILES(X86)"] || "C:\\Program Files (x86)"}\\Microsoft\\Edge\\Application\\msedge.exe`,
          `${process.env.PROGRAMFILES || "C:\\Program Files"}\\Microsoft\\Edge\\Application\\msedge.exe`
        ]
      : ["/usr/bin/chromium", "/usr/bin/chromium-browser", "/usr/bin/google-chrome", "/usr/bin/google-chrome-stable"];

  const fs = require("fs");
  for (const candidate of candidates) {
    if (!candidate) continue;
    try {
      if (fs.existsSync(candidate)) return candidate;
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
      "--js-flags=--max-old-space-size=192"
    ]
  };
  const executablePath = resolveChromiumExecutablePath();
  if (executablePath) {
    launchOptions.executablePath = executablePath;
  }

  try {
    if (executablePath) {
      return { ok: true, browser: await chromium.launch(launchOptions) };
    }
    return { ok: true, browser: await chromium.launch({ channel: "chrome", ...launchOptions }) };
  } catch (firstErr) {
    try {
      return { ok: true, browser: await chromium.launch(launchOptions) };
    } catch (err) {
      return {
        ok: false,
        reason: err.message || firstErr.message || "Could not launch browser"
      };
    }
  }
}

async function newStealthContext(browser) {
  const context = await browser.newContext({
    userAgent: STEALTH_USER_AGENT,
    viewport: { width: 1280, height: 900 },
    javaScriptEnabled: true,
    // Images/fonts inflate memory on large showcases and are not needed for the API harvest.
    extraHTTPHeaders: {
      "sec-ch-ua": '"Not_A Brand";v="8", "Chromium";v="120", "Google Chrome";v="120"',
      "sec-ch-ua-mobile": "?0",
      "sec-ch-ua-platform": '"Linux"'
    }
  });
  await context.addInitScript(() => {
    Object.defineProperty(navigator, "webdriver", { get: () => undefined });
  });
  await context.route("**/*", async (route) => {
    const req = route.request();
    const type = req.resourceType();
    const url = req.url();
    if (type === "image" || type === "media" || type === "font") {
      await route.abort();
      return;
    }
    if (/google-analytics|googletagmanager|doubleclick|facebook\.net|hotjar|segment\.io/i.test(url)) {
      await route.abort();
      return;
    }
    await route.continue();
  });
  return context;
}

async function scrollShowcasePage(page) {
  // Prefer mouse wheel over page.evaluate — surviving longer under low memory.
  try {
    await page.mouse.move(640, 450);
    await page.mouse.wheel(0, 3200);
  } catch (err) {
    if (isClosedError(err)) throw err;
  }
  try {
    await page.keyboard.press("PageDown");
    await page.keyboard.press("End");
  } catch (err) {
    if (isClosedError(err)) throw err;
  }
  try {
    await page.evaluate(() => {
      const main = document.querySelector("main") || document.documentElement;
      main.scrollTop = main.scrollHeight;
      window.scrollTo(0, document.body.scrollHeight);
      const scroller =
        document.querySelector("[data-radix-scroll-area-viewport]") ||
        document.querySelector(".overflow-y-auto") ||
        null;
      if (scroller) scroller.scrollTop = scroller.scrollHeight;
    });
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
  crashReason = ""
}) {
  if (!byKey.size) {
    return {
      ok: false,
      reason: crashReason || "Browser load returned no products"
    };
  }

  const expected = totalCards + totalSealed;
  const capped = byKey.size >= maxItems;
  const partial =
    Boolean(crashReason) || (!capped && expected > 0 && byKey.size < expected * 0.9);

  return {
    ok: true,
    handle: slug,
    profileUrl,
    profile: profile || { handle: slug, displayName: slug, profilePhoto: null },
    products: [...byKey.values()].slice(0, maxItems),
    totalCards,
    totalSealed,
    expectedTotal: expected || null,
    partial,
    crashReason: crashReason || "",
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
  const profileUrl = `https://app.getcollectr.com/showcase/profile/@${encodeURIComponent(slug)}`;
  const byKey = new Map();
  let totalCards = 0;
  let totalSealed = 0;
  let profile = null;
  let browser = launched.browser;
  let context;
  let page;
  let crashReason = "";

  const report = () => {
    if (!onProgress) return;
    const expectedTotal = totalCards + totalSealed > 0 ? totalCards + totalSealed : null;
    onProgress({
      loaded: byKey.size,
      totalCards,
      totalSealed,
      expectedTotal
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
    if (added > 0) report();
    return added;
  };

  try {
    context = await newStealthContext(browser);
    page = await context.newPage();

    // Listen only — do not intercept/reissue requests (route.fetch() is WAF-blocked).
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
    // Collectr keeps analytics sockets busy, so networkidle often never settles.
    await page.waitForTimeout(2500);
    report();

    let staleRounds = 0;
    let lastSize = byKey.size;
    const expectedTotal = () => (totalCards + totalSealed > 0 ? totalCards + totalSealed : 0);

    for (let round = 0; round < MAX_SCROLL_ROUNDS && byKey.size < maxItems; round += 1) {
      if (page.isClosed() || !browser.isConnected()) {
        crashReason = crashReason || "Browser closed during showcase scroll";
        break;
      }

      try {
        await scrollShowcasePage(page);
        await page.waitForTimeout(SCROLL_PAUSE_MS);
      } catch (err) {
        crashReason = err?.message || String(err);
        break;
      }

      if (byKey.size === lastSize) {
        staleRounds += 1;
        if (staleRounds >= STALE_SCROLL_ROUNDS) break;
      } else {
        staleRounds = 0;
        lastSize = byKey.size;
      }

      const expected = expectedTotal();
      if (expected > 0 && byKey.size >= Math.min(expected, maxItems)) break;
    }
  } catch (err) {
    crashReason = err.message || "Browser load failed";
  } finally {
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
    crashReason
  });
}

module.exports = {
  fetchCollectrShowcaseCatalogViaBrowser,
  showcaseApiPath,
  buildShowcaseApiUrl
};
