from __future__ import annotations

import json
from dataclasses import dataclass
from datetime import date

import requests

from .models import EventRecord

MONDAY_API_URL = "https://api.monday.com/v2"


@dataclass(frozen=True, slots=True)
class MondayColumnMap:
    event_date: str = "date_mm4w9x8p"
    event_title: str = "text_mm4whrb1"
    event_details: str = "text_mm4wpkzw"
    event_link: str = "link_mm4w7r6"


def incoming_events(records: list[EventRecord], today: date) -> list[EventRecord]:
    incoming: list[EventRecord] = []
    for record in records:
        if record.kind != "event" or not record.start_date:
            continue
        try:
            start_date = date.fromisoformat(record.start_date)
        except ValueError:
            continue
        if start_date >= today:
            incoming.append(record)
    return incoming


def build_column_values(
    record: EventRecord, columns: MondayColumnMap | None = None
) -> dict:
    columns = columns or MondayColumnMap()
    values: dict[str, object] = {
        columns.event_title: record.title,
        columns.event_details: build_event_details(record),
    }
    if record.start_date:
        values[columns.event_date] = {"date": record.start_date}
    if record.url:
        values[columns.event_link] = {"url": record.url, "text": "Event link"}
    return values


def build_event_details(record: EventRecord) -> str:
    details = [
        f"Partner: {record.partner}",
        f"Date: {record.start_date}",
    ]
    time_text = format_time(record)
    if time_text:
        details.append(f"Time: {time_text}")
    if record.location:
        details.append(f"Location: {record.location}")
    if record.description:
        details.append("")
        details.append(record.description)
    if record.source_url:
        details.append("")
        details.append(f"Source page: {record.source_url}")
    return "\n".join(details)


def create_items(
    records: list[EventRecord],
    board_id: str,
    api_token: str,
    columns: MondayColumnMap | None = None,
    timeout: int = 30,
) -> int:
    columns = columns or MondayColumnMap()
    session = requests.Session()
    session.headers.update(
        {
            "Authorization": api_token,
            "Content-Type": "application/json",
            "API-Version": "2025-04",
        }
    )

    created = 0
    for record in records:
        create_item(session, board_id, record, columns, timeout)
        created += 1
    return created


def create_item(
    session: requests.Session,
    board_id: str,
    record: EventRecord,
    columns: MondayColumnMap,
    timeout: int,
) -> None:
    query = """
    mutation CreatePartnerEvent($boardId: ID!, $itemName: String!, $columnValues: JSON!) {
      create_item(board_id: $boardId, item_name: $itemName, column_values: $columnValues) {
        id
      }
    }
    """
    payload = {
        "query": query,
        "variables": {
            "boardId": str(board_id),
            "itemName": record.title,
            "columnValues": json.dumps(build_column_values(record, columns)),
        },
    }
    response = session.post(MONDAY_API_URL, json=payload, timeout=timeout)
    response.raise_for_status()
    body = response.json()
    if body.get("errors"):
        raise RuntimeError(json.dumps(body["errors"]))


def format_time(record: EventRecord) -> str:
    if record.start_time and record.end_time:
        return f"{record.start_time} - {record.end_time}"
    return record.start_time or record.end_time
