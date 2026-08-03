/* global InfinityAccount */

const EMB_DIM = 512;
const state = {
  scannerReady: false,
  stream: null,
  previewUrl: null,
  selected: null,
  matches: [],
  clipReady: false,
  clipLoading: false,
  clipPipeline: null
};

const $ = (id) => document.getElementById(id);

function escapeHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function formatUsd(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return "";
  return `$${n.toFixed(2)}`;
}

function setStatus(text, kind = "") {
  const el = $("scanStatus");
  if (!el) return;
  el.textContent = text;
  el.className = `scan-status${kind ? ` ${kind}` : ""}`;
}

function setLoading(text) {
  const el = $("scanLoading");
  if (!el) return;
  el.textContent = text || "";
}

function showModelProgress(show, pct = 0) {
  const bar = $("scanModelProgress");
  const fill = $("scanModelProgressFill");
  if (!bar || !fill) return;
  bar.classList.toggle("visible", show);
  fill.style.width = `${Math.min(100, Math.max(0, pct))}%`;
}

async function fetchScannerStatus() {
  try {
    const res = await fetch("/api/scan/status");
    const data = res.ok ? await res.json() : {};
    state.scannerReady = Boolean(data.available);
    if (data.available) {
      setStatus(`Scanner catalog loaded (${Number(data.cardCount || 0).toLocaleString()} cards).`, "ok");
    } else {
      setStatus(data.message || "Scanner database not available on server.", "warn");
    }
  } catch {
    setStatus("Could not reach scanner API.", "err");
  }
}

async function loadClipModel() {
  if (state.clipReady || state.clipLoading) return state.clipPipeline;
  state.clipLoading = true;
  setLoading("Loading vision model (first time may take a minute)…");
  showModelProgress(true, 5);
  try {
    const { pipeline, env } = await import(
      "https://cdn.jsdelivr.net/npm/@xenova/transformers@2.17.2"
    );
    env.allowLocalModels = false;
    env.useBrowserCache = true;
    const progress = (p) => {
      if (p.status === "progress" && p.progress != null) {
        showModelProgress(true, Math.round(p.progress));
      }
    };
    state.clipPipeline = await pipeline("image-feature-extraction", "Xenova/clip-vit-base-patch32", {
      progress_callback: progress
    });
    state.clipReady = true;
    showModelProgress(false);
    setLoading("");
    return state.clipPipeline;
  } catch (err) {
    showModelProgress(false);
    setLoading("");
    console.error(err);
    throw new Error("Could not load vision model in browser.");
  } finally {
    state.clipLoading = false;
  }
}

async function embeddingFromImageSource(source) {
  const extractor = await loadClipModel();
  const out = await extractor(source, { pooling: "mean", normalize: true });
  const data = out && out.data ? out.data : out;
  const arr = Array.from(data);
  if (arr.length !== EMB_DIM) {
    throw new Error(`Unexpected embedding size (${arr.length})`);
  }
  return arr;
}

async function matchEmbedding(embedding) {
  const res = await fetch("/api/scan/match", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ embedding, limit: 10 })
  });
  return res.ok ? res.json() : { ok: false, matches: [], error: `HTTP ${res.status}` };
}

async function matchText(query) {
  const res = await fetch("/api/scan/match", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ q: query, limit: 16 })
  });
  return res.ok ? res.json() : { ok: false, matches: [], error: `HTTP ${res.status}` };
}

