#!/usr/bin/env node
'use strict';

const http = require('http');

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

const DOMAIN = getArg('domain', null);
const CDP_PORT = parseInt(getArg('port', '9222'), 10);

if (!DOMAIN || hasFlag('help')) {
  console.error(`Usage: extract-cookies.js --domain <domain> [--port <n>]
  --domain <d>   Domain to extract cookies for (e.g., example.com)
  --port <n>     CDP port (default: 9222)
  --help         Show this help`);
  process.exit(hasFlag('help') ? 0 : 1);
}

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

async function main() {
  let targets;
  try {
    targets = await httpGet(`http://localhost:${CDP_PORT}/json`);
  } catch (e) {
    console.error(`Failed to connect to CDP on port ${CDP_PORT}: ${e.message}`);
    process.exit(1);
  }

  // Find a page target matching the domain
  const page = targets.find(t =>
    t.type === 'page' && t.webSocketDebuggerUrl && t.url.includes(DOMAIN)
  );

  if (!page) {
    // Fall back to first page target
    const fallback = targets.find(t => t.type === 'page' && t.webSocketDebuggerUrl);
    if (!fallback) {
      console.error(`No page targets found on port ${CDP_PORT}`);
      process.exit(1);
    }
    console.error(`[extract-cookies] No page matching "${DOMAIN}" found, using: ${fallback.url}`);
  }

  const target = page || targets.find(t => t.type === 'page' && t.webSocketDebuggerUrl);
  const ws = new WebSocket(target.webSocketDebuggerUrl);

  await new Promise((resolve, reject) => {
    ws.on('open', resolve);
    ws.on('error', reject);
  });

  // Enable network to access cookies
  await cdpSend(ws, 'Network.enable', {});

  // Get cookies for the domain
  const result = await cdpSend(ws, 'Network.getCookies', {
    urls: [`https://${DOMAIN}`, `https://www.${DOMAIN}`]
  });

  ws.close();

  if (!result.cookies || result.cookies.length === 0) {
    console.error(`[extract-cookies] No cookies found for ${DOMAIN}`);
    process.exit(1);
  }

  // Output as Cookie header format
  const cookieStr = result.cookies
    .map(c => `${c.name}=${c.value}`)
    .join('; ');

  // Write to stdout (no trailing newline for easy use in $(...))
  process.stdout.write(cookieStr);
}

main().catch((e) => {
  console.error(`Fatal: ${e.message}`);
  process.exit(1);
});
