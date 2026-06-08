# FileDrop

A lightweight, self-hosted file-transfer tool that runs entirely on Cloudflare's
free tier. Authenticated users generate **time-limited transfer links**, upload files
from one machine, and download them on another — then the link (and its files) expire
automatically.

Think of it as your own private, disposable "drop box" for moving files between two
computers when email, USB sticks, or a slow remote session won't cut it. No third-party
services, no app installs — just a browser and a URL.

---

## Features

- 🔐 **Email-OTP authentication** via Cloudflare Access — only whitelisted emails can log in
- ⏱️ **Time-limited links** — every link auto-expires after 4 hours (configurable)
- 🔗 **Public transfer links** — recipients upload/download without logging in
- 🗑️ **Automatic cleanup** — an hourly cron deletes files from expired/deactivated links
- 📦 **Streaming uploads** — files pipe straight to R2 storage, never buffered in the Worker
- 🆓 **$0/month** for typical personal/small-team use, all on Cloudflare's free tier
- 📄 **Single-file Worker** — no build step, no dependencies, no bundler

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

Built on **Cloudflare Workers + R2 + KV + Access**. See
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the full design.

---

## Quick Start

> Full step-by-step instructions (including the Cloudflare Access setup, which is the
> trickiest part) are in **[docs/DEPLOYMENT.md](docs/DEPLOYMENT.md)**. The condensed
> version:

1. **Install Wrangler** and log in:
   ```bash
   npm install -g wrangler
   wrangler login
   ```
2. **Create the R2 bucket:**
   ```bash
   wrangler r2 bucket create filedrop-files
   ```
3. **Create the KV namespace** and paste the returned `id` into `wrangler.toml`
   (replace `REPLACE_WITH_YOUR_KV_NAMESPACE_ID`):
   ```bash
   wrangler kv namespace create FILEDROP_KV
   ```
4. **Deploy the Worker:**
   ```bash
   wrangler deploy
   ```
5. **Set up Cloudflare Access** (Zero Trust → Access → Applications) — an email-OTP
   policy for your dashboard, plus **Bypass** policies for the public paths `/t/*`,
   `/upload/*`, and `/download/*`. Details in
   [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md#step-5--set-up-cloudflare-access-email-otp-gate).
6. **Test the flow** — log in, generate a link, open it in another browser, upload and
   download a file.

---

## Configuration

Defaults live in the `CONFIG` block at the top of [worker.js](worker.js):

| Setting | Default | Meaning |
|---|---|---|
| `LINK_TTL_SECONDS` | `4 * 60 * 60` | How long a link stays valid (4 hours) |
| `MAX_FILE_SIZE_MB` | `500` | Max size per file |
| `MAX_FILES_PER_LINK` | `20` | Max files per link |

Change a value and re-run `wrangler deploy`.

---

## License

[MIT](LICENSE) — free to use, modify, and distribute.
