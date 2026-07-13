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

  /** Home-only: fixed element pool — no create/destroy per flight. */
  let skyRecyclerToken = null;

  function stopInfinityCardSkyRecycler() {
    if (skyRecyclerToken && typeof skyRecyclerToken.cleanup === "function") {
      try {
        skyRecyclerToken.cleanup();
      } catch {
        /* ignore */
      }
    }
    skyRecyclerToken = null;
    const sky = byId("cardSky");
    if (sky) {
      sky.replaceChildren();
      sky.classList.remove("card-sky--recycle", "card-sky-frozen");
    }
  }

  function downsampleCardUrl(url, maxW) {
    return new Promise((resolve) => {
      const img = new Image();
      img.decoding = "async";
      img.referrerPolicy = "no-referrer";
      img.onload = () => {
        try {
          const w = Math.max(1, Math.min(maxW, img.naturalWidth || maxW));
          const ratio = (img.naturalHeight || maxW) / (img.naturalWidth || maxW);
          const h = Math.max(1, Math.round(w * ratio));
          const canvas = document.createElement("canvas");
          canvas.width = w;
          canvas.height = h;
          const ctx = canvas.getContext("2d", { alpha: false });
          if (!ctx) {
            resolve(url);
            return;
          }
          ctx.drawImage(img, 0, 0, w, h);
          resolve(canvas.toDataURL("image/jpeg", 0.72));
        } catch {
          resolve(url);
        }
      };
      img.onerror = () => resolve("");
      img.src = url;
    });
  }

  async function preloadDownsampled(urls, maxW) {
    const out = [];
    const queue = urls.slice();
    const concurrency = 4;
    async function worker() {
      while (queue.length) {
        const u = queue.shift();
        const data = await downsampleCardUrl(u, maxW);
        if (data) out.push(data);
      }
    }
    await Promise.all(Array.from({ length: concurrency }, () => worker()));
    return out;
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
    const dpr = Math.min(1.25, window.devicePixelRatio || 1);
    const thumbW = Math.round((narrow ? 140 : 200) * dpr);

    let poolCap;
    let maxActive;
    let durMinSec;
    let durRangeSec;
    if (catalogSearch) {
      poolCap = narrow ? 16 : 22;
      maxActive = narrow ? 9 : 12;
      durMinSec = 13;
      durRangeSec = 6;
    } else if (homeSky) {
      poolCap = narrow ? 32 : 48;
      maxActive = narrow ? 14 : 22;
      durMinSec = 12;
      durRangeSec = 6;
    } else {
      poolCap = narrow ? 28 : 40;
      maxActive = narrow ? 12 : 18;
      durMinSec = 12;
      durRangeSec = 5;
    }

    const sourcePool = shuffle(uniq).slice(0, Math.min(uniq.length, poolCap));
    maxActive = Math.min(maxActive, sourcePool.length);

    void (async () => {
      const warm = await preloadDownsampled(sourcePool, thumbW);
      if (skyRecyclerToken !== token || !warm.length) return;

      let deck = shuffle(warm);
      let deckIndex = 0;
      const active = [];

      function nextSrc() {
        if (!deck.length) return "";
        const src = deck[deckIndex % deck.length];
        deckIndex += 1;
        if (deckIndex >= deck.length) {
          deck = shuffle(deck);
          deckIndex = 0;
        }
        return src;
      }

      function armFlight(img, staggerSec) {
        if (skyRecyclerToken !== token) return;
        const startVw = Math.random() * 120 - 15;
        const endVw = startVw + (Math.random() * 48 - 24);
        const duration = durMinSec + Math.random() * durRangeSec;
        const r1 = Math.random() * 24 - 12;
        const r2 = r1 + (Math.random() * 36 - 18);

        img.style.setProperty("--x-start", `${startVw.toFixed(2)}vw`);
        img.style.setProperty("--x-end", `${endVw.toFixed(2)}vw`);
        img.style.setProperty("--dur", `${duration.toFixed(2)}s`);
        img.style.setProperty("--delay", `${Math.max(0, staggerSec).toFixed(2)}s`);
        img.style.setProperty("--rot-start", `${r1.toFixed(2)}deg`);
        img.style.setProperty("--rot-end", `${r2.toFixed(2)}deg`);

        // Restart CSS animation without recreating the node.
        img.style.animation = "none";
        // Force reflow so the next animation name takes effect.
        void img.offsetWidth;
        img.style.animation = "";
        img.classList.add("flying-card--ready");
      }

      function onFlightEnd(event) {
        if (skyRecyclerToken !== token) return;
        const img = event.currentTarget;
        img.src = nextSrc() || img.src;
        armFlight(img, Math.random() * 0.35);
      }

      const frag = document.createDocumentFragment();
      for (let i = 0; i < maxActive; i += 1) {
        const img = document.createElement("img");
        img.className = "flying-card flying-card--recycle flying-card--ready";
        img.alt = "";
        img.decoding = "sync";
        img.draggable = false;
        img.src = nextSrc();
        img.addEventListener("animationend", onFlightEnd);
        active.push(img);
        frag.appendChild(img);
        armFlight(img, i * (narrow ? 0.28 : 0.2));
      }
      sky.appendChild(frag);

      function onVisibility() {
        if (document.hidden) sky.classList.add("card-sky-frozen");
        else sky.classList.remove("card-sky-frozen");
      }
      document.addEventListener("visibilitychange", onVisibility);
      onVisibility();
      token.cleanup = () => document.removeEventListener("visibilitychange", onVisibility);
    })();
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
