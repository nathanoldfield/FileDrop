# FileDrop — Architecture & Design

A lightweight, self-hosted file transfer tool built entirely on Cloudflare's free tier. Authenticated users generate time-limited transfer links, upload files from one machine, and download them on another — then the link expires automatically.

---

## Overview

**Problem:** Moving files between two computers is often clumsy — email attachment limits, USB sticks, or slow remote-desktop file transfers all get in the way, especially for large files.

**Solution:** A multi-user web app hosted on Cloudflare Workers, protected by Cloudflare Access (email OTP), that:
- Restricts access to a whitelist of email addresses
- Lets any authenticated user generate a unique, time-limited transfer link
- Accepts file uploads from a source machine via that link
- Serves those files for download on a destination machine
- Auto-expires the link (and its files) after 4 hours, or on manual deactivation
- Requires no admin intervention for day-to-day use — management via Cloudflare dashboard if needed

No third-party auth services, no app installs on either machine — just a browser, a Cloudflare account, and a URL.

---

## Authentication — Cloudflare Access (Email OTP)

Authentication is handled entirely by **Cloudflare Access**, sitting in front of the Worker. Your Worker never sees unauthenticated requests and never handles passwords or tokens itself.

### How it works

1. User navigates to `https://filedrop.yourdomain.com` (or your `*.workers.dev` URL)
2. Cloudflare Access intercepts the request and presents a login page
3. User enters their email address
4. Cloudflare sends a **one-time 6-digit code** to that email (no magic link — code entry)
5. User enters the code → Cloudflare issues a signed JWT and sets an Access cookie
6. All subsequent requests carry that cookie — the Worker reads the verified email from the `Cf-Access-Authenticated-User-Email` header

### Access Policy

- **Allowed:** Emails in the whitelist (configured as an Access policy rule: `Emails → is one of → [list]`)
- **Blocked:** Everyone else — they never reach the Worker
- **Admin:** Managed via the Cloudflare Zero Trust dashboard (add/remove emails, view login logs)
- No admin role needed within the app itself — all authenticated users are equal
- Emergency fixes (stuck files, bad state) done directly via the Cloudflare R2 and KV dashboards

### Cost

Cloudflare Access is **free for up to 50 users** under the Zero Trust free plan. Email OTP delivery is handled by Cloudflare — no email provider needed, no API keys, no sending limits that matter for personal use.

---

## Cloudflare Free Tier Fit

| Service | Used For | Free Tier Limit | Expected Usage |
|---|---|---|---|
| **Access (Zero Trust)** | Email OTP auth, user whitelist | Free up to 50 users | Your user count |
| **Workers** | All app logic & routing | 100,000 req/day | < 50 req/session |
| **R2** | File storage | 10 GB storage, zero egress | Turns over every 4h |
| **KV** | Link metadata & expiry | 1 GB, 100K reads/day | Negligible |

**R2 storage note:** The 10 GB limit is the total stored at any point. Since files are deleted after link expiry (within 1 hour of the 4-hour mark), storage turns over quickly. Transferring several GB per session stays comfortably within limits.

**Cost at normal personal/team use: $0.00/month.**

---

## Architecture

```
  Browser (any user)
       |
  [ Cloudflare Access ]  ← Email OTP gate, user whitelist
       |  (passes verified email in header)
       ▼
  [ Cloudflare Worker ]  ← App logic, UI, file routing
       |            |
  [ KV Store ]   [ R2 Bucket ]
  (link metadata)  (file blobs)
```

### Components

**Cloudflare Access Policy**
- Sits in front of the Worker as a Zero Trust application
- Sends email OTP, verifies it, passes `Cf-Access-Authenticated-User-Email` header to Worker
- Email whitelist managed in Zero Trust dashboard — no code changes to add/remove users

**Cloudflare Worker (`worker.js`)**
- Reads verified user email from Access header on every authenticated request
- Serves the entire single-page UI (HTML/CSS/JS embedded in the Worker)
- HTTP routes:
  - `GET /` — Dashboard: list of the user's active links + "Generate Link" button
  - `POST /generate` — Creates a new transfer token stored in KV with 4-hour TTL
  - `POST /deactivate/:token` — Deactivates a link (owner only)
  - `GET /t/:token` — Transfer page (upload + download UI, accessible without auth for recipients)
  - `POST /upload/:token` — Receives a file (raw stream) and stores it in R2
  - `GET /download/:token/:filename` — Streams a file from R2 to the browser
- Cron trigger (every hour) — deletes R2 objects for expired/deactivated links

**Cloudflare R2 Bucket (`filedrop-files`)**
- Files stored under key: `transfers/:token/:filename`
- No public access — only reachable via the Worker
- Objects deleted by cron after link expiry

