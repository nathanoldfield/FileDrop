// ============================================================
// FileDrop — Cloudflare Worker
// ============================================================
// Auth:    Cloudflare Access (email OTP) — handled before this
//          Worker runs. Verified email available in header:
//          Cf-Access-Authenticated-User-Email
//
// Routes (authenticated — behind Access):
//   GET  /              → Dashboard (user's links)
//   POST /generate      → Create new transfer token
//   POST /deactivate/:token → Deactivate a link (owner only)
//
// Routes (unauthenticated — public transfer endpoints):
//   GET  /t/:token                  → Transfer page
//   POST /upload/:token             → Upload files
//   GET  /download/:token/:filename → Download a file
//
// Cron:   Runs hourly — cleans up expired/deactivated R2 objects
// ============================================================

const CONFIG = {
  LINK_TTL_SECONDS: 4 * 60 * 60,        // 4 hours
  MAX_FILE_SIZE_MB: 500,
  MAX_FILES_PER_LINK: 20,
  CLEANUP_PREFIX: "transfers/",
};

// ── Entry point ──────────────────────────────────────────────

export default {
  async fetch(request, env, ctx) {
    try {
      return await handleRequest(request, env, ctx);
    } catch (err) {
      console.error("Unhandled error:", err);
      return jsonError(500, "Internal server error");
    }
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(runCleanup(env));
  },
};

// ── Router ───────────────────────────────────────────────────

async function handleRequest(request, env) {
  const url = new URL(request.url);
  const path = url.pathname;
  const method = request.method;

  // Public transfer routes — no Access auth required
  if (path.match(/^\/t\/[a-zA-Z0-9_-]+$/) && method === "GET") {
    return serveTransferPage(path.split("/")[2], env);
  }
  if (path.match(/^\/upload\/[a-zA-Z0-9_-]+$/) && method === "POST") {
    return handleUpload(path.split("/")[2], request, env);
  }
  if (path.match(/^\/download\/[a-zA-Z0-9_-]+\/.+$/) && method === "GET") {
    const parts = path.split("/");
    const token = parts[2];
    const filename = decodeURIComponent(parts.slice(3).join("/"));
    return handleDownload(token, filename, env);
  }

  // Authenticated routes — Cloudflare Access ensures these are protected
  const userEmail = request.headers.get("Cf-Access-Authenticated-User-Email");

  // During local dev / testing without Access, you can set a fallback:
  // const userEmail = request.headers.get("Cf-Access-Authenticated-User-Email") || "dev@localhost";

  if (!userEmail) {
    // This should never happen in production (Access blocks unauthenticated requests)
    // but is a safety net
    return new Response("Unauthorized — Cloudflare Access required", { status: 401 });
  }

  if (path === "/" && method === "GET") {
    return serveDashboard(userEmail, env, request);
  }
  if (path === "/generate" && method === "POST") {
    return generateLink(userEmail, env);
  }
  if (path.match(/^\/deactivate\/[a-zA-Z0-9_-]+$/) && method === "POST") {
    return deactivateLink(path.split("/")[2], userEmail, env);
  }

  return new Response("Not found", { status: 404 });
}

// ── Dashboard ─────────────────────────────────────────────────

async function serveDashboard(userEmail, env, request) {
  const links = await getUserLinks(userEmail, env);
  const origin = new URL(request.url).origin;
  const html = buildDashboardHTML(userEmail, links, origin);
  return htmlResponse(html);
}

async function getUserLinks(userEmail, env) {
  const indexKey = `user-links:${userEmail}`;
  const raw = await env.FILEDROP_KV.get(indexKey, "json");
  if (!raw || !Array.isArray(raw)) return [];

  const links = [];
  for (const token of raw) {
    const meta = await env.FILEDROP_KV.get(`token:${token}`, "json");
    if (meta) links.push(meta);
  }
  // Sort newest first
  links.sort((a, b) => b.createdAt - a.createdAt);
  return links;
}

// ── Generate link ─────────────────────────────────────────────

