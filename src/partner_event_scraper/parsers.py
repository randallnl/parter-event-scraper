from __future__ import annotations

import re
from collections.abc import Callable, Iterable
from datetime import datetime
from urllib.parse import urljoin, urlparse

import dateparser
from bs4 import BeautifulSoup, Tag

from .models import EventRecord

DATE_RE = re.compile(
    r"\b(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)?(?:day|sday|nesday|rsday|urday)?[,]?\s*"
    r"(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|"
    r"Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\s+"
    r"\d{1,2}(?:,\s*\d{4})?\b"
)
NUMERIC_DATE_RE = re.compile(r"\b\d{1,2}/\d{1,2}/\d{2,4}\b")
ISO_DATE_RE = re.compile(r"\b\d{4}-\d{2}-\d{2}\b")
TIME_RANGE_RE = re.compile(
    r"\b(\d{1,2}(?::\d{2})?\s*(?:AM|PM|am|pm))\s*(?:-|to|\u2013|\u2014|\s+)\s*"
    r"(\d{1,2}(?::\d{2})?\s*(?:AM|PM|am|pm))\b"
)
COMPACT_POST_DATE_RE = re.compile(r"\b\d{1,2}/\d{1,2}/\d{2}\b")
MONTH_YEAR_RE = re.compile(
    r"\b(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|"
    r"Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\s+(\d{4})\b",
    flags=re.I,
)


def parse_html(html: str, partner: dict, scraped_at: str) -> list[EventRecord]:
    soup = BeautifulSoup(html, "html.parser")
    for selector in ("script", "style", "noscript", "svg"):
        for node in soup.select(selector):
            node.decompose()

    parser = PARSERS[partner["parser"]]
    records = list(parser(soup, partner, scraped_at))
    return dedupe(records)


def squarespace_events(
    soup: BeautifulSoup, partner: dict, scraped_at: str
) -> Iterable[EventRecord]:
    source_url = partner["url"]
    for heading in soup.find_all(["h1", "h2", "h3"]):
        title = clean_text(heading.get_text(" "))
        if not title or len(title) > 180 or title.lower() in {"upcoming events", "past events"}:
            continue

        article = find_eventlist_article(heading)
        block = [article] if article else collect_until_next_heading(heading)
        block_text = clean_text(" ".join(node.get_text(" ") for node in block if isinstance(node, Tag)))
        date_match = DATE_RE.search(block_text)
        if not date_match:
            date_match = DATE_RE.search(clean_text(previous_text(heading, limit=80)))
        if not date_match:
            continue

        link = heading.find("a", href=True)
        href = urljoin(source_url, link["href"]) if link else source_url
        start_time, end_time = parse_time_range(block_text)
        start_date = normalize_date(date_match.group(0))
        end_date = parse_end_date(block_text, start_date)

        yield EventRecord(
            partner=partner["name"],
            title=title,
            start_date=start_date,
            end_date=end_date,
            start_time=start_time,
            end_time=end_time,
            location=find_location(block_text),
            description=shorten(remove_calendar_noise(block_text), 700),
            image_url=find_image_url(block, source_url),
            url=href,
            source_url=source_url,
            kind=partner.get("kind", "event"),
            scraped_at=scraped_at,
        )


def heading_date_events(
    soup: BeautifulSoup, partner: dict, scraped_at: str
) -> Iterable[EventRecord]:
    source_url = partner["url"]
    nodes = soup.find_all(["h2", "h3", "p", "li", "div"])
    current_date = ""
    seen_headings: set[int] = set()

    for node in nodes:
        text = clean_text(node.get_text(" "))
        if not text:
            continue
        if full_date := full_date_from_text(text):
            current_date = normalize_date(full_date)
            continue
        if node.name not in {"h2", "h3"} or id(node) in seen_headings or not current_date:
            continue
        seen_headings.add(id(node))
        title = clean_text(node.get_text(" "))
        if title.lower() in {"past events", "filter events"}:
            continue
        link = node.find("a", href=True)
        block_text = clean_text(" ".join(n.get_text(" ") for n in collect_until_next_heading(node)))
        yield EventRecord(
            partner=partner["name"],
            title=title,
            start_date=current_date,
            location=find_location(block_text),
            description=shorten(block_text, 700),
            image_url=find_image_url([node, *collect_until_next_heading(node)], source_url),
            url=urljoin(source_url, link["href"]) if link else source_url,
            source_url=source_url,
            kind=partner.get("kind", "event"),
            scraped_at=scraped_at,
        )


