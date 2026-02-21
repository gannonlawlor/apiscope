#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

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
const CAPTURE_FILE = getArg('capture', null);
const SKILL_NAME = getArg('name', null);
const CAPTURES_DIR = getArg('captures-dir', '/opt/OpenClaw/.openclaw/captures');
const SKILLS_DIR = getArg('skills-dir', '/opt/OpenClaw/.openclaw/skills');

if ((!DOMAIN && !CAPTURE_FILE) || hasFlag('help')) {
  console.error(`Usage: generate-api-skill.js --domain <domain> [options]
  --domain <d>        Domain to generate skill for (e.g., example.com)
  --capture <file>    Specific capture file (default: most recent for domain)
  --name <n>          Skill name (default: api-<domain-prefix>)
  --captures-dir <d>  Captures directory (default: /opt/OpenClaw/.openclaw/captures)
  --skills-dir <d>    Skills directory (default: /opt/OpenClaw/.openclaw/skills)
  --help              Show this help`);
  process.exit(hasFlag('help') ? 0 : 1);
}

// --- URL normalization ---
function normalizePath(urlStr) {
  try {
    const u = new URL(urlStr);
    let p = u.pathname;
    // Replace UUIDs
    p = p.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '{uuid}');
    // Replace hex hashes (8+ chars)
    p = p.replace(/\/[0-9a-f]{8,64}(?=\/|$)/gi, '/{hash}');
    // Replace pure numeric IDs
    p = p.replace(/\/\d{2,}(?=\/|$)/g, '/{id}');
    // Replace timestamps (unix epoch 10+ digits)
    p = p.replace(/\/\d{10,13}(?=\/|$)/g, '/{ts}');
    return p;
  } catch {
    return urlStr;
  }
}

function normalizeQueryParams(urlStr) {
  try {
    const u = new URL(urlStr);
    const params = [];
    for (const [key] of u.searchParams) {
      params.push(key);
    }
    return params.sort().join(',');
  } catch {
    return '';
  }
}

function endpointKey(method, url) {
  return `${method} ${normalizePath(url)}`;
}

// --- Schema inference ---
function inferSchema(jsonStr, maxDepth = 2) {
  let obj;
  try {
    obj = JSON.parse(jsonStr);
  } catch {
    return null;
  }
  return describeType(obj, 0, maxDepth);
}

function describeType(val, depth, maxDepth) {
  if (val === null) return 'null';
  if (Array.isArray(val)) {
    if (val.length === 0) return '[]';
    if (depth >= maxDepth) return `[...${val.length} items]`;
    return `[${describeType(val[0], depth + 1, maxDepth)}] (${val.length} items)`;
  }
  if (typeof val === 'object') {
    if (depth >= maxDepth) return `{...${Object.keys(val).length} keys}`;
    const entries = Object.entries(val).slice(0, 15);
    const fields = entries.map(([k, v]) => `  ${k}: ${describeType(v, depth + 1, maxDepth)}`);
    const extra = Object.keys(val).length > 15 ? `\n  ...${Object.keys(val).length - 15} more keys` : '';
    return `{\n${fields.join('\n')}${extra}\n}`;
  }
  if (typeof val === 'string') {
    if (val.length > 80) return `string (${val.length} chars)`;
    return `"${val}"`;
  }
  return typeof val;
}

// --- Auth pattern detection ---
function detectAuthPatterns(requests) {
  const authHeaders = new Map(); // header name -> count
  const cookieNames = new Map(); // cookie name -> count

  for (const req of requests) {
    const headers = req.requestHeaders || {};
    for (const [key, value] of Object.entries(headers)) {
      const lower = key.toLowerCase();
      if (lower === 'authorization') {
        // Extract auth scheme
        const scheme = (value || '').split(' ')[0] || 'unknown';
        const label = `Authorization: ${scheme} ...`;
        authHeaders.set(label, (authHeaders.get(label) || 0) + 1);
      }
      if (lower.includes('csrf') || lower.includes('token') || lower.includes('x-api')) {
        authHeaders.set(key, (authHeaders.get(key) || 0) + 1);
      }
      if (lower === 'cookie') {
        // Parse cookie names
        const cookies = (value || '').split(';').map(c => c.trim().split('=')[0]).filter(Boolean);
        for (const name of cookies) {
          cookieNames.set(name, (cookieNames.get(name) || 0) + 1);
        }
      }
    }
  }

  return { authHeaders, cookieNames };
}