function renderMatches() {
  const list = $("scanResults");
  if (!list) return;
  if (!state.matches.length) {
    list.innerHTML = `<div class="scan-empty">No matches yet. Capture a card or search by name.</div>`;
    return;
  }
  list.innerHTML = state.matches
    .map((card) => {
      const sel = state.selected && state.selected.id === card.id;
      const thumb = card.imageUrl
        ? `<img src="${escapeHtml(card.imageUrl)}" alt="" loading="lazy" />`
        : `<div class="scan-result-thumb-ph">No img</div>`;
      const conf =
        card.confidence != null
          ? `<span class="scan-confidence">${Math.round(card.confidence * 100)}%</span>`
          : "";
      const tcgPrice = formatUsd(card.priceTcgplayer);
      const tcgPriceHtml = tcgPrice
        ? card.tcgplayerUrl
          ? `<a class="scan-result-meta" href="${escapeHtml(card.tcgplayerUrl)}" target="_blank" rel="noopener noreferrer">TCGplayer: ${escapeHtml(tcgPrice)}</a>`
          : `<div class="scan-result-meta">TCGplayer: ${escapeHtml(tcgPrice)}</div>`
        : "";
      return `<button type="button" class="scan-result${sel ? " selected" : ""}" data-id="${escapeHtml(card.id)}">${thumb}<div><div class="scan-result-name">${escapeHtml(card.name)}</div><div class="scan-result-meta">${escapeHtml(card.setName || card.setId)} · ${escapeHtml(card.setCode)} #${escapeHtml(card.cardNumber)}</div>${tcgPriceHtml}</div>${conf}</button>`;
    })
    .join("");

  list.querySelectorAll(".scan-result[data-id]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const id = btn.getAttribute("data-id");
      state.selected = state.matches.find((c) => c.id === id) || null;
      renderMatches();
      updateAddPanel();
    });
  });
}

function updateAddPanel() {
  const panel = $("scanAddPanel");
  const summary = $("scanSelectedSummary");
  if (!panel || !summary) return;
  if (!state.selected) {
    panel.classList.remove("visible");
    summary.textContent = "";
    return;
  }
  panel.classList.add("visible");
  const tcgPrice = formatUsd(state.selected.priceTcgplayer);
  const tcgLabel = tcgPrice ? ` · TCGplayer ${tcgPrice}` : "";
  summary.textContent = `${state.selected.name} — ${state.selected.setName || state.selected.setId} #${state.selected.cardNumber}${tcgLabel}`;
}

function getActiveImageSource() {
  const preview = $("scanPreview");
  if (preview && preview.src && preview.style.display !== "none") return preview;
  const video = $("scanVideo");
  if (video && video.videoWidth > 0) return video;
  return null;
}

async function runScan() {
  if (!state.scannerReady) {
    window.alert("Scanner catalog is not loaded on the server.");
    return;
  }
  const source = getActiveImageSource();
  if (!source) {
    window.alert("Start the camera or upload a photo first.");
    return;
  }
  setLoading("Analyzing card…");
  $("scanBtn").disabled = true;
  try {
    const embedding = await embeddingFromImageSource(source);
    const result = await matchEmbedding(embedding);
    if (!result.ok) throw new Error(result.error || "Match failed");
    state.matches = result.matches || [];
    state.selected = state.matches[0] || null;
    renderMatches();
    updateAddPanel();
  } catch (err) {
    window.alert(err.message || "Scan failed.");
  } finally {
    setLoading("");
    $("scanBtn").disabled = false;
  }
}

async function runTextSearch() {
  const input = $("scanTextSearch");
  const q = input ? String(input.value || "").trim() : "";
  if (!q) return;
  if (!state.scannerReady) {
    window.alert("Scanner catalog is not loaded on the server.");
    return;
  }
  setLoading("Searching…");
  try {
    const result = await matchText(q);
    state.matches = result.matches || [];
    state.selected = state.matches[0] || null;
    renderMatches();
    updateAddPanel();
  } catch {
    window.alert("Search failed.");
  } finally {
    setLoading("");
  }
}

async function startCamera() {
  stopCamera();
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: "environment" }, width: { ideal: 1280 }, height: { ideal: 960 } },
      audio: false
    });
    state.stream = stream;
    const video = $("scanVideo");
    const placeholder = $("scanPlaceholder");
    const preview = $("scanPreview");
    if (video) {
      video.srcObject = stream;
      video.style.display = "block";
      await video.play();
    }
    if (placeholder) placeholder.style.display = "none";
    if (preview) preview.style.display = "none";
    $("scanStopBtn").disabled = false;
    $("scanCaptureBtn").disabled = false;
  } catch {
    window.alert("Camera access was denied or is unavailable.");
  }
}

function stopCamera() {
  if (state.stream) {
    state.stream.getTracks().forEach((t) => t.stop());
    state.stream = null;
  }
  const video = $("scanVideo");
  if (video) {
    video.srcObject = null;
    video.style.display = "none";
  }
  $("scanStopBtn").disabled = true;
  $("scanCaptureBtn").disabled = !state.previewUrl;
}