def squarespace_blog(
    soup: BeautifulSoup, partner: dict, scraped_at: str
) -> Iterable[EventRecord]:
    source_url = partner["url"]
    for heading in soup.find_all(["h1", "h2", "h3"]):
        title = clean_text(heading.get_text(" "))
        if not title or title.lower() in {"nhcje blog"}:
            continue
        nearby = clean_text(previous_text(heading, limit=180) + " " + following_text(heading, limit=260))
        date_text = first_post_date(nearby)
        if not date_text:
            continue
        link = heading.find("a", href=True)
        yield EventRecord(
            partner=partner["name"],
            title=title,
            start_date=normalize_date(date_text),
            description=shorten(following_text(heading, limit=500), 500),
            image_url=find_image_url([heading, *collect_until_next_heading(heading)], source_url),
            url=urljoin(source_url, link["href"]) if link else source_url,
            source_url=source_url,
            kind=partner.get("kind", "announcement"),
            scraped_at=scraped_at,
        )


def wordpress_posts(
    soup: BeautifulSoup, partner: dict, scraped_at: str
) -> Iterable[EventRecord]:
    source_url = partner["url"]
    for heading in soup.find_all(["h1", "h2", "h3"]):
        title = clean_text(heading.get_text(" "))
        if not title or title.lower().startswith("category "):
            continue
        block_text = clean_text(following_text(heading, limit=700))
        date_text = last_full_date_from_text(block_text)
        if not date_text:
            continue
        link = heading.find("a", href=True)
        yield EventRecord(
            partner=partner["name"],
            title=title,
            start_date=normalize_date(date_text),
            description=shorten(remove_author_date(block_text), 500),
            image_url=find_image_url([heading, *collect_until_next_heading(heading)], source_url),
            url=urljoin(source_url, link["href"]) if link else source_url,
            source_url=source_url,
            kind=partner.get("kind", "announcement"),
            scraped_at=scraped_at,
        )


def generic_links(
    soup: BeautifulSoup, partner: dict, scraped_at: str
) -> Iterable[EventRecord]:
    source_url = partner["url"]
    for link in soup.find_all("a", href=True):
        text = clean_text(link.get_text(" "))
        context = clean_text(text + " " + following_text(link, limit=180))
        date_text = first_post_date(context) or full_date_from_text(context)
        if not text or not date_text:
            continue
        title = DATE_RE.sub("", text)
        title = NUMERIC_DATE_RE.sub("", title)
        title = ISO_DATE_RE.sub("", title)
        yield EventRecord(
            partner=partner["name"],
            title=clean_text(title) or text,
            start_date=normalize_date(date_text),
            description=shorten(context, 400),
            image_url=find_image_url([link], source_url),
            url=urljoin(source_url, link["href"]),
            source_url=source_url,
            kind=partner.get("kind", "event"),
            scraped_at=scraped_at,
        )


def shopify_blog_events(
    soup: BeautifulSoup, partner: dict, scraped_at: str
) -> Iterable[EventRecord]:
    source_url = partner["url"]
    blog_path = urlparse(source_url).path.rstrip("/")
    seen_urls: set[str] = set()

    for link in soup.find_all("a", href=True):
        href = link["href"]
        if not urlparse(urljoin(source_url, href)).path.startswith(f"{blog_path}/"):
            continue
        url = urljoin(source_url, href)
        if url in seen_urls:
            continue
        seen_urls.add(url)

        card = link.find_parent(class_=re.compile(r"\barticle-card-wrapper\b|\bcard-wrapper\b"))
        if not card:
            card = link.find_parent(class_=re.compile(r"\bcard\b"))
        title = clean_text(link.get_text(" ")) or clean_text(link.get("aria-label", ""))
        if not title and card:
            image = card.find("img", alt=True)
            title = clean_text(image["alt"]) if image else ""
        if not title or title.lower() == "view all":
            continue

        description = ""
        if card:
            description_node = card.find(class_=re.compile(r"\bcard-description\b"))
            description = clean_text(description_node.get_text(" ")) if description_node else ""
        date_text = first_post_date(f"{title} {description}") or month_year_date(title)
        start_date = normalize_date(date_text) if date_text else scraped_at[:10]
        start_time, end_time = parse_time_range(description)

        yield EventRecord(
            partner=partner["name"],
            title=title,
            start_date=start_date,
            start_time=start_time,
            end_time=end_time,
            location=find_location(description),
            description=shorten(description or title, 700),
            image_url=find_image_url([card] if card else [link], source_url),
            url=url,
            source_url=source_url,
            kind=partner.get("kind", "event"),
            scraped_at=scraped_at,
        )


def collect_until_next_heading(start: Tag, max_nodes: int = 12) -> list[Tag]:
    nodes: list[Tag] = []
    for sibling in start.next_siblings:
        if isinstance(sibling, Tag) and sibling.name in {"h1", "h2", "h3"}:
            break
        if isinstance(sibling, Tag):
            nodes.append(sibling)
        if len(nodes) >= max_nodes:
            break
    return nodes


