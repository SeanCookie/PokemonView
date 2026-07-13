(function (global) {
  "use strict";

  function escapeHtml(value) {
    return String(value ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  /**
   * @param {object} options
   * @param {() => number} [options.getItemCount]
   * @param {() => boolean} [options.getCanUndo]
   * @param {() => number} [options.getUndoCount]
   * @param {(meta: { canUndo?: boolean, undoCount?: number, lastCollectrImport?: object|null }) => void} [options.setCollectionMeta]
   * @param {() => Promise<void>|void} [options.onCollectionChanged]
   * @param {() => string} [options.getDefaultUrl]
   * @param {boolean} [options.alwaysVisible] - if true, never hide for empty-collection dismiss flow
   * @param {boolean} [options.enableDismiss] - dashboard-style dismiss for empty collections
   */
  function mountCollectrImportUI(options = {}) {
    const byId = (id) => document.getElementById(id);
    const collectrImportUrl = byId("collectrImportUrl");
    const collectrImportStatus = byId("collectrImportStatus");
    const collectrPreviewBtn = byId("collectrPreviewBtn");
    const collectrImportBtn = byId("collectrImportBtn");
    const collectrReplaceExisting = byId("collectrReplaceExisting");
    const collectrProgress = byId("collectrProgress");
    const collectrProgressLabel = byId("collectrProgressLabel");
    const collectrProgressPct = byId("collectrProgressPct");
    const collectrProgressFill = byId("collectrProgressFill");
    const collectrPreviewSummary = byId("collectrPreviewSummary");
    const collectrImportPanel = byId("collectrImportPanel");
    const collectrImportDismiss = byId("collectrImportDismiss");
    const collectrDeleteWrap = byId("collectrDeleteWrap");
    const collectrDeleteImportBtn = byId("collectrDeleteImportBtn");

    if (!collectrImportPanel || !collectrImportUrl) {
      return null;
    }

    let collectrCatalogCache = null;
    let collectrCatalogCacheUrl = "";
    let collectrImportBatchId = "";
    let lastCollectrImport = null;
    let collectionCanUndo = false;
    let collectionUndoCount = 0;
    let itemCount = 0;

    const COLLECTR_DISMISS_KEY_PREFIX = "ic.collectrImport.dismissed.v1.";
    const alwaysVisible = Boolean(options.alwaysVisible);
    const enableDismiss = options.enableDismiss !== false && !alwaysVisible;

    function collectrDismissStorageKey() {
      const user = global.InfinityAccount?.getUser?.();
      const id = String(user?.id || user?.email || user?.username || "").trim();
      return id ? `${COLLECTR_DISMISS_KEY_PREFIX}${id}` : "";
    }

    function isCollectrImportDismissed() {
      const key = collectrDismissStorageKey();
      if (!key) return false;
      try {
        return localStorage.getItem(key) === "1";
      } catch {
        return false;
      }
    }

    function setCollectrImportDismissed(dismissed) {
      const key = collectrDismissStorageKey();
      if (!key) return;
      try {
        if (dismissed) localStorage.setItem(key, "1");
        else localStorage.removeItem(key);
      } catch {
        /* ignore */
      }
    }

    function readItemCount() {
      if (typeof options.getItemCount === "function") {
        return Number(options.getItemCount()) || 0;
      }
      return itemCount;
    }

    function readCanUndo() {
      if (typeof options.getCanUndo === "function") {
        return Boolean(options.getCanUndo());
      }
      return collectionCanUndo;
    }

    function readUndoCount() {
      if (typeof options.getUndoCount === "function") {
        return Number(options.getUndoCount()) || 0;
      }
      return collectionUndoCount;
    }

    function notifyMeta(patch) {
      if (typeof options.setCollectionMeta === "function") {
        options.setCollectionMeta(patch);
      }
    }

    async function refreshCollection() {
      if (typeof options.onCollectionChanged === "function") {
        await options.onCollectionChanged();
      }
    }

    function updateCollectrImportPanelVisibility() {
      if (!collectrImportPanel) return;
      if (alwaysVisible) {
        collectrImportPanel.hidden = false;
        if (collectrImportDismiss) collectrImportDismiss.hidden = true;
        return;
      }
      const count = readItemCount();
      const isNewUser = count === 0;
      const show = isNewUser && !isCollectrImportDismissed();
      collectrImportPanel.hidden = !show;
      if (collectrImportDismiss) collectrImportDismiss.hidden = !enableDismiss;
    }

    function setCollectrStatus(message, isError = false) {
      if (!collectrImportStatus) return;
      collectrImportStatus.textContent = message || "";
      collectrImportStatus.style.color = isError ? "var(--down, var(--danger, #ff5f73))" : "var(--muted)";
    }

    function setCollectrProgress(percent, label) {
      const pct = Math.max(0, Math.min(100, Math.round(Number(percent) || 0)));
      if (collectrProgress) {
        collectrProgress.classList.add("active");
        collectrProgress.setAttribute("aria-hidden", "false");
      }
      if (collectrProgressLabel && label) collectrProgressLabel.textContent = label;
      if (collectrProgressPct) collectrProgressPct.textContent = `${pct}%`;
      if (collectrProgressFill) collectrProgressFill.style.width = `${pct}%`;
      const track = collectrProgress?.querySelector("[role=progressbar]");
      if (track) track.setAttribute("aria-valuenow", String(pct));
    }

    function hideCollectrProgress() {
      if (collectrProgress) {
        collectrProgress.classList.remove("active");
        collectrProgress.setAttribute("aria-hidden", "true");
      }
      if (collectrProgressFill) collectrProgressFill.style.width = "0%";
      if (collectrProgressPct) collectrProgressPct.textContent = "0%";
    }

    function isCollectrUngradedCard(row) {
      if (!row || row.is_card === false) return false;
      // Collectr grade_id can mean raw condition (e.g. Near Mint); graded needs a company.
      const gradeCompany = String(row.grade_company || "").trim();
      return !gradeCompany;
    }

    function filterCollectrProductsForImport(products) {
      return (Array.isArray(products) ? products : []).filter(isCollectrUngradedCard);
    }

    function showCollectrPreviewSummary(catalog) {
      if (!collectrPreviewSummary || !catalog) return;
      const filtered = filterCollectrProductsForImport(catalog.products);
      const handle = catalog.handle || "collector";
      const expected = Number(catalog.expectedTotal) || 0;
      const partialNote =
        catalog.partial && expected > filtered.length
          ? `<div style="color:var(--down, var(--danger, #ff5f73));font-size:12px;">Partial load: ${filtered.length.toLocaleString()} ready of ~${expected.toLocaleString()} showcase items. Re-run Preview if this looks too low.</div>`
          : "";
      collectrPreviewSummary.innerHTML = `
        <div>Ready to import from <strong>@${escapeHtml(handle)}</strong></div>
        <div><strong>${filtered.length.toLocaleString()}</strong> ungraded Pokémon cards</div>
        <div style="color:var(--muted);font-size:12px;">Sealed, graded, and other TCGs are skipped${catalog.filteredOutNonPokemon ? ` (${Number(catalog.filteredOutNonPokemon).toLocaleString()} other TCGs)` : ""}</div>
        ${partialNote}`;
      collectrPreviewSummary.classList.add("visible");
    }

    function hideCollectrPreviewSummary() {
      if (!collectrPreviewSummary) return;
      collectrPreviewSummary.classList.remove("visible");
      collectrPreviewSummary.innerHTML = "";
    }

    function resetCollectrImportField() {
      if (collectrImportUrl) collectrImportUrl.value = "";
      collectrCatalogCache = null;
      collectrCatalogCacheUrl = "";
      collectrImportBatchId = "";
      hideCollectrPreviewSummary();
    }

    function applyDefaultUrl() {
      if (!collectrImportUrl || String(collectrImportUrl.value || "").trim()) return;
      if (typeof options.getDefaultUrl !== "function") return;
      const next = String(options.getDefaultUrl() || "").trim();
      if (!next) return;
      const parsed = global.CollectrImportClient?.parseCollectrProfileUrl?.(next);
      collectrImportUrl.value =
        parsed?.ok && parsed.handle ? `@${parsed.handle}` : next;
    }

    function updateCollectrDeleteButton() {
      if (!collectrDeleteWrap || !collectrDeleteImportBtn) return;
      const count = readItemCount();
      if (readCanUndo()) {
        const undoN = readUndoCount() || count;
        collectrDeleteImportBtn.textContent = "Undo";
        collectrDeleteImportBtn.classList.add("collectr-undo-btn");
        collectrDeleteImportBtn.title = `Restore ${undoN.toLocaleString()} item(s) to your collection`;
        collectrDeleteWrap.hidden = false;
        return;
      }
      collectrDeleteImportBtn.classList.remove("collectr-undo-btn");
      if (!count) {
        collectrDeleteWrap.hidden = true;
        return;
      }
      collectrDeleteImportBtn.textContent = "Delete All";
      collectrDeleteImportBtn.title = `Remove all ${count.toLocaleString()} item(s) from your collection`;
      collectrDeleteWrap.hidden = false;
    }

    function setCollectrActionButtonsDisabled(disabled) {
      if (collectrDeleteImportBtn) collectrDeleteImportBtn.disabled = disabled;
      if (collectrImportBtn) collectrImportBtn.disabled = disabled;
      if (collectrPreviewBtn) collectrPreviewBtn.disabled = disabled;
    }

    async function deleteAllCollectionItems() {
      const count = readItemCount();
      if (!count) return;
      if (
        !global.confirm(
          `Remove all ${count.toLocaleString()} item(s) from your personal collection? You can use Undo to bring them back.`
        )
      ) {
        return;
      }
      setCollectrActionButtonsDisabled(true);
      try {
        const res = await fetch("/api/collection/delete-all", {
          method: "POST",
          credentials: "same-origin",
          headers: { "Content-Type": "application/json" },
          body: "{}"
        });
        const payload = await res.json().catch(() => ({}));
        if (!res.ok || !payload.ok) {
          setCollectrStatus(payload.error || "Could not clear your collection.", true);
          return;
        }
        lastCollectrImport = null;
        collectrImportBatchId = "";
        collectionCanUndo = Boolean(payload.canUndo);
        collectionUndoCount = Number(payload.deleted) || count;
        itemCount = 0;
        notifyMeta({
          canUndo: collectionCanUndo,
          undoCount: collectionUndoCount,
          lastCollectrImport: null
        });
        setCollectrStatus(
          `Removed ${Number(payload.deleted || 0).toLocaleString()} item(s). Click Undo to restore.`
        );
        await refreshCollection();
        updateCollectrDeleteButton();
        updateCollectrImportPanelVisibility();
      } catch (err) {
        setCollectrStatus(err.message || "Delete failed.", true);
      } finally {
        setCollectrActionButtonsDisabled(false);
      }
    }

    async function undoDeleteAllCollectionItems() {
      const restoreN = readUndoCount() || 0;
      if (!readCanUndo()) return;
      if (
        restoreN &&
        !global.confirm(`Restore ${restoreN.toLocaleString()} item(s) to your personal collection?`)
      ) {
        return;
      }
      setCollectrActionButtonsDisabled(true);
      try {
        const res = await fetch("/api/collection/undo-delete-all", {
          method: "POST",
          credentials: "same-origin",
          headers: { "Content-Type": "application/json" },
          body: "{}"
        });
        const payload = await res.json().catch(() => ({}));
        if (!res.ok || !payload.ok) {
          setCollectrStatus(payload.error || "Could not restore your collection.", true);
          return;
        }
        collectionCanUndo = false;
        collectionUndoCount = 0;
        notifyMeta({ canUndo: false, undoCount: 0 });
        setCollectrStatus(
          `Restored ${Number(payload.restored || 0).toLocaleString()} item(s) to your collection.`
        );
        await refreshCollection();
        updateCollectrDeleteButton();
        updateCollectrImportPanelVisibility();
      } catch (err) {
        setCollectrStatus(err.message || "Restore failed.", true);
      } finally {
        setCollectrActionButtonsDisabled(false);
      }
    }

    async function fetchCollectrCatalogInBrowser(url, onProgress) {
      if (!global.CollectrImportClient?.fetchAllCollectrShowcaseProducts) {
        throw new Error("Collectr import helper failed to load. Hard refresh the page.");
      }
      let fakePct = 0;
      const tick = setInterval(() => {
        fakePct = Math.min(92, fakePct + 1);
        setCollectrProgress(
          fakePct,
          "Loading showcase from Collectr (large collections may take several minutes)…"
        );
      }, 900);
      try {
        return await global.CollectrImportClient.fetchAllCollectrShowcaseProducts(url, {
          maxItems: 25000,
          onProgress
        });
      } finally {
        clearInterval(tick);
      }
    }

    async function uploadCollectrProductsBatches(catalog, replaceExisting, importBatchId, onProgress) {
      const batchSize = 400;
      const products = filterCollectrProductsForImport(catalog.products || []);
      const totalBatches = Math.max(1, Math.ceil(products.length / batchSize));
      let imported = 0;
      let skipped = 0;
      let pricedFromSets = 0;
      let batchIndex = 0;
      for (let i = 0; i < products.length; i += batchSize) {
        const slice = products.slice(i, i + batchSize);
        const isFinal = i + batchSize >= products.length;
        batchIndex += 1;
        if (onProgress) {
          const processed = Math.min(i + slice.length, products.length);
          onProgress({
            phase: "save",
            batchIndex,
            totalBatches,
            processed,
            total: products.length,
            percent: Math.round((processed / products.length) * 100)
          });
        }
        const res = await fetch("/api/collectr/import/bulk", {
          method: "POST",
          credentials: "same-origin",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            products: slice,
            replaceExisting: replaceExisting && i === 0,
            importSingles: true,
            importSealed: false,
            profileUrl: catalog.profileUrl,
            handle: catalog.handle,
            importBatchId
          })
        });
        const payload = await res.json().catch(() => ({}));
        if (!res.ok || !payload.ok) {
          throw new Error(payload.error || "Import batch failed");
        }
        imported += Number(payload.imported) || 0;
        skipped += Number(payload.skipped) || 0;
        pricedFromSets += Number(payload.pricedFromSets) || 0;
        if (isFinal) {
          await fetch("/api/collectr/import/bulk", {
            method: "POST",
            credentials: "same-origin",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              products: [],
              handle: catalog.handle,
              profileUrl: catalog.profileUrl,
              importBatchId,
              finalBatch: true,
              runImported: imported,
              runSkipped: skipped
            })
          }).catch(() => {});
        }
      }
      return { imported, skipped, pricedFromSets, totalFound: products.length };
    }

    function parseCollectrImportInput(raw) {
      if (!global.CollectrImportClient?.parseCollectrProfileUrl) {
        return { ok: false, error: "Collectr import helper failed to load. Hard refresh the page." };
      }
      return global.CollectrImportClient.parseCollectrProfileUrl(raw);
    }

    if (enableDismiss) {
      collectrImportDismiss?.addEventListener("click", () => {
        setCollectrImportDismissed(true);
        updateCollectrImportPanelVisibility();
      });
    } else if (collectrImportDismiss) {
      collectrImportDismiss.hidden = true;
    }

    collectrDeleteImportBtn?.addEventListener("click", () => {
      if (readCanUndo()) undoDeleteAllCollectionItems();
      else deleteAllCollectionItems();
    });

    collectrPreviewBtn?.addEventListener("click", async () => {
      const url = collectrImportUrl?.value.trim() || "";
      const parsed = parseCollectrImportInput(url);
      if (!parsed.ok) {
        setCollectrStatus(parsed.error || "Enter a Collectr @username or showcase link.", true);
        return;
      }
      hideCollectrPreviewSummary();
      setCollectrStatus("");
      setCollectrProgress(0, "Loading showcase from Collectr…");
      collectrPreviewBtn.disabled = true;
      collectrImportBtn.disabled = true;
      try {
        const catalog = await fetchCollectrCatalogInBrowser(parsed.profileUrl, (progress) => {
          const loaded = Number(progress.loaded) || 0;
          const expected = Number(progress.expectedTotal) || 0;
          const pct =
            expected > 0
              ? Math.min(99, Math.round((loaded / expected) * 100))
              : Math.min(95, Math.round(loaded / 50));
          setCollectrProgress(
            pct,
            `Loading showcase… ${loaded.toLocaleString()}${expected ? ` / ${expected.toLocaleString()}` : ""} items`
          );
        });
        if (!catalog.ok) {
          setCollectrStatus(catalog.error || "Preview failed.", true);
          hideCollectrProgress();
          return;
        }
        collectrCatalogCache = catalog;
        collectrCatalogCacheUrl = parsed.handle;
        setCollectrProgress(100, "Preview complete");
        showCollectrPreviewSummary(catalog);
        const filteredPreview = filterCollectrProductsForImport(catalog.products);
        setCollectrStatus(
          `Preview ready for @${catalog.handle}: ${filteredPreview.length.toLocaleString()} ungraded Pokémon cards to import.`
        );
        setTimeout(() => hideCollectrProgress(), 600);
      } catch (err) {
        setCollectrStatus(err.message || "Network error while previewing Collectr.", true);
        hideCollectrProgress();
      } finally {
        collectrPreviewBtn.disabled = false;
        collectrImportBtn.disabled = false;
      }
    });

    collectrImportBtn?.addEventListener("click", async () => {
      const url = collectrImportUrl?.value.trim() || "";
      const parsed = parseCollectrImportInput(url);
      if (!parsed.ok) {
        setCollectrStatus(parsed.error || "Enter a Collectr @username or showcase link.", true);
        return;
      }
      const profileUrl = parsed.profileUrl;
      const replace = Boolean(collectrReplaceExisting?.checked);
      const confirmText = replace
        ? "Replace your entire collection and import ungraded Pokémon cards from this Collectr showcase?"
        : "Import ungraded Pokémon cards from this Collectr showcase into your collection?";
      if (!global.confirm(confirmText)) return;

      setCollectrStatus("");
      collectrPreviewBtn.disabled = true;
      collectrImportBtn.disabled = true;
      collectrImportBatchId = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
      try {
        let catalog =
          collectrCatalogCache &&
          collectrCatalogCacheUrl === parsed.handle &&
          !collectrCatalogCache.partial
            ? collectrCatalogCache
            : null;
        const fetchWeight = catalog ? 0 : 45;

        if (!catalog) {
          setCollectrProgress(0, "Fetching catalog from Collectr…");
          catalog = await fetchCollectrCatalogInBrowser(profileUrl, (progress) => {
            const loaded = Number(progress.loaded) || 0;
            const expected = Number(progress.expectedTotal) || 0;
            const fetchPct =
              expected > 0
                ? (loaded / expected) * fetchWeight
                : Math.min(fetchWeight - 1, loaded / 80);
            setCollectrProgress(
              Math.round(fetchPct),
              `Fetching from Collectr… ${loaded.toLocaleString()}${expected ? ` / ${expected.toLocaleString()}` : ""}`
            );
          });
          collectrCatalogCache = catalog;
          collectrCatalogCacheUrl = parsed.handle;
        }

        if (!catalog.ok) {
          setCollectrStatus(catalog.error || "Could not load Collectr showcase.", true);
          hideCollectrProgress();
          return;
        }

        showCollectrPreviewSummary(catalog);
        const products = filterCollectrProductsForImport(catalog.products || []);
        if (!products.length) {
          setCollectrStatus("No ungraded Pokémon cards found to import.", true);
          hideCollectrProgress();
          return;
        }
        const useBatches = products.length > 400;
        const saveStart = fetchWeight;
        setCollectrProgress(
          saveStart,
          useBatches
            ? `Saving ${products.length.toLocaleString()} items in batches…`
            : `Saving ${products.length.toLocaleString()} items…`
        );

        const catalogForImport = { ...catalog, products };
        const result = await uploadCollectrProductsBatches(
          catalogForImport,
          replace,
          collectrImportBatchId,
          (progress) => {
            const savePct =
              saveStart +
              Math.round(((progress.processed || 0) / (progress.total || 1)) * (100 - saveStart));
            const batchNote = useBatches
              ? ` (batch ${progress.batchIndex} of ${progress.totalBatches})`
              : "";
            setCollectrProgress(
              savePct,
              `Saving to your collection… ${Number(progress.processed || 0).toLocaleString()} / ${Number(progress.total || 0).toLocaleString()}${batchNote}`
            );
          }
        );

        setCollectrProgress(100, "Import complete");
        lastCollectrImport = {
          batchId: collectrImportBatchId,
          handle: catalog.handle,
          itemCount: Number(result.imported) || 0,
          importedAt: new Date().toISOString()
        };
        notifyMeta({ lastCollectrImport });
        let statusMsg = `Imported ${Number(result.imported || 0).toLocaleString()} ungraded Pokémon cards from @${catalog.handle} (${Number(result.skipped || 0).toLocaleString()} skipped).`;
        const skippedOtherTcgs = Number(catalog.filteredOutNonPokemon) || 0;
        if (skippedOtherTcgs > 0) {
          statusMsg += ` ${skippedOtherTcgs.toLocaleString()} Magic/other TCG items were excluded.`;
        }
        if (Number(result.pricedFromSets) > 0) {
          statusMsg += ` ${Number(result.pricedFromSets).toLocaleString()} priced from Sets/TCGplayer links.`;
        }
        setCollectrStatus(statusMsg);
        await refreshCollection();
        updateCollectrDeleteButton();
        updateCollectrImportPanelVisibility();
        resetCollectrImportField();
        applyDefaultUrl();
        setTimeout(() => hideCollectrProgress(), 1200);
      } catch (err) {
        setCollectrStatus(err.message || "Import failed.", true);
        hideCollectrProgress();
      } finally {
        collectrPreviewBtn.disabled = false;
        collectrImportBtn.disabled = false;
      }
    });

    function syncFromDashboard(dashboard = {}, items = []) {
      itemCount = Array.isArray(items) ? items.length : readItemCount();
      if (dashboard && typeof dashboard === "object") {
        if (dashboard.lastCollectrImport?.batchId) {
          lastCollectrImport = dashboard.lastCollectrImport;
        }
        collectionCanUndo = Boolean(dashboard.canUndoCollection);
        collectionUndoCount = Number(dashboard.collectionUndoCount) || 0;
      }
      updateCollectrDeleteButton();
      updateCollectrImportPanelVisibility();
      applyDefaultUrl();
    }

    function refresh() {
      itemCount = readItemCount();
      collectionCanUndo = readCanUndo();
      collectionUndoCount = readUndoCount();
      updateCollectrDeleteButton();
      updateCollectrImportPanelVisibility();
      applyDefaultUrl();
    }

    updateCollectrImportPanelVisibility();
    updateCollectrDeleteButton();
    applyDefaultUrl();

    return {
      refresh,
      syncFromDashboard,
      resetField: resetCollectrImportField,
      updateDeleteButton: updateCollectrDeleteButton,
      updateVisibility: updateCollectrImportPanelVisibility,
      getLastImport: () => lastCollectrImport
    };
  }

  const api = { mount: mountCollectrImportUI };
  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }
  global.CollectrImportUI = api;
})(typeof window !== "undefined" ? window : globalThis);
