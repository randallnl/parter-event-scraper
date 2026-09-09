const IMPORT_BATCH_SIZE = 500;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/health") {
      return Response.json({ ok: true });
    }

    if (request.method === "GET" && url.pathname === "/workspace") {
      return workspaceResponse();
    }

    if (request.method === "POST" && url.pathname === "/api/parse-url") {
      return parseUrlWorkspaceRequest(request, env);
    }

    if (request.method !== "POST") {
      return new Response("POST to run the event scraper, or GET /workspace.", {
        status: 405,
        headers: { Allow: "POST" },
      });
    }

    const authError = await validateManualRun(request, env);
    if (authError) {
      return authError;
    }

    try {
      return Response.json(await scrapeAndImport(env));
    } catch (error) {
      return Response.json(
        { error: error instanceof Error ? error.message : String(error) },
        { status: 500 },
      );
    }
  },

  async scheduled(_event, env, ctx) {
    ctx.waitUntil(
      scrapeAndImport(env).catch((error) => {
        console.error(error);
      }),
    );
  },
};

async function parseUrlWorkspaceRequest(request, env) {
  const authError = await validateManualRun(request, env);
  if (authError) {
    return authError;
  }

  try {
    const input = await request.json();
    const partner = workspacePartner(input);
    const response = await fetch(partner.url, {
      headers: {
        "User-Agent": "NH-Ecosystem-Event-Scraper/1.0",
      },
    });

    if (!response.ok) {
      throw new Error(`Source returned ${response.status}`);
    }

    const html = await response.text();
    const parsedRecords = await parsePartner(html, partner);
    const records = input.include_details === false
      ? parsedRecords
      : await enrichBlogRecords(parsedRecords, partner);
    const deduped = deduplicate(records).sort((a, b) =>
      (a.startDate || "").localeCompare(b.startDate || ""),
    );

    return Response.json({
      ok: true,
      partner,
      fetched_bytes: html.length,
      records: deduped,
      import_payload: {
        records: deduped.map(toImportRecord),
      },
    });
  } catch (error) {
    return Response.json(
      { ok: false, error: error instanceof Error ? error.message : String(error) },
      { status: 400 },
    );
  }
}

function workspacePartner(input) {
  const url = String(input.url || "").trim();
  const parser = String(input.parser || "").trim();
  const parsedUrl = new URL(url);

  if (!["http:", "https:"].includes(parsedUrl.protocol)) {
    throw new Error("URL must start with http:// or https://.");
  }
  if (!parser) {
    throw new Error("Choose a parser.");
  }

  return {
    name: String(input.name || parsedUrl.hostname).trim(),
    url: parsedUrl.toString(),
    parser,
    kind: String(input.kind || "event").trim() || "event",
  };
}

