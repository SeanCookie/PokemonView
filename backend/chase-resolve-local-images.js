"use strict";

function slugify(value) {
  return String(value || "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function decodeHtmlEntities(s) {
  return String(s || "")
    .replace(/&#8217;/g, "'")
    .replace(/&#8211;/g, "-")
    .replace(/&#038;/g, "&")
    .replace(/&#\d+;/g, " ");
}

function cardNoCandidates(cardNumberRaw) {
  const no = String(cardNumberRaw || "").trim();
  if (!no) return [];
  const candidates = new Set([no]);
  const n = Number(no);
  if (Number.isFinite(n)) {
    candidates.add(String(n));
    candidates.add(String(n).padStart(3, "0"));
  }
  const promo = no.match(/^(\d+)([a-zA-Z]+)$/);
  if (promo) {
    const base = promo[1];
    const suffix = promo[2];
    candidates.add(base);
    const bn = Number(base);
    if (Number.isFinite(bn)) {
      candidates.add(String(bn).padStart(3, "0") + suffix);
      candidates.add(String(bn) + suffix);
    }
  }
  return [...candidates].filter(Boolean);
}

function pickLocalImagePath(localImages, cardNumberRaw) {
  if (!localImages || typeof localImages !== "object") return "";
  for (const key of cardNoCandidates(cardNumberRaw)) {
    const v = localImages[key];
    if (v && isLocalDbImagePath(v)) return String(v).trim();
  }
  return "";
}

function isLocalDbImagePath(p) {
  const s = String(p || "");
  return s.startsWith("/card-images/") || s.startsWith("/card-images-japanese/");
}

function isPokemonCategory(item) {
  const slug = String(item.category_slug || "").toLowerCase();
  if (slug === "pokemon") return true;
  return /pok/.test(String(item.category || "").toLowerCase());
}

function parseChaseTitle(title) {
  const t = String(title || "").trim();
  const m = t.match(/^#\s*([A-Za-z0-9]+)\s*(.*)$/i);
  if (!m) return { cardNoRaw: "", rest: t };
  return { cardNoRaw: m[1], rest: m[2].trim() };
}

function chaseLanguageFromSubtitle(subtitle) {
  return /japanese/i.test(String(subtitle || "")) ? "japanese" : "english";
}

function setHintSlugFromSubtitle(subtitle) {
  const part0 = String(subtitle || "").split("|")[0].trim();
  const s = part0
    .replace(/^\d{4}\s*/i, "")
    .replace(/^pokemon\s*/i, "")
    .replace(/\s*japanese\s*/gi, " ")
    .trim();
  return slugify(s);
}

function parallelSlugFromSubtitle(subtitle) {
  const parts = String(subtitle || "").split("|");
  if (parts.length < 2) return "";
  return slugify(parts[1].trim());
}

function chaseCardNameSlug(rest, parallelSlug) {
  let combined = `${rest} ${parallelSlug.replace(/-/g, " ")}`.toUpperCase();
  combined = combined
    .replace(/\bHOLO\b/g, " ")
    .replace(/\bFULL\s+ART\b/g, " FA ")
    .replace(/\bGOLD\s+STAR\b/g, " STAR ")
    .replace(/\s+/g, " ")
    .trim();
  return slugify(combined);
}

function flattenManifestRows(manifest, language) {
  const byCode =
    manifest && manifest.byCode && typeof manifest.byCode === "object" ? manifest.byCode : {};
  const rows = [];
  for (const [code, ent] of Object.entries(byCode)) {
    if (!ent || typeof ent.cards !== "object") continue;
    const href = String(ent.sourceHref || "");
    let hrefTail = "";
    try {
      if (href.startsWith("http")) {
        const u = new URL(href);
        hrefTail = decodeURIComponent(u.pathname.replace(/^\/+|\/+$/g, "").replace(/\/+/g, " "));
      } else {
        const m = href.match(/\/(?:set\/|)([^/?#]+)/i);
        hrefTail = m ? decodeURIComponent(m[1].replace(/\+/g, " ")) : "";
      }
    } catch {
      hrefTail = "";
    }
    rows.push({
      code,
      language,
      sourceTitle: String(ent.sourceTitle || ""),
      titleSlug: slugify(ent.sourceTitle),
      hrefSlug: slugify(hrefTail),
      cards: ent.cards,
      localImages: ent.localImages && typeof ent.localImages === "object" ? ent.localImages : {}
    });
  }
  return rows;
}

function scoreSetHint(row, hintSlug) {
  if (!hintSlug) return 1;
  const hay = slugify(`${row.code} ${row.sourceTitle} ${row.hrefSlug || ""} ${row.titleSlug}`);
  const tokens = hintSlug.split("-").filter((t) => t.length > 2);
  if (!tokens.length) return hintSlug.length ? 0 : 1;
  let s = 0;
  for (const t of tokens) {
    if (hay === t) s += 10;
    else if (hay.includes(t)) s += 5;
  }
  return s;
}

function nameScore(dbName, chaseSlug) {
  const db = slugify(decodeHtmlEntities(dbName));
  if (!db || !chaseSlug) return 0;
  if (db === chaseSlug) return 100;
  if (db.includes(chaseSlug) || chaseSlug.includes(db)) return 85;
  const a = new Set(db.split("-").filter((x) => x.length > 1));
  const b = new Set(chaseSlug.split("-").filter((x) => x.length > 1));
  let hit = 0;
  for (const x of b) if (a.has(x)) hit += 1;
  return hit * 12;
}

function buildCardLookup(rows) {
  const lookup = new Map();
  for (const row of rows) {
    for (const k of Object.keys(row.localImages)) {
      const path = row.localImages[k];
      if (!isLocalDbImagePath(path)) continue;
      const name = row.cards[k];
      if (!name) continue;
      const key = `${row.language}\t${k}`;
      if (!lookup.has(key)) lookup.set(key, []);
      lookup.get(key).push({ row, path, k, name });
    }
  }
  return lookup;
}

let cache = {
  lookup: null,
  rows: null
};

const MIN_SCORE = 28;

async function ensureLookup(getSetCardManifest) {
  if (cache.lookup) return cache.lookup;
  const [en, ja] = await Promise.all([
    getSetCardManifest("english"),
    getSetCardManifest("japanese")
  ]);
  const rows = [...flattenManifestRows(en, "english"), ...flattenManifestRows(ja, "japanese")];
  cache.rows = rows;
  cache.lookup = buildCardLookup(rows);
  return cache.lookup;
}

function gatherCandidates(lookup, lang, cardNoRaw) {
  const merged = [];
  const seen = new Set();
  for (const key of cardNoCandidates(cardNoRaw)) {
    const arr = lookup.get(`${lang}\t${key}`) || [];
    for (const entry of arr) {
      const sid = `${entry.row.code}\t${entry.k}`;
      if (seen.has(sid)) continue;
      seen.add(sid);
      merged.push(entry);
    }
  }
  return merged;
}

function resolveOne(item, lookup) {
  if (!isPokemonCategory(item)) return null;
  const { cardNoRaw, rest } = parseChaseTitle(item.title);
  if (!cardNoRaw) return null;
  const lang = chaseLanguageFromSubtitle(item.subtitle);
  const hintSlug = setHintSlugFromSubtitle(item.subtitle);
  const parallelSlug = parallelSlugFromSubtitle(item.subtitle);
  const chaseSlug = chaseCardNameSlug(rest, parallelSlug);

  const candidates = gatherCandidates(lookup, lang, cardNoRaw);
  if (!candidates.length) return null;

  let best = null;
  let bestScore = -1;
  let secondBest = -1;
  for (const c of candidates) {
    const setScore = scoreSetHint(c.row, hintSlug);
    if (setScore < 1) continue;
    const ns = nameScore(c.name, chaseSlug);
    const total = setScore * 8 + ns;
    if (total > bestScore) {
      secondBest = bestScore;
      bestScore = total;
      best = c;
    } else if (total > secondBest) {
      secondBest = total;
    }
  }
  if (!best || bestScore < MIN_SCORE) return null;
  if (secondBest >= MIN_SCORE && secondBest >= bestScore - 4) return null;
  const path = pickLocalImagePath(best.row.localImages, cardNoRaw);
  if (!path) return null;
  return { image: path, image_back: null };
}

async function resolveChaseLocalImagesBatch(items, getSetCardManifest) {
  const lookup = await ensureLookup(getSetCardManifest);
  const byId = {};
  for (const it of items) {
    if (!it || !it.id) continue;
    const hit = resolveOne(it, lookup);
    if (hit && hit.image) byId[it.id] = hit;
  }
  return byId;
}

module.exports = { resolveChaseLocalImagesBatch };
