# MyNews PWA

A mobile-first news-monitoring PWA scaffold using React + TypeScript, Cloudflare Workers, D1, and NewsData.io. The initial administrator username is `admin`; the initial password is chosen during a one-time bootstrap flow and is never stored in source code.

## Current implementation status

Included in this scaffold:
- PWA manifest and service-worker generation for app-shell caching.
- Cloudflare Worker API with password hashing (PBKDF2-HMAC-SHA-256), hashed opaque session tokens, HttpOnly/Secure/SameSite cookies, and basic origin checks.
- One-time admin bootstrap guarded by a `BOOTSTRAP_TOKEN` secret and an empty-user check.
- Admin-only user listing, creation, username/role/status updates, password reset, and deletion safeguards.
- D1 schema for users, sessions, queries, article metadata, folders, bookmarks/state, notes, preferences, usage, and query/article associations.
- Manual NewsData.io Latest API request proxy, a daily application credit cap, basic query builder, and initial dashboard/settings screens.
- Folder chooser and API route for filing an article.

Not yet complete / must be tested before real use:
- The remaining reading-library UX (folder contents, complete notes editor, export formats).
- Full offline read/write sync and robust conflict resolution; current PWA service worker caches the app shell, not a complete offline data layer.
- Full query-builder validation for every NewsData.io plan/parameter combination and complete filtering settings UI.
- Robust request throttling by IP/user, audit log, password reset UX, account recovery, and security review.
- Automated tests and a production build verification in your environment.
- NewsData.io terms/plan confirmation for multi-user use.

Treat this as an implementation starter, not production-audited software.

## Prerequisites

- Node.js 20+ and npm
- A Cloudflare account with Workers and D1 enabled
- A NewsData.io API key on a plan that permits your intended usage
- Wrangler CLI (installed through this project's dev dependencies)

## 1. Install dependencies

```bash
npm install
```

## 2. Create the D1 database

```bash
npx wrangler d1 create mynews-db
```

Copy the returned database ID into `wrangler.toml`, replacing `REPLACE_WITH_YOUR_D1_DATABASE_ID`.

Apply migrations locally and remotely:

```bash
npx wrangler d1 migrations apply mynews-db --local
npx wrangler d1 migrations apply mynews-db --remote
```

Do not run the remote migration command until you have reviewed the database name and ID in `wrangler.toml`.

## 3. Configure secrets

Generate a long random bootstrap token on your own computer:

```bash
openssl rand -hex 32
```

Set the token as a Worker secret. Paste the generated token when Wrangler prompts you; do not commit it or send it in chat.

```bash
npx wrangler secret put BOOTSTRAP_TOKEN
npx wrangler secret put NEWSDATA_API_KEY
```

`BOOTSTRAP_TOKEN` is only for the one-time setup endpoint. `NEWSDATA_API_KEY` stays on the server and is never included in frontend code.

## 4. Set the application origin and budget

After you choose your deployment URL, set `APP_ORIGIN` to that exact origin. For a temporary workers.dev deployment, deploy first, note the URL, then set the variable and redeploy. Keep `DAILY_CREDIT_CAP` at `160` initially, so the application stops before the assumed 200-credit free daily allowance is exhausted. Confirm the actual quota in your NewsData.io dashboard because plans can change.

## 5. Deploy

```bash
npm run deploy
```

Open the deployed URL. The first visit should show the one-time admin setup screen. Enter:
- Bootstrap token: the random token you generated and set as `BOOTSTRAP_TOKEN`.
- Password: choose a strong password of at least 14 characters.
- Confirm password: repeat it.

The username is fixed to `admin` for this first account. Once setup succeeds, immediately remove the bootstrap secret:

```bash
npx wrangler secret delete BOOTSTRAP_TOKEN
```

The API also rejects bootstrap after any user exists. If you remove the secret before setup succeeds, set a new token secret and retry.

## Local development notes

The frontend dev server proxies `/api` to `http://127.0.0.1:8787`. Start a local Worker separately using Wrangler in another terminal, after setting up a local D1 database and a `.dev.vars` file based on `.dev.vars.example`:

```bash
cp .dev.vars.example .dev.vars
# Edit .dev.vars locally; never commit it.
npx wrangler dev --port 8787
```

In a second terminal:

```bash
npm run dev
```

The Worker cookie is `Secure`, which is correct for HTTPS deployment. Some local HTTP browser setups may not send a Secure cookie; prefer testing auth through Wrangler's HTTPS URL or adapt local-only cookie handling carefully without weakening production settings.

## Security notes

- Never put the NewsData.io key in `VITE_*` variables or browser code.
- Never commit `.dev.vars`, real tokens, passwords, or production database credentials.
- Bootstrap should be performed over HTTPS. Remove the bootstrap secret immediately after use.
- Back up D1 before applying future destructive migrations.
- Add Cloudflare rate limiting/WAF rules before inviting more users.
- Multi-user redistribution of provider news data must comply with NewsData.io terms and your plan.
- This scaffold has not received a professional security audit; test thoroughly before exposing it publicly.