function workspaceResponse() {
  return new Response(workspaceHtml(), {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}

function workspaceHtml() {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Partner URL Parser Workspace</title>
  <style>
    :root {
      color-scheme: light;
      --bg: #f7f7f4;
      --panel: #ffffff;
      --ink: #1e2422;
      --muted: #62706b;
      --line: #d8ddd7;
      --accent: #1f6f68;
      --accent-2: #9a5b2f;
      --error: #9e2f2f;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      font: 15px/1.45 system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      color: var(--ink);
      background: var(--bg);
    }
    header {
      padding: 20px 24px 14px;
      border-bottom: 1px solid var(--line);
      background: var(--panel);
    }
    h1 { margin: 0 0 4px; font-size: 22px; letter-spacing: 0; }
    header p { margin: 0; color: var(--muted); max-width: 860px; }
    main {
      display: grid;
      grid-template-columns: minmax(320px, 420px) minmax(0, 1fr);
      gap: 16px;
      padding: 16px;
    }
    form, .results, .record {
      background: var(--panel);
      border: 1px solid var(--line);
      border-radius: 8px;
    }
    form { padding: 16px; align-self: start; position: sticky; top: 16px; }
    label { display: block; margin: 0 0 12px; font-weight: 650; }
    input, select, textarea, button {
      width: 100%;
      margin-top: 5px;
      border: 1px solid var(--line);
      border-radius: 6px;
      padding: 10px 11px;
      font: inherit;
      background: white;
      color: var(--ink);
    }
    textarea { min-height: 74px; resize: vertical; }
    .row { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
    .check {
      display: flex;
      align-items: center;
      gap: 9px;
      font-weight: 500;
      color: var(--muted);
    }
    .check input { width: auto; margin: 0; }
    button {
      margin-top: 8px;
      border-color: var(--accent);
      background: var(--accent);
      color: white;
      font-weight: 700;
      cursor: pointer;
    }
    button:disabled { opacity: .58; cursor: progress; }
    .hint { color: var(--muted); font-size: 13px; margin-top: 8px; }
    .results { padding: 16px; min-height: 300px; overflow: hidden; }
    .summary {
      display: flex;
      gap: 10px;
      flex-wrap: wrap;
      margin-bottom: 12px;
      color: var(--muted);
    }
    .pill {
      border: 1px solid var(--line);
      border-radius: 999px;
      padding: 4px 9px;
      background: #fafbf9;
    }
    .error { color: var(--error); font-weight: 650; }
    .record { margin: 12px 0; padding: 12px; display: grid; grid-template-columns: 120px minmax(0, 1fr); gap: 12px; }
    .record img {
      width: 120px;
      height: 120px;
      object-fit: cover;
      border-radius: 6px;
      border: 1px solid var(--line);
      background: #eef1ed;
    }
    .no-image {
      display: grid;
      place-items: center;
      width: 120px;
      height: 120px;
      border-radius: 6px;
      border: 1px dashed var(--line);
      color: var(--muted);
      font-size: 12px;
    }
    h2 { margin: 0 0 6px; font-size: 17px; }
    .meta { color: var(--muted); font-size: 13px; margin-bottom: 8px; }
    .desc {
      max-height: 8.8em;
      overflow: auto;
      border-top: 1px solid var(--line);
      padding-top: 8px;
      white-space: pre-wrap;
    }
    details { margin-top: 14px; }
    pre {
      overflow: auto;
      background: #202522;
      color: #edf2ee;
      border-radius: 8px;
      padding: 12px;
      font-size: 12px;
      line-height: 1.5;
    }
    @media (max-width: 820px) {
      main { grid-template-columns: 1fr; }
      form { position: static; }
      .record { grid-template-columns: 1fr; }
      .record img, .no-image { width: 100%; height: 180px; }
    }
  </style>
</head>
<body>
  <header>
    <h1>Partner URL Parser Workspace</h1>
    <p>Paste a partner URL, choose the parser you want to test, and inspect the normalized records without importing them.</p>
  </header>
  <main>
    <form id="parser-form">
      <label>Admin token
        <input id="admin-token" type="password" autocomplete="off" placeholder="SCRAPER_ADMIN_TOKEN">
      </label>
      <label>Partner URL
        <textarea id="url" required placeholder="https://queerlective.com/blogs/upcoming-events"></textarea>
      </label>
      <div class="row">
        <label>Parser
          <select id="parser" required>
            <option value="embedded_calendar">embedded_calendar</option>
            <option value="mobilize_events">mobilize_events</option>
            <option value="shopify_blog_events">shopify_blog_events</option>
            <option value="squarespace_events">squarespace_events</option>
            <option value="heading_date_events">heading_date_events</option>
            <option value="squarespace_blog">squarespace_blog</option>
            <option value="wordpress_posts">wordpress_posts</option>
            <option value="generic_links">generic_links</option>
          </select>
        </label>
        <label>Kind
          <select id="kind">
            <option value="event">event</option>
            <option value="announcement">announcement</option>
          </select>
        </label>
      </div>
      <label>Partner name
        <input id="name" placeholder="Optional; defaults to hostname">
      </label>
      <label class="check">
        <input id="include-details" type="checkbox" checked>
        Fetch full blog/article detail pages
      </label>
      <button id="submit" type="submit">Parse URL</button>
      <p class="hint">The token is only sent as a bearer token to this Worker. Results are not imported into NH Ecosystem.</p>
    </form>
    <section class="results" id="results">
      <div class="summary"><span class="pill">Ready</span></div>
      <p class="hint">Parsed records will appear here, followed by the exact import payload JSON.</p>
    </section>
  </main>
  <script>
    const form = document.querySelector("#parser-form");
    const results = document.querySelector("#results");
    const button = document.querySelector("#submit");

    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      button.disabled = true;
      results.innerHTML = '<div class="summary"><span class="pill">Parsing...</span></div>';
      const token = document.querySelector("#admin-token").value.trim();
      const body = {
        url: document.querySelector("#url").value.trim(),
        parser: document.querySelector("#parser").value,
        kind: document.querySelector("#kind").value,
        name: document.querySelector("#name").value.trim(),
        include_details: document.querySelector("#include-details").checked,
      };

      try {
        const response = await fetch("/api/parse-url", {
          method: "POST",
          headers: {
            "Authorization": "Bearer " + token,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(body),
        });
        const data = await response.json();
        if (!response.ok || !data.ok) throw new Error(data.error || "Parse failed");
        renderResults(data);
      } catch (error) {
        results.innerHTML = '<p class="error">' + escapeHtml(error.message) + '</p>';
      } finally {
        button.disabled = false;
      }
    });

    function renderResults(data) {
      const records = data.import_payload.records;
      results.innerHTML = [
        '<div class="summary">',
        '<span class="pill">' + records.length + ' records</span>',
        '<span class="pill">' + data.fetched_bytes + ' bytes fetched</span>',
        '<span class="pill">' + escapeHtml(data.partner.parser) + '</span>',
        '</div>',
        records.map(renderRecord).join(''),
        '<details open><summary>Import payload JSON</summary><pre>' + escapeHtml(JSON.stringify(data.import_payload, null, 2)) + '</pre></details>',
        '<details><summary>Raw parser records</summary><pre>' + escapeHtml(JSON.stringify(data.records, null, 2)) + '</pre></details>',
      ].join('');
    }

    function renderRecord(record) {
      const image = record.image_url
        ? '<img src="' + escapeHtml(record.image_url) + '" alt="">'
        : '<div class="no-image">No image</div>';
      return '<article class="record">' +
        image +
        '<div>' +
          '<h2>' + escapeHtml(record.title || '(untitled)') + '</h2>' +
          '<div class="meta">' +
            escapeHtml([record.start_date, record.start_time, record.location].filter(Boolean).join(' | ')) +
          '</div>' +
          '<div class="meta"><a href="' + escapeHtml(record.url) + '" target="_blank" rel="noreferrer">' + escapeHtml(record.url) + '</a></div>' +
          '<div class="desc">' + escapeHtml(record.description || '') + '</div>' +
        '</div>' +
      '</article>';
    }

    function escapeHtml(value) {
      return String(value ?? '').replace(/[&<>"']/g, (char) => ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#39;',
      })[char]);
    }
  </script>
</body>
</html>`;
}

async function scrapeAndImport(env) {
  const partners = await fetchPartners(env);
  const records = [];
  const failures = [];

  for (const partner of partners) {
    try {
      const response = await fetch(partner.url, {
        headers: {
          "User-Agent": "NH-Ecosystem-Event-Scraper/1.0",
        },
      });

      if (!response.ok) {
        throw new Error(`Source returned ${response.status}`);
      }

      const html = await response.text();
      const partnerRecords = await parsePartner(html, partner);
      records.push(...(await enrichBlogRecords(partnerRecords, partner)));
    } catch (error) {
      failures.push({
        partner: partner.name,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const events = deduplicate(records)
    .filter(isIncomingEvent)
    .sort((a, b) => a.startDate.localeCompare(b.startDate));
  const result = await importEventsInChunks(env, events);

  return {
    partners: partners.length,
    scraped: records.length,
    submitted: events.length,
    imported: result.imported,
    skipped: result.skipped,
    failures,
  };
}

async function fetchPartners(env) {
  const response = await env.SOQNH_ONLINE.fetch(
    `${ecosystemBaseUrl(env)}/api/scraper/organizations`,
    {
      headers: {
        Authorization: `Bearer ${await scraperApiToken(env)}`,
        Accept: "application/json",
      },
    },
  );

  if (!response.ok) {
    throw new Error(
      `Could not load organizations: ${response.status} ${await response.text()}`,
    );
  }

  const body = await response.json();
  return body.partners || [];
}

async function importEventsInChunks(env, records) {
  const totals = { imported: 0, skipped: 0 };

  for (let index = 0; index < records.length; index += IMPORT_BATCH_SIZE) {
    const result = await importEvents(
      env,
      records.slice(index, index + IMPORT_BATCH_SIZE),
    );
    totals.imported += Number(result.imported || 0);
    totals.skipped += Number(result.skipped || 0);
  }

  return totals;
}

async function importEvents(env, records) {
  const response = await env.SOQNH_ONLINE.fetch(
    `${ecosystemBaseUrl(env)}/api/scraper/events`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${await scraperApiToken(env)}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        records: records.map(toImportRecord),
      }),
    },
  );

  if (!response.ok) {
    throw new Error(
      `Event import failed: ${response.status} ${await response.text()}`,
    );
  }

  return response.json();
}

async function parsePartner(html, partner) {
  const cleanHtml = stripIgnoredHtml(html);

  switch (partner.parser) {
    case "squarespace_events":
      return parseSquarespaceEvents(cleanHtml, partner);
    case "heading_date_events":
      return parseHeadingDateEvents(cleanHtml, partner);
    case "generic_links":
      return parseGenericLinks(cleanHtml, partner);
    case "squarespace_blog":
      return parseSquarespaceBlog(cleanHtml, partner);
    case "wordpress_posts":
      return parseWordPressPosts(cleanHtml, partner);
    case "shopify_blog_events":
      return parseShopifyBlogEvents(cleanHtml, partner);
    case "embedded_calendar":
      return parseEmbeddedCalendar(html, cleanHtml, partner);
    case "mobilize_events":
      return parseMobilizeEvents(html, partner);
    default:
      throw new Error(`Unsupported parser: ${partner.parser}`);
  }
}

async function parseMobilizeEvents(html, partner) {
  const organizationId = mobilizeOrganizationId(html, partner);
  if (!organizationId) {
    throw new Error("Could not find a Mobilize organization id in the page.");
  }

  const records = [];
  let nextUrl = mobilizeEventsApiUrl(organizationId);
  for (let page = 0; nextUrl && page < 4; page += 1) {
    const response = await fetch(nextUrl, {
      headers: {
        "User-Agent": "NH-Ecosystem-Event-Scraper/1.0",
        Accept: "application/json",
      },
    });
    if (!response.ok) {
      throw new Error(`Mobilize API returned ${response.status}`);
    }

    const body = await response.json();
    records.push(...mobilizeRecords(body.data || [], partner));
    nextUrl = typeof body.next === "string" ? body.next : "";
  }

  return deduplicate(records);
}

function mobilizeEventsApiUrl(organizationId) {
  const url = new URL(`https://api.mobilize.us/v1/organizations/${organizationId}/events`);
  url.searchParams.set("per_page", "100");
  url.searchParams.set("timeslot_start", "gte_now");
  return url.toString();
}

function mobilizeOrganizationId(html, partner) {
  if (partner.mobilize_organization_id || partner.mobilizeOrganizationId) {
    return String(partner.mobilize_organization_id || partner.mobilizeOrganizationId);
  }

  const slug = mobilizeSlug(partner.url);
  if (!slug) {
    return "";
  }

  const patterns = [
    new RegExp(`"current_organization"\\s*:\\s*\\{[^}]*"id"\\s*:\\s*(\\d+)[^}]*"slug"\\s*:\\s*"${escapeRegExp(slug)}"`, "i"),
    new RegExp(`"organization"\\s*:\\s*\\{[^}]*"id"\\s*:\\s*(\\d+)[^}]*"slug"\\s*:\\s*"${escapeRegExp(slug)}"`, "i"),
    new RegExp(`"id"\\s*:\\s*(\\d+)[^{}]{0,600}"slug"\\s*:\\s*"${escapeRegExp(slug)}"`, "i"),
  ];
  for (const pattern of patterns) {
    const match = html.match(pattern);
    if (match) {
      return match[1];
    }
  }
  return "";
}

function mobilizeSlug(url) {
  try {
    const parsed = new URL(url);
    if (!/(^|\.)mobilize\.us$/i.test(parsed.hostname)) {
      return "";
    }
    return parsed.pathname.split("/").filter(Boolean)[0] || "";
  } catch (_error) {
    return "";
  }
}

function mobilizeRecords(events, partner) {
  const records = [];
  for (const event of events) {
    const timeslots = Array.isArray(event.timeslots) ? event.timeslots : [];
    for (const timeslot of timeslots) {
      const start = mobilizeDateTime(timeslot.start_date, event.timezone);
      const end = mobilizeDateTime(timeslot.end_date, event.timezone);
      if (!event.title || !start.date) {
        continue;
      }

      records.push({
        partner: partner.name,
        title: cleanText(event.title),
        startDate: start.date,
        endDate: end.date,
        startTime: start.time,
        endTime: end.time,
        location: mobilizeLocation(event),
        description: shorten(textFromHtml(event.description || event.summary || ""), 1800),
        imageUrl: event.featured_image_url || event.sponsor?.logo_url || "",
        url: event.browser_url || partner.url,
        sourceUrl: partner.url,
        kind: partner.kind || "event",
        scrapedAt: new Date().toISOString(),
      });
    }
  }
  return records;
}

function mobilizeDateTime(timestamp, timezone = "America/New_York") {
  const seconds = Number(timestamp);
  if (!Number.isFinite(seconds) || seconds <= 0) {
    return { date: "", time: "" };
  }
  const date = new Date(seconds * 1000);
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone || "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "numeric",
    minute: "2-digit",
  }).formatToParts(date);
  const value = (type) => parts.find((part) => part.type === type)?.value || "";
  const dayPeriod = value("dayPeriod");
  return {
    date: `${value("year")}-${value("month")}-${value("day")}`,
    time: cleanText(`${value("hour")}:${value("minute")} ${dayPeriod}`).toUpperCase(),
  };
}

