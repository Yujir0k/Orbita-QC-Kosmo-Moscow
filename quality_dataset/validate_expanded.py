"""Check integrity, causal links, media, and demo paths in expanded fixtures."""

from __future__ import annotations

import hashlib
import json
from collections import Counter, defaultdict
from datetime import datetime
from pathlib import Path
from typing import Any


ROOT = Path(__file__).resolve().parent
DATA = ROOT / 'expanded_dataset'


def read_json(path: str) -> Any:
    return json.loads((DATA / path).read_text(encoding='utf-8'))


def read_jsonl(path: str) -> list[dict[str, Any]]:
    return [json.loads(line) for line in (DATA / path).read_text(encoding='utf-8').splitlines()]


def require(condition: bool, message: str) -> None:
    if not condition:
        raise AssertionError(message)


def validate() -> None:
    manifest = read_json('manifest.json')
    items = read_json('items.json')
    catalogs = read_json('catalogs.json')
    media = read_json('media_index.json')
    routes = read_json('demo_routes.json')
    timeline = read_json('expected/demo_timeline.json')
    metrics = read_json('expected/metrics.json')
    categories = read_json('expected/category_by_item.json')
    deliveries = read_jsonl('events/deliveries.jsonl')
    sources = read_jsonl('events/source_deliveries.jsonl')
    actions = read_jsonl('interactions/scripted_actions.jsonl')
    ingest = read_jsonl('events/ingest_stream.jsonl')
    invalid = read_jsonl('events/invalid_deliveries.jsonl')
    outcomes = read_json('expected/ingest_outcomes.json')

    item_by_id = {item['id']: item for item in items}
    asset_by_id = {asset['asset_id']: asset for asset in media}
    require(len(item_by_id) == len(items) == manifest['item_count'] == 180, 'Item count/IDs')
    require(len(asset_by_id) == len(media) == manifest['media_asset_count'] == 18, 'Media count/IDs')
    require(set(routes['event_refs']) == set(manifest['demo_item_ids']) == {f'ITEM-{n:03d}' for n in range(13, 22)}, 'Demo IDs')
    require(len(categories) == 162 and sum(Counter(categories.values()).values()) == 162, 'Category count')
    require(Counter(categories.values()) == manifest['background_mix'], 'Category mix')
    require(all(asset['synthetic_generated_image'] is True for asset in media), 'Unmarked synthetic image')
    for asset in media:
        path = ROOT / asset['path_from_quality_dataset']
        require(path.is_file(), f'Missing image: {path}')
        require(hashlib.sha256(path.read_bytes()).hexdigest() == asset['sha256'], f'Media hash mismatch: {asset["asset_id"]}')
        require(asset['item_id'] in item_by_id, f'Media item missing: {asset["asset_id"]}')

    source_ids = {source['id'] for source in catalogs['sources']}
    station_ids = {station['id'] for station in catalogs['stations']}
    equipment_ids = {equipment['id'] for equipment in catalogs['equipment']}
    operator_shift = {operator['id']: operator['shift_id'] for operator in catalogs['operators']}
    require(len(deliveries) == manifest['delivery_count'], 'Delivery count')
    require(deliveries == sorted(deliveries, key=lambda value: (value['deliver_at'], value['delivery_id'])), 'Delivery order')
    require(len({delivery['delivery_id'] for delivery in deliveries}) == len(deliveries), 'Duplicate delivery_id')
    by_event: dict[str, dict[str, Any]] = {}
    duplicated = 0
    for record in deliveries:
        message = record['message']
        event_id = message['event_id']
        if event_id in by_event:
            duplicated += 1
            require(by_event[event_id] == message, f'Conflicting valid redelivery: {event_id}')
        else:
            by_event[event_id] = message
        require(message['item_id'] in item_by_id, f'Unknown item: {event_id}')
        require(message['source_id'] in source_ids, f'Unknown source: {event_id}')
        require(message['station_id'] in station_ids, f'Unknown station: {event_id}')
        require(message.get('equipment_id') is None or message['equipment_id'] in equipment_ids, f'Unknown equipment: {event_id}')
        require(datetime.fromisoformat(message['occurred_at']).tzinfo is not None, f'Naive event time: {event_id}')
        require(datetime.fromisoformat(record['deliver_at']).tzinfo is not None, f'Naive delivery time: {event_id}')
        require(record['deliver_at'] >= message['occurred_at'], f'Delivery precedes event: {event_id}')
        require(message['schema_version'] in {'1.0', '2.0'}, f'Unknown valid schema: {event_id}')
        require(message['item_type_id'] == item_by_id[message['item_id']]['item_type_id'], f'Item type mismatch: {event_id}')
        if message['schema_version'] == '2.0':
            require(message['line_id'] == item_by_id[message['item_id']]['line_id'], f'Line mismatch: {event_id}')
            state = message.get('item_state', {})
            require(isinstance(state.get('physical_location'), str) and bool(state['physical_location']), f'Physical location missing: {event_id}')
            require(state.get('line_lock_status') in {'HELD_AT_STATION', 'IN_BUFFER', 'ROUTED_FORWARD'}, f'Invalid line lock: {event_id}')
            if message.get('actor_id') in operator_shift:
                require(operator_shift[message['actor_id']] == message['shift_id'], f'Operator shift mismatch: {event_id}')
        data = message['data']
        if message['event_type'] == 'inspection_result':
            require(data['inspection_result'] in {'signs_detected', 'no_signs_detected', 'unable_to_assess'}, f'Result enum: {event_id}')
            require(data['observation_quality'] in {'good', 'poor'}, f'Quality enum: {event_id}')
            require(data['confidence'] is None or 0 <= data['confidence'] <= 1, f'Confidence range: {event_id}')
            require(data['inspection_result'] != 'unable_to_assess' or data['confidence'] is None, f'Unassessable confidence: {event_id}')
            require(data['inspection_result'] != 'signs_detected' or data['defects'], f'Missing defect: {event_id}')
            if message['schema_version'] == '2.0':
                require(bool(data.get('observation_summary')), f'Missing observation summary: {event_id}')
                require(bool(data.get('comparison', {}).get('summary')), f'Missing comparison: {event_id}')
                spec = data.get('kd_spec', {})
                require(spec.get('surface_zone_class') in {'ZONE_A_CRITICAL', 'ZONE_B_MATING', 'ZONE_C_NON_CRITICAL'}, f'Invalid KD zone: {event_id}')
                require(isinstance(spec.get('max_allowable_defect_length_mm'), (int, float)) and spec['max_allowable_defect_length_mm'] >= 0, f'Invalid KD limit: {event_id}')
                require(isinstance(spec.get('standard_ref'), str) and bool(spec['standard_ref']), f'Missing KD reference: {event_id}')
                if data['inspection_result'] == 'signs_detected':
                    require(all(defect.get('description') and defect.get('observed_feature') for defect in data['defects']), f'Missing text evidence: {event_id}')
                for defect in data['defects']:
                    require(defect.get('defect_class') in {'SCRATCH', 'CRACK', 'BURR', 'DENT', 'DISCOLORATION'}, f'Invalid defect class: {event_id}')
                    require(defect['defect_class'] == defect['defect_type_id'], f'Conflicting defect class: {event_id}')
                    require(all(isinstance(defect.get(key), (int, float)) and defect[key] > 0 for key in ('length_mm', 'width_mm')), f'Invalid CV dimensions: {event_id}')
                    require(defect.get('depth_estimated_mm') is None or isinstance(defect['depth_estimated_mm'], (int, float)) and defect['depth_estimated_mm'] >= 0, f'Invalid estimated depth: {event_id}')
                    require(defect.get('dimension_source') == ('synthetic_calibrated_2d_cv_estimate' if data['method'] == 'external_analyzer' else 'synthetic_manual_scale_estimate'), f'Dimension origin lost: {event_id}')
                if data['method'] == 'external_analyzer' and not data['evidence_refs']:
                    require(bool(data['capture_context'].get('missing_image_reason')), f'Missing image gap reason: {event_id}')
                if data['inspection_point_id'] != 'CP-IN':
                    evidence = data.get('media_evidence', {})
                    require(set(evidence) == {'before_operation', 'after_operation'}, f'Media pair missing: {event_id}')
                    for name, slot in evidence.items():
                        require(set(slot) == {'url', 'sha256_hash', 'status', 'absence_reason'}, f'Media slot fields: {event_id}/{name}')
                        if slot['status'] == 'AVAILABLE':
                            matching = [asset for asset in media if slot['url'] == '/media/' + Path(asset['path_from_quality_dataset']).name]
                            require(len(matching) == 1 and matching[0]['item_id'] == message['item_id'] and matching[0]['sha256'] == slot['sha256_hash'] and slot['absence_reason'] == 'NONE', f'Invalid available media: {event_id}/{name}')
                        else:
                            require(slot['status'] == 'MISSING' and slot['url'] is None and slot['sha256_hash'] == '' and slot['absence_reason'] in {'LOST_IN_TRANSIT', 'CLASSIFIED_RESTRICTED', 'NO_CAMERA_AT_STATION'}, f'Invalid missing media: {event_id}/{name}')
            for asset_id in data['evidence_refs']:
                require(asset_id in asset_by_id and asset_by_id[asset_id]['item_id'] == message['item_id'], f'Invalid media ref: {event_id}')
        if message['event_type'] == 'master_action':
            require(message.get('actor_id', '').startswith('MASTER-'), f'Wrong master author: {event_id}')
            for asset_id in data['evidence_refs']:
                require(asset_id in asset_by_id and asset_by_id[asset_id]['item_id'] == message['item_id'], f'Invalid master media: {event_id}')
        if message['event_type'] == 'quality_decision':
            require(message.get('actor_id', '').startswith('QC-'), f'Wrong decision author: {event_id}')
            require(bool(data['reason']), f'Decision reason blank: {event_id}')
        if message['event_type'] == 'controller_check':
            require(message.get('actor_id', '').startswith('QC-'), f'Wrong check author: {event_id}')
            require(data['observation_event_id'] in by_event or data['observation_event_id'] in
                    {record['message']['event_id'] for record in deliveries}, f'Controller check lacks signal: {event_id}')
    require(len(by_event) == manifest['unique_event_count'], 'Unique event count')
    for message in by_event.values():
        if message['schema_version'] != '2.0' or message['event_type'] != 'quality_decision' or message['data']['decision'] != 'confirmed':
            continue
        observations = [by_event[ref.split('#')[0]] for ref in message['data']['finding_refs']]
        if observations and all(not observation['data'].get('evidence_refs') for observation in observations):
            prior_checks = [check for check in by_event.values()
                            if check['event_type'] == 'controller_check' and check['item_id'] == message['item_id']
                            and check['event_id'] in message['data']['evidence_event_ids']]
            prior_manual = [observation for observation in by_event.values()
                            if observation['item_id'] == message['item_id'] and observation['event_type'] == 'inspection_result'
                            and observation['data']['method'] in {'manual', 'manual_verification'}
                            and observation['occurred_at'] <= message['occurred_at']]
            require(bool(prior_checks or prior_manual), f'Photo-free confirmation without documented human check: {message["event_id"]}')
    require(metrics['counts']['items'] == len(items), 'Metrics item count')
    require(metrics['counts']['unique_events'] == len(by_event), 'Metrics event count')
    require(metrics['counts']['duplicate_deliveries'] == len(deliveries) - len(by_event), 'Metrics duplicate count')
    require(metrics['counts']['release_after_rework_decisions'] == sum(
        message['event_type'] == 'quality_decision' and message['data']['decision'] == 'release_after_rework'
        for message in by_event.values()), 'Metrics release count')
    require(metrics['counts']['rework_operation_runs'] == sum(
        message['event_type'] == 'operation_started' and bool(message['data']['previous_operation_run_id'])
        for message in by_event.values()), 'Metrics rework count')
    for event_id, message in by_event.items():
        data = message['data']
        for key in ('basis_event_ids', 'evidence_event_ids'):
            for basis_id in data.get(key, []):
                require(basis_id in by_event, f'Basis missing: {event_id} -> {basis_id}')
                require(by_event[basis_id]['item_id'] == message['item_id'], f'Cross-item basis: {event_id}')
                require(by_event[basis_id]['occurred_at'] <= message['occurred_at'], f'Future basis: {event_id}')
        for ref in data.get('finding_refs', []):
            inspection_id, finding_id = ref.split('#', 1)
            source = by_event.get(inspection_id)
            require(source is not None and source['item_id'] == message['item_id'], f'Finding event missing: {ref}')
            require(any(defect['finding_id'] == finding_id for defect in source['data'].get('defects', [])), f'Finding missing: {ref}')
    require(duplicated == manifest['duplicate_delivery_count'] and duplicated >= 100, 'Duplicate count')
    require(len(sources) + len(actions) == len(deliveries), 'Source/action partition')
    require(all(record['message']['source_id'] not in {'QC-UI', 'TECH-UI', 'MASTER-UI'} for record in sources), 'Human action in source stream')
    require(all(record['message']['source_id'] in {'QC-UI', 'TECH-UI', 'MASTER-UI'} for record in actions), 'Source event in actions')

    starts = {message['operation_run_id']: message for message in by_event.values() if message['event_type'] == 'operation_started'}
    finishes = {message['operation_run_id']: message for message in by_event.values() if message['event_type'] == 'operation_finished'}
    require(len(finishes) == len(starts) - 1, 'Unexpected unfinished operation count')
    for run, finish in finishes.items():
        require(run in starts, f'Finish without start: {run}')
        start = starts[run]
        require(start['item_id'] == finish['item_id'], f'Run item mismatch: {run}')
        require(start['occurred_at'] < finish['occurred_at'], f'Run time mismatch: {run}')
        reported = finish['data']['reported_duration']
        elapsed = (datetime.fromisoformat(finish['occurred_at']) - datetime.fromisoformat(start['occurred_at'])).total_seconds() / 60
        require(reported['value'] == elapsed and reported['meaning'] == 'elapsed_station_time', f'Duration mismatch: {run}')
        previous = start['data'].get('previous_operation_run_id')
        if previous:
            require(previous in finishes and finishes[previous]['item_id'] == finish['item_id'], f'Rework linkage: {run}')
    for resource in ('equipment_id', 'actor_id'):
        occupied: dict[str, list[tuple[datetime, datetime, str]]] = defaultdict(list)
        for run, start in starts.items():
            if run not in finishes or start['schema_version'] != '2.0':
                continue
            if start.get(resource):
                occupied[start[resource]].append((datetime.fromisoformat(start['occurred_at']),
                                                   datetime.fromisoformat(finishes[run]['occurred_at']), run))
        for resource_id, intervals in occupied.items():
            intervals.sort()
            for earlier, later in zip(intervals, intervals[1:]):
                require(earlier[1] <= later[0], f'Overlapping {resource}: {resource_id}, {earlier[2]}, {later[2]}')

    demo = routes['event_refs']
    def time_of(item: str, step: str) -> str:
        return by_event[demo[item][step]]['occurred_at']
    require(time_of('ITEM-013', 'detected') < time_of('ITEM-013', 'confirmed') < time_of('ITEM-013', 'master_photo') < time_of('ITEM-013', 'measurement') < time_of('ITEM-013', 'recheck') < time_of('ITEM-013', 'released'), 'Successful rework sequence')
    require(time_of('ITEM-014', 'detected') < time_of('ITEM-014', 'first_master') < time_of('ITEM-014', 'failed_recheck') < time_of('ITEM-014', 'second_master') < time_of('ITEM-014', 'successful_recheck') < time_of('ITEM-014', 'released'), 'Second rework sequence')
    require(by_event[demo['ITEM-014']['failed_recheck']]['data']['inspection_result'] == 'signs_detected', 'Failed rework wrongly clear')
    require(by_event[demo['ITEM-014']['successful_recheck']]['data']['inspection_result'] == 'no_signs_detected', 'Second rework not clear')
    require(by_event[demo['ITEM-015']['unassessable']]['data']['evidence_refs'] == [], 'Missing-photo scenario has initial image')
    require(by_event[demo['ITEM-015']['master_photo']]['data']['evidence_refs'] == ['M015-MASTER-DENT'], 'Master photo missing')
    require(by_event[demo['ITEM-015']['scrap']]['data']['disposition'] == 'scrap', 'Critical disposition missing')
    require(by_event[demo['ITEM-016']['rejected']]['data']['decision'] == 'rejected', 'False positive not rejected')
    require(by_event[demo['ITEM-016']['suspected']]['data']['evidence_refs'] == ['M016-CV-GLARE'], 'Glare photo missing')
    require(by_event[demo['ITEM-013']['before_machine']]['data']['evidence_refs'] == ['M013-CV-BEFORE'], 'Missing initial photo for 013')
    require(by_event[demo['ITEM-014']['before_machine']]['data']['evidence_refs'] == ['M014-CV-BEFORE'], 'Missing initial photo for 014')
    require(time_of('ITEM-013', 'before_machine') < time_of('ITEM-013', 'detected'), 'Before/after operation order for 013')
    require(time_of('ITEM-014', 'before_machine') < time_of('ITEM-014', 'detected'), 'Before/after operation order for 014')
    preexisting = by_event[demo['ITEM-019']['after_machine']]['data']
    require(preexisting['media_evidence']['before_operation']['status'] == 'AVAILABLE' and preexisting['media_evidence']['after_operation']['status'] == 'AVAILABLE', 'Pre-existing defect photos incomplete')
    require(by_event[demo['ITEM-019']['before_machine']]['data']['defects'][0]['length_mm'] == preexisting['defects'][0]['length_mm'], 'Pre-existing defect dimensions changed')
    require('уже был' in preexisting['comparison']['summary'], 'Pre-existing defect attribution missing')
    lost = by_event[demo['ITEM-020']['after_signal']]['data']['media_evidence']
    require(lost['before_operation']['status'] == 'AVAILABLE' and lost['after_operation']['status'] == 'MISSING' and lost['after_operation']['absence_reason'] == 'LOST_IN_TRANSIT', 'Lost-after-photo scenario')
    restricted = by_event[demo['ITEM-021']['restricted_signal']]['data']
    require(all(slot['status'] == 'MISSING' and slot['absence_reason'] == 'CLASSIFIED_RESTRICTED' for slot in restricted['media_evidence'].values()), 'Restricted-photo scenario')
    require(restricted['defects'][0]['length_mm'] > 0 and restricted['kd_spec']['standard_ref'], 'Restricted text metrics/KD missing')
    for item, camera, master in [('ITEM-025', 'M025-CV-BURR', 'M025-MASTER-CLEAR'), ('ITEM-028', 'M028-CV-SCRATCH', 'M028-MASTER-CLEAR')]:
        own = [event for event in by_event.values() if event['item_id'] == item]
        require(any(camera in event['data'].get('evidence_refs', []) for event in own), f'Missing photo of defect: {item}')
        require(any(master in event['data'].get('evidence_refs', []) for event in own), f'Missing photo after rework: {item}')
    require(len(timeline) == sum(len(value) for value in demo.values()), 'Timeline size')
    for step in timeline:
        require(demo[step['item_id']][step['step']] == step['event_id'], 'Timeline reference mismatch')

    require(len(invalid) == manifest['invalid_delivery_count'] == 30, 'Invalid count')
    require(len(ingest) == len(deliveries) + len(invalid), 'Ingest stream missing records')
    require({value['delivery_id'] for value in ingest} == {value['delivery_id'] for value in deliveries} |
            {entry['delivery']['delivery_id'] for entry in invalid}, 'Ingest IDs')
    require(len(outcomes) == len(ingest), 'Ingest expected outcomes count')
    outcome_by_id = {entry['delivery_id']: entry for entry in outcomes}
    require(len(outcome_by_id) == len(outcomes), 'Duplicate outcome ID')
    for case in invalid:
        delivery = case['delivery']
        require(delivery['delivery_id'] not in {d['delivery_id'] for d in deliveries}, 'Invalid record in valid history')
        require(outcome_by_id[delivery['delivery_id']]['outcome'] == 'quarantined', 'Invalid outcome')
        require(outcome_by_id[delivery['delivery_id']]['error_code'] == case['expected_error_code'], 'Invalid error code')
        require(case['expected_behavior'] == 'quarantine_without_mutating_history', 'Invalid policy')
    require(Counter(x['outcome'] for x in outcomes) == {'accepted': len(by_event), 'duplicate': duplicated, 'quarantined': len(invalid)}, 'Outcome distribution')
    require(len([m for m in by_event.values() if m['event_type'] == 'quality_decision' and m['data']['decision'] == 'release_after_rework']) >
            len([m for m in by_event.values() if m['event_type'] == 'quality_decision' and m['data']['decision'] == 'scrap_approved']) * 5,
            'Repairable cases do not dominate')
    print(f'OK: {len(items)} items, {len(by_event)} events, {len(deliveries)} deliveries ({duplicated} duplicates), {len(invalid)} quarantined cases, {len(media)} images')


if __name__ == '__main__':
    validate()
