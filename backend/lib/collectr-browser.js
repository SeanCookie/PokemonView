"use strict";

const { isCollectrPokemonProduct } = require("./collectr-pokemon-filter");
const COLLECTR_ANON_USERNAME = "00000000-0000-0000-0000-000000000000";
const SCROLL_PAUSE_MS = 350;
const MAX_SCROLL_ROUNDS = 250;
const STALE_SCROLL_ROUNDS = 18;
const STEALTH_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

function showcaseApiPath(handle) {
  const slug = String(handle || "")
    .trim()
    .toLowerCase()
    .replace(/^@+/, "");
  return `@${encodeURIComponent(slug)}`;
}

function mergeProductsByKey(byKey, rows, stats) {
  if (!byKey || !Array.isArray(rows)) return;
  for (const row of rows) {
    if (!isCollectrPokemonProduct(row)) {
      if (stats) stats.filteredOutNonPokemon += 1;
      continue;
    }
    const key = `${row?.product_id || ""}::${row?.grade_id || ""}::${row?.product_sub_type || ""}`;
    if (!row?.product_id || byKey.has(key)) continue;
    byKey.set(key, row);
  }
}

function isShowcaseApiUrl(url, handle) {
  const text = String(url || "");
  if (!text.includes("api-v2.getcollectr.com/data/showcase/")) return false;
  const path = showcaseApiPath(handle);
  return text.includes(`/data/showcase/${path}`) || text.includes(`/data/showcase/@${handle}`);
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
    args: ["--disable-blink-features=AutomationControlled"]
  };

  try {
    return { ok: true, browser: await chromium.launch({ channel: "chrome", ...launchOptions }) };
  } catch {
    try {
      return { ok: true, browser: await chromium.launch(launchOptions) };
    } catch (err) {
      return { ok: false, reason: err.message || "Could not launch browser" };
    }
  }
}

async function newStealthContext(browser) {
  const context = await browser.newContext({
    userAgent: STEALTH_USER_AGENT,
    extraHTTPHeaders: {
      "sec-ch-ua": '"Not_A Brand";v="8", "Chromium";v="120", "Google Chrome";v="120"',
      "sec-ch-ua-mobile": "?0",
      "sec-ch-ua-platform": '"Windows"'
    }
  });
  await context.addInitScript(() => {
    Object.defineProperty(navigator, "webdriver", { get: () => undefined });
  });
  return context;
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
  const mergeStats = { filteredOutNonPokemon: 0 };
  let totalCards = 0;
  let totalSealed = 0;
  let profile = null;
  let browser = launched.browser;
  let context;
  let page;

  try {
    context = await newStealthContext(browser);
    page = await context.newPage();

    await page.route("**/api-v2.getcollectr.com/data/showcase/**", async (route) => {
      try {
        const response = await route.fetch();
        const url = route.request().url();
        if (isShowcaseApiUrl(url, slug) && response.ok()) {
          const payload = await response.json();
          if (payload && typeof payload === "object") {
            if (!profile) {
              profile = {
                handle: payload.handle || slug,
                displayName: payload.user || payload.displayName || slug,
                profilePhoto: payload.profile_photo || payload.profilePhoto || null
              };
            }
            if (payload.total_cards) totalCards = Number(payload.total_cards) || totalCards;
            if (payload.total_sealed) totalSealed = Number(payload.total_sealed) || totalSealed;
            mergeProductsByKey(
              byKey,
              Array.isArray(payload.products) ? payload.products : [],
              mergeStats
            );
            if (onProgress) {
              const expectedTotal = totalCards + totalSealed > 0 ? totalCards + totalSealed : null;
              onProgress({
                loaded: byKey.size,
                totalCards,
                totalSealed,
                expectedTotal
              });
            }
          }
        }
        await route.fulfill({ response });
      } catch {
        try {
          await route.continue();
        } catch {
          // page may be closing
        }
      }
    });

    await page.goto(profileUrl, { waitUntil: "networkidle", timeout: 120_000 });
    await page.waitForTimeout(1500);

    let staleRounds = 0;
    let lastSize = 0;
    const expectedTotal = () => (totalCards + totalSealed > 0 ? totalCards + totalSealed : 0);

    for (let round = 0; round < MAX_SCROLL_ROUNDS && byKey.size < maxItems; round += 1) {
      await page.evaluate(() => {
        const main = document.querySelector("main") || document.documentElement;
        main.scrollTop = main.scrollHeight;
        window.scrollTo(0, document.body.scrollHeight);
      });
      await page.waitForTimeout(SCROLL_PAUSE_MS);

      if (byKey.size === lastSize) {
        staleRounds += 1;
        if (staleRounds >= STALE_SCROLL_ROUNDS) break;
      } else {
        staleRounds = 0;
        lastSize = byKey.size;
      }

      const expected = expectedTotal();
      if (expected > 0 && byKey.size >= expected) break;
    }
  } catch (err) {
    return { ok: false, reason: err.message || "Browser load failed" };
  } finally {
    await page?.close().catch(() => {});
    await context?.close().catch(() => {});
    await browser?.close().catch(() => {});
  }

  if (!byKey.size) {
    return { ok: false, reason: "Browser load returned no products" };
  }

  const expected = totalCards + totalSealed;
  return {
    ok: true,
    handle: slug,
    profileUrl,
    profile: profile || { handle: slug, displayName: slug, profilePhoto: null },
    products: [...byKey.values()].slice(0, maxItems),
    totalCards,
    totalSealed,
    filteredOutNonPokemon: mergeStats.filteredOutNonPokemon,
    source: "collectr-browser"
  };
}

module.exports = {
  fetchCollectrShowcaseCatalogViaBrowser,
  showcaseApiPath
};
