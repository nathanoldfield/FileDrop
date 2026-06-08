# FileDrop — Deployment Guide

Everything you need to get FileDrop running on Cloudflare's free tier.

---

## What you'll need

- A **Cloudflare account** (free) — [dash.cloudflare.com](https://dash.cloudflare.com)
- **Node.js** installed locally (any recent LTS version) — only needed to run `wrangler`
- **~20 minutes**

> A custom domain is **optional**. FileDrop works out of the box on the free
> `*.workers.dev` URL. If you do want a custom domain, you'll need it added to Cloudflare
> DNS — see the note in Step 5b.

---

## Step 1 — Install Wrangler

```bash
npm install -g wrangler
```

Authenticate with your Cloudflare account:

```bash
wrangler login
```

This opens a browser window. Log in and grant access. When you see "Successfully logged in" in the terminal, continue.

---

## Step 2 — Create the R2 bucket

```bash
wrangler r2 bucket create filedrop-files
```

You should see: `Created bucket 'filedrop-files'`

---

## Step 3 — Create the KV namespace

```bash
wrangler kv namespace create FILEDROP_KV
```

The output will look like this:

```
Add the following to your configuration file in your kv_namespaces array:
{ binding = "FILEDROP_KV", id = "abc123def456..." }
```

**Copy that `id` value.** Open `wrangler.toml` and replace `REPLACE_WITH_YOUR_KV_NAMESPACE_ID` with it:

```toml
[[kv_namespaces]]
binding = "FILEDROP_KV"
id = "abc123def456..."   # ← paste your actual ID here
```

---

## Step 4 — Deploy the Worker

```bash
wrangler deploy
```

Expected output:
```
Uploaded filedrop (X.XX sec)
Published filedrop (X.XX sec)
  https://filedrop.YOUR-SUBDOMAIN.workers.dev
```

Your app is now live at that URL. **But do not share it yet** — set up Access first (next step) or it's publicly accessible to anyone.

---

## Step 5 — Set up Cloudflare Access (email OTP gate)

This is the authentication layer. It sits in front of your Worker and handles the email OTP login. Only email addresses you whitelist can reach the dashboard and generate links.

### 5a. Open Zero Trust dashboard

Go to [one.dash.cloudflare.com](https://one.dash.cloudflare.com) → your account → **Zero Trust**.

If this is your first time, you'll be asked to choose a team name (e.g. `mycompany` or anything you like). This becomes part of the login portal URL.

### 5b. Create a new Access Application

Navigate to: **Access → Applications → Add an application**

Select **"Self-hosted"**.

Fill in:

| Field | Value |
|---|---|
| **Application name** | `FileDrop` |
| **Session duration** | `24 hours` (or your preference) |
| **Application domain** | Your Worker URL, e.g. `filedrop.yourname.workers.dev` |

> **Using a custom domain?** Set the Application domain to `filedrop.yourdomain.com`,
> uncomment the `routes` block in `wrangler.toml` (and set `workers_dev = false` if you
> want to disable the workers.dev URL), then add a DNS CNAME record:
> `filedrop` → `filedrop.yourname.workers.dev` in your Cloudflare DNS settings.

Click **Next**.

### 5c. Add an Allow Policy for authenticated users

Click **Add a policy**.

| Field | Value |
|---|---|
| **Policy name** | `Allowed Users` |
| **Action** | `Allow` |

Under **Configure rules**, add a rule:

| Selector | Value |
|---|---|
| `Emails` | `alice@example.com, bob@example.com` (one per line — your user list) |

Click **Save policy**, then **Save application**.

### 5d. Add Bypass Policies for public paths ⚠️ Required

> **This step is critical.** Without it, recipients who open a transfer link will hit the Access login wall and cannot upload or download files — even though the link is meant to be public.

Cloudflare Access intercepts all requests at the network edge, before the Worker runs. The three public endpoints must be explicitly bypassed so unauthenticated recipients can use them.

Still in **Access → Applications → FileDrop → Edit**, go to the **Policies** tab and add **three separate Bypass policies** — one for each public path:

**Policy 1 — Transfer page**

| Field | Value |
|---|---|
| **Policy name** | `Public — Transfer page` |
| **Action** | `Bypass` |
| **Path** | `/t/*` |

Under **Configure rules**: Selector = `Everyone`

**Policy 2 — File upload**

| Field | Value |
|---|---|
| **Policy name** | `Public — Upload` |
| **Action** | `Bypass` |
| **Path** | `/upload/*` |

Under **Configure rules**: Selector = `Everyone`

**Policy 3 — File download**

| Field | Value |
|---|---|
| **Policy name** | `Public — Download` |
| **Action** | `Bypass` |
| **Path** | `/download/*` |

Under **Configure rules**: Selector = `Everyone`

Save each policy. Your policy list should now show the Bypass policies above the Allow policy.

> **Important:** Do **not** add a bypass for `/` or `/deactivate/*`. Those remain protected — only logged-in users can access the dashboard and deactivate links.

### 5e. Verify it works

Visit your Worker URL in a fresh private/incognito browser window. You should see the Cloudflare Access login page — **not** your FileDrop app directly.

Enter one of the allowed email addresses. Check the inbox for a 6-digit code. Enter it. You should land on the FileDrop dashboard.

---

## Step 6 — Test the full flow

1. **Log in** at your Worker URL with an allowed email address
2. Click **"Generate Link"** — a transfer link appears and can be copied to your clipboard
3. **Open the link** in a different browser or machine (no login needed — the bypass policies handle this)
4. **Drop a file** onto the upload zone and click "Upload Files" — a per-file progress indicator is shown
5. Go back to the dashboard — the file count on the link card should update
6. Open the transfer link again — the file should appear with a download button
7. Click **↓** to download it
8. Back on the dashboard, click **"Deactivate"** to kill the link early — files are removed by the hourly cleanup cron

---

## Managing users

To **add or remove users**, go to:

**Zero Trust → Access → Applications → FileDrop → Edit → Policies → Allowed Users → Edit**

Update the email list and save. Changes take effect immediately — no redeployment needed.

---

## Managing files & links (emergency / admin)

You don't need a separate admin panel. Use the Cloudflare dashboards directly:

| Task | Where |
|---|---|
| Browse or delete stored files | Cloudflare Dashboard → R2 → `filedrop-files` → Browse |
| Inspect or delete link metadata | Cloudflare Dashboard → Workers & Pages → KV → `FILEDROP_KV` → View |
| View Worker errors in real time | Workers & Pages → `filedrop` → Logs → Begin log stream |
| View Access login history | Zero Trust → Access → Logs |

---

## Route reference

| Method | Path | Auth | Description |
|---|---|---|---|
| `GET` | `/` | Required | Dashboard |
| `POST` | `/generate` | Required | Create a new transfer link |
| `POST` | `/deactivate/:token` | Required | Deactivate a link (owner only) |
| `GET` | `/t/:token` | Bypassed | Transfer page (public) |
| `POST` | `/upload/:token` | Bypassed | Upload a file to a link (public) |
| `GET` | `/download/:token/:filename` | Bypassed | Download a file (public) |

Files are uploaded one at a time as a raw binary stream — no multipart encoding. This allows the Worker to pipe bytes directly to R2 without buffering the entire file in memory.

Deactivated links have their R2 files removed by the **hourly cleanup cron**. Files from expired links are also removed at that time.

---

## Updating the Worker

After any code change to `worker.js` or `wrangler.toml`:

```bash
wrangler deploy
```

That's it — zero downtime.

---

## Local development (optional)

To run FileDrop locally before deploying:

```bash
wrangler dev
```

This starts a local server at `http://localhost:8787`.

> **Note:** Cloudflare Access does **not** run locally. The Worker checks for the `Cf-Access-Authenticated-User-Email` header — which won't be present in local dev. To test locally, temporarily uncomment the fallback line in `worker.js`:
>
> ```js
> // Find this line in handleRequest():
> const userEmail = request.headers.get("Cf-Access-Authenticated-User-Email") || "dev@localhost";
> ```
>
> **Remember to remove the fallback before deploying to production.**

---

## Troubleshooting

**Transfer link asks recipients to log in**
→ The Cloudflare Access bypass policies for `/t/*`, `/upload/*`, and `/download/*` are missing or not saved. See Step 5d. All three paths need a Bypass policy with action = Everyone.

**Upload fails with "Network error" immediately**
→ The `/upload/*` bypass policy is missing. Cloudflare Access is intercepting the upload request before it reaches the Worker. Add the bypass policy as described in Step 5d.

**Deactivate button fails with 401**
→ A bypass policy is incorrectly covering `/t/*` for all HTTP methods and stripping the auth header from the deactivate request. The deactivate endpoint is `POST /deactivate/:token` — ensure your bypass policy is scoped to `/t/*` (GET only, not all methods). The Worker routes deactivation through `/deactivate/` specifically to avoid this conflict.

**"Unauthorized — Cloudflare Access required" when visiting the app**
→ Cloudflare Access is not in front of the Worker. Check the Access application domain matches your Worker URL exactly.

**Upload fails with "Link has expired" immediately after generating**
→ Check that your KV namespace ID in `wrangler.toml` is correct and the namespace exists (`wrangler kv namespace list`).

**Files don't appear after upload**
→ KV has eventual consistency — wait a few seconds and refresh the transfer page.

**"Internal server error" on any request**
→ Check Worker logs: `wrangler tail` in your terminal while reproducing the error. This streams live logs.

**Files still visible in R2 after deactivating a link**
→ Expected behaviour. R2 cleanup runs on the hourly cron — files will be deleted within the hour. The link itself is immediately deactivated so recipients can no longer access it.

**Access login emails going to spam**
→ The OTP email comes from Cloudflare's own sending infrastructure. Check spam/junk and mark as not spam. Nothing to configure on your end.

**Want to change the 4-hour link expiry?**
→ Edit `LINK_TTL_SECONDS` in `worker.js` then `wrangler deploy`.

---

## Free tier limits — at a glance

| Limit | Free allowance | Expected usage |
|---|---|---|
| Workers requests | 100,000 / day | < 50 per transfer session |
| R2 storage | 10 GB (turns over every 4h) | Depends on file sizes |
| R2 operations | 1M writes, 10M reads / month | Negligible for personal use |
| KV reads/writes | 100,000 / day | < 10 per session |
| Access users | 50 | Your team size |
| Egress / bandwidth | **Unlimited / free** | — |

All of the above = **$0.00/month** for typical personal/small-team use.