async function generateLink(userEmail, env) {
  const token = generateToken();
  const now = Math.floor(Date.now() / 1000);
  const expiresAt = now + CONFIG.LINK_TTL_SECONDS;

  const meta = {
    token,
    owner: userEmail,
    createdAt: now,
    expiresAt,
    active: true,
    files: [],
  };

  // Store token metadata with TTL (KV will auto-purge after expiry)
  await env.FILEDROP_KV.put(`token:${token}`, JSON.stringify(meta), {
    expiration: expiresAt + 3600, // Extra hour so cron can clean R2 first
  });

  // Update user's link index
  const indexKey = `user-links:${userEmail}`;
  const existing = (await env.FILEDROP_KV.get(indexKey, "json")) || [];
  // Keep only last 50 tokens in index
  const updated = [token, ...existing].slice(0, 50);
  await env.FILEDROP_KV.put(indexKey, JSON.stringify(updated), {
    expirationTtl: 86400 * 30, // Index lives 30 days
  });

  return jsonResponse({ token, expiresAt, url: `/t/${token}` });
}

// ── Deactivate link ───────────────────────────────────────────

async function deactivateLink(token, userEmail, env) {
  const meta = await env.FILEDROP_KV.get(`token:${token}`, "json");
  if (!meta) return jsonError(404, "Link not found");
  if (meta.owner !== userEmail) return jsonError(403, "Not your link");

  meta.active = false;
  meta.deactivatedAt = Math.floor(Date.now() / 1000);

  await env.FILEDROP_KV.put(`token:${token}`, JSON.stringify(meta), {
    expirationTtl: 7200, // Keep metadata 2 more hours for cleanup cron
  });

  return jsonResponse({ ok: true });
}

// ── Transfer page (public) ────────────────────────────────────

async function serveTransferPage(token, env) {
  const meta = await env.FILEDROP_KV.get(`token:${token}`, "json");
  const now = Math.floor(Date.now() / 1000);

  let state = "valid";
  if (!meta) state = "expired";
  else if (!meta.active) state = "deactivated";
  else if (now >= meta.expiresAt) state = "expired";

  const html = buildTransferHTML(token, meta, state);
  return htmlResponse(html);
}

// ── Upload (public) ───────────────────────────────────────────

async function handleUpload(token, request, env) {
  const meta = await env.FILEDROP_KV.get(`token:${token}`, "json");
  const now = Math.floor(Date.now() / 1000);

  if (!meta || !meta.active || now >= meta.expiresAt) {
    return jsonError(410, "This transfer link has expired or been deactivated");
  }

  if (meta.files.length >= CONFIG.MAX_FILES_PER_LINK) {
    return jsonError(400, `Maximum ${CONFIG.MAX_FILES_PER_LINK} files per link`);
  }

  // Single-file streaming upload: filename in header, raw body streamed to R2
  const rawName = request.headers.get("X-File-Name");
  if (!rawName) {
    return jsonError(400, "Missing X-File-Name header");
  }

  const safeName = decodeURIComponent(rawName).replace(/[^a-zA-Z0-9._\- ()]/g, "_");
  const fileSize = parseInt(request.headers.get("X-File-Size") || "0", 10);
  const contentType = request.headers.get("Content-Type") || "application/octet-stream";

  if (fileSize > CONFIG.MAX_FILE_SIZE_MB * 1024 * 1024) {
    return jsonError(400, `File "${safeName}" exceeds ${CONFIG.MAX_FILE_SIZE_MB} MB limit`);
  }

  const r2Key = `${CONFIG.CLEANUP_PREFIX}${token}/${safeName}`;

  // Stream request body directly to R2 — no Worker-side buffering
  await env.FILEDROP_R2.put(r2Key, request.body, {
    httpMetadata: { contentType },
  });

  if (!meta.files.find((f) => f.name === safeName)) {
    meta.files.push({ name: safeName, size: fileSize, uploadedAt: now });
    await env.FILEDROP_KV.put(`token:${token}`, JSON.stringify(meta), {
      expiration: meta.expiresAt + 3600,
    });
  }

  return jsonResponse({ ok: true, name: safeName, size: fileSize });
}

// ── Download (public) ─────────────────────────────────────────

async function handleDownload(token, filename, env) {
  const meta = await env.FILEDROP_KV.get(`token:${token}`, "json");
  const now = Math.floor(Date.now() / 1000);

  if (!meta || !meta.active || now >= meta.expiresAt) {
    return new Response("This transfer link has expired or been deactivated.", { status: 410 });
  }

  const safeName = filename.replace(/[^a-zA-Z0-9._\- ()]/g, "_");
  const r2Key = `${CONFIG.CLEANUP_PREFIX}${token}/${safeName}`;
  const object = await env.FILEDROP_R2.get(r2Key);

  if (!object) return new Response("File not found", { status: 404 });

  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set("Content-Disposition", `attachment; filename="${safeName}"`);
  headers.set("Cache-Control", "no-store");

  return new Response(object.body, { headers });
}

