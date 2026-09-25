"""Reference ingestion replay for expanded synthetic deliveries, without packages."""

from __future__ import annotations

import json
from collections import Counter
from datetime import datetime
from pathlib import Path
from typing import Any


ROOT = Path(__file__).resolve().parent / 'expanded_dataset'
REQUIRED = {'event_id', 'event_type', 'schema_version', 'occurred_at', 'source_id',
            'item_id', 'item_type_id', 'line_id', 'station_id', 'shift_id', 'data'}
RESULTS = {'signs_detected', 'no_signs_detected', 'unable_to_assess'}


def load(path: str) -> Any:
    content = (ROOT / path).read_text(encoding='utf-8')
    return [json.loads(line) for line in content.splitlines()] if path.endswith('.jsonl') else json.loads(content)


def parse_time(value: Any) -> bool:
    try:
        return isinstance(value, str) and datetime.fromisoformat(value).tzinfo is not None
    except (TypeError, ValueError):
        return False


def replay() -> Counter[str]:
    items = {item['id'] for item in load('items.json')}
    stations = {station['id'] for station in load('catalogs.json')['stations']}
    media = {asset['asset_id'] for asset in load('media_index.json')}
    expected = {entry['delivery_id']: entry for entry in load('expected/ingest_outcomes.json')}
    stream = load('events/ingest_stream.jsonl')
    seen: dict[str, dict[str, Any]] = {}
    counts: Counter[str] = Counter()
    for delivery in stream:
        message = delivery['message']
        data = message.get('data', {})
        error: str | None = None
        if not REQUIRED <= message.keys():
            error = 'missing_item_id' if 'item_id' not in message else 'missing_occurred_at'
        elif message['schema_version'] not in {'1.0', '2.0'}:
            error = 'unsupported_schema'
        elif not parse_time(message['occurred_at']) or not parse_time(delivery['deliver_at']):
            error = 'invalid_timestamp'
        elif message['item_id'] not in items:
            error = 'unknown_item_id'
        elif message['station_id'] not in stations:
            error = 'unknown_station'
        elif message['event_type'] == 'inspection_result':
            if data.get('inspection_result') not in RESULTS:
                error = 'invalid_inspection_enum'
            elif data.get('confidence') is not None and not 0 <= data['confidence'] <= 1:
                error = 'negative_confidence'
            elif any(asset_id not in media for asset_id in data.get('evidence_refs', [])):
                error = 'unknown_media_ref'
        if error is None and message['event_id'] in seen:
            error = 'duplicate' if seen[message['event_id']] == message else 'conflicting_redelivery'
        if error is None:
            seen[message['event_id']] = message
            outcome = 'accepted'
        elif error == 'duplicate':
            outcome = 'duplicate'
        else:
            outcome = 'quarantined'
        counts[outcome] += 1
        reference = expected[delivery['delivery_id']]
        if reference['outcome'] != outcome or reference.get('error_code') != (error if outcome == 'quarantined' else None):
            raise AssertionError(f'Unexpected ingestion result for {delivery["delivery_id"]}: {outcome}, {error}; expected {reference}')
    if len(expected) != len(stream):
        raise AssertionError('Expected outcome file does not cover the stream')
    print(f'REPLAY OK: {counts["accepted"]} accepted, {counts["duplicate"]} exact duplicates, {counts["quarantined"]} quarantined')
    return counts


if __name__ == '__main__':
    replay()