function mobilizeLocation(event) {
  if (event.is_virtual) {
    return event.virtual_action_url ? `Virtual: ${event.virtual_action_url}` : "Virtual";
  }
  const location = event.location || {};
  return cleanText([
    location.venue,
    ...(Array.isArray(location.address_lines) ? location.address_lines : []),
    location.locality,
    location.region,
    location.postal_code,
  ].filter(Boolean).join(", "));
}

async function parseEmbeddedCalendar(rawHtml, cleanHtml, partner) {
  const records = [
    ...parseCalendarLikeHtml(cleanHtml, partner),
    ...parseJsonLdEvents(rawHtml, partner),
  ];
  const candidates = embeddedCalendarUrls(rawHtml, partner.url);

  for (const url of candidates.slice(0, 6)) {
    try {
      const response = await fetch(url, {
        headers: {
          "User-Agent": "NH-Ecosystem-Event-Scraper/1.0",
          Accept: "text/html,application/xhtml+xml,application/xml,text/calendar,*/*",
        },
      });
      if (!response.ok) {
        throw new Error(`Embedded source returned ${response.status}`);
      }

      const body = await response.text();
      if (/BEGIN:VCALENDAR/i.test(body)) {
        records.push(...parseIcsEvents(body, partner, url));
      } else {
        const childHtml = stripIgnoredHtml(body);
        records.push(...parseCalendarLikeHtml(childHtml, { ...partner, url }));
        records.push(...parseJsonLdEvents(body, { ...partner, url }));
      }
    } catch (error) {
      console.error(`Could not parse embedded calendar ${url}: ${error.message}`);
    }
  }

  return deduplicate(records);
}

