# Partner Event Scraper

A small Python scraper for collecting event and announcement information from partner websites into normalized CSV or JSON.

It also includes a Cloudflare Worker entry point that can run the incoming-event
scrape on a daily cron. The Worker now asks NH Solidarity Ecosystem which
organizations to scrape, scrapes those sources, and imports normalized events
back into NH Solidarity Ecosystem.

## Setup

```bash
python3 -m venv .venv
source .venv/bin/activate
python -m pip install -e ".[dev]"
```

## Run

```bash
partner-events scrape --output events.csv
partner-events scrape --format json --output events.json
```

The Python CLI can still write incoming dated events to Monday.com for local
runs. Set a Monday API token and add `--write-monday`:

```bash
export MONDAY_API_TOKEN="your-token"
partner-events scrape --write-monday --output events.csv
```

By default this writes future/current `event` records to board `18420375431` with:

- event date: `date_mm4w9x8p`
- event title: `text_mm4whrb1`
- event details: `text_mm4wpkzw`
- event link: `link_mm4w7r6`

For local CLI runs, keep using the environment variable:

```bash
export MONDAY_API_TOKEN="your-token"
```

## Deploy Worker

Set the shared scraper token in this project and in the NH Ecosystem Worker
project. Both Workers must use the same value:

```bash
npx wrangler secret put SCRAPER_API_TOKEN
```

Manual Worker runs are disabled unless you set a separate admin token:

```bash
npx wrangler secret put SCRAPER_ADMIN_TOKEN
```

Then deploy:

```bash
npm install
npm run deploy
```

The Worker is deployed as `parter-event-scraper` and configured in
`wrangler.jsonc` to run daily at `13:00 UTC`. It uses
`ECOSYSTEM_BASE_URL=https://nhsolidarityecosystem.com`.

With `SCRAPER_ADMIN_TOKEN` set, you can manually trigger it with:

```bash
curl -X POST https://parter-event-scraper.randall-d53.workers.dev \
  -H "Authorization: Bearer $SCRAPER_ADMIN_TOKEN"
```

The default partner list lives in `partners.yaml`. Add new partners there and choose the parser that best matches the site:

- `squarespace_events`: dated event listings with event titles, calendar links, and "View Event" links.
- `heading_date_events`: event pages where date headings sit near event title headings.
- `squarespace_blog`: Squarespace blog or announcement listings.
- `wordpress_posts`: WordPress category/archive post listings.
- `generic_links`: fallback that records dated links from simple pages.

## Output Fields

Each record includes:

- `partner`
- `title`
- `start_date`
- `end_date`
- `start_time`
- `end_time`
- `location`
- `description`
- `url`
- `source_url`
- `kind`
- `scraped_at`

Some partner pages expose full event details; others expose only post/article summaries. Empty fields are left blank instead of guessed.
