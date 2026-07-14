# Workana Sniper Automation

Workana Sniper Automation is a local web app that watches Workana IT projects, generates tailored proposals with Gemini, submits bids through an authenticated browser session, and can optionally reply to incoming Workana chat messages with short informal answers.

The app is built with Express, Vite, React, Playwright, Gemini, and a lightweight `db.json` file.

## What It Does

- Scrapes Workana project listings for IT/programming opportunities.
- Supports all Workana languages through `language=xx`.
- Detects the project language (`pt`, `es`, `en`) and writes the proposal in the same language.
- Filters projects with whitelist and blacklist keywords.
- Generates short, technical, client-specific proposals with Gemini.
- Keeps proposal prices competitive and close to the low end of the client budget.
- Adds a small free sample offer at the end of each proposal.
- Opens the Workana bid form and submits proposals through the same authenticated session used by the browser.
- Uses anti-detection delays between generations, submissions, and chat replies.
- Can auto-reply to Workana inbox messages with short informal chat-style answers.
- Provides a local dashboard for configuration, logs, project review, proposal editing, scraping, auto-submit, and chat auto-reply.

## Tech Stack

- Node.js
- Express
- Vite
- React
- TypeScript
- Playwright
- Gemini API (`@google/genai`)
- File-based storage with `db.json`

## Requirements

- Node.js 20+
- Google Chrome installed locally
- A valid Gemini API key
- A Workana account
- An authenticated Workana session cookie or persistent Playwright profile

## Installation

```bash
npm install
```

Create a `.env` file based on `.env.example`:

```bash
cp .env.example .env
```

Then edit `.env` with your Gemini key and Workana settings.

## Running Locally

```bash
npm run dev
```

The app runs at:

```text
http://localhost:3002
```

## Environment Variables

### Server

```env
PORT=3002
HMR_PORT=24679
```

### Gemini

```env
GEMINI_API_KEY="your_gemini_api_key"
GEMINI_MODEL="gemini-2.5-flash-lite"
```

### Workana Session

```env
FREELAS_EMAIL="your_email"
FREELAS_PASSWORD="your_password"
FREELAS_SESSION_COOKIE="workana_session=..."
PLAYWRIGHT_HEADLESS=true
PLAYWRIGHT_CHANNEL=chrome
USE_PERSISTENT_PROFILE=true
PLAYWRIGHT_USER_DATA_DIR=.workana-profile
```

The recommended flow is to use the persistent browser profile. Open the login browser from the dashboard, sign in manually, and let the app synchronize cookies into `db.json`.

### Scraping

```env
WORKANA_CATEGORY=it-programming
WORKANA_LANGUAGE=xx
SCRAPE_START_PAGE=1
AUTO_SCRAPE=true
SCRAPE_INTERVAL_MS=30000
```

`WORKANA_LANGUAGE=xx` searches projects across all languages.

### Auto Proposal Submission

```env
AUTO_SUBMIT=false
MAX_PROPOSALS_PER_DAY=10
AUTO_PIPELINE_INTERVAL_MS=30000
AUTOPILOT_SUBMIT_DELAY_MS=45000
AUTOPILOT_SUBMIT_JITTER_MS=45000
```

When auto-submit is enabled, the app processes one project at a time:

1. Scrape new jobs.
2. Generate one proposal.
3. Wait a short generation delay.
4. Wait the anti-detection submission delay.
5. Submit one proposal.
6. Repeat on the next loop.

### Pricing Strategy

```env
PRICE_DISCOUNT_FACTOR=0.7
PRICE_BUDGET_LOW_QUARTILE=0.2
```

The app discounts Gemini's suggested price and caps it near the lower part of the client's budget range, while respecting Workana's minimum bid.

### Keyword Filtering

```env
USE_KEYWORD_FILTERS=true
```

Whitelist and blacklist keywords can be edited from the dashboard. When disabled, all scraped projects pass through the pipeline.

### Auto Chat Replies

```env
AUTO_REPLY_MESSAGES=false
AUTO_REPLY_INTERVAL_MS=45000
AUTO_REPLY_DELAY_MS=25000
AUTO_REPLY_JITTER_MS=20000
AUTO_REPLY_MAX_PER_PASS=3
```

When enabled, the app scans the Workana inbox and replies only when the latest message in a thread is from the client. Replies are generated with Gemini and kept short, informal, and conversational.

Example style:

```text
opa, vi aqui
consigo te mandar um mini fluxo ainda hoje
me confirma só o prazo que vc precisa?
```

## Dashboard Features

- Scrape Workana jobs manually.
- Enable or disable full auto mode.
- Enable or disable chat auto-reply.
- Open a visible browser for manual Workana login.
- Configure Gemini model and session settings.
- Edit keyword filters.
- Review scraped opportunities.
- Generate proposals manually.
- Edit proposal text, price, and delivery time.
- Submit pending proposals.
- View logs for scraping, generation, submission, and chat replies.

## Main Project Files

```text
server.ts                    Express API, automation loops, Gemini generation
src/App.tsx                  React dashboard
src/types.ts                 Shared project/config/log types
lib/workana-scrape.ts        Workana job scraping and parsing
lib/submit-proposals.ts      Proposal submission orchestration
lib/workana-bid-api.ts       Direct Workana bid API payload and auth helpers
lib/workana-messages.ts      Inbox scanning and auto-reply logic
lib/browser-session.ts       Persistent browser session and cookie sync
lib/budget-utils.ts          Budget parsing and competitive price normalization
lib/job-language.ts          Job language detection
db.json                      Local database generated at runtime
```

## Scripts

```bash
npm run dev
npm run build
npm run start
npm run lint
```

## Notes

This tool is designed to run locally with your own Workana account and browser profile. Keep `.env`, `db.json`, and the Playwright profile private because they may contain session data.

Use automation responsibly and tune delays, filters, and daily limits according to your account behavior.