function captureFrame() {
  const video = $("scanVideo");
  if (!video || !video.videoWidth) return;
  const canvas = document.createElement("canvas");
  canvas.width = video.videoWidth;
  canvas.height = video.videoHeight;
  const ctx = canvas.getContext("2d");
  ctx.drawImage(video, 0, 0);
  if (state.previewUrl) URL.revokeObjectURL(state.previewUrl);
  state.previewUrl = canvas.toDataURL("image/jpeg", 0.92);
  const preview = $("scanPreview");
  const placeholder = $("scanPlaceholder");
  if (preview) {
    preview.src = state.previewUrl;
    preview.style.display = "block";
  }
  if (video) video.style.display = "none";
  if (placeholder) placeholder.style.display = "none";
  $("scanCaptureBtn").disabled = false;
}

function onFileSelected(file) {
  if (!file || !file.type.startsWith("image/")) return;
  if (state.previewUrl && state.previewUrl.startsWith("blob:")) URL.revokeObjectURL(state.previewUrl);
  state.previewUrl = URL.createObjectURL(file);
  const preview = $("scanPreview");
  const video = $("scanVideo");
  const placeholder = $("scanPlaceholder");
  if (preview) {
    preview.src = state.previewUrl;
    preview.style.display = "block";
  }
  if (video) video.style.display = "none";
  if (placeholder) placeholder.style.display = "none";
  stopCamera();
}

async function addSelectedToCollection() {
  if (!state.selected) {
    window.alert("Select a match from the list first.");
    return;
  }
  if (window.InfinityAccount && !window.InfinityAccount.isSignedIn()) {
    window.InfinityAccount.openSignIn();
    return;
  }
  const qty = Math.max(1, Math.floor(Number($("scanQty")?.value || 1)));
  const card = state.selected;
  const body = {
    type: "single",
    name: card.name,
    setName: card.setName || card.setId || "",
    cardNumber: card.cardNumber,
    setCode: card.setCode || "",
    setLanguage: "english",
    imageUrl: card.imageUrl || "",
    quantity: qty,
    notes: card.id ? `Scan: ${card.id}` : ""
  };
  setLoading("Adding to collection…");
  try {
    const res = await fetch("/api/items", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    });
    const payload = res.ok ? await res.json().catch(() => ({})) : null;
    if (!res.ok) {
      window.alert(payload?.error || `Could not add card (${res.status})`);
      return;
    }
    if (payload?.merged) {
      const added = Math.max(1, Math.floor(Number(payload.quantityAdded) || qty));
      const total = Math.max(0, Math.floor(Number(payload.item?.quantity) || 0));
      window.alert(
        total
          ? `${card.name} already in collection — quantity +${added} (now ${total}).`
          : `${card.name} already in collection — quantity +${added}.`
      );
    } else {
      window.alert(`Added ${card.name} to your collection.`);
    }
    if ($("scanQty")) $("scanQty").value = "1";
  } catch {
    window.alert("Network error while adding the card.");
  } finally {
    setLoading("");
  }
}

function bindUi() {
  $("scanStartBtn")?.addEventListener("click", startCamera);
  $("scanStopBtn")?.addEventListener("click", stopCamera);
  $("scanCaptureBtn")?.addEventListener("click", captureFrame);
  $("scanBtn")?.addEventListener("click", runScan);
  $("scanTextSearchBtn")?.addEventListener("click", runTextSearch);
  $("scanTextSearch")?.addEventListener("keydown", (e) => {
    if (e.key === "Enter") runTextSearch();
  });
  $("scanAddBtn")?.addEventListener("click", addSelectedToCollection);
  $("scanFileInput")?.addEventListener("change", (e) => {
    const file = e.target.files && e.target.files[0];
    onFileSelected(file);
    e.target.value = "";
  });
  window.addEventListener("beforeunload", stopCamera);
}

async function initScanYourCards() {
  bindUi();
  await fetchScannerStatus();
  $("scanStopBtn").disabled = true;
  $("scanCaptureBtn").disabled = true;
}

initScanYourCards();