def find_eventlist_article(node: Tag) -> Tag | None:
    article = node.find_parent("article")
    if not isinstance(article, Tag):
        return None
    classes = article.get("class", [])
    return article if "eventlist-event" in classes else None


def clean_text(text: str) -> str:
    return re.sub(r"\s+", " ", text).strip()


def dedupe(records: list[EventRecord]) -> list[EventRecord]:
    seen: set[tuple[str, str, str, str]] = set()
    unique: list[EventRecord] = []
    for record in records:
        key = (record.partner, record.title.lower(), record.start_date, record.url)
        if key not in seen:
            seen.add(key)
            unique.append(record)
    return unique


def find_location(text: str) -> str:
    state_match = re.search(
        r"(?:Location|Meeting Place):\s*(.*?\b[A-Z]{2}(?:\s+\d{5})?)\b",
        text,
        flags=re.I,
    )
    if state_match:
        return clean_text(state_match.group(1))
    for pattern in (r"Location:\s*([^\.]+)", r"Meeting Place:\s*([^\.]+)"):
        if match := re.search(pattern, text, flags=re.I):
            return clean_text(match.group(1))
    return ""


def find_image_url(nodes: list[Tag | None], source_url: str) -> str:
    for node in nodes:
        if not isinstance(node, Tag):
            continue
        image = node.find("img")
        if not image:
            continue
        value = image.get("src") or first_srcset_url(image.get("srcset", ""))
        if value:
            return urljoin(source_url, value)
    return ""


def first_srcset_url(srcset: str) -> str:
    if not srcset:
        return ""
    return srcset.split(",", 1)[0].strip().split(" ", 1)[0]


def first_post_date(text: str) -> str:
    if match := ISO_DATE_RE.search(text):
        return match.group(0)
    if match := COMPACT_POST_DATE_RE.search(text):
        return match.group(0)
    return full_date_from_text(text)


def month_year_date(text: str) -> str:
    if match := MONTH_YEAR_RE.search(text):
        return f"{match.group(1)} 1, {match.group(2)}"
    return ""


def following_text(node: Tag, limit: int = 400) -> str:
    chunks: list[str] = []
    for sibling in node.next_siblings:
        if isinstance(sibling, Tag) and sibling.name in {"h1", "h2", "h3"}:
            break
        if isinstance(sibling, Tag):
            chunks.append(sibling.get_text(" "))
        if len(clean_text(" ".join(chunks))) >= limit:
            break
    return clean_text(" ".join(chunks))[:limit]


def full_date_from_text(text: str) -> str:
    if match := DATE_RE.search(text):
        return match.group(0)
    return ""


def normalize_date(text: str) -> str:
    parsed = dateparser.parse(
        text,
        settings={"PREFER_DATES_FROM": "future", "RELATIVE_BASE": datetime(2026, 1, 1)},
    )
    return parsed.date().isoformat() if parsed else ""


def parse_end_date(text: str, start_date: str) -> str:
    dates = DATE_RE.findall(text)
    if len(dates) < 2:
        return ""
    end_date = normalize_date(dates[1])
    return end_date if end_date != start_date else ""


def parse_time_range(text: str) -> tuple[str, str]:
    if not (match := TIME_RANGE_RE.search(text)):
        return "", ""
    return clean_text(match.group(1)).upper(), clean_text(match.group(2)).upper()


def previous_text(node: Tag, limit: int = 160) -> str:
    chunks: list[str] = []
    for sibling in node.previous_siblings:
        if isinstance(sibling, Tag) and sibling.name in {"h1", "h2", "h3"}:
            break
        if isinstance(sibling, Tag):
            chunks.append(sibling.get_text(" "))
        if len(clean_text(" ".join(chunks))) >= limit:
            break
    return clean_text(" ".join(reversed(chunks)))[:limit]


def remove_author_date(text: str) -> str:
    return clean_text(DATE_RE.sub("", text, count=1))


def last_full_date_from_text(text: str) -> str:
    dates = DATE_RE.findall(text)
    return dates[-1] if dates else ""


def remove_calendar_noise(text: str) -> str:
    text = re.sub(r"Google Calendar\s+ICS", "", text, flags=re.I)
    text = re.sub(r"View Event\s*\u2192?", "", text, flags=re.I)
    return clean_text(text)


def shorten(text: str, limit: int) -> str:
    text = clean_text(text)
    return text if len(text) <= limit else text[: limit - 3].rstrip() + "..."


PARSERS: dict[str, Callable[[BeautifulSoup, dict, str], Iterable[EventRecord]]] = {
    "squarespace_events": squarespace_events,
    "heading_date_events": heading_date_events,
    "squarespace_blog": squarespace_blog,
    "wordpress_posts": wordpress_posts,
    "generic_links": generic_links,
    "shopify_blog_events": shopify_blog_events,
}
