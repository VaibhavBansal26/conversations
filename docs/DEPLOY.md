# Deploying Conversations for free

Free path: **Render** (a free web service built from the Dockerfile, plus a free Postgres database), connected to this GitHub repo so every push to `main` redeploys. Nothing here deploys by itself: the files are inert until you connect a host.

## 1. Connect GitHub and deploy (about 5 minutes)
1. Sign up at render.com with your GitHub account and authorise the Render GitHub app for this repo.
2. **New > Blueprint**, pick this repo. Render reads [`render.yaml`](../render.yaml), creates the `conversations` web service and `conversations-db` Postgres, generates `JWT_SECRET`, and wires `DATABASE_URL`.
3. When it asks for the `sync: false` values, leave them blank for now. The first build takes several minutes.
4. Copy the service address (`https://conversations-xxxx.onrender.com`). In the service's **Environment** tab set `PUBLIC_URL` to it and `CORS_ORIGINS` to the same value, then redeploy.
5. Open the address, register, and you are in. Platform operators are created only with the CLI (`npm run admin`). Render's free plan has no shell, so run it on your own machine against the database's *external* connection string: `DATABASE_URL=<external url> npm run admin --prefix server`.
6. Optional checks: add the repo variable `APP_URL` and run **Actions > deploy-check** to confirm `/healthz` and `/readyz` (it waits for a sleeping instance to wake).

## 2. What the free tier is, and is not
Check Render's current terms; at the time of writing:
- The web service sleeps after about 15 minutes idle and takes about a minute to wake; WebSocket connections drop when it sleeps and clients reconnect.
- Free Postgres is time-limited (about 30 days, then it is deleted unless you upgrade) and small. For a longer-lived free database, create one on Neon or Supabase and paste its `postgres://...?sslmode=require` URL into `DATABASE_URL`.
- 512 MB RAM and shared CPU: fine for testing and demos, not for load. Use [SCALING.md](SCALING.md) and [CLOUD-LOADTEST.md](CLOUD-LOADTEST.md) for production sizing.
- No Redis is needed for one instance. With more than one instance set `REDIS_URL` (Render Key Value or Upstash) so rate limits, presence and queues are shared.

## 3. Free address and your own domain
You get `https://conversations-xxxx.onrender.com` for free, with TLS. A custom domain costs money (a `.com` is roughly $10 a year; Cloudflare Registrar sells at cost). Free subdomain programmes exist (for example `is-a.dev`), but they require a request to a third party, so check their rules before relying on one. To use your own domain: Render service > **Settings > Custom Domains**, add the CNAME it shows, then update `PUBLIC_URL`.
If Cloudflare proxies the domain, set `TRUSTED_PROXY_HOPS=2` and read [CLOUDFLARE.md](CLOUDFLARE.md) first (real client IPs are only trusted from Cloudflare when configured).

## 4. Secrets
Never commit keys. Add them in the Render **Environment** tab (or as GitHub Actions secrets for workflows). Stripe, SMS and email keys are optional and listed in [CONFIGURATION.md](CONFIGURATION.md); use **test-mode** keys until you have verified the flows.
