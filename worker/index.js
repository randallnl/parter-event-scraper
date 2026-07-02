const MONDAY_API_URL = "https://api.monday.com/v2";
const MONDAY_BOARD_ID = "18420375431";

const COLUMNS = {
  eventDate: "date_mm4w9x8p",
  eventTitle: "text_mm4whrb1",
  eventDetails: "text_mm4wpkzw",
  eventLink: "link_mm4w7r6",
};

const PARTNERS = [
  {
    name: "603 Equality",
    url: "https://603equality.org/events",
    parser: "squarespaceEvents",
  },
  {
    name: "Black Heritage Trail NH",
    url: "https://blackheritagetrailnh.org/all-events",
    parser: "headingDateEvents",
  },
  {
    name: "Black Lives Matter NH",
    url: "https://blmnh.org/events",
    parser: "squarespaceEvents",
  },
  {
    name: "Racial Unity Team",
    url: "https://rutnh.org/Events/",
    parser: "genericLinks",
  },
];

export default {
  async fetch(request, env) {
    if (new URL(request.url).pathname === "/health") {
      return Response.json({ ok: true });
    }

    if (request.method !== "POST") {
      return new Response("POST to run the scraper, or GET /health.", {
        status: 405,
        headers: { Allow: "POST" },
      });
    }

    const result = await scrapeAndWrite(env);
    return Response.json(result);
  },

  async scheduled(_event, env, ctx) {
    ctx.waitUntil(scrapeAndWrite(env));
  },
};

async function scrapeAndWrite(env) {
  const token = env.MONDAY_API_TOKEN;
  if (!token) {
    throw new Error("Missing MONDAY_API_TOKEN binding.");
  }

  const today = new Date().toISOString().slice(0, 10);
  const records = [];
  const failures = [];

  for (const partner of PARTNERS) {
    try {
      const response = await fetch(partner.url, {
        headers: {
          "User-Agent": "PartnerEventScraperWorker/0.1",
        },
      });
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      const html = await response.text();
      records.push(...parsePartner(html, partner));
    } catch (error) {
      failures.push(`${partner.name}: ${error.message}`);
    }
  }

  const incoming = dedupe(records)
    .filter((record) => record.startDate && record.startDate >= today)
    .sort((a, b) => a.startDate.localeCompare(b.startDate));

  let created = 0;
  for (const record of incoming) {
    await createMondayItem(token, record);
    created += 1;
  }

  return {
    scraped: records.length,
    incoming: incoming.length,
    created,
    failures,
  };
}

function parsePartner(html, partner) {
  const cleanHtml = html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, "");
  if (partner.parser === "headingDateEvents") {
    return parseHeadingDateEvents(cleanHtml, partner);
  }
  if (partner.parser === "genericLinks") {
    return parseGenericLinks(cleanHtml, partner);
  }
  return parseSquarespaceEvents(cleanHtml, partner);
}

