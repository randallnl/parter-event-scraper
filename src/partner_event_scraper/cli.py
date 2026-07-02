from __future__ import annotations

import argparse
import csv
import json
import os
import sys
from datetime import UTC, datetime
from pathlib import Path

import requests
import yaml

from .models import FIELDNAMES, EventRecord
from .monday import create_items, incoming_events
from .parsers import PARSERS, parse_html


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="partner-events")
    subparsers = parser.add_subparsers(dest="command", required=True)

    scrape = subparsers.add_parser("scrape", help="Scrape partner sites.")
    scrape.add_argument("--config", default="partners.yaml", help="Path to partner YAML config.")
    scrape.add_argument("--output", "-o", default="events.csv", help="Output CSV or JSON file.")
    scrape.add_argument("--format", choices=("csv", "json"), default=None, help="Output format.")
    scrape.add_argument("--partner", action="append", help="Only scrape partner name(s).")
    scrape.add_argument("--timeout", type=int, default=25, help="HTTP timeout in seconds.")
    scrape.add_argument(
        "--write-monday",
        action="store_true",
        help="Create Monday.com items for incoming event records.",
    )
    scrape.add_argument("--monday-board-id", default="18420375431", help="Monday.com board ID.")
    scrape.add_argument(
        "--monday-token-env",
        default="MONDAY_API_TOKEN",
        help="Environment variable containing the Monday.com API token.",
    )

    args = parser.parse_args(argv)
    if args.command == "scrape":
        return scrape_partners(args)
    return 1


def scrape_partners(args: argparse.Namespace) -> int:
    config_path = Path(args.config)
    config = yaml.safe_load(config_path.read_text()) or {}
    partners = config.get("partners", [])
    selected = {name.lower() for name in args.partner or []}
    if selected:
        partners = [p for p in partners if p["name"].lower() in selected]

    validate_partners(partners)
    scraped_at = datetime.now(UTC).isoformat(timespec="seconds")
    session = requests.Session()
    session.headers.update(
        {
            "User-Agent": (
                "PartnerEventScraper/0.1 "
                "(contact: add-your-contact-email@example.org)"
            )
        }
    )

    records: list[EventRecord] = []
    failures: list[str] = []
    for partner in partners:
        try:
            html = fetch(session, partner["url"], timeout=args.timeout)
            partner_records = parse_html(html, partner, scraped_at)
            records.extend(partner_records)
            print(f"{partner['name']}: {len(partner_records)} records", file=sys.stderr)
        except Exception as exc:  # noqa: BLE001 - continue scraping the remaining partners.
            failures.append(f"{partner['name']}: {exc}")
            print(f"{partner['name']}: failed: {exc}", file=sys.stderr)

    output_path = Path(args.output)
    output_format = args.format or output_path.suffix.removeprefix(".") or "csv"
    write_records(output_path, output_format, records)
    print(f"Wrote {len(records)} records to {output_path}", file=sys.stderr)

    if args.write_monday:
        token = os.environ.get(args.monday_token_env)
        if not token:
            raise RuntimeError(f"Missing Monday API token in ${args.monday_token_env}")
        monday_records = incoming_events(records, datetime.now(UTC).date())
        created = create_items(
            monday_records,
            board_id=args.monday_board_id,
            api_token=token,
            timeout=args.timeout,
        )
        print(
            f"Created {created} Monday items on board {args.monday_board_id}",
            file=sys.stderr,
        )

    return 2 if failures and not records else 0


def fetch(session: requests.Session, url: str, timeout: int) -> str:
    response = session.get(url, timeout=timeout)
    response.raise_for_status()
    return response.text


def validate_partners(partners: list[dict]) -> None:
    for partner in partners:
        missing = {"name", "url", "parser"} - partner.keys()
        if missing:
            raise ValueError(f"Partner config missing {sorted(missing)}: {partner}")
        if partner["parser"] not in PARSERS:
            raise ValueError(f"Unknown parser {partner['parser']!r} for {partner['name']}")


def write_records(path: Path, output_format: str, records: list[EventRecord]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    if output_format == "json":
        path.write_text(json.dumps([r.to_dict() for r in records], indent=2) + "\n")
        return
    if output_format != "csv":
        raise ValueError(f"Unsupported output format: {output_format}")

    with path.open("w", newline="") as file:
        writer = csv.DictWriter(file, fieldnames=FIELDNAMES)
        writer.writeheader()
        writer.writerows(record.to_dict() for record in records)


if __name__ == "__main__":
    raise SystemExit(main())
