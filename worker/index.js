const IMPORT_BATCH_SIZE = 500;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/health") {
      return Response.json({ ok: true });
    }

    if (request.method !== "POST") {
      return new Response("POST to run the event scraper.", {
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
      records.push(...parsePartner(html, partner));
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
  const response = await fetch(
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
  const response = await fetch(`${ecosystemBaseUrl(env)}/api/scraper/events`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${await scraperApiToken(env)}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      records: records.map(toImportRecord),
    }),
  });

  if (!response.ok) {
    throw new Error(
      `Event import failed: ${response.status} ${await response.text()}`,
    );
  }

  return response.json();
}

function parsePartner(html, partner) {
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
    default:
      throw new Error(`Unsupported parser: ${partner.parser}`);
  }
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
    const block = html.slice(heading.index + heading.raw.length, nextIndex);
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
      url: absoluteUrl(firstHref(heading.content) || partner.url, partner.url),
      sourceUrl: partner.url,
      kind: partner.kind || "announcement",
      scrapedAt: new Date().toISOString(),
    });
  }

  return records;
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

function firstHref(html) {
  return html.match(/href=["']([^"']+)["']/i)?.[1] || "";
}

function absoluteUrl(href, baseUrl) {
  return new URL(href, baseUrl).toString();
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
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) {
    return text;
  }

  const parsed = new Date(`${text} 00:00:00 GMT-0500`);
  if (Number.isNaN(parsed.valueOf())) {
    return "";
  }
  return parsed.toISOString().slice(0, 10);
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