**Cloudflare KV Namespace (`FILEDROP_KV`)**
- One entry per token:
  ```json
  {
    "token": "Xk9mP2qRvTnL...",
    "owner": "alice@example.com",
    "createdAt": 1716800000,
    "expiresAt": 1716814400,
    "active": true,
    "files": [
      { "name": "report.pdf", "size": 2048000, "uploadedAt": 1716800100 }
    ]
  }
  ```
- KV native TTL set to expiry time (auto-purges metadata)
- A secondary index key `user-links:alice@example.com` stores the list of that user's token IDs

---

## User Flow

### Logging In

1. Open your FileDrop URL
2. Cloudflare Access shows a login screen — enter your email address
3. Check email for a 6-digit OTP code (sent by Cloudflare, arrives in seconds)
4. Enter code → you're in, session lasts 24 hours by default (configurable)

### Generating a Transfer Link

1. On the dashboard, click **"Generate Link"**
2. Link is created instantly with a 4-hour expiry:
   `https://filedrop.yourdomain.com/t/Xk9mP2qRvTnL...`
3. Copy the link — share it with yourself or paste it on the source machine

### Uploading Files (Source Machine)

1. Open the transfer link — **no login required** for this step
2. Drag and drop files onto the upload zone, or click to browse
3. Files upload one at a time, streamed directly to R2 via the Worker
4. Per-file progress shown; page confirms completion with file list

### Downloading Files (Destination Machine)

1. Open the same transfer link — **no login required**
2. See all uploaded files with names and sizes
3. Click a file's **↓** button to download it (files download individually)
4. Files stream from R2 through the Worker to the browser

### Link Expiry & Deactivation

| Method | Trigger | Effect |
|---|---|---|
| Auto-expiry | 4 hours after creation | Link returns "Expired" to any visitor; files deleted within 1 hour by cron |
| Manual deactivation | Owner clicks "Deactivate" on dashboard | Immediate; files queued for deletion on next cron run |

### Dashboard (Authenticated Users)

- Lists all active links created by the logged-in user
- Shows: status, expiry countdown, files uploaded, link URL
- "Deactivate" button per active link
- Recently expired/deactivated links shown greyed out, then disappear

---

## File Structure

```
filedrop/
├── wrangler.toml        # Cloudflare config (Worker, R2, KV, cron bindings)
├── worker.js            # Main Worker — all routing logic + embedded UI
├── README.md            # Overview & quick start
└── docs/
    ├── DEPLOYMENT.md    # Step-by-step setup & deployment instructions
    └── ARCHITECTURE.md  # This file
```

Single-file Worker — no build step, no npm dependencies, no bundler.

---

## Security Model

| Concern | Mitigation |
|---|---|
| Unauthorised app access | Cloudflare Access blocks anyone not on the email whitelist before they hit the Worker |
| Token guessing for transfer links | 32-byte random token (256-bit space); practically unguessable |
| Uploading to someone else's link | Tokens are valid for upload only while active — no account takeover risk |
| File persistence after expiry | Cron deletes R2 objects within 1 hour of expiry |
| Large file / abuse | `MAX_FILE_SIZE_MB` config (default 500 MB); token only creatable by authenticated users |
| Direct R2 access | Bucket has no public binding — all access via Worker only |
| Session hijacking | Handled by Cloudflare Access (signed JWT, short-lived) |

**Transfer links are intentionally unauthenticated** — the use case requires pasting a link on a machine where you're not logged in. Security relies on the token being unguessable and short-lived, not on auth at the transfer endpoint.

---

## Limitations & Constraints

- **Request size limits** — very large single files may hit Workers request limits. Files beyond that need a multipart/chunked upload approach (see Future Enhancements).
- **No resumable uploads** — interrupted uploads must restart.
- **Transfer links are public once shared** — anyone with the URL can upload or download. Don't share links over insecure channels.
- **KV eventual consistency** — the file list on the download page may lag by a few seconds after upload.
- **Per-file download only** — files are downloaded one at a time; there is no "download all as ZIP" (see Future Enhancements).

---

## Cloudflare Dashboard as Admin Interface

Rather than building a custom admin panel, day-to-day management uses Cloudflare's own dashboards:

| Task | Where |
|---|---|
| Add / remove authorised users | Zero Trust → Access → Application → Policy |
| View login history | Zero Trust → Access → Logs |
| Force-delete files | R2 dashboard → browse bucket → delete objects |
| Inspect / delete link metadata | Workers & Pages → KV → browse namespace |
| View Worker errors & logs | Workers & Pages → Worker → Logs (real-time tail) |
| Redeploy after config change | `wrangler deploy` or Workers dashboard editor |

---

## Potential Future Enhancements (v2)

- **"Download All as ZIP"** — bundle a link's files into a single archive (CPU-intensive; may need Workers Paid for large transfers)
- Multipart / chunked upload for very large files
- Per-link optional password (for extra-sensitive transfers)
- Custom expiry time per link (not just 4 hours)
- Download count limit (e.g. "expire after 1 download")
- Upload notification email via Cloudflare Email Workers
- Custom domain with branded UI
