const { writeJsonAtomic } = require("./write-json-atomic");

function decodeHtml(value) {
  return String(value || "")
    .replace(/&#8217;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

function normalizeCardNumber(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  const digits = raw.replace(/[^0-9]/g, "");
  if (digits && digits.length === raw.length) return digits.padStart(3, "0");
  return raw.toUpperCase();
}

function extractTcgplayerUrlFromPkmnCardHtml(cardHtml) {
  const hrefRe = /href="([^"]+)"/gi;
  let match;
  const hrefs = [];
  while ((match = hrefRe.exec(String(cardHtml || "")))) {
    const href = decodeHtml(match[1]).replace(/&#0*38;/gi, "&");
    if (/tcgplayer\.com/i.test(href)) hrefs.push(href);
  }
  for (const href of hrefs) {
    let url = href;
    for (let depth = 0; depth < 6; depth += 1) {
      const direct = url.match(/https?:\/\/(?:www\.)?tcgplayer\.com\/product\/\d+/i);
      if (direct) return direct[0].split("&")[0].split("#")[0];
      try {
        const parsed = new URL(url);
        const nested = parsed.searchParams.get("u");
        if (!nested) break;
        url = decodeURIComponent(nested);
      } catch {
        break;
      }
    }
  }
  return "";
}

function stripTags(html) {
  return decodeHtml(
    String(html || "")
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim()
  );
}

function stripTagsKeepNewlines(html) {
  const s = decodeHtml(
    String(html || "")
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<[^>]+>/g, " ")
  );
  return s
    .split("\n")
    .map((line) => line.replace(/\s+/g, " ").trim())
    .join("\n")
    .trim();
}

function replaceAbbrEnergyTags(htmlFragment) {
  return String(htmlFragment || "").replace(/<abbr\b([^>]*?)>([\s\S]*?)<\/abbr>/gi, (_full, attrs, inner) => {
    const condensed = stripTags(inner).replace(/\s+/g, "").trim();
    if (/\bptcg-symbol-name\b/i.test(String(attrs))) {
      if (/^[A-Za-z]{1,2}$/.test(condensed)) {
        return `{${condensed.toUpperCase()}}`;
      }
      return condensed || "";
    }
    return stripTags(inner).trim();
  });
}

function pickRegex(text, pattern, group = 1) {
  const match = String(text || "").match(pattern);
  return match && match[group] ? decodeHtml(match[group]).trim() : "";
}

function stripIllustratorLvSuffix(value) {
  return String(value || "")
    .replace(/\s*[·•]\s*LV\..*$/i, "")
    .trim();
}

function comparableImageUrl(value) {
  const raw = String(value || "").trim().toLowerCase();
  if (!raw) return "";
  try {
    const u = new URL(raw);
    u.hash = "";
    return u.pathname;
  } catch {
    const pathOnly = raw.split("?")[0].split("#")[0];
    const idx = pathOnly.indexOf("://");
    if (idx !== -1) {
      const afterProto = pathOnly.slice(idx + 3).replace(/^[^/]+/, "");
      return afterProto.toLowerCase();
    }
    return pathOnly.toLowerCase();
  }
}

function resolveDetailsStorageKey(details, row, setEntry) {
  const imgRaw = String(details.imageUrl || row.imageUrl || "").trim();
  const imgs = setEntry?.images && typeof setEntry.images === "object" ? setEntry.images : null;

  if (imgRaw && imgs) {
    const imgPath = comparableImageUrl(imgRaw);
    for (const [k, manifestUrl] of Object.entries(imgs)) {
      const mRaw = String(manifestUrl || "").trim();
      if (!mRaw) continue;
      if (mRaw === imgRaw || comparableImageUrl(mRaw) === imgPath) return k;
    }
  }

  if (/\bAnn25thR?-/i.test(imgRaw)) {
    return null;
  }

  return normalizeCardNumber(String(row.cardNo || details.cardNo || ""));
}

function parseSetCards(setHtml) {
  const cards = [];
  const re = /<a href="https:\/\/pkmncards\.com\/card\/([^"]+)" title="([^"]+)" class="card-image-link"><img[^>]*src="([^"]+)"/g;
  let match = re.exec(setHtml);
  while (match) {
    const cardPath = match[1].trim();
    const title = decodeHtml(match[2].trim());
    const imageUrl = match[3].trim();
    const parsed = title.match(/^(.*?) · .*?#\s*([A-Za-z0-9-]+)$/);
    if (parsed) {
      cards.push({
        name: parsed[1].trim(),
        cardNo: normalizeCardNumber(parsed[2]),
        cardUrl: `https://pkmncards.com/card/${cardPath}`,
        imageUrl
      });
    }
    match = re.exec(setHtml);
  }
  return cards;
}