function parseCalendarLikeHtml(html, partner) {
  return [
    ...parseSquarespaceEvents(html, partner),
    ...parseHeadingDateEvents(html, partner),
    ...parseGenericLinks(html, partner),
  ];
}

function embeddedCalendarUrls(html, sourceUrl) {
  const urls = new Set();
  const source = new URL(sourceUrl);
  const attrRegex = /\b(?:src|href|data-src)=["']([^"']+)["']/gi;

  for (const match of html.matchAll(attrRegex)) {
    const value = decodeHtmlAttribute(match[1]);
    if (!isCalendarCandidate(value)) {
      continue;
    }
    urls.add(absoluteUrl(value, sourceUrl));
  }

  if (/\/calendar\/?$/i.test(source.pathname)) {
    urls.add(new URL("/calendar-events", source.origin).toString());
    urls.add(new URL("/events", source.origin).toString());
  }

  return [...urls].filter((url) => {
    const parsed = new URL(url);
    return ["http:", "https:"].includes(parsed.protocol);
  });
}

function isCalendarCandidate(value) {
  return /(?:calendar|event|events|ical|ics|tockify|trumba|localist|eventbrite|google\.com\/calendar)/i.test(value);
}

function parseSquarespaceEvents(html, partner) {
  const records = [];
  const headings = headingMatches(html);

  for (let index = 0; index < headings.length; index += 1) {
    const heading = headings[index];
    const title = textFromHtml(heading.content);
    if (!title || /^(upcoming events|past events)$/i.test(title)) {
      continue;
    }

    const nextIndex = headings[index + 1]?.index ?? html.length;
    const article = squarespaceEventArticleHtml(html, heading.index);
    const block = article || html.slice(heading.index + heading.raw.length, nextIndex);
    const blockText = textFromHtml(block);
    const dateText = firstLongDate(blockText);
    if (!dateText) {
      continue;
    }

    const timeRange = parseTimeRange(blockText);
    records.push({
      partner: partner.name,
      title,
      startDate: normalizeDate(dateText),
      endDate: secondLongDate(blockText),
      startTime: timeRange.startTime,
      endTime: timeRange.endTime,
      location: locationFromText(blockText),
      description: shorten(removeCalendarNoise(blockText), 700),
      imageUrl: firstImageUrl(block, partner.url),
      url: absoluteUrl(firstHref(heading.content) || firstHref(block) || partner.url, partner.url),
      sourceUrl: partner.url,
      kind: partner.kind || "event",
      scrapedAt: new Date().toISOString(),
    });
  }

  return records;
}

