"""Scale the curated scenario into a reproducible, linked event stream."""

from __future__ import annotations

import argparse
import json
from datetime import datetime, timedelta
from pathlib import Path
from typing import Any


ROOT = Path(__file__).resolve().parent
BASE = ROOT / 'dataset'


def read_json(name: str) -> Any:
    return json.loads((BASE / name).read_text(encoding='utf-8'))


def read_jsonl(name: str) -> list[dict[str, Any]]:
    return [json.loads(line) for line in (BASE / name).read_text(encoding='utf-8').splitlines() if line]


def write_json(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')


def write_jsonl(path: Path, values: list[dict[str, Any]]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(''.join(json.dumps(v, ensure_ascii=False, separators=(',', ':')) + '\n' for v in values), encoding='utf-8')


def shifted(value: str, seconds: int) -> str:
    return (datetime.fromisoformat(value) + timedelta(seconds=seconds)).isoformat(timespec='seconds')


def replace_ids(value: Any, mapping: dict[str, str], seconds: int, key: str = '') -> Any:
    if isinstance(value, dict):
        return {k: replace_ids(v, mapping, seconds, k) for k, v in value.items()}
    if isinstance(value, list):
        return [replace_ids(v, mapping, seconds, key) for v in value]
    if isinstance(value, str):
        if key in {'occurred_at', 'deliver_at'}:
            return shifted(value, seconds)
        if value in mapping:
            return mapping[value]
        if '#' in value:
            prefix, suffix = value.split('#', 1)
            if prefix in mapping:
                return f'{mapping[prefix]}#{suffix}'
    return value


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--copies', type=int, default=10, help='Number of complete 12-item scenario copies')
    parser.add_argument('--spacing-seconds', type=int, default=60, help='Start offset between copies; smaller means greater load')
    parser.add_argument('--source-replicas', type=int, default=2, help='Independent instances for each source kind')
    parser.add_argument('--output', type=Path, default=ROOT / 'load_dataset')
    args = parser.parse_args()
    if args.copies < 1 or args.spacing_seconds < 0 or args.source_replicas < 1:
        parser.error('copies and source-replicas must be positive; spacing-seconds must be non-negative')

    base_items = read_json('items.json')
    base_deliveries = read_jsonl('events/deliveries.jsonl')
    base_sources = [x['id'] for x in read_json('catalogs.json')['sources']]
    all_items: list[dict[str, Any]] = []
    all_deliveries: list[dict[str, Any]] = []
    source_ids: set[str] = set()

    for copy_number in range(1, args.copies + 1):
        prefix = f'LOAD-{copy_number:04d}-'
        identifiers: set[str] = set()
        for item in base_items:
            identifiers.add(item['id'])
            identifiers.add(item['work_order_id'])
            identifiers.update(component['id'] for component in item['components'])
        for delivery in base_deliveries:
            identifiers.add(delivery['delivery_id'])
            message = delivery['message']
            identifiers.add(message['event_id'])
            if 'operation_run_id' in message:
                identifiers.add(message['operation_run_id'])
        mapping = {identifier: prefix + identifier for identifier in identifiers}
        replica = (copy_number - 1) % args.source_replicas + 1
        mapping.update({source: f'{source}-R{replica:02d}' for source in base_sources})
        source_ids.update(mapping[source] for source in base_sources)
        offset = (copy_number - 1) * args.spacing_seconds
        all_items.extend(replace_ids(item, mapping, offset) for item in base_items)
        all_deliveries.extend(replace_ids(delivery, mapping, offset) for delivery in base_deliveries)

    all_deliveries.sort(key=lambda row: (row['deliver_at'], row['delivery_id']))
    item_ids = {item['id'] for item in all_items}
    event_ids = {row['message']['event_id'] for row in all_deliveries}
    assert len(item_ids) == 12 * args.copies
    base_unique_count = len({row['message']['event_id'] for row in base_deliveries})
    assert len(event_ids) == base_unique_count * args.copies
    assert len(all_deliveries) == len(base_deliveries) * args.copies
    assert all(row['message']['item_id'] in item_ids for row in all_deliveries)
    assert all(row['message']['source_id'] in source_ids for row in all_deliveries)
    run_ids = {row['message']['operation_run_id'] for row in all_deliveries if 'operation_run_id' in row['message']}
    for row in all_deliveries:
        message = row['message']
        data = message['data']
        if message['event_type'] in {'quality_decision', 'cause_review'}:
            assert all(ref.split('#', 1)[0] in event_ids for ref in data['finding_refs'])
        if message['event_type'] == 'cause_review':
            assert all(ref in event_ids for ref in data['basis_event_ids'])
        if message['event_type'] == 'operation_started' and data['previous_operation_run_id']:
            assert data['previous_operation_run_id'] in run_ids

    output = args.output.resolve()
    write_json(output / 'manifest.json', {
        'source_dataset': 'cosmo-quality-synthetic-v1',
        'synthetic': True,
        'copies': args.copies,
        'spacing_seconds': args.spacing_seconds,
        'source_replicas_per_kind': args.source_replicas,
        'distinct_source_ids': len(source_ids),
        'item_count': len(item_ids),
        'unique_event_count': len(event_ids),
        'delivery_count': len(all_deliveries),
        'note': 'Синтетическая нагрузка для проверки порядка событий по изделию, повторов и полноты обработки.',
    })
    write_json(output / 'items.json', all_items)
    write_json(output / 'source_ids.json', sorted(source_ids))
    write_jsonl(output / 'deliveries.jsonl', all_deliveries)
    print(f'Generated {len(item_ids)} items, {len(event_ids)} events, {len(all_deliveries)} deliveries in {output}')


if __name__ == '__main__':
    main()
