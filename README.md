# apiscope

Passive CDP traffic capture → API pattern analysis → OpenClaw SKILL.md generation.

Replaces flaky browser automation with direct `curl` calls by learning a site's internal APIs from live traffic.

## How it works

1. **Capture** — Connects to a Chromium DevTools Protocol endpoint, enables `Network.enable` (read-only), and records all XHR/Fetch API calls while you browse normally.
2. **Generate** — Analyzes captured traffic: normalizes URLs, groups endpoints, infers request/response schemas, detects auth patterns, and produces a SKILL.md with curl examples.
3. **Extract cookies** — Pulls fresh session cookies from the live browser via CDP for use in curl calls.

## Scripts

| Script | Purpose |
|---|---|
| `bin/capture.js` | CDP traffic capture (passive, no page interaction) |
| `bin/generate-skill.js` | Analyze captures → generate SKILL.md |
| `bin/extract-cookies.js` | Extract fresh cookies from live browser session |

## Usage

```bash
# Start capturing traffic (browse the site normally during this)
bin/capture.js --port 9222 --duration 300

# Generate an API skill from captured traffic
bin/generate-skill.js --domain example.com

# Extract fresh cookies for curl calls
COOKIES=$(bin/extract-cookies.js --domain example.com --port 9222)
curl -s 'https://www.example.com/api/search?q=test' -H "Cookie: $COOKIES"
```

## OpenClaw integration

- `skill/SKILL.md` — Instruction skill teaching agents the capture → curl workflow
- Generated per-domain skills go in `/opt/OpenClaw/.openclaw/skills/api-<domain>/`
- Capture data stored in `/opt/OpenClaw/.openclaw/captures/<domain>/`

## Prerequisites

- Node.js
- `ws` module (bundled with OpenClaw at `/opt/OpenClaw/.npm-global/lib/node_modules/openclaw/node_modules/ws/`)
- Chromium with CDP enabled (e.g., OpenClaw VNC desktop browser)

## Design principles

- **Zero dependencies** — Uses only Node.js stdlib + the `ws` module already bundled with OpenClaw
- **Passive capture** — `Network.enable` is read-only; doesn't navigate, click, or modify page state
- **No token storage** — Generated skills document auth *patterns*, not actual values
- **Operator-initiated** — Capture requires manual start, not background surveillance
- **Local only** — No external communication, telemetry, or cloud services
