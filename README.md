# 99Freelas Sniper Automation

Local dashboard for monitoring 99Freelas projects, generating short AI-assisted proposals, and submitting them through an authenticated browser session.

The app is built with React, Express, Gemini, and Playwright. It is designed to run locally against your own freelancer account and keep operational data in local JSON files.

## What It Does

- Scrapes 99Freelas project listings across configurable categories.
- Filters projects with whitelist and blacklist keywords.
- Uses Gemini to generate concise, human-sounding proposals.
- Suggests a competitive price and delivery time for each project.
- Optionally submits proposal forms through Playwright.
- Runs an automatic loop that scrapes, generates, queues, and submits eligible proposals.
- Detects client questions or messages when possible and appends a short technical reply that reinforces the free proof-of-concept offer.
- Stores runtime logs separately from the project database to keep the dashboard responsive.

## Tech Stack

- Node.js + TypeScript
- Express API server
- React + Vite dashboard
- Gemini API via `@google/genai`
- Playwright for authenticated browser automation
- Local JSON persistence (`db.json` and `logs.json`)

## Project Flow

1. The scraper loads configured 99Freelas category URLs.
2. Parsed projects are deduplicated by project ID.
3. Blacklist and whitelist filters decide which projects enter the dashboard.
4. Gemini generates a proposal, suggested price, and suggested delivery time.
5. The proposal can be reviewed manually or sent by the worker.
6. Autopilot can continuously run scrape + generation + submission cycles.

## Setup

Install dependencies:

```bash
npm install
```

Copy the environment example:

```bash
cp .env.example .env
```

Fill in at least:

```env
GEMINI_API_KEY="your_gemini_key"
FREELAS_EMAIL="your_99freelas_email"
FREELAS_PASSWORD="your_99freelas_password"
```

For reliable 99Freelas access, use the persistent browser profile or paste a valid session cookie:

```env
USE_PERSISTENT_PROFILE=true
PLAYWRIGHT_USER_DATA_DIR=.99freelas-profile
FREELAS_SESSION_COOKIE="JSESSIONID=...; kmlicin=...; kmlicn=...; sgcn=..."
```

Run locally:

```bash
npm run dev
```

By default, the app runs on:

```text
http://localhost:3001
```

## Environment Variables

### Core

```env
PORT=3001
GEMINI_API_KEY="..."
GEMINI_MODEL="gemini-2.5-flash-lite"
```

### 99Freelas Session

```env
FREELAS_EMAIL="..."
FREELAS_PASSWORD="..."
FREELAS_SESSION_COOKIE="..."
PLAYWRIGHT_HEADLESS=true
USE_PERSISTENT_PROFILE=true
PLAYWRIGHT_USER_DATA_DIR=.99freelas-profile
```

### Scraping

```env
AUTO_SCRAPE=true
SCRAPE_START_PAGE=1
SCRAPE_INTERVAL_MS=30000
SCRAPE_CATEGORIES=web-mobile-e-software,vendas-e-marketing,fotografia-e-audiovisual,design-e-criacao
```

`SCRAPE_CATEGORIES` accepts simple category slugs or complete query fragments. Examples:

```env
SCRAPE_CATEGORIES=web-mobile-e-software
SCRAPE_CATEGORIES=web-mobile-e-software&sub-categorias=desenvolvimento-mobile
SCRAPE_CATEGORIES=web-mobile-e-software,vendas-e-marketing,design-e-criacao
```

### Autopilot

```env
AUTO_LOOP_INTERVAL_MS=180000
AUTOPILOT_BATCH_SIZE=10
AUTOPILOT_MAX_BIDS=5
AUTOPILOT_GENERATE_DELAY_MS=2500
AUTOPILOT_GENERATE_JITTER_MS=3500
AUTOPILOT_SUBMIT_DELAY_MS=45000
AUTOPILOT_SUBMIT_JITTER_MS=45000
```

### Pricing

```env
PROPOSAL_PRICE_FACTOR=0.5
```

`PROPOSAL_PRICE_FACTOR` is applied after Gemini suggests a price. For example, `0.5` cuts the generated price in half.

## Dashboard Controls

- **Scrape**: manually imports projects from configured categories.
- **Generate Proposal**: generates proposal text, price, and deadline for the selected project.
- **Submit Queue**: sends pending proposals through Playwright.
- **Autopilot**: starts or stops the continuous scrape + generate + submit loop.
- **Whitelist Toggle**: enables or disables keyword-based project filtering.

## Data Files

These files are local runtime state and should not be committed:

```text
db.json
logs.json
.env
.99freelas-profile/
```

`db.json.example` and `.env.example` are safe templates for new environments.

## Useful Commands

```bash
npm run dev
npm run build
npm run start
npm run lint
```

## Notes

- Existing generated proposals are not automatically rewritten when prompt rules change.
- Restart `npm run dev` after changing `.env` or scraper configuration.
- 99Freelas may require a valid browser session; persistent profile login is usually more reliable than email/password automation.
