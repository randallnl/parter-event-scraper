from datetime import date

from partner_event_scraper.models import EventRecord
from partner_event_scraper.monday import build_column_values, incoming_events


def test_build_column_values_maps_event_to_monday_columns():
    record = EventRecord(
        partner="603 Equality",
        title="Community Gathering",
        start_date="2026-07-12",
        start_time="10:00 AM",
        end_time="5:00 PM",
        location="Concord, NH",
        description="Join us.",
        url="https://example.org/event",
        source_url="https://example.org/events",
    )

    values = build_column_values(record)

    assert values["date_mm4w9x8p"] == {"date": "2026-07-12"}
    assert values["text_mm4whrb1"] == "Community Gathering"
    assert "Partner: 603 Equality" in values["text_mm4wpkzw"]
    assert values["link_mm4w7r6"] == {
        "url": "https://example.org/event",
        "text": "Event link",
    }


def test_incoming_events_keeps_only_current_and_future_events():
    records = [
        EventRecord(partner="A", title="Past", start_date="2026-07-01", kind="event"),
        EventRecord(partner="A", title="Today", start_date="2026-07-02", kind="event"),
        EventRecord(partner="A", title="News", start_date="2026-07-03", kind="announcement"),
        EventRecord(partner="A", title="Future", start_date="2026-07-04", kind="event"),
    ]

    kept = incoming_events(records, today=date(2026, 7, 2))

    assert [record.title for record in kept] == ["Today", "Future"]
