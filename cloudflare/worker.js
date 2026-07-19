import { Container } from "@cloudflare/containers";
import { tryServeCardImageFromR2 } from "./card-images-r2.js";
import {
  maybeRewriteHtmlNav,
  tryServeNavAssetOverride
} from "./frontend-overrides.js";

const SECRET_KEYS = [
  "GOOGLE_CLIENT_ID",
  "ADMIN_USERNAMES",
  "TCGPLAYER_PUBLIC_KEY",
  "TCGPLAYER_PRIVATE_KEY",
  "TCGPLAYER_API_VERSION",
  "POKEDATA_API_KEY",
  "PRICECHARTING_API_TOKEN",
  "PSA_ACCESS_TOKEN",
  "EBAY_APP_ID",
  "EBAY_CLIENT_ID",
  "EBAY_CLIENT_SECRET",
  "SMTP_HOST",
  "SMTP_PORT",
  "SMTP_SECURE",
  "SMTP_USER",
  "SMTP_PASS",
  "SMTP_FROM",
  "POWER_PACKS_COOKIE",
  "STORE_SYNC_SECRET"
];

/**
 * Env passed to container.start({ env }) can replace the image environment.
 * Always include PATH so `node` from CMD remains resolvable.
 */
function containerEnvFromBindings(bindings) {
  const out = {
    PATH: "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
    HOME: "/root",
    NODE_ENV: "production",
    PORT: "8080",
    DEFER_HEAVY_STARTUP: "1",
    SELF_HOSTED: "1",
    APP_PUBLIC_URL: bindings.APP_PUBLIC_URL || "https://pokemonview.com",
    DEFAULT_CURRENCY: bindings.DEFAULT_CURRENCY || "USD",
    DEFAULT_REGION: bindings.DEFAULT_REGION || "US"
  };
  for (const key of SECRET_KEYS) {
    const value = bindings[key];
    if (value != null && String(value).trim() !== "") {
      out[key] = String(value);
    }
  }
  return out;
}

/**
 * Runs the PokemonView Node server (see Dockerfile).
 */
export class PokemonViewContainer extends Container {
  defaultPort = 8080;
  sleepAfter = "30m";
  // Absolute paths — survives env replacement / non-/app cwd.
  entrypoint = ["/usr/local/bin/node", "/app/app.js"];
  enableInternet = true;

  constructor(ctx, env) {
    super(ctx, env);
    this.envVars = containerEnvFromBindings(env);
  }

