import { Container } from "@cloudflare/containers";
import { tryServeCardImageFromR2 } from "./card-images-r2.js";

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
  "POWER_PACKS_COOKIE"
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
    // Apply latest Worker secrets/vars. Destroy+restart when they change —
    // stop() alone can leave a running Node process with stale process.env.
    const nextEnv = containerEnvFromBindings(this.env);
    const secretFingerprint =
      "rev3|" + SECRET_KEYS.map((k) => `${k}=${nextEnv[k] || ""}`).join("|");
    if (this._appliedSecretFingerprint !== secretFingerprint) {
      try {
        await this.destroy();
      } catch {
        /* may already be gone */
      }
      this._appliedSecretFingerprint = secretFingerprint;
    }
    this.envVars = nextEnv;

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

export default {
  async fetch(request, env) {
    // Card / symbol / set art is served from the R2 binding at the edge.
    // No public R2 S3 API URL is required for the site.
    const imageResponse = await tryServeCardImageFromR2(request, env);
    if (imageResponse) return imageResponse;

    const container = env.POKEMONVIEW.getByName("main-v7");
    return container.fetch(request);
  }
};
