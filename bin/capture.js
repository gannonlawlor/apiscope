#!/usr/bin/env node
'use strict';

const http = require('http');
const path = require('path');
const fs = require('fs');

// Use ws from OpenClaw's bundled dependencies
const WS_PATH = '/opt/OpenClaw/.npm-global/lib/node_modules/openclaw/node_modules/ws';
const WebSocket = require(WS_PATH);

// --- CLI args ---
const args = process.argv.slice(2);
function getArg(name, defaultVal) {
  const idx = args.indexOf('--' + name);
  if (idx === -1 || idx + 1 >= args.length) return defaultVal;
  return args[idx + 1];
}
function hasFlag(name) {
  return args.indexOf('--' + name) !== -1;
}

const CDP_PORT = parseInt(getArg('port', '9222'), 10);
const DURATION = parseInt(getArg('duration', '300'), 10);
const CAPTURES_DIR = getArg('output', '/opt/OpenClaw/.openclaw/captures');
const REDACT = hasFlag('redact');

if (hasFlag('help')) {
  console.log(`Usage: capture-api.js [options]
  --port <n>       CDP port (default: 9222)
  --duration <s>   Capture duration in seconds (default: 300)
  --output <dir>   Output directory (default: /opt/OpenClaw/.openclaw/captures)
  --redact         Strip request bodies containing sensitive patterns
  --help           Show this help`);
  process.exit(0);
}

// --- Noise filtering ---
const NOISE_DOMAINS = new Set([
  'google-analytics.com', 'www.google-analytics.com', 'analytics.google.com',
  'googletagmanager.com', 'www.googletagmanager.com',
  'googlesyndication.com', 'pagead2.googlesyndication.com',
  'doubleclick.net', 'ad.doubleclick.net',
  'google.com', 'www.google.com',  // tracking pixels only — real API calls won't match these bare domains
  'facebook.com', 'www.facebook.com', 'connect.facebook.net',
  'facebook.net', 'www.facebook.net',
  'stripe.com', 'js.stripe.com', 'api.stripe.com', 'm.stripe.com',
  'sentry.io', 'sentry-cdn.com',
  'hotjar.com', 'static.hotjar.com', 'script.hotjar.com',
  'segment.io', 'api.segment.io', 'cdn.segment.com',
  'datadome.co', 'api-js.datadome.co',
  'recaptcha.net', 'www.recaptcha.net',
  'gstatic.com', 'www.gstatic.com',
  'newrelic.com', 'bam.nr-data.net', 'js-agent.newrelic.com',
  'fullstory.com', 'rs.fullstory.com',
  'optimizely.com', 'cdn.optimizely.com',
  'quantserve.com', 'pixel.quantserve.com',
  'branch.io', 'api.branch.io',
  'braze.com', 'sdk.iad-01.braze.com',
  'amplitude.com', 'api.amplitude.com',
  'mixpanel.com', 'api.mixpanel.com',
  'intercom.io', 'widget.intercom.io',
  'clarity.ms', 'www.clarity.ms',
  'mouseflow.com',
  'crazyegg.com',
  'tiktok.com', 'analytics.tiktok.com',
  'pinterest.com', 'ct.pinterest.com',
  'snapchat.com', 'tr.snapchat.com',
]);

const STATIC_EXTENSIONS = /\.(js|css|png|jpg|jpeg|gif|svg|ico|woff|woff2|ttf|eot|map|webp|avif)(\?|$)/i;

const SENSITIVE_PATTERNS = /password|passwd|card_?number|card_?num|cvv|cvc|ssn|social_?security|secret_?key|private_?key/i;

function isNoiseDomain(url) {
  try {
    const hostname = new URL(url).hostname;
    // Check exact match and parent domain
    if (NOISE_DOMAINS.has(hostname)) return true;
    const parts = hostname.split('.');
    for (let i = 1; i < parts.length - 1; i++) {
      if (NOISE_DOMAINS.has(parts.slice(i).join('.'))) return true;
    }
    return false;
  } catch {
    return false;
  }
}

