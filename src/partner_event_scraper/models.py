from __future__ import annotations

from dataclasses import asdict, dataclass


@dataclass(slots=True)
class EventRecord:
    partner: str
    title: str
    start_date: str = ""
    end_date: str = ""
    start_time: str = ""
    end_time: str = ""
    location: str = ""
    description: str = ""
    url: str = ""
    source_url: str = ""
    kind: str = "event"
    scraped_at: str = ""

    def to_dict(self) -> dict[str, str]:
        return asdict(self)


FIELDNAMES = list(EventRecord(partner="", title="").to_dict().keys())
