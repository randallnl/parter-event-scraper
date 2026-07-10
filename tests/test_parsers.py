from partner_event_scraper.parsers import parse_html


def test_squarespace_events_extracts_event_fields():
    html = """
    <h2>UPCOMING EVENTS</h2>
    <h1><a href="/events/sample">Community Gathering</a></h1>
    <ul>
      <li>Sunday, July 12, 2026</li>
      <li>10:00 AM 5:00 PM</li>
      <li>Location: 123 Main Street, Concord, NH</li>
    </ul>
    <p>Join us for a community event.</p>
    """
    partner = {
        "name": "Example",
        "url": "https://example.org/events",
        "parser": "squarespace_events",
        "kind": "event",
    }

    records = parse_html(html, partner, "2026-07-02T12:00:00+00:00")

    assert len(records) == 1
    assert records[0].title == "Community Gathering"
    assert records[0].start_date == "2026-07-12"
    assert records[0].location == "123 Main Street, Concord, NH"
    assert records[0].url == "https://example.org/events/sample"


def test_heading_date_events_uses_nearest_date_heading():
    html = """
    <p>August 8, 2026</p>
    <h3><a href="https://forms.example/register">Walking Tour</a></h3>
    <p>Meeting Place: Headquarters | 222 Court Street, Portsmouth, NH.</p>
    """
    partner = {
        "name": "Trail",
        "url": "https://example.org/all-events",
        "parser": "heading_date_events",
        "kind": "event",
    }

    records = parse_html(html, partner, "2026-07-02T12:00:00+00:00")

    assert len(records) == 1
    assert records[0].title == "Walking Tour"
    assert records[0].start_date == "2026-08-08"
    assert records[0].location == "Headquarters | 222 Court Street, Portsmouth, NH"


def test_wordpress_posts_extracts_post_date():
    html = """
    <h1>Category ABLE NH News</h1>
    <h2><a href="/news/post">ABLE NH receives funding</a></h2>
    <p>Short excerpt about the announcement.</p>
    <ul><li>ABLE Staff</li><li>November 12, 2024</li></ul>
    """
    partner = {
        "name": "ABLE NH",
        "url": "https://ablenh.org/category/able-nh-news/",
        "parser": "wordpress_posts",
        "kind": "announcement",
    }

    records = parse_html(html, partner, "2026-07-02T12:00:00+00:00")

    assert len(records) == 1
    assert records[0].title == "ABLE NH receives funding"
    assert records[0].start_date == "2024-11-12"
    assert records[0].kind == "announcement"


def test_shopify_blog_events_extracts_all_blog_cards_as_events():
    html = """
    <div class="article-card-wrapper card-wrapper">
      <a href="/blogs/upcoming-events/june-2026-events" class="card-inner-content" aria-label="June 2026 Events"></a>
      <div class="card-content">
        <h3><a href="/blogs/upcoming-events/june-2026-events">June 2026 Events</a></h3>
      </div>
    </div>
    <div class="article-card-wrapper card-wrapper">
      <a href="/blogs/upcoming-events/north-country-commons" aria-label="North Country Commons, July 19"></a>
      <div class="card-content">
        <h3><a href="/blogs/upcoming-events/north-country-commons">North Country Commons, July 19</a></h3>
        <div class="card-description light">Community is Power</div>
      </div>
    </div>
    <div class="article-card-wrapper card-wrapper">
      <a href="/blogs/upcoming-events/currier-trip" aria-label="Currier Trip"></a>
      <div class="card-content">
        <h3><a href="/blogs/upcoming-events/currier-trip">Currier Trip</a></h3>
      </div>
    </div>
    """
    partner = {
        "name": "Queerlective",
        "url": "https://queerlective.com/blogs/upcoming-events",
        "parser": "shopify_blog_events",
        "kind": "event",
    }

    records = parse_html(html, partner, "2026-07-10T12:00:00+00:00")

    assert [record.title for record in records] == [
        "June 2026 Events",
        "North Country Commons, July 19",
        "Currier Trip",
    ]
    assert records[0].start_date == "2026-06-01"
    assert records[1].start_date == "2026-07-19"
    assert records[2].start_date == "2026-07-10"
    assert all(record.kind == "event" for record in records)
