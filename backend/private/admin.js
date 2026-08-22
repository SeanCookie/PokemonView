(() => {
  const denied = document.getElementById("adminDenied");
  const app = document.getElementById("adminApp");
  const tcgLastSuccess = document.getElementById("tcgLastSuccess");
  const tcgCacheSaved = document.getElementById("tcgCacheSaved");
  const tcgCacheLive = document.getElementById("tcgCacheLive");
  const tcgPricedCount = document.getElementById("tcgPricedCount");
  const tcgTotalLinks = document.getElementById("tcgTotalLinks");
  const tcgCacheCard = document.getElementById("tcgCacheCard");
  const tcgStatusBadge = document.getElementById("tcgStatusBadge");
  const tcgProgressBar = document.getElementById("tcgProgressBar");
  const tcgProgressText = document.getElementById("tcgProgressText");
  const pcDetailsCacheCount = document.getElementById("pcDetailsCacheCount");
  const pcUpdatedCount = document.getElementById("pcUpdatedCount");
  const pcTotalSections = document.getElementById("pcTotalSections");
  const pcDetailsProgressText = document.getElementById("pcDetailsProgressText");
  const pcCacheCard = document.getElementById("pcCacheCard");
  const pcLastSuccess = document.getElementById("pcLastSuccess");
  const pcCacheSaved = document.getElementById("pcCacheSaved");
  const pcStatusBadge = document.getElementById("pcStatusBadge");
  const pcProgressBar = document.getElementById("pcProgressBar");
  const pcStatusMsg = document.getElementById("pcStatusMsg");
  const btnPcDetailsUpdate = document.getElementById("btnPcDetailsUpdate");
  const btnPcDetailsStop = document.getElementById("btnPcDetailsStop");
  const pcFailLinksSection = document.getElementById("pcFailLinksSection");
  const pcFailLinksCount = document.getElementById("pcFailLinksCount");
  const pcFailLinksList = document.getElementById("pcFailLinksList");
  const btnClearPcFailLinks = document.getElementById("btnClearPcFailLinks");
  const pcConsoleResolveUrl = document.getElementById("pcConsoleResolveUrl");
  const pcConsoleResolveSet = document.getElementById("pcConsoleResolveSet");
  const btnPcConsoleResolve = document.getElementById("btnPcConsoleResolve");
  const pcCorrectCardSearch = document.getElementById("pcCorrectCardSearch");
  const pcCorrectSelectedCard = document.getElementById("pcCorrectSelectedCard");
  const pcCorrectCardResults = document.getElementById("pcCorrectCardResults");
  const pcCorrectCardResultsMeta = document.getElementById("pcCorrectCardResultsMeta");
  const pcCorrectCardGrid = document.getElementById("pcCorrectCardGrid");
  const pcCorrectCurrentLink = document.getElementById("pcCorrectCurrentLink");
  const pcCorrectProductUrl = document.getElementById("pcCorrectProductUrl");
  const btnPcCorrectSave = document.getElementById("btnPcCorrectSave");
  const pcCorrectStatusMsg = document.getElementById("pcCorrectStatusMsg");
  const tcgSetRefreshSelect = document.getElementById("tcgSetRefreshSelect");
  const btnTcgSetRefresh = document.getElementById("btnTcgSetRefresh");
  const pcSetRefreshSelect = document.getElementById("pcSetRefreshSelect");
  const btnPcSetRefresh = document.getElementById("btnPcSetRefresh");
  const tcgStatusMsg = document.getElementById("tcgStatusMsg");
  const btnTcgPriceUpdate = document.getElementById("btnTcgPriceUpdate");
  const btnTcgPriceStop = document.getElementById("btnTcgPriceStop");
  const tcgFailLinksSection = document.getElementById("tcgFailLinksSection");
  const btnClearTcgFailLinks = document.getElementById("btnClearTcgFailLinks");
  const tcgFailLinksCount = document.getElementById("tcgFailLinksCount");
  const tcgFailLinksList = document.getElementById("tcgFailLinksList");
  const statUsers = document.getElementById("statUsers");
  const statItems = document.getElementById("statItems");
  const statActivities = document.getElementById("statActivities");
  const statManualRestock = document.getElementById("statManualRestock");
  const restockCacheCard = document.getElementById("restockCacheCard");
  const restockLastRefresh = document.getElementById("restockLastRefresh");
  const restockItemCount = document.getElementById("restockItemCount");
  const restockLastSummary = document.getElementById("restockLastSummary");
  const restockStatusBadge = document.getElementById("restockStatusBadge");
  const restockProgressBar = document.getElementById("restockProgressBar");
  const restockProgressText = document.getElementById("restockProgressText");
  const restockRetailerList = document.getElementById("restockRetailerList");
  const btnRestockSelectAll = document.getElementById("btnRestockSelectAll");
  const btnRestockSelectNone = document.getElementById("btnRestockSelectNone");
  const restockRefreshMsg = document.getElementById("restockRefreshMsg");
  const btnRestockRefresh = document.getElementById("btnRestockRefresh");
  const btnRestockStop = document.getElementById("btnRestockStop");
  const btnClearActivities = document.getElementById("btnClearActivities");
  const siteStatusMsg = document.getElementById("siteStatusMsg");
  const restockForm = document.getElementById("restockForm");
  const restockFormMsg = document.getElementById("restockFormMsg");
  const manualRestockBody = document.getElementById("manualRestockBody");
  const nicknameForm = document.getElementById("nicknameForm");
  const nicknameFormMsg = document.getElementById("nicknameFormMsg");
  const nicknameBody = document.getElementById("nicknameBody");
  const nicknameSetCode = document.getElementById("nicknameSetCode");
  const nicknameText = document.getElementById("nicknameText");
  const nicknameCardNumber = document.getElementById("nicknameCardNumber");
  const nicknameLanguage = document.getElementById("nicknameLanguage");
  const nicknameCardSearch = document.getElementById("nicknameCardSearch");
  const nicknameCardResults = document.getElementById("nicknameCardResults");
  const nicknameCardResultsMeta = document.getElementById("nicknameCardResultsMeta");
  const nicknameCardGrid = document.getElementById("nicknameCardGrid");
  const nicknameSelectedCard = document.getElementById("nicknameSelectedCard");
  const nicknameSubmitBtn = document.getElementById("nicknameSubmitBtn");
  const usersBody = document.getElementById("usersBody");
  const usersSearch = document.getElementById("usersSearch");
  const usersCountLabel = document.getElementById("usersCountLabel");
  let allUsersCache = [];

  let tcgPollTimer = null;
  let pcPollTimer = null;
  let restockPollTimer = null;
  let restockRetailerOptions = [];
  let restockRetailerSelection = null;
  const nicknameCardIndex = { english: null, japanese: null };
  let nicknameSelected = null;
  let nicknameSearchTimer = null;
  let pcCorrectSelected = null;
  let pcCorrectSearchTimer = null;
  const NICKNAME_CARD_SEARCH_DEBOUNCE_MS = 320;
  const NICKNAME_CARD_SEARCH_LIMIT = 120;

  function formatDateTime(value) {
    const text = String(value || "").trim();
    if (!text) return "—";
    const d = new Date(text);
    if (Number.isNaN(d.getTime())) return text;
    return d.toLocaleString();
  }

  function setStatus(el, message, type = "") {
    if (!el) return;
    el.textContent = message || "";
    el.classList.remove("ok", "error");
    if (type) el.classList.add(type);
  }

  function renderTcgCache(tcg) {
    if (!tcg) return;
    tcgLastSuccess.textContent = formatDateTime(tcg.lastSuccessfulAt || tcg.finishedAt);
    tcgCacheSaved.textContent = formatDateTime(tcg.cacheSavedAt);

    const progress = tcg.progress || {};
    const totalLinks =
      Number(tcg.totalLinkCount) > 0
        ? Number(tcg.totalLinkCount)
        : Number(progress.total) > 0
          ? Number(progress.total)
          : 0;
    const cached = Number(tcg.cachedCount ?? tcg.cacheEntryCount) || 0;
    const priced = Number(tcg.pricedInCacheCount) || 0;

    tcgCacheLive.textContent =
      totalLinks > 0 ? `${cached.toLocaleString()} / ${totalLinks.toLocaleString()}` : cached.toLocaleString();
    tcgPricedCount.textContent = priced.toLocaleString();
    tcgTotalLinks.textContent = totalLinks > 0 ? totalLinks.toLocaleString() : "—";

    const tcgBusy = Boolean(tcg.inFlight);
    const busy = tcgBusy;
    const status = String(tcg.status || "idle");
    const phase = String(tcg.phase || "").trim().toLowerCase();
    const collecting =
      tcgBusy &&
      (phase === "collecting" ||
        (Number(progress.setsTotal) > 0 &&
          Number(progress.done) === 0 &&
          Number(progress.ok || 0) === 0 &&
          Number(progress.fail || 0) === 0 &&
          Number(progress.skipped || 0) === 0 &&
          Number(progress.setsDone || 0) < Number(progress.setsTotal || 0)));

    const liveStat = tcgCacheCard?.querySelector(".admin-stat--live");
    if (liveStat) liveStat.classList.toggle("is-polling", busy);

    const setLabel = tcg.setCode ? ` · ${tcg.setCode}` : "";
    tcgStatusBadge.textContent = collecting
      ? `collecting${setLabel}`
      : tcgBusy
        ? `running${setLabel}`
        : status;
    tcgStatusBadge.className = `admin-badge${
      tcgBusy || status === "running"
        ? " running"
        : status === "error"
          ? " error"
          : status === "stopped"
            ? " stopped"
            : ""
    }`;

    const total = Number(progress.total) || Number(tcg.totalLinkCount) || 0;
    const done = Number(progress.done) || 0;
    const setsDone = Number(progress.setsDone) || 0;
    const setsTotal = Number(progress.setsTotal) || 0;
    const pct = collecting
      ? setsTotal > 0
        ? Math.min(100, Math.round((setsDone / setsTotal) * 100))
        : 0
      : total > 0
        ? Math.min(100, Math.round((done / total) * 100))
        : 0;
    tcgProgressBar.style.width = `${pct}%`;
    const skipped = Number(progress.skipped || 0);
    if (collecting) {
      tcgProgressText.textContent = setsTotal
        ? `Collecting links · ${setsDone.toLocaleString()} / ${setsTotal.toLocaleString()} sets (${pct}%) · ${total.toLocaleString()} links so far`
        : "Collecting TCGplayer links from sets…";
    } else {
      tcgProgressText.textContent = total
        ? `${done.toLocaleString()} / ${total.toLocaleString()} (${pct}%) · ok ${Number(progress.ok || 0).toLocaleString()} · fail ${Number(progress.fail || 0).toLocaleString()}${skipped ? ` · skipped ${skipped.toLocaleString()}` : ""}`
        : "—";
    }

    if (tcgBusy) {
      const detail = String(tcg.detail || "").trim();
      const workingSet = String(tcg.currentSetName || tcg.currentSetCode || tcg.setName || tcg.setCode || "").trim();
      const workingCard = [
        String(tcg.currentCardName || "").trim(),
        tcg.currentCardNo ? `#${String(tcg.currentCardNo).trim()}` : ""
      ]
        .filter(Boolean)
        .join(" ");
      let statusLine = detail;
      if (!statusLine) {
        if (collecting) {
          statusLine = workingSet
            ? `Collecting TCGplayer links from ${workingSet}…`
            : "Collecting TCGplayer links from sets…";
        } else if (workingCard && workingSet) {
          statusLine = `Pricing ${workingCard} · ${workingSet}`;
        } else if (workingCard) {
          statusLine = `Pricing ${workingCard}…`;
        } else if (workingSet) {
          statusLine = `Pricing links in ${workingSet}…`;
        } else {
          statusLine = "TCG price check running…";
        }
      }
      const counts = total
        ? ` · ${done.toLocaleString()}/${total.toLocaleString()} (${pct}%)`
        : collecting && setsTotal
          ? ` · sets ${setsDone.toLocaleString()}/${setsTotal.toLocaleString()} (${pct}%)`
          : "";
      setStatus(tcgStatusMsg, `${statusLine}${counts}`, "");
    } else if (totalLinks > 0 && priced > 0 && priced < totalLinks * 0.5) {
      setStatus(
        tcgStatusMsg,
        `Only ${priced.toLocaleString()} of ${totalLinks.toLocaleString()} links are priced in cache. Run “Update all TCG prices” again and keep the server running until priced count catches up.`,
        "error"
      );
    }

    btnTcgPriceUpdate.disabled = tcgBusy;
    btnTcgPriceUpdate.textContent = tcgBusy ? "Price check running…" : "Update all TCG prices";
    if (btnTcgSetRefresh) btnTcgSetRefresh.disabled = tcgBusy;
    if (tcgSetRefreshSelect) tcgSetRefreshSelect.disabled = tcgBusy;
    if (btnTcgPriceStop) {
      btnTcgPriceStop.hidden = !busy;
      btnTcgPriceStop.disabled = !busy;
    }
  }

  function renderPcCache(pc) {
    if (!pcCacheCard || !pc) return;
    const progress = pc.progress || {};
    const pcBusy = Boolean(pc.inFlight);
    if (pcLastSuccess) pcLastSuccess.textContent = formatDateTime(pc.lastSuccessfulAt || pc.finishedAt);
    if (pcCacheSaved) pcCacheSaved.textContent = formatDateTime(pc.cacheSavedAt);
    const totalSections =
      Number(pc.totalCardCount) > 0
        ? Number(pc.totalCardCount)
        : Number(progress.total) > 0
          ? Number(progress.total)
          : 0;
    const cached = Number(pc.cacheEntryCount) || 0;
    const updated = Number(pc.updatedSuccessfullyCount ?? pc.cacheEntryCount) || 0;
    if (pcDetailsCacheCount) {
      pcDetailsCacheCount.textContent =
        totalSections > 0
          ? `${cached.toLocaleString()} / ${totalSections.toLocaleString()}`
          : cached.toLocaleString();
    }
    if (pcUpdatedCount) pcUpdatedCount.textContent = updated.toLocaleString();
    if (pcTotalSections) {
      pcTotalSections.textContent = totalSections > 0 ? totalSections.toLocaleString() : "—";
    }

    const liveStat = pcCacheCard.querySelector(".admin-stat--live");
    if (liveStat) liveStat.classList.toggle("is-polling", pcBusy);

    const status = String(pc.status || "idle");
    if (pcStatusBadge) {
      pcStatusBadge.textContent = pcBusy ? "running" : status;
      pcStatusBadge.className = `admin-badge${
        pcBusy || status === "running"
          ? " running"
          : status === "error"
            ? " error"
            : status === "stopped"
              ? " stopped"
              : ""
      }`;
    }

    const total = Number(progress.total) || totalSections || 0;
    const done = Number(progress.done) || 0;
    const pct = total > 0 ? Math.min(100, Math.round((done / total) * 100)) : 0;
    if (pcProgressBar) pcProgressBar.style.width = `${pct}%`;
    const skipped = Number(progress.skipped || 0);
    if (pcDetailsProgressText) {
      pcDetailsProgressText.textContent = total
        ? `${done.toLocaleString()} / ${total.toLocaleString()} (${pct}%) · ok ${Number(progress.ok || 0).toLocaleString()} · fail ${Number(progress.fail || 0).toLocaleString()}${skipped ? ` · skipped ${skipped.toLocaleString()}` : ""}`
        : pcBusy
          ? "Starting PriceCharting pass…"
          : "—";
    }

    if (pcBusy) {
      const detail = String(pc.detail || "").trim();
      const workingSet = String(pc.currentSetName || pc.currentSetCode || pc.setName || pc.setCode || "").trim();
      const workingCard = [
        String(pc.currentCardName || "").trim(),
        pc.currentCardNo ? `#${String(pc.currentCardNo).trim()}` : ""
      ]
        .filter(Boolean)
        .join(" ");
      let statusLine = detail;
      if (!statusLine) {
        if (workingCard && workingSet) statusLine = `Fetching ${workingCard} · ${workingSet}`;
        else if (workingCard) statusLine = `Fetching ${workingCard}…`;
        else if (workingSet) statusLine = `Refreshing PriceCharting details for ${workingSet}…`;
        else statusLine = "PriceCharting details refresh running…";
      }
      const counts = total ? ` · ${done.toLocaleString()}/${total.toLocaleString()} (${pct}%)` : "";
      setStatus(pcStatusMsg, `${statusLine}${counts}`, "");
    } else if (totalSections > 0 && updated > 0 && updated < totalSections * 0.35) {
      setStatus(
        pcStatusMsg,
        `Cache has ${updated.toLocaleString()} of ${totalSections.toLocaleString()} catalog cards. Run “Update PriceCharting cache” again to fill gaps (many cards are not on PriceCharting, so 100% is not expected).`,
        "error"
      );
    }

    if (btnPcDetailsUpdate) {
      btnPcDetailsUpdate.disabled = pcBusy;
      btnPcDetailsUpdate.textContent = pcBusy ? "PriceCharting running…" : "Update PriceCharting cache";
    }
    if (btnPcSetRefresh) btnPcSetRefresh.disabled = pcBusy;
    if (pcSetRefreshSelect) pcSetRefreshSelect.disabled = pcBusy;
    if (btnPcDetailsStop) {
      btnPcDetailsStop.hidden = !pcBusy;
      btnPcDetailsStop.disabled = !pcBusy;
    }
  }

  function renderSite(site, restock) {
    statUsers.textContent = Number(site?.userCount || 0).toLocaleString();
    statItems.textContent = Number(site?.collectionItemCount || 0).toLocaleString();
    statActivities.textContent = Number(site?.activityCount || 0).toLocaleString();
    statManualRestock.textContent = Number(restock?.manualItemCount || 0).toLocaleString();
  }

  function getSelectedRestockRetailers() {
    if (!restockRetailerList) return [];
    return [...restockRetailerList.querySelectorAll('input[type="checkbox"][data-retailer]:checked')].map(
      (input) => input.getAttribute("data-retailer")
    );
  }

  function setRestockRetailerChecks(selectedNames) {
    if (!restockRetailerList) return;
    const selected = selectedNames == null ? null : new Set(selectedNames);
    restockRetailerList.querySelectorAll('input[type="checkbox"][data-retailer]').forEach((input) => {
      const name = input.getAttribute("data-retailer");
      input.checked = selected == null ? true : selected.has(name);
    });
  }

  function renderRestockRetailerPicker(retailers) {
    if (!restockRetailerList) return;
    const list = Array.isArray(retailers) ? retailers : [];
    const previous = getSelectedRestockRetailers();
    const preserve =
      restockRetailerSelection != null
        ? restockRetailerSelection
        : previous.length
          ? previous
          : null;
    restockRetailerOptions = list;
    if (!list.length) {
      restockRetailerList.innerHTML = `<p class="admin-hint" style="margin:0">No retailers found in restock cache yet.</p>`;
      return;
    }
    restockRetailerList.innerHTML = list
      .map((row) => {
        const name = String(row.name || "").trim();
        if (!name) return "";
        const count = Number(row.count || 0);
        const id = `restockRetailer_${encodeURIComponent(name).replace(/%/g, "_")}`;
        return `<label class="restock-retailer-option" for="${id}">
          <input type="checkbox" id="${id}" data-retailer="${escapeHtml(name)}" checked />
          <span>${escapeHtml(name)} <span class="count">(${count.toLocaleString()})</span></span>
        </label>`;
      })
      .join("");
    setRestockRetailerChecks(preserve);
  }

  function renderRestockCache(restock) {
    if (!restock) return;
    if (Array.isArray(restock.retailers)) {
      renderRestockRetailerPicker(restock.retailers);
    }
    if (restockLastRefresh) {
      restockLastRefresh.textContent = formatDateTime(restock.autoRefreshedAt || restock.lastFinishedAt);
    }
    if (restockItemCount) {
      const tracked = Number(restock.itemCount || 0);
      const manual = Number(restock.manualItemCount || 0);
      restockItemCount.textContent =
        manual > 0
          ? `${tracked.toLocaleString()} (+${manual.toLocaleString()} manual)`
          : tracked.toLocaleString();
    }
    if (restockLastSummary) {
      if (restock.lastError) {
        restockLastSummary.textContent = `Error: ${restock.lastError}`;
      } else if (restock.lastFinishedAt) {
        const stamped = Number(restock.lastInStockStamped || 0);
        const amazon = Number(restock.lastAmazonStatusUpdates || 0);
        const prices = Number(restock.lastPriceUpdates || 0);
        const smoke =
          Number(restock.lastSmokeStatusUpdates || 0) + Number(restock.lastSmokePriceUpdates || 0);
        const pokene =
          Number(restock.lastPokeNeStatusUpdates || 0) + Number(restock.lastPokeNePriceUpdates || 0);
        const selected = Array.isArray(restock.lastSelectedRetailers)
          ? restock.lastSelectedRetailers.join(", ")
          : "all";
        restockLastSummary.textContent = `Retailers: ${selected}. In-stock stamped ${stamped.toLocaleString()}, Amazon ${amazon.toLocaleString()}, prices ${prices.toLocaleString()}, Smoke ${smoke.toLocaleString()}, PokeNE ${pokene.toLocaleString()}`;
      } else {
        restockLastSummary.textContent = "—";
      }
    }

    const busy = Boolean(restock.inFlight);
    const stopped = !busy && String(restock.progress?.phase || "").toLowerCase() === "stopped";
    if (restockStatusBadge) {
      restockStatusBadge.textContent = busy
        ? "refreshing"
        : restock.lastError
          ? "error"
          : stopped
            ? "stopped"
            : "idle";
      restockStatusBadge.classList.remove("running", "error", "stopped");
      if (busy) restockStatusBadge.classList.add("running");
      else if (restock.lastError) restockStatusBadge.classList.add("error");
      else if (stopped) restockStatusBadge.classList.add("stopped");
    }

    const progress = restock.progress || {};
    const current = Number(progress.current) || 0;
    const total = Number(progress.total) || 0;
    const percent = Number.isFinite(Number(progress.percent))
      ? Math.max(0, Math.min(100, Number(progress.percent)))
      : total > 0
        ? Math.round((current / total) * 100)
        : busy
          ? 0
          : 0;
    if (restockProgressBar) {
      restockProgressBar.style.width = `${busy || percent > 0 ? percent : 0}%`;
    }
    if (restockProgressText) {
      if (busy) {
        const counts =
          total > 0 ? ` (${current.toLocaleString()} / ${total.toLocaleString()})` : "";
        restockProgressText.textContent = `${progress.label || "Refreshing…"}${counts} · ${percent}%`;
      } else if (restock.lastError) {
        restockProgressText.textContent = progress.label || restock.lastError;
      } else if (stopped) {
        restockProgressText.textContent = progress.label || "Refresh stopped";
      } else if (percent >= 100 && restock.lastFinishedAt) {
        restockProgressText.textContent = progress.label || "Refresh complete";
      } else {
        restockProgressText.textContent = "—";
      }
    }

    if (btnRestockRefresh) {
      btnRestockRefresh.disabled = busy;
      btnRestockRefresh.textContent = busy ? "Refresh running…" : "Refresh cache";
    }
    if (btnRestockStop) {
      btnRestockStop.hidden = !busy;
      btnRestockStop.disabled = !busy;
    }
    if (btnRestockSelectAll) btnRestockSelectAll.disabled = busy;
    if (btnRestockSelectNone) btnRestockSelectNone.disabled = busy;
    if (restockRetailerList) {
      restockRetailerList.querySelectorAll("input").forEach((input) => {
        input.disabled = busy;
      });
    }
    if (restockCacheCard) {
      restockCacheCard.classList.toggle("is-busy", busy);
    }
  }

  function renderCardNicknames(nicknames) {
    const list = Array.isArray(nicknames) ? [...nicknames] : [];
    if (!nicknameBody) return;
    if (!list.length) {
      nicknameBody.innerHTML = `<tr><td colspan="6" style="color:var(--muted)">No nicknames yet.</td></tr>`;
      return;
    }
    list.sort((a, b) => {
      const nickCmp = String(a.nickname || "").localeCompare(String(b.nickname || ""), undefined, {
        sensitivity: "base"
      });
      if (nickCmp !== 0) return nickCmp;
      const setCmp = String(a.setCode || "").localeCompare(String(b.setCode || ""), undefined, {
        sensitivity: "base"
      });
      if (setCmp !== 0) return setCmp;
      return String(a.cardNumber || "").localeCompare(String(b.cardNumber || ""), undefined, {
        numeric: true,
        sensitivity: "base"
      });
    });
    nicknameBody.innerHTML = list
      .map((row) => {
        const searchUrl = `/sets.html?q=${encodeURIComponent(row.nickname || "")}`;
        const cardLabel = `${escapeHtml(row.setCode)} #${escapeHtml(row.cardNumber)}`;
        const setLabel = row.setName ? `${escapeHtml(row.setName)} (${escapeHtml(row.setCode)})` : escapeHtml(row.setCode);
        return `<tr>
          <td>${escapeHtml(row.nickname)}</td>
          <td>${cardLabel}</td>
          <td>${setLabel}</td>
          <td>${escapeHtml(row.language || "english")}</td>
          <td><a href="${searchUrl}" target="_blank" rel="noopener noreferrer">Search</a></td>
          <td><button type="button" class="admin-btn danger" data-remove-nickname-id="${escapeHtml(row.id)}">Remove</button></td>
        </tr>`;
      })
      .join("");
  }

  async function loadCardNicknames() {
    const payload = await api("/api/admin/card-nicknames");
    renderCardNicknames(payload.nicknames);
    return payload.nicknames;
  }

  function normalizeSearchText(text) {
    return String(text || "").toLowerCase();
  }

  function normalizeCardName(name) {
    let s = String(name || "").trim();
    if (!s) return "";
    for (let pass = 0; pass < 2; pass += 1) {
      s = s
        .replace(/&amp;/gi, "&")
        .replace(/&quot;/gi, "\"")
        .replace(/&#39;|&apos;/gi, "'")
        .replace(/&lt;/gi, "<")
        .replace(/&gt;/gi, ">")
        .replace(/&#(\d+);/g, (_, num) => {
          const code = Number(num);
          return Number.isFinite(code) ? String.fromCharCode(code) : "";
        })
        .replace(/&#x([a-f0-9]+);/gi, (_, hex) => {
          const code = Number.parseInt(hex, 16);
          return Number.isFinite(code) ? String.fromCharCode(code) : "";
        });
    }
    try {
      const ta = document.createElement("textarea");
      ta.innerHTML = s;
      s = String(ta.value || s).trim();
    } catch {
      // keep decoded string
    }
    return s.replace(/\s{2,}/g, " ").trim();
  }

  function compareNicknameCardsBySet(a, b) {
    const dateA = Date.parse(a.setReleaseDate) || 0;
    const dateB = Date.parse(b.setReleaseDate) || 0;
    if (dateB !== dateA) return dateB - dateA;
    const setCmp = String(a.setCode).localeCompare(String(b.setCode), undefined, { sensitivity: "base" });
    if (setCmp !== 0) return setCmp;
    const na = Number(a.cardNo);
    const nb = Number(b.cardNo);
    if (Number.isFinite(na) && Number.isFinite(nb) && na !== nb) return na - nb;
    return String(a.label).localeCompare(String(b.label), undefined, { numeric: true, sensitivity: "base" });
  }

  async function loadNicknameCardIndex(language = "english") {
    const lang = String(language || "english").toLowerCase() === "japanese" ? "japanese" : "english";
    if (nicknameCardIndex[lang] !== null) return nicknameCardIndex[lang];

    const response = await fetch(`/api/sets/cards?language=${encodeURIComponent(lang)}`, {
      credentials: "same-origin"
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || !payload?.byCode || typeof payload.byCode !== "object") {
      nicknameCardIndex[lang] = [];
      return [];
    }

    const cards = [];
    for (const [code, entry] of Object.entries(payload.byCode)) {
      if (!entry || typeof entry !== "object") continue;
      const setCode = String(code).trim().toUpperCase();
      const setName = normalizeCardName(entry.sourceTitle || entry.name || setCode);
      const setReleaseDate = String(entry.releaseDate || "").trim();
      const cardMap = entry.cards && typeof entry.cards === "object" ? entry.cards : {};
      const localImages = entry.localImages && typeof entry.localImages === "object" ? entry.localImages : {};
      const remoteImages = entry.images && typeof entry.images === "object" ? entry.images : {};
      for (const [cardNo, rawName] of Object.entries(cardMap)) {
        const name = normalizeCardName(rawName) || `${setName} Card ${cardNo}`;
        const label = `#${cardNo}`;
        cards.push({
          setCode,
          setName,
          setReleaseDate,
          cardNo: String(cardNo),
          label,
          name,
          imageUrl: localImages[cardNo] || remoteImages[cardNo] || "",
          _haystack: normalizeSearchText(`${name} ${label} ${cardNo} ${setName} ${setCode}`)
        });
      }
    }

    cards.sort(compareNicknameCardsBySet);
    nicknameCardIndex[lang] = cards;
    return cards;
  }

  function getNicknameCardIndex(language = "english") {
    const lang = String(language || "english").toLowerCase() === "japanese" ? "japanese" : "english";
    return nicknameCardIndex[lang] || [];
  }

  function searchNicknameCards(query, language = "english") {
    const q = normalizeSearchText(String(query || "").trim());
    if (!q) return [];
    const matches = [];
    for (const card of getNicknameCardIndex(language)) {
      if (card._haystack.includes(q)) matches.push(card);
    }
    return matches;
  }

  function updateNicknameSubmitState() {
    const ready = Boolean(nicknameSelected?.setCode && nicknameSelected?.cardNo);
    if (nicknameSubmitBtn) nicknameSubmitBtn.disabled = !ready;
    if (nicknameSetCode) nicknameSetCode.value = nicknameSelected?.setCode || "";
    if (nicknameCardNumber) nicknameCardNumber.value = nicknameSelected?.cardNo || "";
  }

  function renderNicknameSelectedCard() {
    if (!nicknameSelectedCard) return;
    if (!nicknameSelected) {
      nicknameSelectedCard.hidden = true;
      nicknameSelectedCard.innerHTML = "";
      return;
    }
    const card = nicknameSelected;
    const thumb = card.imageUrl
      ? `<img src="${escapeHtml(card.imageUrl)}" alt="${escapeHtml(card.name)}" loading="lazy" />`
      : `<div class="nickname-card-thumb placeholder">No image</div>`;
    nicknameSelectedCard.hidden = false;
    nicknameSelectedCard.innerHTML = `
      ${thumb}
      <div class="nickname-selected-card-info">
        <strong>${escapeHtml(card.name)}</strong>
        <div class="nickname-selected-card-meta">${escapeHtml(card.setName)} (${escapeHtml(card.setCode)}) · ${escapeHtml(card.label)}</div>
      </div>
      <button type="button" class="admin-btn" id="nicknameClearCardBtn">Change card</button>
    `;
    document.getElementById("nicknameClearCardBtn")?.addEventListener("click", () => {
      clearNicknameCardSelection();
      nicknameCardSearch?.focus();
    });
  }

  function clearNicknameCardSelection() {
    nicknameSelected = null;
    updateNicknameSubmitState();
    renderNicknameSelectedCard();
    if (nicknameCardSearch) nicknameCardSearch.value = "";
    hideNicknameCardResults();
    scheduleNicknameCardSearch();
  }

  function selectNicknameCard(card) {
    if (!card) return;
    nicknameSelected = {
      setCode: card.setCode,
      setName: card.setName,
      cardNo: card.cardNo,
      label: card.label,
      name: card.name,
      imageUrl: card.imageUrl
    };
    if (nicknameCardSearch) nicknameCardSearch.value = "";
    hideNicknameCardResults();
    updateNicknameSubmitState();
    renderNicknameSelectedCard();
  }

  function hideNicknameCardResults() {
    if (nicknameCardResults) nicknameCardResults.hidden = true;
    if (nicknameCardGrid) nicknameCardGrid.innerHTML = "";
    if (nicknameCardResultsMeta) nicknameCardResultsMeta.textContent = "";
  }

  function renderNicknameCardThumb(card) {
    return card.imageUrl
      ? `<img class="nickname-card-thumb" src="${escapeHtml(card.imageUrl)}" alt="${escapeHtml(card.name)}" loading="lazy" />`
      : `<div class="nickname-card-thumb placeholder">No image</div>`;
  }

  function renderNicknameCardSearchResults() {
    if (!nicknameCardGrid || !nicknameCardResults) return;
    const query = String(nicknameCardSearch?.value || "").trim();
    if (!query) {
      hideNicknameCardResults();
      return;
    }
    if (nicknameSelected) {
      hideNicknameCardResults();
      return;
    }

    const lang = nicknameLanguage?.value || "english";
    const matches = searchNicknameCards(query, lang);
    const display = matches.slice(0, NICKNAME_CARD_SEARCH_LIMIT);
    const truncated = matches.length > display.length;

    nicknameCardResults.hidden = false;
    if (nicknameCardResultsMeta) {
      nicknameCardResultsMeta.textContent = matches.length
        ? `${matches.length.toLocaleString()} card${matches.length === 1 ? "" : "s"} for “${query}”${truncated ? ` · showing first ${display.length}` : ""}`
        : `No cards found for “${query}”.`;
    }

    if (!display.length) {
      nicknameCardGrid.innerHTML = "";
      return;
    }

    nicknameCardGrid.innerHTML = display
      .map(
        (card) => `<button
          type="button"
          class="nickname-card-tile"
          data-set-code="${escapeHtml(card.setCode)}"
          data-card-number="${escapeHtml(card.cardNo)}"
        >
          ${renderNicknameCardThumb(card)}
          <div class="nickname-card-tile-name">${escapeHtml(card.name)}</div>
          <div class="nickname-card-tile-meta">${escapeHtml(card.setName)} (${escapeHtml(card.setCode)}) · ${escapeHtml(card.label)}</div>
        </button>`
      )
      .join("");

    nicknameCardGrid.querySelectorAll(".nickname-card-tile").forEach((btn) => {
      btn.addEventListener("click", () => {
        const setCode = btn.getAttribute("data-set-code") || "";
        const cardNo = btn.getAttribute("data-card-number") || "";
        const card = getNicknameCardIndex(lang).find((row) => row.setCode === setCode && row.cardNo === cardNo);
        if (card) selectNicknameCard(card);
      });
    });
  }

  function scheduleNicknameCardSearch() {
    if (nicknameSearchTimer) clearTimeout(nicknameSearchTimer);
    nicknameSearchTimer = setTimeout(() => {
      nicknameSearchTimer = null;
      renderNicknameCardSearchResults();
    }, NICKNAME_CARD_SEARCH_DEBOUNCE_MS);
  }

  function updatePcCorrectSaveState() {
    const ready = Boolean(
      pcCorrectSelected?.setCode &&
        pcCorrectSelected?.cardNo &&
        String(pcCorrectProductUrl?.value || "").trim()
    );
    if (btnPcCorrectSave) btnPcCorrectSave.disabled = !ready;
  }

  function renderPcCorrectCurrentLink(entry) {
    if (!pcCorrectCurrentLink) return;
    if (!pcCorrectSelected) {
      pcCorrectCurrentLink.textContent = "Select a card to see its cached link.";
      return;
    }
    const label = `${pcCorrectSelected.name} (${pcCorrectSelected.setCode} #${pcCorrectSelected.cardNo})`;
    if (!entry?.cached) {
      pcCorrectCurrentLink.textContent = `${label} is not in the PriceCharting cache yet.`;
      return;
    }
    const url = String(entry.productUrl || "").trim();
    const sold = Number(entry.soldListings || 0);
    const grades = Number(entry.gradedGuides || 0);
    if (!url) {
      pcCorrectCurrentLink.textContent = `${label} is cached, but has no product URL.`;
      return;
    }
    pcCorrectCurrentLink.innerHTML = `Current link for <strong>${escapeHtml(label)}</strong>: <a href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(url)}</a> · ${sold} sold · ${grades} grade guide${grades === 1 ? "" : "s"}`;
  }

  async function loadPcCorrectCacheEntry() {
    if (!pcCorrectSelected?.setCode || !pcCorrectSelected?.cardNo) {
      renderPcCorrectCurrentLink(null);
      return;
    }
    try {
      const entry = await api(
        `/api/admin/pricecharting-details/entry?setCode=${encodeURIComponent(pcCorrectSelected.setCode)}&cardNo=${encodeURIComponent(pcCorrectSelected.cardNo)}`
      );
      renderPcCorrectCurrentLink(entry);
      if (entry?.productUrl && pcCorrectProductUrl && !String(pcCorrectProductUrl.value || "").trim()) {
        // leave blank so user pastes the correction; don't prefill the wrong URL
      }
    } catch (err) {
      if (pcCorrectCurrentLink) {
        pcCorrectCurrentLink.textContent = err.message || "Could not load cached link.";
      }
    }
  }

  function clearPcCorrectCardSelection() {
    pcCorrectSelected = null;
    if (pcCorrectCardSearch) pcCorrectCardSearch.value = "";
    if (pcCorrectProductUrl) pcCorrectProductUrl.value = "";
    if (pcCorrectSelectedCard) {
      pcCorrectSelectedCard.hidden = true;
      pcCorrectSelectedCard.innerHTML = "";
    }
    if (pcCorrectCardResults) pcCorrectCardResults.hidden = true;
    if (pcCorrectCardGrid) pcCorrectCardGrid.innerHTML = "";
    if (pcCorrectCardResultsMeta) pcCorrectCardResultsMeta.textContent = "";
    renderPcCorrectCurrentLink(null);
    setStatus(pcCorrectStatusMsg, "");
    updatePcCorrectSaveState();
  }

  function selectPcCorrectCard(card) {
    pcCorrectSelected = {
      setCode: card.setCode,
      setName: card.setName,
      cardNo: card.cardNo,
      name: card.name,
      label: card.label,
      imageUrl: card.imageUrl || ""
    };
    if (pcCorrectCardSearch) pcCorrectCardSearch.value = "";
    if (pcCorrectCardResults) pcCorrectCardResults.hidden = true;
    if (pcCorrectCardGrid) pcCorrectCardGrid.innerHTML = "";
    const thumb = pcCorrectSelected.imageUrl
      ? `<img src="${escapeHtml(pcCorrectSelected.imageUrl)}" alt="${escapeHtml(pcCorrectSelected.name)}" loading="lazy" />`
      : `<div class="nickname-card-thumb placeholder">No image</div>`;
    if (pcCorrectSelectedCard) {
      pcCorrectSelectedCard.hidden = false;
      pcCorrectSelectedCard.innerHTML = `
        ${thumb}
        <div class="nickname-selected-card-info">
          <strong>${escapeHtml(pcCorrectSelected.name)}</strong>
          <div class="nickname-selected-card-meta">${escapeHtml(pcCorrectSelected.setName)} (${escapeHtml(pcCorrectSelected.setCode)}) · ${escapeHtml(pcCorrectSelected.label)}</div>
        </div>
        <button type="button" class="admin-btn" id="pcCorrectClearCardBtn">Change card</button>
      `;
      document.getElementById("pcCorrectClearCardBtn")?.addEventListener("click", () => {
        clearPcCorrectCardSelection();
        pcCorrectCardSearch?.focus();
      });
    }
    setStatus(pcCorrectStatusMsg, "");
    updatePcCorrectSaveState();
    loadPcCorrectCacheEntry();
  }

  function renderPcCorrectCardSearchResults() {
    if (!pcCorrectCardGrid || !pcCorrectCardResults) return;
    const query = String(pcCorrectCardSearch?.value || "").trim();
    if (!query) {
      pcCorrectCardResults.hidden = true;
      pcCorrectCardGrid.innerHTML = "";
      if (pcCorrectCardResultsMeta) pcCorrectCardResultsMeta.textContent = "";
      return;
    }
    if (pcCorrectSelected) {
      pcCorrectCardResults.hidden = true;
      return;
    }
    const matches = searchNicknameCards(query, "english");
    const display = matches.slice(0, 24);
    pcCorrectCardResults.hidden = false;
    if (pcCorrectCardResultsMeta) {
      pcCorrectCardResultsMeta.textContent = matches.length
        ? `Showing ${display.length} of ${matches.length} match${matches.length === 1 ? "" : "es"}`
        : "No cards match that search.";
    }
    pcCorrectCardGrid.innerHTML = display
      .map((card, index) => {
        const thumb = card.imageUrl
          ? `<img class="nickname-card-thumb" src="${escapeHtml(card.imageUrl)}" alt="${escapeHtml(card.name)}" loading="lazy" />`
          : `<div class="nickname-card-thumb placeholder">No image</div>`;
        return `<button type="button" class="nickname-card-tile" data-pc-correct-index="${index}">
          ${thumb}
          <div class="nickname-card-tile-name">${escapeHtml(card.name)}</div>
          <div class="nickname-card-tile-meta">${escapeHtml(card.setName)} (${escapeHtml(card.setCode)}) · ${escapeHtml(card.label)}</div>
        </button>`;
      })
      .join("");
    pcCorrectCardGrid.querySelectorAll("[data-pc-correct-index]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const index = Number(btn.getAttribute("data-pc-correct-index"));
        const card = display[index];
        if (card) selectPcCorrectCard(card);
      });
    });
  }

  function schedulePcCorrectCardSearch() {
    if (pcCorrectSearchTimer) clearTimeout(pcCorrectSearchTimer);
    pcCorrectSearchTimer = setTimeout(() => {
      pcCorrectSearchTimer = null;
      renderPcCorrectCardSearchResults();
    }, NICKNAME_CARD_SEARCH_DEBOUNCE_MS);
  }

  async function initNicknameCardPicker() {
    if (nicknameCardSearch) {
      nicknameCardSearch.disabled = true;
      nicknameCardSearch.placeholder = "Loading cards…";
    }
    if (pcCorrectCardSearch) {
      pcCorrectCardSearch.disabled = true;
      pcCorrectCardSearch.placeholder = "Loading cards…";
    }
    try {
      await Promise.all([loadNicknameCardIndex("english"), loadNicknameCardIndex("japanese")]);
      if (nicknameCardSearch) {
        nicknameCardSearch.disabled = false;
        nicknameCardSearch.placeholder = "Search cards…";
      }
      if (pcCorrectCardSearch) {
        pcCorrectCardSearch.disabled = false;
        pcCorrectCardSearch.placeholder = "Search cards…";
      }
    } catch (err) {
      if (nicknameCardSearch) {
        nicknameCardSearch.disabled = true;
        nicknameCardSearch.placeholder = "Could not load cards";
      }
      if (pcCorrectCardSearch) {
        pcCorrectCardSearch.disabled = true;
        pcCorrectCardSearch.placeholder = "Could not load cards";
      }
      setStatus(nicknameFormMsg, err.message || "Could not load card catalog.", "error");
    }
  }

  function resetNicknameForm({ keepNickname = false } = {}) {
    const keptNickname = keepNickname ? String(nicknameText?.value || "").trim() : "";
    const keptLanguage = keepNickname
      ? String(nicknameLanguage?.value || "english")
      : "english";
    nicknameForm?.reset();
    if (nicknameLanguage) nicknameLanguage.value = keptLanguage;
    if (nicknameText) nicknameText.value = keptNickname;
    clearNicknameCardSelection();
    if (keptNickname) nicknameCardSearch?.focus();
    else nicknameText?.focus();
  }

  function renderManualRestock(items) {
    const list = Array.isArray(items) ? items : [];
    if (!list.length) {
      manualRestockBody.innerHTML = `<tr><td colspan="5" style="color:var(--muted)">No manual products yet.</td></tr>`;
      return;
    }
    manualRestockBody.innerHTML = list
      .map(
        (row) => `<tr>
          <td>${escapeHtml(row.name)}</td>
          <td>${escapeHtml(row.retailer || "—")}</td>
          <td>${escapeHtml(row.statusLabel || row.status || "—")}</td>
          <td><a href="${escapeHtml(row.productUrl)}" target="_blank" rel="noopener noreferrer">Open</a></td>
          <td><button type="button" class="admin-btn danger" data-remove-id="${escapeHtml(row.id)}">Remove</button></td>
        </tr>`
      )
      .join("");
  }

  function sortUsersRecentFirst(users) {
    return [...(Array.isArray(users) ? users : [])].sort((a, b) => {
      const at = Date.parse(a?.createdAt || a?.lastLoginAt || 0) || 0;
      const bt = Date.parse(b?.createdAt || b?.lastLoginAt || 0) || 0;
      return bt - at;
    });
  }

  function filterUsers(users, query) {
    const q = String(query || "")
      .trim()
      .toLowerCase();
    const sorted = sortUsersRecentFirst(users);
    if (!q) return sorted;
    return sorted.filter((row) => {
      const hay = `${row.username || ""} ${row.name || ""} ${row.email || ""}`.toLowerCase();
      return hay.includes(q);
    });
  }

  function renderUsers(users) {
    if (Array.isArray(users)) allUsersCache = users;
    const list = filterUsers(allUsersCache, usersSearch?.value || "");
    if (usersCountLabel) {
      const total = allUsersCache.length;
      const shown = list.length;
      usersCountLabel.textContent =
        shown === total
          ? `${total.toLocaleString()} user${total === 1 ? "" : "s"}`
          : `Showing ${shown.toLocaleString()} of ${total.toLocaleString()}`;
    }
    if (!usersBody) return;
    if (!list.length) {
      usersBody.innerHTML = `<tr><td colspan="8" style="color:var(--muted)">${
        allUsersCache.length ? "No users match your search." : "No users yet."
      }</td></tr>`;
      return;
    }
    usersBody.innerHTML = list
      .map((row) => {
        const id = escapeHtml(row.id || "");
        const disabled = Boolean(row.disabledAt);
        const roleLabel = row.isAdmin ? "admin" : escapeHtml(row.role || "user");
        return `<tr data-user-id="${id}" class="${disabled ? "admin-user-disabled" : ""}">
          <td><input class="admin-input" data-field="username" value="${escapeHtml(row.username || "")}" autocomplete="off" spellcheck="false" /></td>
          <td><input class="admin-input" data-field="name" value="${escapeHtml(row.name || "")}" autocomplete="off" /></td>
          <td><input class="admin-input" data-field="email" type="email" value="${escapeHtml(row.email || "")}" autocomplete="off" /></td>
          <td>${roleLabel}${disabled ? " · disabled" : ""}</td>
          <td>${Number(row.itemCount || 0).toLocaleString()}</td>
          <td>${escapeHtml(formatDateTime(row.createdAt))}</td>
          <td>${escapeHtml(formatDateTime(row.lastLoginAt))}</td>
          <td class="admin-user-actions">
            <button type="button" class="admin-btn primary" data-save-user>Save</button>
            <button type="button" class="admin-btn" data-user-role="${row.isAdmin ? "user" : "admin"}">${row.isAdmin ? "Revoke admin" : "Make admin"}</button>
            <button type="button" class="admin-btn" data-user-action="${disabled ? "enable" : "disable"}">${disabled ? "Enable" : "Disable"}</button>
            <button type="button" class="admin-btn" data-user-action="reset-collection">Reset collection</button>
            <button type="button" class="admin-btn danger" data-user-action="delete">Delete</button>
          </td>
        </tr>`;
      })
      .join("");

    usersBody.querySelectorAll("[data-save-user]").forEach((btn) => {
      btn.addEventListener("click", async () => {
        const rowEl = btn.closest("tr");
        const userId = rowEl?.getAttribute("data-user-id");
        if (!userId) return;
        const username = rowEl.querySelector('[data-field="username"]')?.value?.trim() || "";
        const name = rowEl.querySelector('[data-field="name"]')?.value?.trim() || "";
        const email = rowEl.querySelector('[data-field="email"]')?.value?.trim() || "";
        const msg = document.getElementById("usersStatusMsg");
        btn.disabled = true;
        try {
          await api(`/api/admin/users/${encodeURIComponent(userId)}`, {
            method: "PATCH",
            body: JSON.stringify({ username, name, email })
          });
          if (msg) {
            msg.textContent = `Saved ${username || email}.`;
            msg.className = "admin-status ok";
          }
          const payload = await api("/api/admin/users");
          renderUsers(payload.users);
        } catch (err) {
          if (msg) {
            msg.textContent = err.message || "Could not save user.";
            msg.className = "admin-status error";
          }
        } finally {
          btn.disabled = false;
        }
      });
    });

    usersBody.querySelectorAll("[data-user-role]").forEach((btn) => {
      btn.addEventListener("click", async () => {
        const rowEl = btn.closest("tr");
        const userId = rowEl?.getAttribute("data-user-id");
        const role = btn.getAttribute("data-user-role") || "user";
        if (!userId) return;
        const msg = document.getElementById("usersStatusMsg");
        try {
          await api(`/api/admin/users/${encodeURIComponent(userId)}/role`, {
            method: "POST",
            body: JSON.stringify({ role })
          });
          if (msg) {
            msg.textContent = `Role updated to ${role || "user"}.`;
            msg.className = "admin-status ok";
          }
          renderUsers((await api("/api/admin/users")).users);
        } catch (err) {
          if (msg) {
            msg.textContent = err.message || "Role update failed.";
            msg.className = "admin-status error";
          }
        }
      });
    });

    usersBody.querySelectorAll("[data-user-action]").forEach((btn) => {
      btn.addEventListener("click", async () => {
        const rowEl = btn.closest("tr");
        const userId = rowEl?.getAttribute("data-user-id");
        const action = btn.getAttribute("data-user-action");
        if (!userId || !action) return;
        const msg = document.getElementById("usersStatusMsg");
        const confirmText =
          action === "delete"
            ? "Permanently delete this user and their collection?"
            : action === "reset-collection"
              ? "Remove all collection items for this user?"
              : "";
        if (confirmText && !window.confirm(confirmText)) return;
        try {
          await api(`/api/admin/users/${encodeURIComponent(userId)}/${action}`, {
            method: "POST",
            body: "{}"
          });
          if (msg) {
            msg.textContent = `User ${action} complete.`;
            msg.className = "admin-status ok";
          }
          renderUsers((await api("/api/admin/users")).users);
        } catch (err) {
          if (msg) {
            msg.textContent = err.message || "Action failed.";
            msg.className = "admin-status error";
          }
        }
      });
    });
  }

  usersSearch?.addEventListener("input", () => {
    renderUsers(allUsersCache);
  });

  function escapeHtml(value) {
    return String(value ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  async function api(path, options = {}) {
    const response = await fetch(path, {
      credentials: "same-origin",
      headers: { "Content-Type": "application/json", ...(options.headers || {}) },
      ...options
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      const err = new Error(payload.error || `Request failed (${response.status})`);
      err.status = response.status;
      err.payload = payload;
      throw err;
    }
    return payload;
  }

  function escapeHtml(text) {
    return String(text || "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function renderTcgFailLinks(links) {
    if (!tcgFailLinksSection || !tcgFailLinksList) return;
    const list = Array.isArray(links) ? links : [];
    const count = list.length;
    tcgFailLinksCount.textContent = count.toLocaleString();
    tcgFailLinksSection.hidden = count === 0;
    if (!count) {
      tcgFailLinksList.innerHTML = "";
      return;
    }
    tcgFailLinksList.innerHTML = list
      .map((row, index) => {
        const url = String(row.url || "").trim();
        const productId = Number(row.productId) || 0;
        const productLabel = productId > 0 ? `Product #${productId}` : "Product ID unknown";
        const error = String(row.error || "Price fetch failed").trim();
        const rowId = `fail-link-${index}`;
        const encodedUrl = encodeURIComponent(url);
        return `<article class="admin-fail-link-row" data-fail-url="${encodedUrl}" data-fail-product-id="${productId || ""}">
          <div class="admin-fail-link-meta">
            <span class="admin-fail-link-product">${escapeHtml(productLabel)}</span>
            <span class="admin-fail-link-when">${escapeHtml(formatDateTime(row.failedAt))}</span>
          </div>
          <div class="admin-fail-link-url"><a href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(url)}</a></div>
          <div class="admin-fail-link-error">${escapeHtml(error)}</div>
          <div class="admin-fail-link-fields">
            <label class="admin-fail-link-price-label">Price link (TCGplayer or PriceCharting)
              <input type="url" placeholder="https://www.pricecharting.com/game/..." data-fail-price-link />
            </label>
            <button type="button" class="admin-btn primary" data-fail-save>Save to cache</button>
            <button type="button" class="admin-btn" data-fail-dismiss>Dismiss</button>
          </div>
          <p class="admin-status" id="${rowId}-msg"></p>
        </article>`;
      })
      .join("");

    function readFailLinkRowContext(rowEl) {
      const encodedUrl = rowEl?.getAttribute("data-fail-url") || "";
      let url = "";
      try {
        url = decodeURIComponent(encodedUrl);
      } catch {
        url = encodedUrl;
      }
      const productId = Number(rowEl?.getAttribute("data-fail-product-id") || 0) || null;
      return { url, productId };
    }

    tcgFailLinksList.querySelectorAll("[data-fail-save]").forEach((btn) => {
      btn.addEventListener("click", async () => {
        const rowEl = btn.closest(".admin-fail-link-row");
        const { url, productId } = readFailLinkRowContext(rowEl);
        const priceUrl = String(rowEl?.querySelector("[data-fail-price-link]")?.value || "").trim();
        const msgEl = rowEl?.querySelector(".admin-status");
        if (!url) {
          setStatus(msgEl, "Missing failed link URL.", "error");
          return;
        }
        if (!priceUrl) {
          setStatus(msgEl, "Paste a TCGplayer or PriceCharting product link.", "error");
          return;
        }
        btn.disabled = true;
        setStatus(msgEl, "Fetching price from link…", "");
        try {
          const saved = await api("/api/admin/tcg-price-check/fail-links/resolve", {
            method: "POST",
            body: JSON.stringify({ url, productId, priceUrl })
          });
          setStatus(msgEl, `Saved: ${saved.nearMintWithShipping || formatUsd(saved.totalPrice)}`, "ok");
          await refreshTcgFailLinks();
          await refreshTcgCacheLive();
        } catch (err) {
          setStatus(msgEl, err.message, "error");
          btn.disabled = false;
        }
      });
    });

    tcgFailLinksList.querySelectorAll("[data-fail-dismiss]").forEach((btn) => {
      btn.addEventListener("click", async () => {
        const rowEl = btn.closest(".admin-fail-link-row");
        const { url, productId } = readFailLinkRowContext(rowEl);
        const msgEl = rowEl?.querySelector(".admin-status");
        if (!url && !productId) {
          setStatus(msgEl, "Missing failed link identity.", "error");
          return;
        }
        btn.disabled = true;
        setStatus(msgEl, "Dismissing…", "");
        try {
          const result = await api("/api/admin/tcg-price-check/fail-links/dismiss", {
            method: "POST",
            body: JSON.stringify({ url, productId })
          });
          if (!result.removed) {
            setStatus(msgEl, "Could not dismiss this link. Refresh and try again.", "error");
            btn.disabled = false;
            return;
          }
          await refreshTcgFailLinks();
        } catch (err) {
          setStatus(msgEl, err.message, "error");
          btn.disabled = false;
        }
      });
    });
  }

  function formatUsd(value) {
    const n = Number(value);
    if (!Number.isFinite(n) || n < 0) return "";
    return `$${n.toFixed(2)}`;
  }

  async function refreshTcgFailLinks() {
    if (!tcgFailLinksSection) return { count: 0, links: [] };
    try {
      const payload = await api("/api/admin/tcg-price-check/fail-links");
      renderTcgFailLinks(payload.links);
      return payload;
    } catch {
      renderTcgFailLinks([]);
      return { count: 0, links: [] };
    }
  }

  function syncPcConsoleResolveSetOptions(links) {
    if (!pcConsoleResolveSet) return;
    const rows = Array.isArray(links) ? links : [];
    const current = String(pcConsoleResolveSet.value || "").trim().toUpperCase();
    const codes = [
      ...new Set(rows.map((row) => String(row.setCode || "").trim().toUpperCase()).filter(Boolean))
    ].sort((a, b) => a.localeCompare(b));
    pcConsoleResolveSet.innerHTML =
      `<option value="">${codes.length === 1 ? codes[0] : "Auto"}</option>` +
      codes.map((code) => `<option value="${escapeHtml(code)}">${escapeHtml(code)}</option>`).join("");
    if (current && codes.includes(current)) {
      pcConsoleResolveSet.value = current;
    } else if (codes.length === 1) {
      pcConsoleResolveSet.value = codes[0];
    } else {
      pcConsoleResolveSet.value = "";
    }
  }

  function renderPcFailLinks(links) {
    if (!pcFailLinksSection || !pcFailLinksList) return;
    const rows = Array.isArray(links) ? links : [];
    const count = rows.length;
    if (pcFailLinksCount) pcFailLinksCount.textContent = String(count);
    pcFailLinksSection.hidden = count === 0;
    syncPcConsoleResolveSetOptions(rows);
    pcFailLinksList.innerHTML = rows
      .map((row, index) => {
        const setCode = String(row.setCode || "").trim().toUpperCase();
        const cardNo = String(row.cardNo || "").trim();
        const cardName = escapeHtml(row.cardName || "Unknown card");
        const setName = escapeHtml(row.setName || "");
        const error = escapeHtml(row.error || "Failed");
        const rowId = `pc-fail-link-${index}`;
        return `<article class="admin-fail-link-row" data-set-code="${escapeHtml(setCode)}" data-card-no="${escapeHtml(cardNo)}">
          <div class="admin-fail-link-meta">
            <span class="admin-fail-link-product"><strong>${cardName}</strong></span>
            <span class="admin-fail-link-when mono">${escapeHtml(setCode)} #${escapeHtml(cardNo)}${setName ? ` · ${setName}` : ""}</span>
          </div>
          <div class="admin-fail-link-error">${error}</div>
          <div class="admin-fail-link-fields">
            <label class="admin-fail-link-price-label">PriceCharting product page
              <input type="url" placeholder="https://www.pricecharting.com/game/..." data-pc-fail-price-link />
            </label>
            <button type="button" class="admin-btn primary" data-pc-fail-save>Save to cache</button>
            <button type="button" class="admin-btn" data-pc-fail-dismiss>Dismiss</button>
          </div>
          <p class="admin-status" id="${rowId}-msg"></p>
        </article>`;
      })
      .join("");

    pcFailLinksList.querySelectorAll("[data-pc-fail-save]").forEach((btn) => {
      btn.addEventListener("click", async () => {
        const rowEl = btn.closest(".admin-fail-link-row");
        const setCode = rowEl?.getAttribute("data-set-code") || "";
        const cardNo = rowEl?.getAttribute("data-card-no") || "";
        const productUrl = String(rowEl?.querySelector("[data-pc-fail-price-link]")?.value || "").trim();
        const msgEl = rowEl?.querySelector(".admin-status");
        if (!setCode || !cardNo) {
          setStatus(msgEl, "Missing card identity.", "error");
          return;
        }
        if (!productUrl) {
          setStatus(msgEl, "Paste a PriceCharting product page URL.", "error");
          return;
        }
        btn.disabled = true;
        setStatus(msgEl, "Fetching PriceCharting details…", "");
        try {
          const saved = await api("/api/admin/pricecharting-details/fail-links/resolve", {
            method: "POST",
            body: JSON.stringify({ setCode, cardNo, productUrl })
          });
          const sold = Number(saved.soldListings || 0);
          const guides = Number(saved.gradedGuides || 0);
          setStatus(
            msgEl,
            `Saved to cache (${sold} sold listing${sold === 1 ? "" : "s"}, ${guides} grade guide${guides === 1 ? "" : "s"}).`,
            "ok"
          );
          await refreshPcFailLinks();
          await refreshPcCacheLive();
        } catch (err) {
          setStatus(msgEl, err.message, "error");
          btn.disabled = false;
        }
      });
    });

    pcFailLinksList.querySelectorAll("[data-pc-fail-dismiss]").forEach((btn) => {
      btn.addEventListener("click", async () => {
        const rowEl = btn.closest(".admin-fail-link-row");
        const setCode = rowEl?.getAttribute("data-set-code") || "";
        const cardNo = rowEl?.getAttribute("data-card-no") || "";
        const msgEl = rowEl?.querySelector(".admin-status");
        btn.disabled = true;
        setStatus(msgEl, "Dismissing…", "");
        try {
          const result = await api("/api/admin/pricecharting-details/fail-links/dismiss", {
            method: "POST",
            body: JSON.stringify({ setCode, cardNo })
          });
          if (!result.removed) {
            setStatus(msgEl, "Could not dismiss. Refresh and try again.", "error");
            btn.disabled = false;
            return;
          }
          await refreshPcFailLinks();
        } catch (err) {
          setStatus(msgEl, err.message, "error");
          btn.disabled = false;
        }
      });
    });
  }

  async function refreshPcFailLinks() {
    if (!pcFailLinksSection) return { count: 0, links: [] };
    try {
      const payload = await api("/api/admin/pricecharting-details/fail-links");
      renderPcFailLinks(payload.links);
      return payload;
    } catch {
      renderPcFailLinks([]);
      return { count: 0, links: [] };
    }
  }

  btnClearPcFailLinks?.addEventListener("click", async () => {
    btnClearPcFailLinks.disabled = true;
    setStatus(pcStatusMsg, "Clearing failed PriceCharting cards…", "");
    try {
      await api("/api/admin/pricecharting-details/fail-links/clear", {
        method: "POST",
        body: "{}"
      });
      renderPcFailLinks([]);
      setStatus(pcStatusMsg, "Cleared all failed PriceCharting cards.", "ok");
    } catch (err) {
      setStatus(pcStatusMsg, err.message, "error");
    } finally {
      btnClearPcFailLinks.disabled = false;
    }
  });

  btnPcConsoleResolve?.addEventListener("click", async () => {
    const consoleUrl = String(pcConsoleResolveUrl?.value || "").trim();
    const setCode = String(pcConsoleResolveSet?.value || "").trim().toUpperCase();
    if (!consoleUrl) {
      setStatus(pcStatusMsg, "Paste a PriceCharting console/set page URL first.", "error");
      return;
    }
    btnPcConsoleResolve.disabled = true;
    setStatus(
      pcStatusMsg,
      setCode
        ? `Resolving ${setCode} fails from console page…`
        : "Resolving fails from console page…",
      ""
    );
    try {
      const result = await api("/api/admin/pricecharting-details/fail-links/resolve-console", {
        method: "POST",
        body: JSON.stringify({ consoleUrl, setCode: setCode || undefined })
      });
      renderPcFailLinks(result.links || []);
      const resolved = Number(result.resolved || 0);
      const matched = Number(result.matched || 0);
      const failed = Number(result.failed || 0);
      const remaining = Number(result.failLinkCount || 0);
      setStatus(
        pcStatusMsg,
        `Resolved ${resolved}/${matched} matched card${matched === 1 ? "" : "s"} from console` +
          (failed ? ` · ${failed} still failed` : "") +
          ` · ${remaining} fail${remaining === 1 ? "" : "s"} left.`,
        resolved > 0 ? "ok" : "error"
      );
      if (resolved > 0) await refreshPcCacheLive();
    } catch (err) {
      setStatus(pcStatusMsg, err.message, "error");
    } finally {
      btnPcConsoleResolve.disabled = false;
    }
  });

  pcCorrectCardSearch?.addEventListener("input", () => {
    if (pcCorrectSelected) return;
    schedulePcCorrectCardSearch();
  });

  pcCorrectCardSearch?.addEventListener("focus", () => {
    if (!pcCorrectSelected && String(pcCorrectCardSearch.value || "").trim()) {
      schedulePcCorrectCardSearch();
    }
  });

  pcCorrectProductUrl?.addEventListener("input", () => {
    updatePcCorrectSaveState();
  });

  btnPcCorrectSave?.addEventListener("click", async () => {
    if (!pcCorrectSelected?.setCode || !pcCorrectSelected?.cardNo) {
      setStatus(pcCorrectStatusMsg, "Search and click a card first.", "error");
      return;
    }
    const productUrl = String(pcCorrectProductUrl?.value || "").trim();
    if (!productUrl) {
      setStatus(pcCorrectStatusMsg, "Paste the correct PriceCharting product page URL.", "error");
      return;
    }
    btnPcCorrectSave.disabled = true;
    setStatus(pcCorrectStatusMsg, "Saving corrected link to cache…", "");
    try {
      const saved = await api("/api/admin/pricecharting-details/override", {
        method: "POST",
        body: JSON.stringify({
          setCode: pcCorrectSelected.setCode,
          cardNo: pcCorrectSelected.cardNo,
          cardName: pcCorrectSelected.name,
          productUrl
        })
      });
      const sold = Number(saved.soldListings || 0);
      const guides = Number(saved.gradedGuides || 0);
      setStatus(
        pcCorrectStatusMsg,
        `Updated cache (${sold} sold listing${sold === 1 ? "" : "s"}, ${guides} grade guide${guides === 1 ? "" : "s"}).`,
        "ok"
      );
      if (pcCorrectProductUrl) pcCorrectProductUrl.value = "";
      await loadPcCorrectCacheEntry();
      await refreshPcFailLinks();
      await refreshPcCacheLive();
      updatePcCorrectSaveState();
    } catch (err) {
      setStatus(pcCorrectStatusMsg, err.message, "error");
      updatePcCorrectSaveState();
    }
  });

  function formatSetRefreshStamp(value) {
    const text = String(value || "").trim();
    if (!text) return "";
    const d = new Date(text);
    if (Number.isNaN(d.getTime())) return "";
    return d.toLocaleString(undefined, {
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit"
    });
  }

  async function loadTcgSetOptions() {
    if (!tcgSetRefreshSelect && !pcSetRefreshSelect) return;
    try {
      const payload = await api("/api/admin/tcg-price-check/sets");
      const sets = Array.isArray(payload.sets) ? payload.sets : [];
      const buildOptions = (kind) =>
        `<option value="">Select a set…</option>` +
        sets
          .map((row) => {
            const code = escapeHtml(row.setCode || "");
            const name = escapeHtml(row.setName || row.setCode || "");
            const stampRaw =
              kind === "tcg" ? row.tcgLastRefreshAt : row.priceChartingLastRefreshAt;
            const stamp = formatSetRefreshStamp(stampRaw);
            const label = stamp
              ? `${name} (${code}) — ${escapeHtml(stamp)}`
              : `${name} (${code})`;
            return `<option value="${code}" data-set-name="${name}">${label}</option>`;
          })
          .join("");
      if (tcgSetRefreshSelect) {
        const current = tcgSetRefreshSelect.value;
        tcgSetRefreshSelect.innerHTML = buildOptions("tcg");
        if (current) tcgSetRefreshSelect.value = current;
      }
      if (pcSetRefreshSelect) {
        const current = pcSetRefreshSelect.value;
        pcSetRefreshSelect.innerHTML = buildOptions("pricecharting");
        if (current) pcSetRefreshSelect.value = current;
      }
    } catch {
      // keep placeholder
    }
  }

  btnClearTcgFailLinks?.addEventListener("click", async () => {
    const msgEl = document.getElementById("tcgStatusMsg");
    btnClearTcgFailLinks.disabled = true;
    setStatus(msgEl, "Clearing failed TCG links…", "");
    try {
      await api("/api/admin/tcg-price-check/fail-links/clear", {
        method: "POST",
        body: "{}"
      });
      renderTcgFailLinks([]);
      setStatus(msgEl, "Cleared all failed TCG links.", "ok");
    } catch (err) {
      setStatus(msgEl, err.message, "error");
    } finally {
      btnClearTcgFailLinks.disabled = false;
    }
  });

  async function refreshTcgCacheLive() {
    const payload = await api("/api/admin/tcg-price-check");
    renderTcgCache({
      ...payload.meta,
      inFlight: payload.inFlight,
      prewarm: payload.prewarm
    });
    await refreshTcgFailLinks();
    const tcgBusy = Boolean(payload.inFlight);
    return { inFlight: tcgBusy, tcgBusy, meta: payload.meta || {} };
  }

  async function refreshPcCacheLive() {
    const payload = await api("/api/admin/pricecharting-details");
    renderPcCache({
      ...payload.meta,
      inFlight: payload.inFlight
    });
    await refreshPcFailLinks();
    const pcBusy = Boolean(payload.inFlight);
    return { inFlight: pcBusy, pcBusy, meta: payload.meta || {} };
  }

  let tcgSetOptionsRefreshAt = 0;
  let pcSetOptionsRefreshAt = 0;

  function startTcgLivePolling() {
    if (tcgPollTimer) return;
    tcgPollTimer = setInterval(() => {
      refreshTcgCacheLive()
        .then(async ({ inFlight, meta }) => {
          const now = Date.now();
          if (inFlight && now - tcgSetOptionsRefreshAt > 8000) {
            tcgSetOptionsRefreshAt = now;
            await loadTcgSetOptions().catch(() => {});
          }
          if (!inFlight) {
            stopTcgLivePolling();
            await loadTcgSetOptions().catch(() => {});
            loadDashboard()
              .then(() => {
                const status = String(tcgStatusBadge?.textContent || "").trim().toLowerCase();
                if (status === "stopped") {
                  setStatus(
                    tcgStatusMsg,
                    "Price check stopped. Cached prices were saved. Click Update again to resume.",
                    "ok"
                  );
                } else if (status === "error") {
                  setStatus(
                    tcgStatusMsg,
                    meta?.lastError || "Price check failed. Check TCGplayer keys in backend/.env and the server log.",
                    "error"
                  );
                } else {
                  setStatus(tcgStatusMsg, "TCG price check finished.", "ok");
                }
              })
              .catch(() => {});
          }
        })
        .catch(() => {});
    }, 1200);
  }

  function startPcLivePolling() {
    if (pcPollTimer) return;
    pcPollTimer = setInterval(() => {
      refreshPcCacheLive()
        .then(async ({ inFlight, meta }) => {
          const now = Date.now();
          if (inFlight && now - pcSetOptionsRefreshAt > 8000) {
            pcSetOptionsRefreshAt = now;
            await loadTcgSetOptions().catch(() => {});
          }
          if (!inFlight) {
            stopPcLivePolling();
            await loadTcgSetOptions().catch(() => {});
            loadDashboard()
              .then(() => {
                const status = String(pcStatusBadge?.textContent || "").trim().toLowerCase();
                if (status === "stopped") {
                  setStatus(pcStatusMsg, "PriceCharting refresh stopped. Cache saved so far.", "ok");
                } else if (status === "error") {
                  setStatus(pcStatusMsg, meta?.lastError || "PriceCharting refresh failed.", "error");
                } else {
                  setStatus(pcStatusMsg, "PriceCharting cache update finished.", "ok");
                }
              })
              .catch(() => {});
          }
        })
        .catch(() => {});
    }, 1200);
  }

  function stopTcgLivePolling() {
    if (tcgPollTimer) {
      clearInterval(tcgPollTimer);
      tcgPollTimer = null;
    }
    const liveStat = tcgCacheCard?.querySelector(".admin-stat--live");
    if (liveStat) liveStat.classList.remove("is-polling");
  }

  function stopPcLivePolling() {
    if (pcPollTimer) {
      clearInterval(pcPollTimer);
      pcPollTimer = null;
    }
    const liveStat = pcCacheCard?.querySelector(".admin-stat--live");
    if (liveStat) liveStat.classList.remove("is-polling");
  }

  function stopRestockLivePolling() {
    if (restockPollTimer) {
      clearInterval(restockPollTimer);
      restockPollTimer = null;
    }
  }

  function startRestockLivePolling() {
    stopRestockLivePolling();
    restockPollTimer = setInterval(async () => {
      try {
        const status = await api("/api/admin/status");
        renderRestockCache(status.restock);
        renderSite(status.site, status.restock);
        if (!status.restock?.inFlight) {
          stopRestockLivePolling();
          if (status.restock?.lastError) {
            setStatus(restockRefreshMsg, status.restock.lastError, "error");
          } else if (String(status.restock?.progress?.phase || "").toLowerCase() === "stopped") {
            setStatus(restockRefreshMsg, "Restock refresh stopped. Progress saved so far.", "ok");
          } else {
            setStatus(
              restockRefreshMsg,
              "Restock refresh finished and cached to restock-tracker.json.",
              "ok"
            );
          }
        }
      } catch {
        // keep polling; transient errors are fine
      }
    }, 2000);
  }

  async function loadDashboard() {
    const status = await api("/api/admin/status");
    const tcg = {
      ...status.tcgPriceCache,
      inFlight: status.tcgPriceCache?.inFlight
    };
    renderTcgCache(tcg);
    renderPcCache(status.priceChartingCache || {});
    renderSite(status.site, status.restock);
    renderRestockCache(status.restock);

    const manual = await api("/api/admin/restock/manual-items");
    renderManualRestock(manual.items);

    const users = await api("/api/admin/users");
    renderUsers(users.users);

    if (status.tcgPriceCache?.inFlight) startTcgLivePolling();
    else stopTcgLivePolling();

    if (status.priceChartingCache?.inFlight) startPcLivePolling();
    else stopPcLivePolling();

    if (status.restock?.inFlight) startRestockLivePolling();
    else stopRestockLivePolling();

    await loadCardNicknames();
    await refreshTcgFailLinks();
    await refreshPcFailLinks();
    await loadTcgSetOptions();
  }

  function waitForAccountReady() {
    return new Promise((resolve) => {
      if (!window.InfinityAccount) {
        resolve();
        return;
      }
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        resolve();
      };
      window.InfinityAccount.onChange(finish);
      setTimeout(finish, 1200);
    });
  }

  async function ensureAdmin() {
    const me = await fetch("/api/auth/me", { credentials: "same-origin" }).then((r) => r.json());
    if (!me?.signedIn || !me?.user?.isAdmin) {
      location.replace("/");
      return false;
    }
    if (denied) denied.hidden = true;
    if (app) app.hidden = false;
    return true;
  }

  btnTcgPriceUpdate?.addEventListener("click", async () => {
    setStatus(tcgStatusMsg, "");
    try {
      const started = await api("/api/admin/tcg-price-check/run", { method: "POST", body: "{}" });
      const total = Number(started?.meta?.totalLinkCount || started?.meta?.progress?.total || 0);
      if (started?.superseded === "pricecharting") {
        setStatus(
          tcgStatusMsg,
          "Stopping PriceCharting and saving its cache, then starting TCG…",
          "ok"
        );
        startPcLivePolling();
      } else {
        setStatus(
          tcgStatusMsg,
          total > 0
            ? `Bulk price check started (${total.toLocaleString()} links). Collecting sets first can take 1–2 minutes.`
            : "Bulk price check started. Link collection runs first (about 1–2 minutes for all English sets), then pricing.",
          "ok"
        );
      }
      startTcgLivePolling();
      await loadDashboard();
    } catch (err) {
      setStatus(tcgStatusMsg, err.message, "error");
    }
  });

  btnTcgPriceStop?.addEventListener("click", async () => {
    btnTcgPriceStop.disabled = true;
    setStatus(tcgStatusMsg, "Stopping…", "");
    try {
      await api("/api/admin/tcg-price-check/stop", { method: "POST", body: "{}" });
      setStatus(
        tcgStatusMsg,
        "Stop requested. Finishing in-flight TCGplayer requests, then saving cache…",
        "ok"
      );
      startTcgLivePolling();
    } catch (err) {
      setStatus(tcgStatusMsg, err.message, "error");
      btnTcgPriceStop.disabled = false;
    }
  });

  btnTcgSetRefresh?.addEventListener("click", async () => {
    const setCode = String(tcgSetRefreshSelect?.value || "").trim().toUpperCase();
    if (!setCode) {
      setStatus(tcgStatusMsg, "Select a set to refresh.", "error");
      return;
    }
    const selected = tcgSetRefreshSelect?.selectedOptions?.[0];
    const setName = String(selected?.getAttribute("data-set-name") || selected?.textContent || "").trim();
    setStatus(tcgStatusMsg, "");
    try {
      const started = await api("/api/admin/tcg-price-check/run-set", {
        method: "POST",
        body: JSON.stringify({ setCode, setName })
      });
      if (started?.superseded === "pricecharting") {
        setStatus(
          tcgStatusMsg,
          `Stopping PriceCharting and saving, then refreshing TCG for ${setCode}…`,
          "ok"
        );
        startPcLivePolling();
      } else {
        setStatus(tcgStatusMsg, `Refreshing TCG prices for ${setCode}…`, "ok");
      }
      startTcgLivePolling();
    } catch (err) {
      setStatus(tcgStatusMsg, err.message, "error");
    }
  });

  btnPcSetRefresh?.addEventListener("click", async () => {
    const setCode = String(pcSetRefreshSelect?.value || "").trim().toUpperCase();
    if (!setCode) {
      setStatus(pcStatusMsg, "Select a set to refresh.", "error");
      return;
    }
    const selected = pcSetRefreshSelect?.selectedOptions?.[0];
    const setName = String(selected?.getAttribute("data-set-name") || selected?.textContent || "").trim();
    setStatus(pcStatusMsg, "");
    try {
      const started = await api("/api/admin/pricecharting-details/run-set", {
        method: "POST",
        body: JSON.stringify({ setCode, setName })
      });
      if (started?.superseded === "tcg") {
        setStatus(
          pcStatusMsg,
          `Stopping TCG and saving, then refreshing PriceCharting for ${setCode}…`,
          "ok"
        );
        startTcgLivePolling();
      } else {
        setStatus(pcStatusMsg, `Refreshing PriceCharting details for ${setCode}…`, "ok");
      }
      startPcLivePolling();
    } catch (err) {
      setStatus(pcStatusMsg, err.message, "error");
    }
  });

  btnPcDetailsUpdate?.addEventListener("click", async () => {
    setStatus(pcStatusMsg, "");
    try {
      const started = await api("/api/admin/pricecharting-details/run", { method: "POST", body: "{}" });
      if (started?.superseded === "tcg") {
        setStatus(pcStatusMsg, "Stopping TCG and saving its cache, then starting PriceCharting…", "ok");
        startTcgLivePolling();
      } else {
        setStatus(pcStatusMsg, "PriceCharting details refresh started.", "ok");
      }
      startPcLivePolling();
    } catch (err) {
      setStatus(pcStatusMsg, err.message, "error");
    }
  });

  btnPcDetailsStop?.addEventListener("click", async () => {
    if (btnPcDetailsStop) btnPcDetailsStop.disabled = true;
    setStatus(pcStatusMsg, "Stopping…", "");
    try {
      await api("/api/admin/pricecharting-details/stop", { method: "POST", body: "{}" });
      setStatus(pcStatusMsg, "Stop requested. Finishing in-flight PriceCharting requests…", "ok");
      startPcLivePolling();
    } catch (err) {
      setStatus(pcStatusMsg, err.message, "error");
      if (btnPcDetailsStop) btnPcDetailsStop.disabled = false;
    }
  });

  btnRestockSelectAll?.addEventListener("click", () => {
    restockRetailerSelection = null;
    setRestockRetailerChecks(null);
  });

  btnRestockSelectNone?.addEventListener("click", () => {
    restockRetailerSelection = [];
    setRestockRetailerChecks([]);
  });

  restockRetailerList?.addEventListener("change", () => {
    restockRetailerSelection = getSelectedRestockRetailers();
  });

  btnRestockRefresh?.addEventListener("click", async () => {
    setStatus(restockRefreshMsg, "");
    const retailers = getSelectedRestockRetailers();
    if (!retailers.length) {
      setStatus(restockRefreshMsg, "Select at least one retailer to refresh.", "error");
      return;
    }
    restockRetailerSelection = retailers;
    if (btnRestockRefresh) btnRestockRefresh.disabled = true;
    try {
      const allSelected =
        restockRetailerOptions.length > 0 && retailers.length === restockRetailerOptions.length;
      await api("/api/admin/restock/refresh", {
        method: "POST",
        body: JSON.stringify(allSelected ? {} : { retailers })
      });
      setStatus(
        restockRefreshMsg,
        allSelected
          ? "Restock refresh started for all retailers…"
          : `Restock refresh started for ${retailers.join(", ")}…`,
        "ok"
      );
      startRestockLivePolling();
      await loadDashboard();
    } catch (err) {
      setStatus(restockRefreshMsg, err.message, "error");
      if (btnRestockRefresh) btnRestockRefresh.disabled = false;
    }
  });

  btnRestockStop?.addEventListener("click", async () => {
    if (btnRestockStop) btnRestockStop.disabled = true;
    setStatus(restockRefreshMsg, "Stopping…", "");
    try {
      await api("/api/admin/restock/stop", { method: "POST", body: "{}" });
      setStatus(restockRefreshMsg, "Stop requested. Finishing the current restock check…", "ok");
      startRestockLivePolling();
    } catch (err) {
      setStatus(restockRefreshMsg, err.message, "error");
      if (btnRestockStop) btnRestockStop.disabled = false;
    }
  });

  btnClearActivities?.addEventListener("click", async () => {
    if (!window.confirm("Clear all collection activity log entries?")) return;
    setStatus(siteStatusMsg, "");
    try {
      const result = await api("/api/admin/activities/clear", { method: "POST", body: "{}" });
      setStatus(siteStatusMsg, `Removed ${result.removed} activity entries.`, "ok");
      await loadDashboard();
    } catch (err) {
      setStatus(siteStatusMsg, err.message, "error");
    }
  });

  restockForm?.addEventListener("submit", async (event) => {
    event.preventDefault();
    setStatus(restockFormMsg, "");
    try {
      await api("/api/admin/restock/manual-items", {
        method: "POST",
        body: JSON.stringify({
          name: document.getElementById("restockName").value,
          productUrl: document.getElementById("restockUrl").value,
          retailer: document.getElementById("restockRetailer").value,
          status: document.getElementById("restockStatus").value,
          lastPrice: document.getElementById("restockPrice").value
        })
      });
      restockForm.reset();
      setStatus(restockFormMsg, "Product added to Restock Tracker.", "ok");
      await loadDashboard();
    } catch (err) {
      setStatus(restockFormMsg, err.message, "error");
    }
  });

  nicknameLanguage?.addEventListener("change", () => {
    clearNicknameCardSelection();
    scheduleNicknameCardSearch();
  });

  nicknameCardSearch?.addEventListener("input", () => {
    if (nicknameSelected) return;
    scheduleNicknameCardSearch();
  });

  nicknameCardSearch?.addEventListener("focus", () => {
    if (!nicknameSelected && String(nicknameCardSearch.value || "").trim()) {
      scheduleNicknameCardSearch();
    }
  });

  nicknameForm?.addEventListener("submit", async (event) => {
    event.preventDefault();
    setStatus(nicknameFormMsg, "");
    if (!nicknameSelected?.setCode || !nicknameSelected?.cardNo) {
      setStatus(nicknameFormMsg, "Search and click a card to link this nickname.", "error");
      nicknameCardSearch?.focus();
      return;
    }
    try {
      await api("/api/admin/card-nicknames", {
        method: "POST",
        body: JSON.stringify({
          nickname: nicknameText?.value || "",
          setCode: nicknameSelected.setCode,
          cardNumber: nicknameSelected.cardNo,
          setName: nicknameSelected.setName || "",
          language: nicknameLanguage?.value || "english"
        })
      });
      resetNicknameForm({ keepNickname: true });
      setStatus(nicknameFormMsg, "Card linked. Pick another card to add it under the same nickname.", "ok");
      await loadCardNicknames();
    } catch (err) {
      setStatus(nicknameFormMsg, err.message, "error");
    }
  });

  nicknameBody?.addEventListener("click", async (event) => {
    const btn = event.target.closest("[data-remove-nickname-id]");
    if (!btn) return;
    const id = btn.getAttribute("data-remove-nickname-id");
    if (!id || !window.confirm("Remove this card from the nickname?")) return;
    setStatus(nicknameFormMsg, "");
    try {
      await api(`/api/admin/card-nicknames/${encodeURIComponent(id)}`, { method: "DELETE" });
      setStatus(nicknameFormMsg, "Nickname removed.", "ok");
      await loadCardNicknames();
    } catch (err) {
      setStatus(nicknameFormMsg, err.message, "error");
    }
  });

  manualRestockBody?.addEventListener("click", async (event) => {
    const btn = event.target.closest("[data-remove-id]");
    if (!btn) return;
    const id = btn.getAttribute("data-remove-id");
    if (!id || !window.confirm("Remove this manual restock product?")) return;
    setStatus(restockFormMsg, "");
    try {
      await api(`/api/admin/restock/manual-items/${encodeURIComponent(id)}`, { method: "DELETE" });
      setStatus(restockFormMsg, "Product removed.", "ok");
      await loadDashboard();
    } catch (err) {
      setStatus(restockFormMsg, err.message, "error");
    }
  });

  async function init() {
    await waitForAccountReady();
    const ok = await ensureAdmin();
    if (!ok) {
      document.addEventListener(
        "infinity-auth-change",
        async () => {
          if (await ensureAdmin()) {
            await loadDashboard();
            await initNicknameCardPicker();
          }
        },
        { once: false }
      );
      return;
    }
    await loadDashboard();
    await initNicknameCardPicker();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