// --- Main ---
function main() {
  // Find capture file
  let captureFile;
  let domain = DOMAIN;

  if (CAPTURE_FILE) {
    captureFile = CAPTURE_FILE;
  } else {
    const domainDir = path.join(CAPTURES_DIR, domain);
    if (!fs.existsSync(domainDir)) {
      console.error(`No captures found for domain: ${domain}`);
      console.error(`Expected directory: ${domainDir}`);
      process.exit(1);
    }
    const files = fs.readdirSync(domainDir)
      .filter(f => f.endsWith('.json'))
      .sort()
      .reverse();
    if (files.length === 0) {
      console.error(`No capture files in ${domainDir}`);
      process.exit(1);
    }
    captureFile = path.join(domainDir, files[0]);
    console.error(`[generate-api-skill] Using capture: ${captureFile}`);
  }

  // Read capture
  let capture;
  try {
    capture = JSON.parse(fs.readFileSync(captureFile, 'utf-8'));
  } catch (e) {
    console.error(`Failed to read capture file: ${e.message}`);
    process.exit(1);
  }

  if (!domain) domain = capture.domain;
  const requests = capture.requests || [];

  if (requests.length === 0) {
    console.error('Capture file contains no requests.');
    process.exit(1);
  }

  console.error(`[generate-api-skill] Analyzing ${requests.length} requests for ${domain}`);

  // Group by normalized endpoint
  const endpoints = new Map(); // key -> { method, normalizedPath, requests: [], queryParams: Set }

  for (const req of requests) {
    const key = endpointKey(req.method, req.url);
    if (!endpoints.has(key)) {
      endpoints.set(key, {
        method: req.method,
        normalizedPath: normalizePath(req.url),
        requests: [],
        queryParams: new Set(),
      });
    }
    const ep = endpoints.get(key);
    ep.requests.push(req);

    // Collect query param names
    try {
      const u = new URL(req.url);
      for (const [k] of u.searchParams) {
        ep.queryParams.add(k);
      }
    } catch {}
  }

  // Sort by frequency descending
  const sortedEndpoints = [...endpoints.values()].sort((a, b) => b.requests.length - a.requests.length);

  // Detect auth patterns across all requests
  const { authHeaders, cookieNames } = detectAuthPatterns(requests);

  // Find consistently-present cookies (in >50% of requests)
  const threshold = Math.max(1, requests.length * 0.5);
  const consistentCookies = [...cookieNames.entries()]
    .filter(([, count]) => count >= threshold)
    .sort((a, b) => b[1] - a[1])
    .map(([name]) => name);

  // Consistent auth headers
  const consistentAuthHeaders = [...authHeaders.entries()]
    .filter(([, count]) => count >= threshold)
    .sort((a, b) => b[1] - a[1]);

  // Determine skill name
  const domainPrefix = domain.replace(/\.com$|\.net$|\.org$|\.io$/, '').replace(/\./g, '-');
  const skillName = SKILL_NAME || `api-${domainPrefix}`;

  // --- Generate SKILL.md ---
  const lines = [];
  const now = new Date().toISOString().split('T')[0];

  // Frontmatter
  lines.push('---');
  lines.push(`name: ${skillName}`);
  lines.push(`description: "${domain} internal API — learned endpoints for direct curl access. Use instead of browser for repeat tasks."`);
  lines.push(`metadata: {"openclaw":{"emoji":"🔌"}}`);
  lines.push('---');
  lines.push('');

  // Title
  lines.push(`# ${domain} API (learned ${now})`);
  lines.push('');
  lines.push('**WARNING:** Undocumented internal APIs learned by traffic capture. May change without notice.');
  lines.push(`Captured from ${requests.length} API calls over ${capture.duration || '?'}s.`);
  lines.push('');

  // Auth section
  lines.push('## Authentication');
  lines.push('');
  lines.push('Cookie-based. Extract fresh cookies before each session:');
  lines.push('```bash');
  lines.push(`/opt/OpenClaw/scripts/extract-cookies.js --domain ${domain} --port ${capture.cdpPort || 9222}`);
  lines.push('```');
  lines.push('');

  if (consistentAuthHeaders.length > 0) {
    lines.push('### Required headers');
    lines.push('```');
    for (const [header] of consistentAuthHeaders) {
      lines.push(`${header}`);
    }
    lines.push('Cookie: <output from extract-cookies.js>');
    lines.push('```');
    lines.push('');
  } else {
    lines.push('### Required headers');
    lines.push('```');
    lines.push('Cookie: <output from extract-cookies.js>');
    lines.push('```');
    lines.push('');
  }

  if (consistentCookies.length > 0) {
    lines.push(`### Key cookies (present in >50% of requests)`);
    lines.push(`\`${consistentCookies.slice(0, 20).join('`, `')}\``);
    lines.push('');
  }

  // Endpoints section
  lines.push('## Endpoints');
  lines.push('');

  for (const ep of sortedEndpoints) {
    const queryStr = ep.queryParams.size > 0
      ? '?' + [...ep.queryParams].map(k => `${k}={${k}}`).join('&')
      : '';

    lines.push(`### ${ep.method} ${ep.normalizedPath}${queryStr}  (observed ${ep.requests.length}x)`);
    lines.push('');

    // Pick a representative request (first one with a response body)
    const representative = ep.requests.find(r => r.responseBody && r.responseStatus >= 200 && r.responseStatus < 400)
      || ep.requests[0];

    // Show actual URL example
    lines.push(`**Example URL:** \`${representative.url}\``);
    lines.push('');

    // Status codes observed
    const statusCounts = {};
    for (const r of ep.requests) {
      const s = r.responseStatus || 0;
      statusCounts[s] = (statusCounts[s] || 0) + 1;
    }
    lines.push(`**Status codes:** ${Object.entries(statusCounts).map(([s, c]) => `${s} (${c}x)`).join(', ')}`);
    lines.push('');

    // Curl example
    lines.push('```bash');
    const curlParts = [`curl -s '${representative.url}'`];
    curlParts.push(`  -H 'Cookie: $COOKIES'`);

    // Add notable headers from the representative request
    const skipHeaders = new Set(['cookie', 'host', 'user-agent', 'accept', 'accept-language',
      'accept-encoding', 'connection', 'referer', 'sec-ch-ua', 'sec-ch-ua-mobile',
      'sec-ch-ua-platform', 'sec-fetch-dest', 'sec-fetch-mode', 'sec-fetch-site',
      'origin', 'pragma', 'cache-control', 'content-length', 'if-none-match',
      'if-modified-since']);

    const headers = representative.requestHeaders || {};
    for (const [key, value] of Object.entries(headers)) {
      if (skipHeaders.has(key.toLowerCase())) continue;
      // Truncate long header values
      const displayVal = value.length > 80 ? value.slice(0, 80) + '...' : value;
      curlParts.push(`  -H '${key}: ${displayVal}'`);
    }

    if (representative.requestBody) {
      // Show content type if POST/PUT
      const contentType = headers['Content-Type'] || headers['content-type'] || '';
      if (contentType.includes('json')) {
        curlParts.push(`  -H 'Content-Type: application/json'`);
        curlParts.push(`  -d '${representative.requestBody.slice(0, 500)}'`);
      } else {
        curlParts.push(`  -d '${representative.requestBody.slice(0, 500)}'`);
      }
    }

    lines.push(curlParts.join(' \\\n'));
    lines.push('```');
    lines.push('');

    // Request body schema (for POST/PUT/PATCH)
    if (representative.requestBody && ['POST', 'PUT', 'PATCH'].includes(ep.method)) {
      const schema = inferSchema(representative.requestBody);
      if (schema) {
        lines.push('**Request body schema:**');
        lines.push('```');
        lines.push(schema);
        lines.push('```');
        lines.push('');
      }
    }

    // Response body schema
    if (representative.responseBody && !representative.responseBody.startsWith('[')) {
      const schema = inferSchema(representative.responseBody);
      if (schema) {
        lines.push('**Response schema:**');
        lines.push('```');
        lines.push(schema);
        lines.push('```');
        lines.push('');
      }
    }
  }

  // Fallback section
  lines.push('## Fallback');
  lines.push('');
  lines.push('If API calls return 401/403:');
  lines.push('1. Re-extract cookies using the command above');
  lines.push('2. If still failing, the site may have changed its auth mechanism');
  lines.push('3. Fall back to using the `browser` tool');
  lines.push('4. Report to Gannon that the API skill needs re-capture');
  lines.push('');
  lines.push('## Re-capture');
  lines.push('');
  lines.push('If endpoints have changed or new endpoints are needed:');
  lines.push('```bash');
  lines.push(`/opt/OpenClaw/scripts/capture-api.js --port ${capture.cdpPort || 9222} --duration 300`);
  lines.push(`/opt/OpenClaw/scripts/generate-api-skill.js --domain ${domain} --name ${skillName}`);
  lines.push('```');

  const skillContent = lines.join('\n') + '\n';

  // Write skill file
  const skillDir = path.join(SKILLS_DIR, skillName);
  fs.mkdirSync(skillDir, { recursive: true });
  const skillPath = path.join(skillDir, 'SKILL.md');
  fs.writeFileSync(skillPath, skillContent);

  console.error(`[generate-api-skill] Generated: ${skillPath}`);
  console.error(`[generate-api-skill] ${sortedEndpoints.length} endpoints documented`);

  // Also print to stdout for review
  console.log(skillContent);
}

main();