function isStaticAsset(url) {
  try {
    return STATIC_EXTENSIONS.test(new URL(url).pathname);
  } catch {
    return false;
  }
}

function getDomain(url) {
  try {
    const hostname = new URL(url).hostname;
    const parts = hostname.split('.');
    // Return last two parts (e.g., example.com)
    return parts.length > 2 ? parts.slice(-2).join('.') : hostname;
  } catch {
    return 'unknown';
  }
}

function redactBody(body) {
  if (!body || !REDACT) return body;
  if (SENSITIVE_PATTERNS.test(body)) return '[REDACTED — sensitive data detected]';
  return body;
}

const MAX_BODY_SIZE = 10 * 1024; // 10KB

function truncateBody(body) {
  if (!body) return body;
  if (body.length > MAX_BODY_SIZE) {
    return body.slice(0, MAX_BODY_SIZE) + `\n...[truncated at ${MAX_BODY_SIZE} bytes, total ${body.length}]`;
  }
  return body;
}

// --- CDP helpers ---
function httpGet(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let data = '';
      res.on('data', (chunk) => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(new Error(`JSON parse error: ${e.message}`)); }
      });
    }).on('error', reject);
  });
}

function cdpSend(ws, method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = cdpSend._id = (cdpSend._id || 0) + 1;
    const timeout = setTimeout(() => reject(new Error(`CDP timeout: ${method}`)), 10000);
    const handler = (msg) => {
      const data = JSON.parse(msg);
      if (data.id === id) {
        clearTimeout(timeout);
        ws.removeListener('message', handler);
        if (data.error) reject(new Error(`CDP error: ${JSON.stringify(data.error)}`));
        else resolve(data.result);
      }
    };
    ws.on('message', handler);
    ws.send(JSON.stringify({ id, method, params }));
  });
}

