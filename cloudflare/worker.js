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

function containerEnvFromBindings(bindings) {
  const out = {
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
 * Runs the Infinity Cards Node server (see Dockerfile).
 */
export class PokemonViewContainer extends Container {
  defaultPort = 8080;
  sleepAfter = "30m";
  // Prefer a real health path so port checks wait for the Node server.
  pingEndpoint = "localhost/api/health";

  constructor(ctx, env) {
    super(ctx, env);
    this.envVars = containerEnvFromBindings(env);
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
    const imageResponse = await tryServeCardImageFromR2(request, env);
    if (imageResponse) return imageResponse;

    const container = env.POKEMONVIEW.getByName("main");
    return container.fetch(request);
  }
};