function parseCardDetails(cardHtml, fallback) {
  const articleHtml = pickRegex(cardHtml, /<article class="type-pkmn_card entry"[\s\S]*?<\/article>/i, 0) || cardHtml;
  const titleRaw = pickRegex(articleHtml, /<h1 class="card-title"[^>]*>([\s\S]*?)<\/h1>/i);
  const name = titleRaw ? titleRaw.split("·")[0].trim() : fallback.name;
  const hpText = pickRegex(articleHtml, /<span class="hp"[^>]*>([\s\S]*?)<\/span>/i);
  const hp = pickRegex(hpText, /([0-9]+)/);
  const stage = stripTags(pickRegex(articleHtml, /<span class="stage"[^>]*>([\s\S]*?)<\/span>/i));
  const evolves = stripTags(pickRegex(articleHtml, /<span class="evolves">([\s\S]*?)<\/span>/i));
  const textBlockInner = pickRegex(articleHtml, /<div class="text">([\s\S]*?)<\/div>/i, 1);
  let attacksText = "";
  if (textBlockInner) {
    const paras = [];
    let pm;
    const pre = /<p[^>]*>([\s\S]*?)<\/p>/gi;
    while ((pm = pre.exec(textBlockInner))) paras.push(pm[1]);
    const flattened =
      paras.length > 0
        ? paras
            .map((chunk) =>
              stripTagsKeepNewlines(replaceAbbrEnergyTags(chunk))
                .split("\n")
                .map((line) => line.replace(/\s+/g, " ").trim())
                .filter(Boolean)
                .join(" ")
            )
            .filter(Boolean)
            .join(" ")
        : stripTagsKeepNewlines(replaceAbbrEnergyTags(textBlockInner))
            .split("\n")
            .map((line) => line.replace(/\s+/g, " ").trim())
            .filter(Boolean)
            .join(" ");
    attacksText = flattened.replace(/\s+/g, " ").trim();
  }
  if (!attacksText) {
    attacksText = stripTags(
      pickRegex(articleHtml, /<div class="text"><p>([\s\S]*?)<\/p>\s*<\/div>/i)
    )
      .replace(/\s+/g, " ")
      .trim();
  }
  const rulesInner = pickRegex(articleHtml, /<div class="rules minor-text">([\s\S]*?)<\/div>/i, 1);
  if (rulesInner) {
    const r = stripTags(decodeHtml(rulesInner)).replace(/\s+/g, " ").trim();
    if (r) attacksText = attacksText ? `${attacksText} ${r}` : r;
  }
  const weakBlock = pickRegex(articleHtml, /<span class="weak"[^>]*>([\s\S]*?)<\/span>/i);
  const resistBlock = pickRegex(articleHtml, /<span class="resist"[^>]*>([\s\S]*?)<\/span>/i);
  const retreatBlock = pickRegex(articleHtml, /<span class="retreat"[^>]*>([\s\S]*?)<\/span>/i);
  const weakType = pickRegex(weakBlock, /<abbr[^>]*title="([^"]+)"/i);
  const weakMultiplier = pickRegex(weakBlock, /<span title="Weakness Modifier">([^<]+)<\/span>/i);
  let weak = weakType
    ? `${weakType}${weakMultiplier ? ` ${weakMultiplier}` : ""}`
    : stripTags(weakBlock).replace(/^weak:\s*/i, "").trim();
  const resistType = pickRegex(resistBlock, /<abbr[^>]*title="([^"]+)"/i);
  let resist = resistType || stripTags(resistBlock).replace(/^resist:\s*/i, "").trim();
  let retreat = stripTags(retreatBlock).replace(/^retreat:\s*/i, "").trim();
  const rarity = stripTags(pickRegex(articleHtml, /<span class="rarity">([\s\S]*?)<\/span>/i));
  const number = normalizeCardNumber(
    stripTags(pickRegex(articleHtml, /<span class="number"><a[^>]*>([\s\S]*?)<\/a><\/span>/i)) || fallback.cardNo
  );
  const total = pickRegex(
    stripTags(pickRegex(articleHtml, /<span class="out-of"[^>]*>([\s\S]*?)<\/span>/i)),
    /([0-9A-Za-z]+)/
  );
  const illustrator = stripIllustratorLvSuffix(
    stripTags(pickRegex(articleHtml, /<div class="illus minor-text">([\s\S]*?)<\/div>/i))
      .replace(/^illus\.\s*/i, "")
      .trim()
  );
  const mark = stripTags(pickRegex(articleHtml, /<span class="Regulation Mark">([\s\S]*?)<\/span>/i))
    .replace(/^Mark:\s*/i, "")
    .trim();
  const formats = stripTags(pickRegex(articleHtml, /<div class="mark-formats minor-text">([\s\S]*?)<\/div>/i))
    .replace(/^Mark:[^·]*·\s*/i, "")
    .replace(/^Formats:\s*/i, "")
    .trim();
  const flavorText = stripTags(pickRegex(articleHtml, /<div class="flavor minor-text">([\s\S]*?)<\/div>/i));
  const ogDescription = decodeHtml(pickRegex(cardHtml, /<meta property="og:description" content="([^"]+)"/i));

  if (!weak || weak === "{" || !resist || !retreat) {
    const weakRaw = pickRegex(ogDescription, /weak:\s*([^|]+)\|/i);
    const resistRaw = pickRegex(ogDescription, /resist:\s*([^|]+)\|/i);
    const retreatRaw = pickRegex(ogDescription, /retreat:\s*([^|]+?)(?:\s+illus\.|$)/i);
    if (weakRaw) weak = weakRaw.trim();
    if (resistRaw) resist = resistRaw.trim();
    if (retreatRaw) retreat = retreatRaw.trim();
  }

  const tcgplayerUrl = extractTcgplayerUrlFromPkmnCardHtml(cardHtml);

  return {
    cardNo: number,
    cardUrl: fallback.cardUrl,
    imageUrl: fallback.imageUrl,
    tcgplayerUrl,
    name,
    hp,
    stage,
    evolves,
    attacksText,
    weakness: weak,
    resistance: resist,
    retreat,
    rarity,
    number,
    total,
    illustrator,
    mark,
    formats,
    flavorText
  };
}

