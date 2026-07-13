(function (global) {
  "use strict";

  function byId(id) {
    return document.getElementById(id);
  }

  function unique(values) {
    return [...new Set(values.filter(Boolean))];
  }

  function shuffle(values) {
    const out = [...values];
    for (let i = out.length - 1; i > 0; i -= 1) {
      const j = Math.floor(Math.random() * (i + 1));
      [out[i], out[j]] = [out[j], out[i]];
    }
    return out;
  }

  function isCardImageUrl(value, opts) {
    const allowJa = opts && opts.includeJapanesePaths;
    const s = String(value || "").trim();
    if (!s) return false;
    if (!allowJa && (s.includes("card-images-japanese") || s.startsWith("/card-images-japanese/"))) {
      return false;
    }
    if (s.startsWith("/card-images-japanese/")) return true;
    if (s.startsWith("/card-images/")) return true;
    return false;
  }

  function pickCardImageSrc(local, remote, opts) {
    const allowJa = opts && opts.includeJapanesePaths;
    const l = String(local || "").trim();
    const r = String(remote || "").trim();

    if (l) {
      const lJa = l.includes("card-images-japanese") || l.startsWith("/card-images-japanese/");
      if (lJa) {
        if (allowJa) return l;
      } else if (l.startsWith("/card-images/")) {
        return l;
      }
    }

    if (r) {
      const rJa = r.includes("card-images-japanese") || r.startsWith("/card-images-japanese/");
      if (rJa) {
        if (allowJa) return r;
      } else if (r.startsWith("/card-images/")) {
        return r;
      }
    }
    return "";
  }

  function normalizeSetCodeFilter(setCodeFilter) {
    if (setCodeFilter == null) return null;
    const list = Array.isArray(setCodeFilter) ? setCodeFilter : [...setCodeFilter];
    const upper = list.map((c) => String(c || "").toUpperCase()).filter(Boolean);
    return new Set(upper);
  }

  function collectAllCardImageUrls(payload, setCodeFilter, opts) {
    const urls = [];
    const filter = normalizeSetCodeFilter(setCodeFilter);
    if (filter && filter.size === 0) return urls;
    const byCode = payload && payload.byCode && typeof payload.byCode === "object" ? payload.byCode : {};
    for (const [code, entry] of Object.entries(byCode)) {
      const codeKey = String(code || "").toUpperCase();
      if (filter && !filter.has(codeKey)) continue;
      const cards = entry && entry.cards && typeof entry.cards === "object" ? entry.cards : {};
      const localImages = entry && entry.localImages && typeof entry.localImages === "object" ? entry.localImages : {};
      const images = entry && entry.images && typeof entry.images === "object" ? entry.images : {};
      const keys = new Set([...Object.keys(cards), ...Object.keys(localImages), ...Object.keys(images)]);
      for (const key of keys) {
        const src = pickCardImageSrc(localImages[key], images[key], opts);
        if (isCardImageUrl(src, opts)) urls.push(src);
      }
    }
    return urls;
  }

  function renderInfinityCardSky(urls, options) {
    const sky = byId("cardSky");
    if (!sky) return;
    const opts = options && typeof options === "object" ? options : {};
    const catalogSearch = Boolean(opts.catalogSearch);
    if (!urls || !urls.length) {
      sky.replaceChildren();
      return;
    }
    const narrow = window.innerWidth < 900;
    const pool = shuffle(unique(urls));
    let cards;

    if (catalogSearch) {
      /**
       * Sets catalog search: only images from the current Search Results list.
       * Keep counts low so typing in search does not constantly restart the whole sky.
       */
      const maxUnique = narrow ? 12 : 16;
      const effectivePool = pool.slice(0, Math.min(pool.length, maxUnique));
      if (!effectivePool.length) {
        sky.replaceChildren();
        return;
      }
      const minFly = narrow ? 6 : 8;
      if (effectivePool.length >= minFly) {
        cards = shuffle([...effectivePool]);
      } else {
        cards = [];
        for (let i = 0; i < minFly; i += 1) {
          cards.push(effectivePool[i % effectivePool.length]);
        }
        shuffle(cards);
      }
    } else {
      /** Fewer layers = less decode / layout work. */
      const slotCount = narrow ? 40 : 56;
      const maxDistinct = Math.min(pool.length, narrow ? 20 : 32);
      const effectivePool = pool.slice(0, Math.max(1, maxDistinct));
      cards = [];
      for (let i = 0; i < slotCount; i += 1) {
        cards.push(effectivePool[i % effectivePool.length]);
      }
      shuffle(cards);
    }

    const slotCount = cards.length;

    const durMinSec = catalogSearch ? 11 : 7;
    const durRangeSec = catalogSearch ? 8 : 9;
    const fetchPriHighCutoff = Math.ceil(slotCount * 0.45);

    const nodes = [];
    for (let index = 0; index < cards.length; index += 1) {
      const src = cards[index];
      const startVw = Math.random() * 138 - 24;
      const driftVw = Math.random() * 72 - 36;
      const endVw = startVw + driftVw;
      const duration = `${(durMinSec + Math.random() * durRangeSec).toFixed(2)}s`;
      const delay = `${(-Math.random() * Number.parseFloat(duration)).toFixed(2)}s`;
      const r1 = Math.random() * 36 - 18;
      const r2 = r1 + (Math.random() * 56 - 28);
      const xs = `${startVw.toFixed(2)}vw`;
      const xe = `${endVw.toFixed(2)}vw`;
      const z = 1 + (index % 12);

      const img = document.createElement("img");
      img.className = "flying-card";
      img.src = src;
      img.alt = "";
      img.loading = "eager";
      img.decoding = "async";
      img.referrerPolicy = "no-referrer";
      if ("fetchPriority" in img) {
        img.fetchPriority = index < fetchPriHighCutoff ? "high" : "low";
      }
      img.style.setProperty("--x-start", xs);
      img.style.setProperty("--x-end", xe);
      img.style.setProperty("--dur", duration);
      img.style.setProperty("--delay", delay);
      img.style.setProperty("--rot-start", `${r1.toFixed(2)}deg`);
      img.style.setProperty("--rot-end", `${r2.toFixed(2)}deg`);
      img.style.zIndex = String(z);
      nodes.push(img);
    }

    sky.replaceChildren();
    const SYNC_FIRST = Math.min(28, nodes.length);
    const firstFrag = document.createDocumentFragment();
    for (let i = 0; i < SYNC_FIRST; i += 1) {
      firstFrag.appendChild(nodes[i]);
    }
    sky.appendChild(firstFrag);

    let idx = SYNC_FIRST;
    const CHUNK = 32;
    function appendRest() {
      const sub = document.createDocumentFragment();
      const end = Math.min(idx + CHUNK, nodes.length);
      for (; idx < end; idx += 1) {
        sub.appendChild(nodes[idx]);
      }
      sky.appendChild(sub);
      if (idx < nodes.length) {
        requestAnimationFrame(appendRest);
      }
    }
    if (idx < nodes.length) {
      requestAnimationFrame(appendRest);
    }
  }

  function renderInfinityCardSkyFromPayload(payload, setCodeFilter, opts) {
    const urls = unique([...collectAllCardImageUrls(payload, setCodeFilter, opts)]);
    renderInfinityCardSky(urls);
  }

  function renderInfinityCardSkyFromPayloads(payloads, setCodeFilter, opts) {
    const list = Array.isArray(payloads) ? payloads : [];
    const merged = [];
    for (const p of list) {
      merged.push(...collectAllCardImageUrls(p, setCodeFilter, opts));
    }
    renderInfinityCardSky(unique(merged));
  }

  /** Home-only: no duplicate URLs in flight; each card is replaced after one pass. */
  let skyRecyclerToken = null;

  function stopInfinityCardSkyRecycler() {
    skyRecyclerToken = null;
    const sky = byId("cardSky");
    if (sky) {
      sky.replaceChildren();
      sky.classList.remove("card-sky--recycle");
    }
  }

  function startInfinityCardSkyRecycler(urls, options) {
    stopInfinityCardSkyRecycler();
    const sky = byId("cardSky");
    if (!sky) return;
    const opts = options && typeof options === "object" ? options : {};
    const catalogSearch = Boolean(opts.catalogSearch);
    const uniq = unique(urls);
    if (!uniq.length) {
      sky.replaceChildren();
      return;
    }

    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      renderInfinityCardSky(uniq, opts);
      return;
    }

    const token = {};
    skyRecyclerToken = token;
    sky.classList.add("card-sky--recycle");

    const narrow = window.innerWidth < 900;
    const homeSky = Boolean(opts.homeSky);
    let pool = uniq;
    /** Home: small shuffled deck — reuse cached images instead of walking the full catalog. */
    let homeDeck = null;
    let homeDeckIndex = 0;
    if (catalogSearch) {
      const maxUnique = narrow ? 12 : 16;
      pool = uniq.slice(0, Math.min(uniq.length, maxUnique));
    } else if (homeSky) {
      const maxDistinct = Math.min(uniq.length, narrow ? 36 : 56);
      homeDeck = shuffle(uniq.slice(0, maxDistinct));
      pool = homeDeck;
    } else {
      const maxDistinct = Math.min(uniq.length, narrow ? 28 : 44);
      pool = uniq.slice(0, Math.max(1, maxDistinct));
    }
    const maxActive = catalogSearch
      ? Math.min(narrow ? 8 : 12, pool.length)
      : homeSky
        ? Math.min(narrow ? 12 : 16, pool.length)
        : Math.min(narrow ? 16 : 22, pool.length);
    const inUse = new Set();
    const durMinSec = catalogSearch ? 12 : 9;
    const durRangeSec = catalogSearch ? 8 : 8;

    function pickUrl() {
      if (homeSky && homeDeck && homeDeck.length) {
        const n = homeDeck.length;
        for (let attempt = 0; attempt < n; attempt += 1) {
          const url = homeDeck[homeDeckIndex % n];
          homeDeckIndex += 1;
          if (homeDeckIndex >= n) {
            homeDeck = shuffle(homeDeck);
            homeDeckIndex = 0;
          }
          if (!inUse.has(url)) return url;
        }
      }
      const avail = pool.filter((u) => !inUse.has(u));
      if (avail.length) return avail[Math.floor(Math.random() * avail.length)];
      return pool[Math.floor(Math.random() * pool.length)];
    }

    function spawnOne(options) {
      if (skyRecyclerToken !== token) return;
      const staggerSec =
        options && typeof options.staggerSec === "number" && Number.isFinite(options.staggerSec)
          ? Math.max(0, options.staggerSec)
          : 0;

      const url = pickUrl();
      const startVw = Math.random() * 138 - 24;
      const driftVw = Math.random() * 72 - 36;
      const endVw = startVw + driftVw;
      const duration = `${(durMinSec + Math.random() * durRangeSec).toFixed(2)}s`;
      const r1 = Math.random() * 36 - 18;
      const r2 = r1 + (Math.random() * 56 - 28);
      const xs = `${startVw.toFixed(2)}vw`;
      const xe = `${endVw.toFixed(2)}vw`;
      const z = 1 + Math.floor(Math.random() * 12);

      inUse.add(url);

      const img = document.createElement("img");
      img.className = "flying-card flying-card--recycle";
      img.alt = "";
      img.loading = "lazy";
      img.decoding = "async";
      img.referrerPolicy = "no-referrer";
      if ("fetchPriority" in img) {
        img.fetchPriority = "low";
      }
      img.style.setProperty("--x-start", xs);
      img.style.setProperty("--x-end", xe);
      img.style.setProperty("--dur", duration);
      img.style.setProperty("--delay", `${staggerSec.toFixed(2)}s`);
      img.style.setProperty("--rot-start", `${r1.toFixed(2)}deg`);
      img.style.setProperty("--rot-end", `${r2.toFixed(2)}deg`);
      img.style.zIndex = String(z);

      img.addEventListener(
        "animationend",
        () => {
          if (skyRecyclerToken !== token) return;
          inUse.delete(url);
          img.remove();
          spawnOne({ staggerSec: Math.random() * 0.22 });
        },
        { once: true }
      );

      function releaseUrlAndMaybeRetry() {
        inUse.delete(url);
        if (skyRecyclerToken === token) {
          spawnOne({ staggerSec });
        }
      }

      function appendWhenReady() {
        if (skyRecyclerToken !== token) {
          inUse.delete(url);
          return;
        }
        img.classList.add("flying-card--ready");
        sky.appendChild(img);
      }

      img.src = url;
      if (img.complete) {
        appendWhenReady();
      } else {
        img.addEventListener("load", appendWhenReady, { once: true });
        img.addEventListener("error", releaseUrlAndMaybeRetry, { once: true });
      }
    }

    for (let i = 0; i < maxActive; i += 1) {
      spawnOne({ staggerSec: i * 0.034 });
    }
  }

  function startInfinityCardSkyRecyclerFromPayloads(payloads, setCodeFilter, opts) {
    const list = Array.isArray(payloads) ? payloads : [];
    const merged = [];
    for (const p of list) {
      merged.push(...collectAllCardImageUrls(p, setCodeFilter, opts));
    }
    const skyOpts = opts && typeof opts === "object" ? opts : {};
    startInfinityCardSkyRecycler(unique(merged), skyOpts);
  }

  async function bootstrapInfinityCardSky() {
    try {
      const sampleRes = await fetch("/api/sets/card-sky-urls?limit=250");
      if (sampleRes.ok) {
        const sample = await sampleRes.json();
        const urls = sample && Array.isArray(sample.urls) ? sample.urls : [];
        if (urls.length) {
          startInfinityCardSkyRecycler(urls, { homeSky: true });
          return;
        }
      }
      const res = await fetch("/api/sets/cards?language=english");
      const payload = res.ok ? await res.json() : null;
      startInfinityCardSkyRecyclerFromPayloads([payload]);
    } catch (_) {
      /* ignore */
    }
  }

  function scheduleAutoInit() {
    const el = byId("cardSky");
    if (!el || el.dataset.autoInit === "off") return;
    bootstrapInfinityCardSky();
  }

  global.renderInfinityCardSky = renderInfinityCardSky;
  global.renderInfinityCardSkyFromPayload = renderInfinityCardSkyFromPayload;
  global.renderInfinityCardSkyFromPayloads = renderInfinityCardSkyFromPayloads;
  global.startInfinityCardSkyRecycler = startInfinityCardSkyRecycler;
  global.startInfinityCardSkyRecyclerFromPayloads = startInfinityCardSkyRecyclerFromPayloads;
  global.stopInfinityCardSkyRecycler = stopInfinityCardSkyRecycler;
  global.bootstrapInfinityCardSky = bootstrapInfinityCardSky;

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", scheduleAutoInit);
  } else {
    scheduleAutoInit();
  }
})(typeof window !== "undefined" ? window : {});