function parseSquarespaceEvents(html, partner) {
  const records = [];
  const headingRegex = /<h[1-3][^>]*>([\s\S]*?)<\/h[1-3]>/gi;
  const headings = [...html.matchAll(headingRegex)];

  for (let index = 0; index < headings.length; index += 1) {
    const heading = headings[index];
    const title = textFromHtml(heading[1]);
    if (!title || /^(upcoming events|past events)$/i.test(title)) {
      continue;
    }
    const nextIndex = headings[index + 1]?.index ?? html.length;
    const block = html.slice(heading.index + heading[0].length, nextIndex);
    const blockText = textFromHtml(block);
    const dateText = firstLongDate(blockText);
    if (!dateText) {
      continue;
    }

    records.push({
      partner: partner.name,
      title,
      startDate: normalizeDate(dateText),
      endDate: secondLongDate(blockText),
      time: firstTimeRange(blockText),
      location: locationFromText(blockText),
      description: shorten(blockText, 700),
      url: absoluteUrl(firstHref(heading[1]) || firstHref(block) || partner.url, partner.url),
      sourceUrl: partner.url,
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
    const block = tokens.slice(index + 1, index + 5).map((token) => token[1]).join(" ");
    records.push({
      partner: partner.name,
      title: text,
      startDate: currentDate,
      time: firstTimeRange(textFromHtml(block)),
      location: locationFromText(textFromHtml(block)),
      description: shorten(textFromHtml(block), 700),
      url: absoluteUrl(firstHref(raw) || partner.url, partner.url),
      sourceUrl: partner.url,
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
      title: text.replace(dateText, "").trim() || text,
      startDate: normalizeDate(dateText),
      description: shorten(text, 400),
      url: absoluteUrl(match[1], partner.url),
      sourceUrl: partner.url,
    });
  }
  return records;
}

async function createMondayItem(token, record) {
  const columnValues = {
    [COLUMNS.eventDate]: { date: record.startDate },
    [COLUMNS.eventTitle]: record.title,
    [COLUMNS.eventDetails]: eventDetails(record),
    [COLUMNS.eventLink]: { url: record.url, text: "Event link" },
  };
  const response = await fetch(MONDAY_API_URL, {
    method: "POST",
    headers: {
      Authorization: token,
      "Content-Type": "application/json",
      "API-Version": "2025-04",
    },
    body: JSON.stringify({
      query: `
        mutation CreatePartnerEvent($boardId: ID!, $itemName: String!, $columnValues: JSON!) {
          create_item(board_id: $boardId, item_name: $itemName, column_values: $columnValues) {
            id
          }
        }
      `,
      variables: {
        boardId: MONDAY_BOARD_ID,
        itemName: record.title,
        columnValues: JSON.stringify(columnValues),
      },
    }),
  });
  const body = await response.json();
  if (!response.ok || body.errors) {
    throw new Error(JSON.stringify(body.errors || body));
  }
}

function eventDetails(record) {
  return [
    `Partner: ${record.partner}`,
    `Date: ${record.startDate}`,
    record.time ? `Time: ${record.time}` : "",
    record.location ? `Location: ${record.location}` : "",
    "",
    record.description || "",
    "",
    `Source page: ${record.sourceUrl}`,
  ]
    .filter((line, index, lines) => line || lines[index - 1])
    .join("\n");
}

function dedupe(records) {
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

function firstHref(html) {
  return html.match(/href=["']([^"']+)["']/i)?.[1] || "";
}

function absoluteUrl(href, baseUrl) {
  return new URL(href, baseUrl).toString();
}

function textFromHtml(html) {
  return html
    .replace(/<br\s*\/?>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&#8217;/g, "'")
    .replace(/&#8211;/g, "-")
    .replace(/\s+/g, " ")
    .trim();
}

function firstLongDate(text) {
  return text.match(/\b(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)?(?:day|sday|nesday|rsday|urday)?[,]?\s*(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\s+\d{1,2}(?:,\s*\d{4})?\b/i)?.[0] || "";
}

function secondLongDate(text) {
  const dates = [...text.matchAll(/\b(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)?(?:day|sday|nesday|rsday|urday)?[,]?\s*(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\s+\d{1,2}(?:,\s*\d{4})?\b/gi)];
  if (dates.length < 2) {
    return "";
  }
  return normalizeDate(dates[1][0]);
}

function firstIsoDate(text) {
  return text.match(/\b\d{4}-\d{2}-\d{2}\b/)?.[0] || "";
}

function firstShortDate(text) {
  return text.match(/\b\d{1,2}\/\d{1,2}\/\d{2,4}\b/)?.[0] || "";
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

function firstTimeRange(text) {
  return text.match(/\b\d{1,2}(?::\d{2})?\s*(?:AM|PM|am|pm)\s*(?:-|to|\s+)\s*\d{1,2}(?::\d{2})?\s*(?:AM|PM|am|pm)\b/)?.[0] || "";
}

function locationFromText(text) {
  return text.match(/\b(?:Location|Meeting Place):\s*([^.;]+)/i)?.[1]?.trim() || "";
}

function shorten(text, limit) {
  return text.length <= limit ? text : `${text.slice(0, limit - 3).trim()}...`;
}