async function fetchHtml(url) {
  const response = await fetch(url, {
    headers: { "User-Agent": "Mozilla/5.0" }
  });
  if (!response.ok) throw new Error(`HTTP ${response.status} for ${url}`);
  return response.text();
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function slugFromSourceHref(sourceHref) {
  const href = String(sourceHref || "").trim();
  const m = href.match(/\/set\/([^/?#]+)/i);
  return m ? m[1].toLowerCase() : "";
}

/**
 * Import one set's card details from PkmnCards.
 */
async function importSetDetailsFromPkmncards({
  setCode,
  setSlug,
  setTitle = "",
  setEntryManifest = null,
  cardDelayMs = 60,
  log = console.log
}) {
  const code = String(setCode || "").trim().toUpperCase();
  const slug = String(setSlug || "").trim().toLowerCase();
  if (!code || !slug) {
    throw new Error("setCode and setSlug are required");
  }

  const setUrl = `https://pkmncards.com/set/${slug}/`;
  const setHtml = await fetchHtml(setUrl);
  const cardRows = parseSetCards(setHtml);
  const byCardNo = {};
  const failures = [];
  const skippedNoKey = [];

  for (const row of cardRows) {
    try {
      const cardHtml = await fetchHtml(row.cardUrl);
      const details = parseCardDetails(cardHtml, row);
      const resolvedKey = resolveDetailsStorageKey(details, row, setEntryManifest);

      if (resolvedKey === null || !String(resolvedKey).trim()) {
        skippedNoKey.push({
          listTitleNo: row.cardNo,
          name: details.name,
          imageUrl: details.imageUrl || row.imageUrl
        });
        log(`skip ${code} (no manifest image match) ${row.cardNo} ${details.name}`);
        continue;
      }

      const storageKey = String(resolvedKey).trim();
      byCardNo[storageKey] = details;
      log(`ok ${code} ${storageKey} (${row.cardNo}) ${row.name}`);
    } catch (err) {
      failures.push({ cardNo: row.cardNo, cardUrl: row.cardUrl, error: String(err.message || err) });
      log(`fail ${code} ${row.cardNo} ${row.name} -> ${String(err.message || err)}`);
    }
    if (cardDelayMs > 0) await sleep(cardDelayMs);
  }

  const entryPayload = {
    sourceHref: `/set/${slug}/`,
    sourceTitle:
      setTitle ||
      (slug ? slug.replace(/-/g, " ").replace(/\b\w/g, (s) => s.toUpperCase()) : code),
    totalCards: Object.keys(byCardNo).length,
    cards: byCardNo,
    failures
  };
  if (skippedNoKey.length) entryPayload.skippedNotInManifest = skippedNoKey;

  return entryPayload;
}

module.exports = {
  extractTcgplayerUrlFromPkmnCardHtml,
  importSetDetailsFromPkmncards,
  slugFromSourceHref,
  parseSetCards,
  parseCardDetails
};