function parseHeadingDateEvents(html, partner) {
  const records = [];
  const tokenRegex = /(<h[1-3][^>]*>[\s\S]*?<\/h[1-3]>|<p[^>]*>[\s\S]*?<\/p>)/gi;
  const tokens = [...html.matchAll(tokenRegex)];
  let currentDate = "";

  for (let index = 0; index < tokens.length; index += 1) {
    const raw = tokens[index][1];
    const text = textFromHtml(raw);
    const dateText = firstLongDate(text);
    if (dateText) {
      currentDate = normalizeDate(dateText);
      continue;
    }
    if (!currentDate || !/^<h[1-3]/i.test(raw)) {
      continue;
    }
    if (/^(past events|filter events)$/i.test(text)) {
      continue;
    }

    const blockText = textFromHtml(
      tokens.slice(index + 1, index + 5).map((token) => token[1]).join(" "),
    );
    const timeRange = parseTimeRange(blockText);
    records.push({
      partner: partner.name,
      title: text,
      startDate: currentDate,
      startTime: timeRange.startTime,
      endTime: timeRange.endTime,
      location: locationFromText(blockText),
      description: shorten(blockText, 700),
      imageUrl: firstImageUrl(raw + blockText, partner.url),
      url: absoluteUrl(firstHref(raw) || partner.url, partner.url),
      sourceUrl: partner.url,
      kind: partner.kind || "event",
      scrapedAt: new Date().toISOString(),
    });
  }

  return records;
}

function parseGenericLinks(html, partner) {
  const records = [];
  const linkRegex = /<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;

  for (const match of html.matchAll(linkRegex)) {
    const text = textFromHtml(match[2]);
    const dateText = firstIsoDate(text) || firstShortDate(text) || firstLongDate(text);
    if (!text || !dateText) {
      continue;
    }

    records.push({
      partner: partner.name,
      title: cleanText(text.replace(dateText, "")) || text,
      startDate: normalizeDate(dateText),
      description: shorten(text, 400),
      imageUrl: firstImageUrl(match[0], partner.url),
      url: absoluteUrl(match[1], partner.url),
      sourceUrl: partner.url,
      kind: partner.kind || "event",
      scrapedAt: new Date().toISOString(),
    });
  }

  return records;
}

function parseSquarespaceBlog(html, partner) {
  const records = [];
  const headings = headingMatches(html);

  for (let index = 0; index < headings.length; index += 1) {
    const heading = headings[index];
    const title = textFromHtml(heading.content);
    if (!title || title.toLowerCase() === "nhcje blog") {
      continue;
    }

    const previous = previousHtml(html, headings, index, 180);
    const following = followingHtml(html, headings, index, 500);
    const nearbyText = textFromHtml(`${previous} ${following}`);
    const dateText = firstPostDate(nearbyText);
    if (!dateText) {
      continue;
    }

    records.push({
      partner: partner.name,
      title,
      startDate: normalizeDate(dateText),
      description: shorten(textFromHtml(following), 500),
      imageUrl: firstImageUrl(`${heading.raw} ${following}`, partner.url),
      url: absoluteUrl(firstHref(heading.content) || partner.url, partner.url),
      sourceUrl: partner.url,
      kind: partner.kind || "announcement",
      scrapedAt: new Date().toISOString(),
    });
  }

  return records;
}

function parseWordPressPosts(html, partner) {
  const records = [];
  const headings = headingMatches(html);

  for (let index = 0; index < headings.length; index += 1) {
    const heading = headings[index];
    const title = textFromHtml(heading.content);
    if (!title || title.toLowerCase().startsWith("category ")) {
      continue;
    }

    const following = followingHtml(html, headings, index, 700);
    const blockText = textFromHtml(following);
    const dateText = lastLongDate(blockText);
    if (!dateText) {
      continue;
    }

    records.push({
      partner: partner.name,
      title,
      startDate: normalizeDate(dateText),
      description: shorten(removeFirstLongDate(blockText), 500),
      imageUrl: firstImageUrl(`${heading.raw} ${following}`, partner.url),
      url: absoluteUrl(firstHref(heading.content) || partner.url, partner.url),
      sourceUrl: partner.url,
      kind: partner.kind || "announcement",
      scrapedAt: new Date().toISOString(),
    });
  }

  return records;
}

function parseShopifyBlogEvents(html, partner) {
  const records = [];
  const seenUrls = new Set();
  const blogPath = new URL(partner.url).pathname.replace(/\/+$/, "");
  const articleLinkPattern = new RegExp(
    `<a\\b[^>]*href=["'](${escapeRegExp(blogPath)}\\/[^"']+)["'][^>]*>([\\s\\S]*?)<\\/a>`,
    "gi",
  );

  for (const match of html.matchAll(articleLinkPattern)) {
    const url = absoluteUrl(match[1], partner.url);
    if (seenUrls.has(url)) {
      continue;
    }
    seenUrls.add(url);

    const context = shopifyCardHtml(html, match.index) || nearbyHtml(html, match.index, 1200);
    const title = shopifyArticleTitle(match[0], match[2], context);
    if (!title || title.toLowerCase() === "view all") {
      continue;
    }

    const description = shopifyCardDescription(context);
    const dateText = firstPostDate(`${title} ${description}`) || monthYearDate(title);
    const timeRange = parseTimeRange(description);

    records.push({
      partner: partner.name,
      title,
      startDate: normalizeDate(dateText) || new Date().toISOString().slice(0, 10),
      startTime: timeRange.startTime,
      endTime: timeRange.endTime,
      location: locationFromText(description),
      description: shorten(description || title, 700),
      imageUrl: firstImageUrl(context, partner.url),
      url,
      sourceUrl: partner.url,
      kind: partner.kind || "event",
      scrapedAt: new Date().toISOString(),
    });
  }

  return records;
}

async function enrichBlogRecords(records, partner) {
  if (!shouldFetchDetailPages(partner)) {
    return records;
  }

  const enriched = [];
  for (const record of records) {
    enriched.push(await enrichBlogRecord(record));
  }
  return enriched;
}

function shouldFetchDetailPages(partner) {
  return new Set([
    "shopify_blog_events",
    "squarespace_blog",
    "wordpress_posts",
  ]).has(partner.parser);
}