  async fetch(request) {
    // Refresh env for the *next* cold start. Do not destroy() here — container
    // disk is ephemeral and destroy wipes store.json (accounts/collections).
    this.envVars = containerEnvFromBindings(this.env);

    // Cold start can exceed the inbound request abort window; do not cancel boot.
    try {
      await this.startAndWaitForPorts({
        ports: [this.defaultPort],
        cancellationOptions: {
          instanceGetTimeoutMS: 90_000,
          portReadyTimeoutMS: 120_000
        }
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error("[pokemonview] container start failed:", message);
      return new Response(`Failed to start container: ${message}`, {
        status: 503,
        headers: { "content-type": "text/plain; charset=utf-8" }
      });
    }
    return super.fetch(request);
  }

  onStart() {
    console.log("[pokemonview] container started");
  }

  onStop() {
    console.log("[pokemonview] container sleeping");
  }

  onError(error) {
    console.error("[pokemonview] container error:", error);
  }
}

const STORE_R2_KEY = "app-data/store.json";
const STORE_SYNC_PATH = "/api/internal/r2-store";
const DATA_SYNC_PATH = "/api/internal/r2-data";
const ALLOWED_APP_DATA_FILES = new Set([
  "tcg-link-prices-cache.json",
  "pricecharting-card-details-cache.json",
  "tcg-link-price-fail-links.json",
  "pricecharting-card-details-fail-links.json"
]);

async function handleDurableStoreRequest(request, env) {
  const url = new URL(request.url);
  if (url.pathname !== STORE_SYNC_PATH) return null;

  const expected = String(env.STORE_SYNC_SECRET || "").trim();
  const got = String(request.headers.get("x-store-sync-secret") || "").trim();
  if (!expected || got !== expected) {
    return new Response(JSON.stringify({ ok: false, error: "Unauthorized" }), {
      status: 401,
      headers: { "content-type": "application/json; charset=utf-8" }
    });
  }

  const bucket = env.CARD_IMAGES;
  if (!bucket) {
    return new Response(JSON.stringify({ ok: false, error: "R2 binding missing" }), {
      status: 503,
      headers: { "content-type": "application/json; charset=utf-8" }
    });
  }

  if (request.method === "GET") {
    const object = await bucket.get(STORE_R2_KEY);
    if (!object) {
      return new Response(JSON.stringify({ ok: false, error: "not_found" }), {
        status: 404,
        headers: { "content-type": "application/json; charset=utf-8" }
      });
    }
    const headers = new Headers();
    headers.set("content-type", "application/json; charset=utf-8");
    headers.set("cache-control", "no-store");
    return new Response(object.body, { status: 200, headers });
  }

  if (request.method === "PUT") {
    const body = await request.arrayBuffer();
    if (!body || body.byteLength < 2) {
      return new Response(JSON.stringify({ ok: false, error: "Empty body" }), {
        status: 400,
        headers: { "content-type": "application/json; charset=utf-8" }
      });
    }

    let incomingUsers = 0;
    try {
      const parsed = JSON.parse(new TextDecoder().decode(body));
      incomingUsers = Array.isArray(parsed?.users) ? parsed.users.length : 0;
    } catch {
      return new Response(JSON.stringify({ ok: false, error: "Invalid JSON" }), {
        status: 400,
        headers: { "content-type": "application/json; charset=utf-8" }
      });
    }

    // Guard: never let an empty boot wipe durable accounts in R2.
    if (incomingUsers === 0) {
      const existing = await bucket.get(STORE_R2_KEY);
      if (existing) {
        try {
          const prev = JSON.parse(await existing.text());
          const prevUsers = Array.isArray(prev?.users) ? prev.users.length : 0;
          if (prevUsers > 0) {
            return new Response(
              JSON.stringify({ ok: false, error: "refusing_empty_overwrite", prevUsers }),
              {
                status: 409,
                headers: { "content-type": "application/json; charset=utf-8" }
              }
            );
          }
        } catch {
          /* if existing is corrupt, allow replace */
        }
      }
    }

    await bucket.put(STORE_R2_KEY, body, {
      httpMetadata: { contentType: "application/json; charset=utf-8" }
    });
    return new Response(JSON.stringify({ ok: true, bytes: body.byteLength, users: incomingUsers }), {
      status: 200,
      headers: { "content-type": "application/json; charset=utf-8" }
    });
  }

  return new Response(JSON.stringify({ ok: false, error: "Method not allowed" }), {
    status: 405,
    headers: { "content-type": "application/json; charset=utf-8" }
  });
}

async function handleDurableAppDataRequest(request, env) {
  const url = new URL(request.url);
  if (url.pathname !== DATA_SYNC_PATH) return null;

  const expected = String(env.STORE_SYNC_SECRET || "").trim();
  const got = String(request.headers.get("x-store-sync-secret") || "").trim();
  if (!expected || got !== expected) {
    return new Response(JSON.stringify({ ok: false, error: "Unauthorized" }), {
      status: 401,
      headers: { "content-type": "application/json; charset=utf-8" }
    });
  }

  const file = String(url.searchParams.get("file") || "").trim();
  if (!ALLOWED_APP_DATA_FILES.has(file)) {
    return new Response(JSON.stringify({ ok: false, error: "Unsupported file" }), {
      status: 400,
      headers: { "content-type": "application/json; charset=utf-8" }
    });
  }

  const bucket = env.CARD_IMAGES;
  if (!bucket) {
    return new Response(JSON.stringify({ ok: false, error: "R2 binding missing" }), {
      status: 503,
      headers: { "content-type": "application/json; charset=utf-8" }
    });
  }

  const r2Key = `app-data/${file}`;

  if (request.method === "GET") {
    const object = await bucket.get(r2Key);
    if (!object) {
      return new Response(JSON.stringify({ ok: false, error: "not_found" }), {
        status: 404,
        headers: { "content-type": "application/json; charset=utf-8" }
      });
    }
    const headers = new Headers();
    headers.set(
      "content-type",
      object.httpMetadata?.contentType || "application/json; charset=utf-8"
    );
    headers.set("cache-control", "no-store");
    const encoding = String(object.httpMetadata?.contentEncoding || "").trim();
    if (encoding) headers.set("content-encoding", encoding);
    return new Response(object.body, { status: 200, headers });
  }

  if (request.method === "PUT") {
    const body = await request.arrayBuffer();
    if (!body || body.byteLength < 2) {
      return new Response(JSON.stringify({ ok: false, error: "Empty body" }), {
        status: 400,
        headers: { "content-type": "application/json; charset=utf-8" }
      });
    }
    const contentEncoding = String(request.headers.get("content-encoding") || "")
      .trim()
      .toLowerCase();
    const httpMetadata = {
      contentType: "application/json; charset=utf-8"
    };
    if (contentEncoding.includes("gzip")) {
      httpMetadata.contentEncoding = "gzip";
    }
    await bucket.put(r2Key, body, { httpMetadata });
    return new Response(
      JSON.stringify({
        ok: true,
        bytes: body.byteLength,
        file,
        gzip: Boolean(httpMetadata.contentEncoding)
      }),
      {
        status: 200,
        headers: { "content-type": "application/json; charset=utf-8" }
      }
    );
  }

  return new Response(JSON.stringify({ ok: false, error: "Method not allowed" }), {
    status: 405,
    headers: { "content-type": "application/json; charset=utf-8" }
  });
}

/**
 * Older container images omit user.preferences on /api/auth/me while /api/dashboard
 * already exposes them. Fill prefs from durable R2 so Settings switches match Home.
 */
async function enrichAuthMePreferences(request, response, env) {
  const url = new URL(request.url);
  if (url.pathname !== "/api/auth/me" || request.method !== "GET") return response;
  if (!response.ok) return response;
  const contentType = response.headers.get("content-type") || "";
  if (!contentType.includes("application/json")) return response;

  let payload;
  try {
    payload = await response.json();
  } catch {
    return response;
  }

  if (!payload?.signedIn || !payload?.user?.id) {
    return Response.json(payload, {
      status: response.status,
      headers: { "cache-control": "no-store" }
    });
  }

  if (payload.user.preferences && typeof payload.user.preferences === "object") {
    return Response.json(payload, {
      status: response.status,
      headers: { "cache-control": "no-store" }
    });
  }

  try {
    const bucket = env.CARD_IMAGES;
    if (!bucket) {
      payload.user.preferences = { showCostBasis: false, showUnrealizedPnL: false };
      return Response.json(payload, {
        status: response.status,
        headers: { "cache-control": "no-store" }
      });
    }
    const object = await bucket.get(STORE_R2_KEY);
    if (!object) {
      payload.user.preferences = { showCostBasis: false, showUnrealizedPnL: false };
      return Response.json(payload, {
        status: response.status,
        headers: { "cache-control": "no-store" }
      });
    }
    const store = JSON.parse(await object.text());
    const users = Array.isArray(store?.users) ? store.users : [];
    const row = users.find((entry) => entry && entry.id === payload.user.id);
    const raw = row?.preferences && typeof row.preferences === "object" ? row.preferences : {};
    payload.user.preferences = {
      showCostBasis: raw.showCostBasis === true,
      showUnrealizedPnL: raw.showUnrealizedPnL === true
    };
  } catch (err) {
    console.warn("[pokemonview] enrich /api/auth/me preferences failed:", err?.message || err);
    payload.user.preferences = { showCostBasis: false, showUnrealizedPnL: false };
  }

  return Response.json(payload, {
    status: response.status,
    headers: { "cache-control": "no-store" }
  });
}

export default {
  async fetch(request, env) {
    // Durable account store — handled at the Worker (no container), so boot can restore without deadlock.
    const storeResponse = await handleDurableStoreRequest(request, env);
    if (storeResponse) return storeResponse;

    const dataResponse = await handleDurableAppDataRequest(request, env);
    if (dataResponse) return dataResponse;

    // Card / symbol / set art is served from the R2 binding at the edge.
    // No public R2 S3 API URL is required for the site.
    const imageResponse = await tryServeCardImageFromR2(request, env);
    if (imageResponse) return imageResponse;

    // Shared nav CSS/JS — serve from Worker so Sign In/search layout is not stuck on a stale image.
    const navAsset = tryServeNavAssetOverride(request);
    if (navAsset) return navAsset;

    // Fresh DO so the container boots with current secrets + latest image after CI rebuild.
    const container = env.POKEMONVIEW.getByName("main-v16");
    const response = await enrichAuthMePreferences(
      request,
      await container.fetch(request),
      env
    );
    return maybeRewriteHtmlNav(request, response);
  }
};
