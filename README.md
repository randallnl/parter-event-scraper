# Partner Event Scraper

A small Python scraper for collecting event and announcement information from partner websites into normalized CSV or JSON.

It also includes a Cloudflare Worker entry point that can run the incoming-event
scrape on a daily cron and write events to Monday.com.

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

To write incoming dated events to Monday.com, set a Monday API token and add
`--write-monday`:

```bash
export MONDAY_API_TOKEN="your-token"
partner-events scrape --write-monday --output events.csv
```

By default this writes future/current `event` records to board `18420375431` with:

- event date: `date_mm4w9x8p`
- event title: `text_mm4whrb1`
- event details: `text_mm4wpkzw`
- event link: `link_mm4w7r6`

## Cloudflare Worker Secret Binding

If this runs from a Cloudflare Worker, bind the Monday token as
`MONDAY_API_TOKEN`. In `wrangler.jsonc`, the secret-store binding should look
like this:

```jsonc
"secrets_store_secrets": [
  {
    "binding": "MONDAY_API_TOKEN",
    "store_id": "2b9ec8a0d6d742649ad4d3498815ca54",
    "secret_name": "Central_Monday_API_TOKEN"
  }
]
```

Worker code should read the token from the Worker environment binding:

```js
env.MONDAY_API_TOKEN
```

For local CLI runs, keep using the environment variable with the same name:

```bash
export MONDAY_API_TOKEN="your-token"
```

## Deploy Worker

```bash
npm install
npm run deploy
```

The Worker is deployed as `parter-event-scraper` and configured in
`wrangler.jsonc` to run daily at `13:00 UTC`. You can also manually trigger it
by sending a `POST` request to the deployed Worker.

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