async function enrichBlogRecord(record) {
  try {
    const response = await fetch(record.url, {
      headers: {
        "User-Agent": "NH-Ecosystem-Event-Scraper/1.0",
      },
    });
    if (!response.ok) {
      throw new Error(`Detail page returned ${response.status}`);
    }

    const html = stripIgnoredHtml(await response.text());
    const details = articleDetails(html, record.url);
    if (!details.description && !details.imageUrl) {
      return record;
    }

    const dateText = firstPostDate(details.description);
    const timeRange = parseTimeRange(details.description);
    return {
      ...record,
      startDate: normalizeDate(dateText) || record.startDate,
      endDate: secondLongDate(details.description) || record.endDate,
      startTime: timeRange.startTime || record.startTime,
      endTime: timeRange.endTime || record.endTime,
      location: locationFromText(details.description) || record.location,
      description: details.description || record.description,
      imageUrl: details.imageUrl || record.imageUrl,
    };
  } catch (error) {
    console.error(`Could not enrich ${record.url}: ${error.message}`);
    return record;
  }
}

function articleDetails(html, baseUrl) {
  const main = html.match(/<main\b[^>]*>([\s\S]*?)<\/main>/i)?.[1] || html;
  const contentBlocks = [
    ...main.matchAll(/<div\b[^>]*class=["'][^"']*\b(?:content-main|rte)\b[^"']*["'][^>]*>([\s\S]*?)<\/div>/gi),
  ]
    .map((match) => textFromHtml(match[1]))
    .filter(Boolean);
  const uniqueBlocks = [...new Set(contentBlocks)];
  const description = uniqueBlocks.length
    ? shorten(uniqueBlocks.join("\n\n"), 4000)
    : metaContent(html, "description");
  const imageUrl =
    metaContent(html, "og:image:secure_url") ||
    metaContent(html, "og:image") ||
    firstImageUrl(main, baseUrl);

  return {
    description,
    imageUrl: imageUrl ? absoluteUrl(imageUrl, baseUrl) : "",
  };
}

function parseJsonLdEvents(html, partner) {
  const records = [];
  const scripts = html.matchAll(
    /<script\b[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi,
  );

  for (const script of scripts) {
    try {
      const data = JSON.parse(textFromHtml(script[1]));
      for (const event of jsonLdEventNodes(data)) {
        const title = cleanText(event.name || event.headline || "");
        const start = String(event.startDate || event.datePublished || "");
        if (!title || !start) {
          continue;
        }
        const startParts = datePartsFromDateTime(start);
        const endParts = datePartsFromDateTime(String(event.endDate || ""));
        records.push({
          partner: partner.name,
          title,
          startDate: startParts.date,
          endDate: endParts.date,
          startTime: startParts.time,
          endTime: endParts.time,
          location: jsonLdLocation(event.location),
          description: shorten(cleanText(event.description || ""), 1200),
          imageUrl: jsonLdImage(event.image, partner.url),
          url: absoluteUrl(event.url || partner.url, partner.url),
          sourceUrl: partner.url,
          kind: partner.kind || "event",
          scrapedAt: new Date().toISOString(),
        });
      }
    } catch (_error) {
      // Some sites include multiple JSON-LD blobs; a malformed blob should not kill the page.
    }
  }

  return records;
}

function jsonLdEventNodes(value) {
  if (!value) {
    return [];
  }
  if (Array.isArray(value)) {
    return value.flatMap(jsonLdEventNodes);
  }
  if (typeof value !== "object") {
    return [];
  }
  const type = Array.isArray(value["@type"]) ? value["@type"] : [value["@type"]];
  const events = type.some((item) => String(item).toLowerCase() === "event") ? [value] : [];
  return [
    ...events,
    ...jsonLdEventNodes(value["@graph"]),
    ...jsonLdEventNodes(value.itemListElement),
  ];
}

function jsonLdLocation(location) {
  if (!location) {
    return "";
  }
  if (typeof location === "string") {
    return cleanText(location);
  }
  if (Array.isArray(location)) {
    return location.map(jsonLdLocation).filter(Boolean).join("; ");
  }
  const address = location.address || {};
  const addressText = typeof address === "string"
    ? address
    : [
        address.streetAddress,
        address.addressLocality,
        address.addressRegion,
        address.postalCode,
      ].filter(Boolean).join(", ");
  return cleanText([location.name, addressText].filter(Boolean).join(" | "));
}

function jsonLdImage(image, baseUrl) {
  if (!image) {
    return "";
  }
  if (typeof image === "string") {
    return absoluteUrl(image, baseUrl);
  }
  if (Array.isArray(image)) {
    return jsonLdImage(image[0], baseUrl);
  }
  return image.url ? absoluteUrl(image.url, baseUrl) : "";
}

function parseIcsEvents(calendarText, partner, sourceUrl) {
  const records = [];
  const unfolded = calendarText.replace(/\r?\n[ \t]/g, "");
  const eventBlocks = unfolded.match(/BEGIN:VEVENT[\s\S]*?END:VEVENT/gi) || [];

  for (const block of eventBlocks) {
    const title = cleanText(icsValue(block, "SUMMARY"));
    const start = icsDateParts(icsValue(block, "DTSTART"));
    if (!title || !start.date) {
      continue;
    }
    const end = icsDateParts(icsValue(block, "DTEND"));
    const url = icsValue(block, "URL") || sourceUrl;
    const description = icsValue(block, "DESCRIPTION");
    records.push({
      partner: partner.name,
      title,
      startDate: start.date,
      endDate: end.date,
      startTime: start.time,
      endTime: end.time,
      location: cleanText(icsValue(block, "LOCATION")),
      description: shorten(description, 1200),
      imageUrl: icsImageUrl(block, sourceUrl),
      url: absoluteUrl(url, sourceUrl),
      sourceUrl,
      kind: partner.kind || "event",
      scrapedAt: new Date().toISOString(),
    });
  }

  return records;
}

function icsValue(block, key) {
  const escaped = escapeRegExp(key);
  const match = block.match(new RegExp(`^${escaped}(?:;[^:\\r\\n]*)?:(.*)$`, "im"));
  return match ? cleanText(decodeIcsText(match[1])) : "";
}

function icsDateParts(value) {
  const dateTime = value.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})/);
  if (dateTime) {
    return {
      date: `${dateTime[1]}-${dateTime[2]}-${dateTime[3]}`,
      time: `${dateTime[4]}:${dateTime[5]}`,
    };
  }
  const dateOnly = value.match(/^(\d{4})(\d{2})(\d{2})/);
  return dateOnly
    ? { date: `${dateOnly[1]}-${dateOnly[2]}-${dateOnly[3]}`, time: "" }
    : { date: normalizeDate(value), time: "" };
}