// --- Main ---
async function main() {
  console.log(`[capture-api] Discovering targets on CDP port ${CDP_PORT}...`);

  let targets;
  try {
    targets = await httpGet(`http://localhost:${CDP_PORT}/json`);
  } catch (e) {
    console.error(`[capture-api] Failed to connect to CDP on port ${CDP_PORT}: ${e.message}`);
    process.exit(1);
  }

  const pages = targets.filter(t => t.type === 'page' && t.webSocketDebuggerUrl);
  if (pages.length === 0) {
    console.error('[capture-api] No page targets found.');
    process.exit(1);
  }

  console.log(`[capture-api] Found ${pages.length} page target(s):`);
  pages.forEach(p => console.log(`  - ${p.title || '(untitled)'}: ${p.url}`));

  // Storage: requestId -> partial request data
  const pendingRequests = new Map();
  // Completed requests grouped by domain
  const capturedByDomain = new Map();
  let totalCaptured = 0;

  const connections = [];

  for (const page of pages) {
    const ws = new WebSocket(page.webSocketDebuggerUrl);

    await new Promise((resolve, reject) => {
      ws.on('open', resolve);
      ws.on('error', reject);
    });

    // Enable network monitoring (passive — no navigation)
    await cdpSend(ws, 'Network.enable', {});
    console.log(`[capture-api] Monitoring: ${page.title || page.url}`);

    ws.on('message', (raw) => {
      let msg;
      try { msg = JSON.parse(raw); } catch { return; }
      if (!msg.method) return; // Skip responses to our commands

      if (msg.method === 'Network.requestWillBeSent') {
        const p = msg.params;
        const req = p.request;
        const type = p.type || p.resourceType || '';

        // Only capture XHR and Fetch
        if (type !== 'XHR' && type !== 'Fetch') return;
        // Filter noise
        if (isNoiseDomain(req.url)) return;
        if (isStaticAsset(req.url)) return;

        pendingRequests.set(p.requestId, {
          timestamp: new Date().toISOString(),
          method: req.method,
          url: req.url,
          requestHeaders: req.headers || {},
          requestBody: redactBody(req.postData || null),
          resourceType: type,
          responseStatus: null,
          responseHeaders: {},
          responseBody: null,
        });
      }

      if (msg.method === 'Network.responseReceived') {
        const p = msg.params;
        const entry = pendingRequests.get(p.requestId);
        if (!entry) return;
        entry.responseStatus = p.response.status;
        entry.responseHeaders = p.response.headers || {};
      }

      if (msg.method === 'Network.loadingFinished') {
        const p = msg.params;
        const entry = pendingRequests.get(p.requestId);
        if (!entry) return;
        pendingRequests.delete(p.requestId);

        // Try to get response body
        cdpSend(ws, 'Network.getResponseBody', { requestId: p.requestId })
          .then((result) => {
            entry.responseBody = truncateBody(result.body || null);
            storeEntry(entry);
          })
          .catch(() => {
            // Body may not be available (e.g., redirects)
            storeEntry(entry);
          });
      }

      if (msg.method === 'Network.loadingFailed') {
        const p = msg.params;
        const entry = pendingRequests.get(p.requestId);
        if (!entry) return;
        pendingRequests.delete(p.requestId);
        entry.responseStatus = 0;
        entry.responseBody = `[failed: ${p.errorText || 'unknown'}]`;
        storeEntry(entry);
      }
    });

    connections.push(ws);
  }

  function storeEntry(entry) {
    const domain = getDomain(entry.url);
    if (!capturedByDomain.has(domain)) capturedByDomain.set(domain, []);
    capturedByDomain.get(domain).push(entry);
    totalCaptured++;
    if (totalCaptured % 10 === 0) {
      console.log(`[capture-api] ${totalCaptured} API calls captured across ${capturedByDomain.size} domain(s)`);
    }
  }

  // Schedule shutdown
  const shutdownTimer = setTimeout(() => {
    console.log(`\n[capture-api] Duration ${DURATION}s elapsed.`);
    shutdown();
  }, DURATION * 1000);

  process.on('SIGINT', () => {
    console.log('\n[capture-api] SIGINT received.');
    clearTimeout(shutdownTimer);
    shutdown();
  });

  process.on('SIGTERM', () => {
    console.log('\n[capture-api] SIGTERM received.');
    clearTimeout(shutdownTimer);
    shutdown();
  });

  let shuttingDown = false;
  function shutdown() {
    if (shuttingDown) return;
    shuttingDown = true;

    // Close WebSocket connections
    for (const ws of connections) {
      try { ws.close(); } catch {}
    }

    // Flush any pending requests that have partial data
    for (const [, entry] of pendingRequests) {
      storeEntry(entry);
    }
    pendingRequests.clear();

    // Write capture files
    const timestamp = new Date().toISOString().replace(/:/g, '-').replace(/\..+/, '');
    let filesWritten = 0;

    for (const [domain, requests] of capturedByDomain) {
      const domainDir = path.join(CAPTURES_DIR, domain);
      fs.mkdirSync(domainDir, { recursive: true });

      const capture = {
        capturedAt: new Date().toISOString(),
        duration: DURATION,
        cdpPort: CDP_PORT,
        domain,
        requests,
      };

      const filePath = path.join(domainDir, `${timestamp}.json`);
      fs.writeFileSync(filePath, JSON.stringify(capture, null, 2));
      filesWritten++;
      console.log(`[capture-api] Wrote ${requests.length} requests to ${filePath}`);
    }

    if (filesWritten === 0) {
      console.log('[capture-api] No API calls captured.');
    } else {
      console.log(`[capture-api] Done. ${totalCaptured} total calls across ${filesWritten} domain(s).`);
    }

    process.exit(0);
  }

  console.log(`[capture-api] Capturing for ${DURATION}s (Ctrl+C to stop early)...`);
}

main().catch((e) => {
  console.error(`[capture-api] Fatal: ${e.message}`);
  process.exit(1);
});
