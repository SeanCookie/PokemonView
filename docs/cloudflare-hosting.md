# Host Infinity Cards on Cloudflare

Infinity Cards is a **Node.js server** with on-disk data (`backend/data/store.json`, set catalogs, pokesymbols, etc.). That does **not** run on Cloudflare Pages or a plain Worker alone.

Use **Cloudflare Containers**: a Docker image of this app, fronted by a small Worker that routes traffic to it. Your domain stays on Cloudflare (DNS + SSL) like before.

Official overview: [Cloudflare Containers](https://developers.cloudflare.com/containers/get-started/)

---

## What you need

1. **Cloudflare account** with the domain (e.g. `pokemonview.com`) on Cloudflare DNS  
2. **Docker Desktop** running on your PC (required for `wrangler deploy` to build the image)  
3. **Node.js 18+** and npm  
4. **Wrangler CLI** (`npm install` in this repo installs it)

---

## 1. Install dependencies

```bash
npm install
```

---

## 2. Log in to Cloudflare

```bash
npx wrangler login
```

---

## 3. Set production secrets

Copy `backend/.env.cloudflare.example` as a checklist. For each secret:

```bash
npx wrangler secret put GOOGLE_CLIENT_ID
npx wrangler secret put ADMIN_USERNAMES
# …repeat for API keys you use in production
```

Non-secret values (`APP_PUBLIC_URL`, currency, region) are already in `wrangler.toml` `[vars]`.

---

## 4. Deploy

### Option A — Cloudflare Git builds (dashboard)

In **Workers & Pages → your project → Settings → Build**:

| Setting | Value |
|---------|--------|
| Root directory | *(leave empty — repo root)* |
| Build command | `npm run build` |
| Deploy command | `npm run deploy:cloudflare` |

**How to read the logs:** A successful deploy always includes a second block after build:

```
Executing user deploy command: npm run deploy:cloudflare
...
Uploaded pokemonview
Building image pokemonview-pokemonviewcontainer:...
```

If your log **stops** at `Success: Build command completed` with no `Executing user deploy command` line, the **Deploy command is empty or wrong** in Settings → Build. The build step only prunes files and prints `build ok` — it does not publish the site.

**Alternative (one command):** If the Deploy command field is missing or ignored, set **Build command** to `npm run cf:ci` and leave Deploy empty. That runs build + deploy together.

**Important:** Use `npm run deploy:cloudflare`, not `npx wrangler deploy` alone. The npm script prunes Git LFS card images before Docker builds the image.

The Worker name in the dashboard **must match** `name = "pokemonview"` in `wrangler.toml`.

`wrangler.toml` must be committed to Git (without it, deploy fails with “Could not detect static files”).

**Card images (~3 GB)** are **not** baked into the Docker image — Cloudflare’s build runners run out of disk above ~3 GB. They are served from **R2** at the edge (`CARD_IMAGES` → `pokemonview-card-images`). **Pokesymbols and set cover art** can also be served from the same R2 bucket for faster edge caching. See **Upload assets to R2** below.

Production runs with **`SELF_HOSTED=1`**: no runtime requests to pkmncards.com or pokesymbols.com CDN.

### Upload assets to R2

One-time from your PC (after `git lfs pull` for card art):

```bash
npx wrangler login
git lfs pull
npx wrangler r2 bucket create pokemonview-card-images
node scripts/upload-static-assets-to-r2.js
node scripts/upload-card-images-to-r2.js
```

Or: `npm run upload:r2` (runs both uploads). On Windows if PowerShell blocks npm: use `node scripts/...` as above.

**Static assets** (~600 PNGs): pokesymbols + set cover logos upload to keys like `pokesymbols/symbols/scarlet-and-violet.png` and `set-images/BS/cover.png`. The Worker serves `/pokesymbols/*` and `/set-images/*` from R2 before hitting the container.

Git LFS materializes card images when Cloudflare clones the repo; `npm run build` **deletes** those folders before the Docker image is built (they are served from R2 instead).

Upload one card set only: `node scripts/upload-card-images-to-r2.js -- --set SVI`. Git LFS remains the source of truth; R2 is the production copy.

### Option B — Deploy from your PC

Make sure **Docker Desktop** is running, then:

```bash
npm install
npm run deploy:cloudflare
```

Or:

```bash
npx wrangler deploy --config wrangler.toml
```

First deploy builds the image, pushes it to Cloudflare’s registry, and provisions the Worker + Container. **Allow 3–5 minutes** after the first deploy before the container is ready.

Check status:

```bash
npx wrangler containers list
```

---

## 5. Attach your domain

In the [Cloudflare dashboard](https://dash.cloudflare.com):

1. **Workers & Pages** → **pokemonview** → **Settings** → **Domains & routes**
2. **Add custom domain** → `pokemonview.com` (and `www` if you use it)

If the zone is already on Cloudflare, DNS is configured automatically.

Alternatively, uncomment the `[[routes]]` blocks in `wrangler.toml` and redeploy.

---

## 6. Google OAuth

In [Google Cloud Console](https://console.cloud.google.com/) → OAuth client:

- **Authorized JavaScript origins:** `https://pokemonview.com`
- Remove old GoDaddy URLs if you no longer use them

---

## 7. GoDaddy cleanup

- Point nameservers to Cloudflare (if not already)
- Cancel or stop the old GoDaddy Node/cPanel app so it does not conflict
- Remove any GoDaddy-specific env vars; production config is now Wrangler secrets + `wrangler.toml`

---

## Local Docker test (optional)

```bash
docker build --platform linux/amd64 -t pokemonview .
docker run --rm -p 8080:8080 -e APP_PUBLIC_URL=http://localhost:8080 pokemonview
```

Open http://localhost:8080

---

## Important: user data persistence

Container **disk is ephemeral**. While the container is running, `backend/data/store.json` (accounts, collection, etc.) behaves normally. If the container is replaced or evicted after sleeping, **runtime writes may be lost** unless you add external persistence (e.g. R2 backup — not set up yet).

For now:

- `max_instances = 1` and a single named container (`main`) keep one consistent disk while it is awake
- `sleepAfter = "30m"` reduces cold starts

If you need durable user data on Cloudflare long term, plan a follow-up to sync `store.json` (and uploads) to **R2** or move auth/data to **D1**.

---

## Troubleshooting

### `Unauthorized` after Docker image builds (your current error)

The Worker uploads and the Docker image **build succeeds**, then push to Cloudflare’s container registry fails with:

```
✘ [ERROR] Unauthorized
```

This is almost always one of two things:

#### 1. Workers Paid plan required

**Containers only work on the [Workers Paid plan](https://developers.cloudflare.com/containers/)** ($5/month). On the Free plan, registry push fails with a vague `Unauthorized` even when everything else is correct.

1. Open [Workers Plans](https://dash.cloudflare.com/?to=/:account/workers/plans)
2. Upgrade to **Workers Paid**
3. Retry the build

#### 2. Build API token missing Containers permission

Workers Builds uses an API token. The auto-generated one may **not** include Containers.

1. **Workers & Pages** → **pokemonview** → **Settings** → **Build**
2. Under **API token**, choose **Create new token** (or add a custom token)
3. Permissions must include at minimum:
   - **Account** → **Workers Scripts** → **Edit**
   - **Account** → **Containers** → **Edit**
   - **Account** → **R2 Storage** → **Edit** (container images use the registry)
   - **Account** → **Account Settings** → **Read**
4. Save and **retry the build**

Stale tokens: if a token was rotated or deleted, create a new one and re-select it in Build settings.

#### Deploy from your PC instead (after Paid plan)

```bash
npx wrangler login
npm run deploy:cloudflare
```

---

| Symptom | Fix |
|--------|-----|
| `Could not detect static files` | Commit `wrangler.toml` to Git; root directory = repo root |
| `Unauthorized` after image build | Workers Paid plan + Containers API token (above) |
| `no space left on device` during Docker build | Set deploy command to `npm run deploy:cloudflare` (not `npx wrangler deploy`); Dockerfile must not `COPY` card-images |
| Build OK but dashboard says failed / site 503 | Deploy command missing — logs must show `Executing user deploy command`. Use `npm run deploy:cloudflare` or build with `npm run cf:ci` |
| `Cannot connect to Docker daemon` | Start Docker Desktop (local deploy only) |
| 502 / container errors right after deploy | Wait a few minutes; check `wrangler containers list` |
| Login cookies not sticking | Ensure `APP_PUBLIC_URL` is `https://pokemonview.com` in `wrangler.toml` |
| Build fails on Apple Silicon | Wrangler builds `linux/amd64` automatically; keep Docker updated |

---

## Files added for Cloudflare

| File | Purpose |
|------|---------|
| `Dockerfile` | Production Node image |
| `wrangler.toml` | Worker + Container config |
| `cloudflare/worker.js` | Routes requests to the container |
| `.dockerignore` | Keeps image smaller |
| `backend/.env.cloudflare.example` | Secret checklist |