function icsImageUrl(block, sourceUrl) {
  const attach = block.match(/^ATTACH(?:;[^:\r\n]*)?:(https?:\/\/\S+\.(?:jpe?g|png|webp|gif)[^\s]*)$/im);
  return attach ? absoluteUrl(decodeIcsText(attach[1]), sourceUrl) : "";
}

function decodeIcsText(value) {
  return value
    .replace(/\\n/gi, " ")
    .replace(/\\,/g, ",")
    .replace(/\\;/g, ";")
    .replace(/\\\\/g, "\\");
}

function toImportRecord(record) {
  return {
    partner: record.partner,
    title: record.title,
    start_date: record.startDate || "",
    end_date: record.endDate || "",
    start_time: record.startTime || "",
    end_time: record.endTime || "",
    location: record.location || "",
    description: record.description || "",
    image_url: record.imageUrl || "",
    url: record.url || "",
    source_url: record.sourceUrl || "",
    kind: record.kind || "event",
    scraped_at: record.scrapedAt || new Date().toISOString(),
  };
}

function isIncomingEvent(record) {
  if ((record.kind || "event") !== "event" || !record.startDate) {
    return false;
  }
  return record.startDate >= new Date().toISOString().slice(0, 10);
}

function deduplicate(records) {
  const seen = new Set();
  return records.filter((record) => {
    const key = `${record.partner}|${record.title.toLowerCase()}|${record.startDate}|${record.url}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

async function validateManualRun(request, env) {
  const adminToken = await optionalSecret(env.SCRAPER_ADMIN_TOKEN);
  if (!adminToken) {
    return Response.json(
      { error: "Manual runs are disabled. Set SCRAPER_ADMIN_TOKEN to enable them." },
      { status: 403 },
    );
  }

  const expected = `Bearer ${adminToken}`;
  if (request.headers.get("Authorization") !== expected) {
    return Response.json({ error: "Unauthorized." }, { status: 401 });
  }

  return null;
}

async function scraperApiToken(env) {
  const token = await optionalSecret(env.SCRAPER_API_TOKEN);
  if (!token) {
    throw new Error("Missing SCRAPER_API_TOKEN secret.");
  }
  return token;
}

async function optionalSecret(binding) {
  if (!binding) {
    return "";
  }
  if (typeof binding === "string") {
    return binding;
  }
  if (typeof binding.get === "function") {
    return binding.get();
  }
  return "";
}

function ecosystemBaseUrl(env) {
  const baseUrl = env.ECOSYSTEM_BASE_URL;
  if (!baseUrl) {
    throw new Error("Missing ECOSYSTEM_BASE_URL variable.");
  }
  return baseUrl.replace(/\/+$/, "");
}

function stripIgnoredHtml(html) {
  return html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, "")
    .replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi, "");
}

function headingMatches(html) {
  const headingRegex = /<h[1-3][^>]*>([\s\S]*?)<\/h[1-3]>/gi;
  return [...html.matchAll(headingRegex)].map((match) => ({
    raw: match[0],
    content: match[1],
    index: match.index,
  }));
}

function previousHtml(html, headings, index, limit) {
  const start = index > 0 ? headings[index - 1].index + headings[index - 1].raw.length : 0;
  return textFromHtml(html.slice(start, headings[index].index)).slice(-limit);
}

function followingHtml(html, headings, index, limit) {
  const start = headings[index].index + headings[index].raw.length;
  const end = headings[index + 1]?.index ?? html.length;
  return textFromHtml(html.slice(start, end)).slice(0, limit);
}

function nearbyHtml(html, index, radius) {
  return html.slice(Math.max(0, index - radius), Math.min(html.length, index + radius));
}

function shopifyCardHtml(html, index) {
  const before = html.slice(0, index);
  const wrapperPattern = /<div\b[^>]*class=["'][^"']*(?:\barticle-card-wrapper\b|\bcard-wrapper\b)[^"']*["'][^>]*>/gi;
  const wrappers = [...before.matchAll(wrapperPattern)];
  const start = wrappers.at(-1)?.index;
  if (start === undefined) {
    return "";
  }

  const after = html.slice(index);
  const next = after.match(wrapperPattern);
  const end = next?.index ? index + next.index : Math.min(html.length, index + 2400);
  return html.slice(start, end);
}

function squarespaceEventArticleHtml(html, index) {
  const before = html.slice(0, index);
  const articlePattern = /<article\b[^>]*class=["'][^"']*\beventlist-event\b[^"']*["'][^>]*>/gi;
  const articles = [...before.matchAll(articlePattern)];
  const start = articles.at(-1)?.index;
  if (start === undefined) {
    return "";
  }

  const endMatch = html.slice(index).match(/<\/article>/i);
  if (!endMatch) {
    return "";
  }

  return html.slice(start, index + endMatch.index + endMatch[0].length);
}

function firstHref(html) {
  return html.match(/href=["']([^"']+)["']/i)?.[1] || "";
}

function metaContent(html, name) {
  const escaped = escapeRegExp(name);
  return (
    html.match(new RegExp(`<meta\\b[^>]*(?:property|name)=["']${escaped}["'][^>]*content=["']([^"']+)["']`, "i"))?.[1] ||
    html.match(new RegExp(`<meta\\b[^>]*content=["']([^"']+)["'][^>]*(?:property|name)=["']${escaped}["']`, "i"))?.[1] ||
    ""
  );
}

function firstImageUrl(html, baseUrl) {
  const imageMatch = html.match(/<img\b[^>]*>/i);
  if (!imageMatch) {
    return "";
  }

  const imageHtml = imageMatch[0];
  const src =
    attributeValue(imageHtml, "src") ||
    firstSrcsetUrl(attributeValue(imageHtml, "srcset")) ||
    attributeValue(imageHtml, "data-src");
  return src ? absoluteUrl(src, baseUrl) : "";
}

function attributeValue(html, name) {
  return html.match(new RegExp(`\\b${name}=["']([^"']+)["']`, "i"))?.[1] || "";
}

function firstSrcsetUrl(srcset) {
  if (!srcset) {
    return "";
  }
  return srcset.split(",", 1)[0].trim().split(/\s+/, 1)[0];
}

function absoluteUrl(href, baseUrl) {
  return new URL(href, baseUrl).toString();
}

function shopifyArticleTitle(anchorHtml, anchorText, context) {
  const text = textFromHtml(anchorText);
  if (text) {
    return text;
  }
  const ariaLabel = anchorHtml.match(/\baria-label=["']([^"']+)["']/i)?.[1] || "";
  if (ariaLabel) {
    return textFromHtml(ariaLabel);
  }
  const imageAlt = context.match(/\balt=["']([^"']+)["']/i)?.[1] || "";
  return textFromHtml(imageAlt);
}

function shopifyCardDescription(context) {
  const match = context.match(/<div\b[^>]*class=["'][^"']*\bcard-description\b[^"']*["'][^>]*>([\s\S]*?)<\/div>/i);
  return match ? textFromHtml(match[1]) : "";
}

function textFromHtml(html) {
  return cleanText(
    html
      .replace(/<br\s*\/?>/gi, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/&nbsp;/g, " ")
      .replace(/&amp;/g, "&")
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&#8217;/g, "'")
      .replace(/&#8211;/g, "-"),
  );
}

function decodeHtmlAttribute(value) {
  return value
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

function cleanText(text) {
  return text.replace(/\s+/g, " ").trim();
}

function firstLongDate(text) {
  return text.match(longDatePattern())?.[0] || "";
}

function secondLongDate(text) {
  const dates = [...text.matchAll(longDatePattern("gi"))];
  if (dates.length < 2) {
    return "";
  }
  return normalizeDate(dates[1][0]);
}

function lastLongDate(text) {
  const dates = [...text.matchAll(longDatePattern("gi"))];
  return dates.length ? dates[dates.length - 1][0] : "";
}

function removeFirstLongDate(text) {
  return cleanText(text.replace(longDatePattern(), ""));
}

function firstPostDate(text) {
  return firstIsoDate(text) || firstShortDate(text) || firstLongDate(text);
}

function firstIsoDate(text) {
  return text.match(/\b\d{4}-\d{2}-\d{2}\b/)?.[0] || "";
}

function firstShortDate(text) {
  return text.match(/\b\d{1,2}\/\d{1,2}\/\d{2,4}\b/)?.[0] || "";
}

function monthYearDate(text) {
  const match = text.match(
    /\b(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\s+(\d{4})\b/i,
  );
  return match ? `${match[1]} 1, ${match[2]}` : "";
}

function longDatePattern(flags = "i") {
  return new RegExp(
    "\\b(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)?(?:day|sday|nesday|rsday|urday)?[,]?\\s*" +
      "(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|" +
      "Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\\s+" +
      "\\d{1,2}(?:,\\s*\\d{4})?\\b",
    flags,
  );
}

function normalizeDate(text) {
  const dateTime = datePartsFromDateTime(text);
  if (dateTime.date) {
    return dateTime.date;
  }

  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) {
    return text;
  }

  const hasYear = /\b\d{4}\b/.test(text);
  const year = new Date().getFullYear();
  const dateText = hasYear ? text : `${text}, ${year}`;
  let parsed = new Date(`${dateText} 00:00:00 GMT-0500`);
  if (Number.isNaN(parsed.valueOf())) {
    return "";
  }
  if (!hasYear) {
    const today = new Date().toISOString().slice(0, 10);
    const parsedDate = parsed.toISOString().slice(0, 10);
    if (parsedDate < today) {
      parsed = new Date(`${text}, ${year + 1} 00:00:00 GMT-0500`);
    }
  }
  return parsed.toISOString().slice(0, 10);
}

function datePartsFromDateTime(value) {
  const match = String(value).match(/^(\d{4}-\d{2}-\d{2})(?:[T\s](\d{2}:\d{2}))?/);
  return match ? { date: match[1], time: match[2] || "" } : { date: "", time: "" };
}

function parseTimeRange(text) {
  const match = text.match(
    /\b(\d{1,2}(?::\d{2})?\s*(?:AM|PM|am|pm))\s*(?:-|to|\s+)\s*(\d{1,2}(?::\d{2})?\s*(?:AM|PM|am|pm))\b/,
  );
  if (!match) {
    return { startTime: "", endTime: "" };
  }
  return {
    startTime: cleanText(match[1]).toUpperCase(),
    endTime: cleanText(match[2]).toUpperCase(),
  };
}

function locationFromText(text) {
  return text.match(/\b(?:Location|Meeting Place):\s*([^.;]+)/i)?.[1]?.trim() || "";
}

function removeCalendarNoise(text) {
  return cleanText(text.replace(/Google Calendar\s+ICS/gi, "").replace(/View Event\s*/gi, ""));
}

function shorten(text, limit) {
  const clean = cleanText(text);
  return clean.length <= limit ? clean : `${clean.slice(0, limit - 3).trim()}...`;
}

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