// ── Cleanup cron ──────────────────────────────────────────────

async function runCleanup(env) {
  console.log("FileDrop cleanup: starting");

  // List all R2 objects
  let cursor;
  let deleted = 0;
  const now = Math.floor(Date.now() / 1000);

  do {
    const listed = await env.FILEDROP_R2.list({
      prefix: CONFIG.CLEANUP_PREFIX,
      cursor,
      limit: 500,
    });

    for (const obj of listed.objects) {
      // Extract token from key: transfers/:token/:filename
      const parts = obj.key.split("/");
      if (parts.length < 3) continue;
      const token = parts[1];

      const meta = await env.FILEDROP_KV.get(`token:${token}`, "json");

      const shouldDelete =
        !meta || // KV entry gone (expired naturally)
        !meta.active || // Manually deactivated
        now >= meta.expiresAt; // Past expiry time

      if (shouldDelete) {
        await env.FILEDROP_R2.delete(obj.key);
        deleted++;
        console.log(`FileDrop cleanup: deleted ${obj.key}`);
      }
    }

    cursor = listed.truncated ? listed.cursor : undefined;
  } while (cursor);

  console.log(`FileDrop cleanup: done. Deleted ${deleted} objects.`);
}

// ── Helpers ───────────────────────────────────────────────────

function generateToken() {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=/g, "");
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatExpiry(expiresAt) {
  const diff = expiresAt - Math.floor(Date.now() / 1000);
  if (diff <= 0) return "Expired";
  const h = Math.floor(diff / 3600);
  const m = Math.floor((diff % 3600) / 60);
  if (h > 0) return `${h}h ${m}m remaining`;
  return `${m}m remaining`;
}

function htmlResponse(html) {
  return new Response(html, {
    headers: { "Content-Type": "text/html;charset=UTF-8", "Cache-Control": "no-store" },
  });
}

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function jsonError(status, message) {
  return jsonResponse({ error: message }, status);
}

// ── HTML: Dashboard ───────────────────────────────────────────

function buildDashboardHTML(userEmail, links, origin) {
  const activeLinks = links.filter(
    (l) => l.active && Math.floor(Date.now() / 1000) < l.expiresAt
  );
  const inactiveLinks = links.filter(
    (l) => !l.active || Math.floor(Date.now() / 1000) >= l.expiresAt
  );

  const renderLink = (link, inactive = false) => {
    const expiredOrDeactivated = !link.active || Math.floor(Date.now() / 1000) >= link.expiresAt;
    const fileCount = link.files?.length || 0;
    const totalSize = (link.files || []).reduce((s, f) => s + f.size, 0);
    const fullUrl = `${origin}/t/${link.token}`;

    return `
      <div class="link-card ${expiredOrDeactivated ? "inactive" : ""}">
        <div class="link-meta">
          <span class="link-status ${expiredOrDeactivated ? "status-dead" : "status-live"}">
            ${expiredOrDeactivated ? (link.active ? "Expired" : "Deactivated") : "Live"}
          </span>
          <span class="link-expiry">${expiredOrDeactivated ? "" : formatExpiry(link.expiresAt)}</span>
        </div>
        <div class="link-url-row">
          <code class="link-url">/t/${link.token.slice(0, 16)}…</code>
          ${
            !expiredOrDeactivated
              ? `<button class="btn-copy" onclick="copyLink('${fullUrl}', this)">Copy</button>`
              : ""
          }
        </div>
        <div class="link-files">
          ${fileCount === 0 ? "No files yet" : `${fileCount} file${fileCount !== 1 ? "s" : ""} · ${formatBytes(totalSize)}`}
        </div>
        ${
          !expiredOrDeactivated
            ? `<button class="btn-deactivate" onclick="deactivate('${link.token}', this)">Deactivate</button>`
            : ""
        }
      </div>`;
  };

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>FileDrop</title>
<style>
  @import url('https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500&family=IBM+Plex+Sans:wght@300;400;500&display=swap');

  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

  :root {
    --bg: #0e0e10;
    --surface: #18181c;
    --border: #2a2a30;
    --border-accent: #3d3d48;
    --text: #e8e8ed;
    --muted: #6b6b7a;
    --accent: #5b8dee;
    --accent-dim: rgba(91,141,238,0.12);
    --live: #3dd68c;
    --live-dim: rgba(61,214,140,0.12);
    --dead: #6b6b7a;
    --danger: #e05c5c;
    --font-mono: 'IBM Plex Mono', monospace;
    --font-sans: 'IBM Plex Sans', sans-serif;
  }

  html, body {
    background: var(--bg);
    color: var(--text);
    font-family: var(--font-sans);
    font-size: 14px;
    line-height: 1.6;
    min-height: 100vh;
  }

  .layout {
    max-width: 720px;
    margin: 0 auto;
    padding: 48px 24px;
  }

  header {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    margin-bottom: 48px;
    padding-bottom: 20px;
    border-bottom: 1px solid var(--border);
  }

  .wordmark {
    font-family: var(--font-mono);
    font-size: 18px;
    font-weight: 500;
    letter-spacing: -0.02em;
    color: var(--text);
  }

  .wordmark span { color: var(--accent); }

  .user-badge {
    font-family: var(--font-mono);
    font-size: 11px;
    color: var(--muted);
    background: var(--surface);
    border: 1px solid var(--border);
    padding: 4px 10px;
    border-radius: 4px;
  }

  .section-label {
    font-family: var(--font-mono);
    font-size: 10px;
    font-weight: 500;
    letter-spacing: 0.12em;
    text-transform: uppercase;
    color: var(--muted);
    margin-bottom: 16px;
  }

  /* Generate button */
  .generate-panel {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 24px;
    margin-bottom: 40px;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 16px;
  }

  .generate-info p {
    color: var(--muted);
    font-size: 13px;
    margin-top: 4px;
  }

  .generate-info strong {
    font-size: 15px;
    font-weight: 500;
    color: var(--text);
  }

  .btn-generate {
    flex-shrink: 0;
    background: var(--accent);
    color: #fff;
    border: none;
    border-radius: 6px;
    padding: 10px 20px;
    font-family: var(--font-mono);
    font-size: 13px;
    font-weight: 500;
    cursor: pointer;
    transition: opacity 0.15s, transform 0.1s;
  }

  .btn-generate:hover { opacity: 0.88; }
  .btn-generate:active { transform: scale(0.97); }
  .btn-generate:disabled { opacity: 0.4; cursor: not-allowed; }

  /* New link result */
  .new-link-result {
    display: none;
    margin-top: 16px;
    padding: 14px 16px;
    background: var(--live-dim);
    border: 1px solid var(--live);
    border-radius: 6px;
  }

  .new-link-result.show { display: block; }

  .new-link-result .result-label {
    font-family: var(--font-mono);
    font-size: 10px;
    letter-spacing: 0.1em;
    text-transform: uppercase;
    color: var(--live);
    margin-bottom: 8px;
  }

  .new-link-result .result-url {
    font-family: var(--font-mono);
    font-size: 13px;
    color: var(--text);
    word-break: break-all;
    margin-bottom: 10px;
  }

  .btn-copy-result {
    background: transparent;
    border: 1px solid var(--live);
    color: var(--live);
    border-radius: 4px;
    padding: 5px 12px;
    font-family: var(--font-mono);
    font-size: 11px;
    cursor: pointer;
    transition: background 0.15s;
  }

  .btn-copy-result:hover { background: var(--live-dim); }

  /* Link cards */
  .links-list { display: flex; flex-direction: column; gap: 10px; }

  .link-card {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 16px 18px;
  }

  .link-card.inactive { opacity: 0.45; }

  .link-meta {
    display: flex;
    align-items: center;
    gap: 10px;
    margin-bottom: 8px;
  }

  .link-status {
    font-family: var(--font-mono);
    font-size: 10px;
    font-weight: 500;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    padding: 2px 8px;
    border-radius: 3px;
  }

  .status-live {
    background: var(--live-dim);
    color: var(--live);
    border: 1px solid rgba(61,214,140,0.3);
  }

  .status-dead {
    background: rgba(107,107,122,0.15);
    color: var(--dead);
    border: 1px solid rgba(107,107,122,0.2);
  }

  .link-expiry {
    font-family: var(--font-mono);
    font-size: 11px;
    color: var(--muted);
  }

  .link-url-row {
    display: flex;
    align-items: center;
    gap: 10px;
    margin-bottom: 8px;
  }

  .link-url {
    font-family: var(--font-mono);
    font-size: 12px;
    color: var(--accent);
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .btn-copy {
    flex-shrink: 0;
    background: transparent;
    border: 1px solid var(--border-accent);
    color: var(--muted);
    border-radius: 4px;
    padding: 3px 10px;
    font-family: var(--font-mono);
    font-size: 11px;
    cursor: pointer;
    transition: border-color 0.15s, color 0.15s;
  }

  .btn-copy:hover { border-color: var(--accent); color: var(--accent); }

  .link-files {
    font-size: 12px;
    color: var(--muted);
    margin-bottom: 10px;
  }

  .btn-deactivate {
    background: transparent;
    border: 1px solid rgba(224,92,92,0.3);
    color: var(--danger);
    border-radius: 4px;
    padding: 4px 12px;
    font-family: var(--font-mono);
    font-size: 11px;
    cursor: pointer;
    transition: background 0.15s;
  }

  .btn-deactivate:hover { background: rgba(224,92,92,0.1); }

  .empty-state {
    text-align: center;
    padding: 40px 0;
    color: var(--muted);
    font-size: 13px;
  }

  .empty-state .icon { font-size: 32px; margin-bottom: 10px; }

  .section { margin-bottom: 40px; }

  footer {
    margin-top: 64px;
    padding-top: 20px;
    border-top: 1px solid var(--border);
    font-family: var(--font-mono);
    font-size: 11px;
    color: var(--muted);
    text-align: center;
  }
</style>
</head>
<body>
<div class="layout">
  <header>
    <div class="wordmark">file<span>drop</span></div>
    <div class="user-badge">${escapeHtml(userEmail)}</div>
  </header>

  <div class="generate-panel">
    <div class="generate-info">
      <strong>New Transfer Link</strong>
      <p>Generates a unique link valid for 4 hours</p>
    </div>
    <button class="btn-generate" id="btnGenerate" onclick="generateLink()">Generate Link</button>
  </div>
  <div class="new-link-result" id="newLinkResult">
    <div class="result-label">✓ Link created — expires in 4 hours</div>
    <div class="result-url" id="newLinkUrl"></div>
    <button class="btn-copy-result" onclick="copyNewLink(this)">Copy Link</button>
  </div>

  <div class="section">
    <div class="section-label">Active Links (${activeLinks.length})</div>
    <div class="links-list" id="activeList">
      ${
        activeLinks.length === 0
          ? `<div class="empty-state"><div class="icon">◌</div>No active links</div>`
          : activeLinks.map((l) => renderLink(l)).join("")
      }
    </div>
  </div>

  ${
    inactiveLinks.length > 0
      ? `<div class="section">
          <div class="section-label">Recent (Expired / Deactivated)</div>
          <div class="links-list">
            ${inactiveLinks.slice(0, 5).map((l) => renderLink(l, true)).join("")}
          </div>
        </div>`
      : ""
  }

  <footer>filedrop · ${new Date().getFullYear()}</footer>
</div>

<script>
  let newLinkUrl = '';

  async function generateLink() {
    const btn = document.getElementById('btnGenerate');
    btn.disabled = true;
    btn.textContent = 'Generating…';

    try {
      const res = await fetch('/generate', { method: 'POST' });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed');

      newLinkUrl = window.location.origin + data.url;
      document.getElementById('newLinkUrl').textContent = newLinkUrl;
      document.getElementById('newLinkResult').classList.add('show');
      btn.textContent = 'Generate Another';

      // Reload after short delay to refresh list
      setTimeout(() => location.reload(), 800);
    } catch (err) {
      alert('Error: ' + err.message);
      btn.textContent = 'Generate Link';
    } finally {
      btn.disabled = false;
    }
  }

  function copyNewLink(btn) {
    navigator.clipboard.writeText(newLinkUrl).then(() => {
      btn.textContent = 'Copied!';
      setTimeout(() => btn.textContent = 'Copy Link', 2000);
    });
  }

  function copyLink(url, btn) {
    navigator.clipboard.writeText(url).then(() => {
      btn.textContent = 'Copied!';
      setTimeout(() => btn.textContent = 'Copy', 2000);
    });
  }

  async function deactivate(token, btn) {
    if (!confirm('Deactivate this link? Files will be deleted.')) return;
    btn.disabled = true;
    btn.textContent = 'Deactivating…';
    try {
      const res = await fetch('/deactivate/' + token, { method: 'POST' });
      if (!res.ok) throw new Error('Failed');
      location.reload();
    } catch (err) {
      alert('Error: ' + err.message);
      btn.disabled = false;
      btn.textContent = 'Deactivate';
    }
  }
</script>
</body>
</html>`;
}

// ── HTML: Transfer page ───────────────────────────────────────

function buildTransferHTML(token, meta, state) {
  if (state !== "valid") {
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>FileDrop — Link ${state === "expired" ? "Expired" : "Deactivated"}</title>
<style>
  @import url('https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500&display=swap');
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    background: #0e0e10; color: #6b6b7a;
    font-family: 'IBM Plex Mono', monospace;
    display: flex; align-items: center; justify-content: center; min-height: 100vh;
    flex-direction: column; gap: 12px;
  }
  .code { font-size: 48px; color: #2a2a30; }
  .msg { font-size: 13px; }
  .sub { font-size: 11px; color: #3a3a44; }
</style>
</head>
<body>
  <div class="code">⊘</div>
  <div class="msg">This link has ${state === "expired" ? "expired" : "been deactivated"}.</div>
  <div class="sub">Ask the sender to generate a new one.</div>
</body>
</html>`;
  }

  const files = meta.files || [];
  const expiresAt = meta.expiresAt;

  const filesHtml =
    files.length === 0
      ? `<div class="empty-files">No files uploaded yet</div>`
      : files
          .map(
            (f) => `
      <div class="file-row">
        <div class="file-icon">◈</div>
        <div class="file-info">
          <div class="file-name">${escapeHtml(f.name)}</div>
          <div class="file-size">${formatBytes(f.size)}</div>
        </div>
        <a class="btn-dl" href="/download/${token}/${encodeURIComponent(f.name)}" download="${escapeHtml(f.name)}">↓</a>
      </div>`
          )
          .join("");

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>FileDrop — Transfer</title>
<style>
  @import url('https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500&family=IBM+Plex+Sans:wght@300;400;500&display=swap');

  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

  :root {
    --bg: #0e0e10;
    --surface: #18181c;
    --surface2: #1e1e24;
    --border: #2a2a30;
    --border-accent: #3d3d48;
    --text: #e8e8ed;
    --muted: #6b6b7a;
    --accent: #5b8dee;
    --accent-dim: rgba(91,141,238,0.1);
    --live: #3dd68c;
    --live-dim: rgba(61,214,140,0.1);
    --font-mono: 'IBM Plex Mono', monospace;
    --font-sans: 'IBM Plex Sans', sans-serif;
  }

  html, body {
    background: var(--bg); color: var(--text);
    font-family: var(--font-sans); font-size: 14px;
    line-height: 1.6; min-height: 100vh;
  }

  .layout { max-width: 640px; margin: 0 auto; padding: 48px 24px; }

  header {
    display: flex; align-items: baseline; justify-content: space-between;
    margin-bottom: 36px; padding-bottom: 18px; border-bottom: 1px solid var(--border);
  }

  .wordmark { font-family: var(--font-mono); font-size: 18px; font-weight: 500; letter-spacing: -0.02em; }
  .wordmark span { color: var(--accent); }

  .expiry-badge {
    font-family: var(--font-mono); font-size: 11px;
    background: var(--live-dim); color: var(--live);
    border: 1px solid rgba(61,214,140,0.25);
    padding: 3px 10px; border-radius: 4px;
  }

  /* Drop zone */
  .drop-zone {
    border: 2px dashed var(--border-accent);
    border-radius: 10px;
    padding: 40px 24px;
    text-align: center;
    cursor: pointer;
    transition: border-color 0.2s, background 0.2s;
    margin-bottom: 24px;
    position: relative;
  }

  .drop-zone.drag-over {
    border-color: var(--accent);
    background: var(--accent-dim);
  }

  .drop-zone input[type="file"] {
    position: absolute; inset: 0; opacity: 0; cursor: pointer; width: 100%; height: 100%;
  }

  .drop-icon { font-size: 32px; color: var(--muted); margin-bottom: 10px; }

  .drop-label { font-size: 14px; color: var(--text); margin-bottom: 4px; }
  .drop-sub { font-size: 12px; color: var(--muted); }

  /* Upload queue */
  .upload-queue { display: flex; flex-direction: column; gap: 8px; margin-bottom: 24px; }

  .queue-item {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 6px;
    padding: 10px 14px;
    display: flex; flex-wrap: wrap; align-items: center; gap: 12px;
  }

  .queue-name { flex: 1; font-size: 13px; font-family: var(--font-mono); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .queue-size { font-size: 11px; color: var(--muted); font-family: var(--font-mono); flex-shrink: 0; }

  .queue-status { font-size: 11px; font-family: var(--font-mono); flex-shrink: 0; }
  .queue-status.pending { color: var(--muted); }
  .queue-status.uploading { color: var(--accent); }
  .queue-status.done { color: var(--live); }
  .queue-status.error { color: #e05c5c; }

  .progress-bar-wrap {
    width: 100%; height: 2px; background: var(--border); border-radius: 1px; margin-top: 6px;
  }

  .progress-bar { height: 2px; background: var(--accent); border-radius: 1px; transition: width 0.2s; }

  /* Send button */
  .btn-send {
    width: 100%;
    background: var(--accent);
    color: #fff;
    border: none;
    border-radius: 6px;
    padding: 12px;
    font-family: var(--font-mono);
    font-size: 14px;
    font-weight: 500;
    cursor: pointer;
    transition: opacity 0.15s;
    margin-bottom: 36px;
  }

  .btn-send:hover { opacity: 0.88; }
  .btn-send:disabled { opacity: 0.35; cursor: not-allowed; }

  /* Files section */
  .section-label {
    font-family: var(--font-mono);
    font-size: 10px; font-weight: 500;
    letter-spacing: 0.12em; text-transform: uppercase;
    color: var(--muted); margin-bottom: 12px;
  }

  .files-list { display: flex; flex-direction: column; gap: 8px; }

  .file-row {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 6px;
    padding: 12px 16px;
    display: flex; align-items: center; gap: 12px;
    transition: border-color 0.15s;
  }

  .file-row:hover { border-color: var(--border-accent); }

  .file-icon { color: var(--muted); font-size: 16px; flex-shrink: 0; }

  .file-info { flex: 1; min-width: 0; }
  .file-name { font-family: var(--font-mono); font-size: 13px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .file-size { font-size: 11px; color: var(--muted); font-family: var(--font-mono); }

  .btn-dl {
    flex-shrink: 0;
    background: transparent;
    border: 1px solid var(--border-accent);
    color: var(--accent);
    text-decoration: none;
    border-radius: 4px;
    padding: 5px 12px;
    font-family: var(--font-mono);
    font-size: 14px;
    transition: background 0.15s, border-color 0.15s;
  }

  .btn-dl:hover { background: var(--accent-dim); border-color: var(--accent); }

  .empty-files {
    text-align: center; padding: 32px; color: var(--muted);
    font-size: 13px; font-family: var(--font-mono);
    border: 1px dashed var(--border); border-radius: 6px;
  }

  footer {
    margin-top: 56px; padding-top: 18px;
    border-top: 1px solid var(--border);
    font-family: var(--font-mono); font-size: 11px;
    color: var(--muted); text-align: center;
  }

  .divider { border: none; border-top: 1px solid var(--border); margin: 32px 0; }
</style>
</head>
<body>
<div class="layout">
  <header>
    <div class="wordmark">file<span>drop</span></div>
    <div class="expiry-badge" id="expiryBadge">Loading…</div>
  </header>

  <!-- Upload section -->
  <div class="section-label">Upload Files</div>
  <div class="drop-zone" id="dropZone">
    <input type="file" id="fileInput" multiple>
    <div class="drop-icon">⊕</div>
    <div class="drop-label">Drop files here or click to browse</div>
    <div class="drop-sub">Up to ${CONFIG.MAX_FILE_SIZE_MB} MB per file · ${CONFIG.MAX_FILES_PER_LINK} files max</div>
  </div>

  <div class="upload-queue" id="uploadQueue"></div>

  <button class="btn-send" id="btnSend" disabled onclick="startUpload()">Upload Files</button>

  <hr class="divider">

  <!-- Files available section -->
  <div class="section-label">Files Available (${files.length})</div>
  <div class="files-list" id="filesList">${filesHtml}</div>

  <footer>filedrop · link expires ${new Date(expiresAt * 1000).toUTCString()}</footer>
</div>

<script>
  const TOKEN = '${token}';
  const EXPIRES_AT = ${expiresAt};
  let pendingFiles = [];

  // Expiry countdown
  function updateExpiry() {
    const diff = EXPIRES_AT - Math.floor(Date.now() / 1000);
    const el = document.getElementById('expiryBadge');
    if (diff <= 0) {
      el.textContent = 'Expired';
      el.style.color = '#6b6b7a';
      return;
    }
    const h = Math.floor(diff / 3600);
    const m = Math.floor((diff % 3600) / 60);
    const s = diff % 60;
    el.textContent = h > 0
      ? h + 'h ' + String(m).padStart(2,'0') + 'm remaining'
      : m + 'm ' + String(s).padStart(2,'0') + 's remaining';
  }
  updateExpiry();
  setInterval(updateExpiry, 1000);

  // Drag and drop
  const dropZone = document.getElementById('dropZone');
  const fileInput = document.getElementById('fileInput');

  dropZone.addEventListener('dragover', e => { e.preventDefault(); dropZone.classList.add('drag-over'); });
  dropZone.addEventListener('dragleave', () => dropZone.classList.remove('drag-over'));
  dropZone.addEventListener('drop', e => {
    e.preventDefault();
    dropZone.classList.remove('drag-over');
    addFiles(Array.from(e.dataTransfer.files));
  });
  fileInput.addEventListener('change', () => addFiles(Array.from(fileInput.files)));

  function addFiles(files) {
    for (const file of files) {
      if (!pendingFiles.find(f => f.name === file.name)) {
        pendingFiles.push(file);
      }
    }
    renderQueue();
    document.getElementById('btnSend').disabled = pendingFiles.length === 0;
  }

  function renderQueue() {
    const queue = document.getElementById('uploadQueue');
    queue.innerHTML = pendingFiles.map((f, i) => \`
      <div class="queue-item" id="qi-\${i}">
        <div class="queue-name">\${escHtml(f.name)}</div>
        <div class="queue-size">\${fmtBytes(f.size)}</div>
        <div class="queue-status pending" id="qs-\${i}">Queued</div>
        <div class="progress-bar-wrap" id="qp-wrap-\${i}" style="display:none;width:100%;grid-column:1/-1">
          <div class="progress-bar" id="qp-\${i}" style="width:0%"></div>
        </div>
      </div>
    \`).join('');
  }

  async function startUpload() {
    if (pendingFiles.length === 0) return;
    const btn = document.getElementById('btnSend');
    btn.disabled = true;
    btn.textContent = 'Uploading…';

    let anyError = false;
    for (let i = 0; i < pendingFiles.length; i++) {
      try {
        await uploadFile(pendingFiles[i], i);
      } catch (err) {
        anyError = true;
        alert('Upload failed: ' + err.message);
      }
    }

    if (!anyError) {
      btn.textContent = 'Uploaded ✓';
      setTimeout(() => location.reload(), 1200);
    } else {
      btn.disabled = false;
      btn.textContent = 'Upload Files';
    }
  }

  function uploadFile(file, index) {
    return new Promise((resolve, reject) => {
      const statusEl = document.getElementById('qs-' + index);
      const progressWrap = document.getElementById('qp-wrap-' + index);
      const progressBar = document.getElementById('qp-' + index);

      if (statusEl) { statusEl.textContent = 'Uploading…'; statusEl.className = 'queue-status uploading'; }
      if (progressWrap) progressWrap.style.display = 'block';

      const xhr = new XMLHttpRequest();

      xhr.upload.addEventListener('progress', e => {
        if (e.lengthComputable && progressBar) {
          progressBar.style.width = (e.loaded / e.total * 100).toFixed(1) + '%';
        }
      });

      xhr.addEventListener('load', () => {
        if (xhr.status >= 200 && xhr.status < 300) {
          if (statusEl) { statusEl.textContent = '✓ Done'; statusEl.className = 'queue-status done'; }
          if (progressWrap) progressWrap.style.display = 'none';
          resolve();
        } else {
          let msg = 'Upload failed';
          try { msg = JSON.parse(xhr.responseText).error || msg; } catch {}
          if (statusEl) { statusEl.textContent = 'Error'; statusEl.className = 'queue-status error'; }
          if (progressWrap) progressWrap.style.display = 'none';
          reject(new Error(msg));
        }
      });

      xhr.addEventListener('error', () => {
        if (statusEl) { statusEl.textContent = 'Error'; statusEl.className = 'queue-status error'; }
        if (progressWrap) progressWrap.style.display = 'none';
        reject(new Error('Network error'));
      });

      xhr.open('POST', '/upload/' + TOKEN);
      xhr.setRequestHeader('X-File-Name', encodeURIComponent(file.name));
      xhr.setRequestHeader('X-File-Size', String(file.size));
      xhr.setRequestHeader('Content-Type', file.type || 'application/octet-stream');
      xhr.send(file);
    });
  }

  function fmtBytes(b) {
    if (b < 1024) return b + ' B';
    if (b < 1048576) return (b/1024).toFixed(1) + ' KB';
    return (b/1048576).toFixed(1) + ' MB';
  }

  function escHtml(s) {
    return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }
</script>
</body>
</html>`;
}

// ── XSS helper ────────────────────────────────────────────────

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
