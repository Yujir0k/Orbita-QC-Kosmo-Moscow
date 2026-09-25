"""Validate references, event semantics and expected results of the demo dataset."""

from __future__ import annotations

import copy
import hashlib
import json
from collections import Counter, defaultdict
from datetime import datetime
from pathlib import Path
from typing import Any


ROOT = Path(__file__).resolve().parent / 'dataset'


def read_json(name: str) -> Any:
    return json.loads((ROOT / name).read_text(encoding='utf-8'))


def read_jsonl(name: str) -> list[dict[str, Any]]:
    return [json.loads(line) for line in (ROOT / name).read_text(encoding='utf-8').splitlines() if line]


def require(condition: bool, message: str) -> None:
    if not condition:
        raise AssertionError(message)


def canonical(value: Any) -> bytes:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(',', ':')).encode('utf-8')


def validate() -> None:
    manifest = read_json('manifest.json')
    catalogs = read_json('catalogs.json')
    assemblies = read_json('assemblies.json')
    items = read_json('items.json')
    deliveries = read_jsonl('events/deliveries.jsonl')
    source_deliveries = read_jsonl('events/source_deliveries.jsonl')
    scripted_actions = read_jsonl('interactions/scripted_actions.jsonl')
    inspection_plan = read_json('inspection_plan.json')
    demo_route = read_json('demo_route.json')
    invalid_deliveries = read_jsonl('events/invalid_deliveries.jsonl')
    scenarios = read_json('expected/scenarios.json')
    checkpoints = read_json('expected/checkpoints.json')
    workflow_actions = read_json('expected/workflow_actions.json')
    metrics = read_json('expected/metrics.json')['at_end_of_replay']
    orders = read_jsonl('integration/inbound.jsonl')
    target_profiles = read_json('integration/target_profiles.json')
    outbound = read_jsonl('integration/expected_outbound.jsonl')
    responses = read_jsonl('integration/emulator_responses.jsonl')
    response_plan = read_json('integration/emulator_response_plan.json')
    integrity = read_json('integrity/baseline.json')
    tamper = read_json('integrity/tamper_case.json')

    require(manifest['synthetic'] is True, 'Dataset must be labelled synthetic')
    require(len(items) == manifest['item_count'] == 12, 'Item count mismatch')
    require(len(deliveries) == manifest['delivery_count'], 'Delivery count mismatch')
    require(len(source_deliveries) == manifest['source_delivery_count'], 'Source delivery count mismatch')
    require(len(scripted_actions) == manifest['scripted_human_action_count'], 'Human action count mismatch')
    require(len({d['delivery_id'] for d in deliveries}) == len(deliveries), 'Duplicate delivery ID')
    require(deliveries == sorted(deliveries, key=lambda x: (x['deliver_at'], x['delivery_id'])), 'Deliveries are not replay-ordered')
    require({d['delivery_id'] for d in source_deliveries}.isdisjoint({d['delivery_id'] for d in scripted_actions}), 'Source and human streams overlap')
    require({d['delivery_id'] for d in source_deliveries + scripted_actions} == {d['delivery_id'] for d in deliveries}, 'Split streams do not reconstruct full replay')
    require(all(d['message']['source_id'] not in {'QC-UI', 'TECH-UI'} for d in source_deliveries), 'Human action found in source stream')
    require(all(d['message']['source_id'] in {'QC-UI', 'TECH-UI'} for d in scripted_actions), 'Non-human event found in action stream')
    require({point['id'] for point in inspection_plan['control_points']} == {'CP-IN', 'CP-POST-MILL', 'CP-FINAL'}, 'Inspection plan point mismatch')
    require({step['item_id'] for step in demo_route['short_route'] + demo_route['extended_route']} <= {item['id'] for item in items}, 'Demo route references missing item')

    item_by_id = {item['id']: item for item in items}
    require(len(item_by_id) == len(items), 'Duplicate item ID')
    catalog_ids = {key: {entry['id'] for entry in catalogs[key]} for key in [
        'item_types', 'component_types', 'lines', 'stations', 'operations', 'operators',
        'reviewers', 'shifts', 'equipment', 'inspection_points', 'defect_types', 'sources',
    ]}
    operations_by_id = {entry['id']: entry for entry in catalogs['operations']}
    equipment_by_id = {entry['id']: entry for entry in catalogs['equipment']}
    points_by_id = {entry['id']: entry for entry in catalogs['inspection_points']}
    operators_by_id = {entry['id']: entry for entry in catalogs['operators']}
    for item in items:
        require(item['item_type_id'] in catalog_ids['item_types'], f'Unknown item type in {item["id"]}')
        require(len({c['id'] for c in item['components']}) == len(item['components']), f'Duplicate component in {item["id"]}')
        counts = Counter(c['component_type_id'] for c in item['components'])
        require(all(k in catalog_ids['component_types'] for k in counts), f'Unknown component type in {item["id"]}')
        assembly = next((a for a in assemblies if a['item_type_id'] == item['item_type_id'] and a['revision'] == item['assembly_revision']), None)
        require(assembly is not None, f'Missing assembly revision for {item["id"]}')
        require(counts == Counter({c['component_type_id']: c['quantity'] for c in assembly['components']}), f'Wrong assembly contents in {item["id"]}')
        require(assembly['geometry_included'] is False, 'Geometry must not be falsely claimed')

    seen_events: dict[str, dict[str, Any]] = {}
    first_order: list[str] = []
    for record in deliveries:
        message = record['message']
        event_id = message['event_id']
        if event_id in seen_events:
            require(seen_events[event_id] == message, f'Conflicting redelivery of {event_id}')
        else:
            seen_events[event_id] = message
            first_order.append(event_id)
        require(datetime.fromisoformat(message['occurred_at']) <= datetime.fromisoformat(record['deliver_at']), f'Delivery precedes occurrence: {event_id}')
        require(message['schema_version'] == '1.0', f'Unsupported schema version: {event_id}')
        require(message['item_id'] in item_by_id, f'Unknown item: {event_id}')
        require(message['item_type_id'] == item_by_id[message['item_id']]['item_type_id'], f'Item type mismatch: {event_id}')
        for field, collection in [
            ('source_id', 'sources'), ('line_id', 'lines'), ('station_id', 'stations'), ('shift_id', 'shifts'),
            ('equipment_id', 'equipment'),
        ]:
            if field in message:
                require(message[field] in catalog_ids[collection], f'Unknown {field}: {event_id}')
        if 'actor_id' in message:
            require(message['actor_id'] in catalog_ids['operators'] | catalog_ids['reviewers'], f'Unknown actor: {event_id}')
            if message['actor_id'] in operators_by_id:
                require(operators_by_id[message['actor_id']]['shift_id'] == message['shift_id'], f'Operator/shift mismatch: {event_id}')
        if 'equipment_id' in message:
            require(equipment_by_id[message['equipment_id']]['station_id'] == message['station_id'], f'Equipment/station mismatch: {event_id}')
    require(len(seen_events) == manifest['unique_event_count'], 'Unique event count mismatch')
    require(len(deliveries) - len(seen_events) == 1, 'Expected exactly one redelivery')

    finding_to_group: dict[str, tuple[str, str, str, str]] = {}
    groups_to_observations: dict[tuple[str, str, str, str], list[str]] = defaultdict(list)
    starts: dict[str, dict[str, Any]] = {}
    finishes: dict[str, dict[str, Any]] = {}
    confirmed_groups: set[tuple[str, str, str, str]] = set()
    rejected_groups: set[tuple[str, str, str, str]] = set()
    final_inspected: set[str] = set()
    any_inspected: set[str] = set()
    cause_confirmed_items: set[str] = set()
    confirmed_procedural_errors = 0
    rework_runs = 0

    for message in seen_events.values():
        event_id = message['event_id']
        kind = message['event_type']
        data = message['data']
        if kind == 'item_received':
            item = item_by_id[message['item_id']]
            require(data['work_order_id'] == item['work_order_id'], f'Item/order mismatch: {event_id}')
            require(data['assembly_revision'] == item['assembly_revision'], f'Item/assembly mismatch: {event_id}')
            require(set(data['component_ids']) == {c['id'] for c in item['components']}, f'Item/components mismatch: {event_id}')
        elif kind == 'inspection_result':
            require(data['inspection_point_id'] in catalog_ids['inspection_points'], f'Unknown point: {event_id}')
            require(points_by_id[data['inspection_point_id']]['station_id'] == message['station_id'], f'Point/station mismatch: {event_id}')
            require(data['inspection_result'] in {'signs_detected', 'no_signs_detected', 'unable_to_assess'}, f'Bad inspection result: {event_id}')
            require(data['observation_quality'] in {'good', 'poor'}, f'Bad observation quality: {event_id}')
            require(data['method'] in {'manual', 'external_analyzer'}, f'Bad method: {event_id}')
            if data['inspection_result'] == 'signs_detected':
                require(len(data['defects']) > 0, f'Missing findings: {event_id}')
            else:
                require(not data['defects'], f'Findings on non-detection: {event_id}')
            if data['inspection_result'] != 'unable_to_assess' and data['observation_quality'] == 'good':
                any_inspected.add(message['item_id'])
                if data['inspection_point_id'] == 'CP-FINAL':
                    final_inspected.add(message['item_id'])
            for defect in data['defects']:
                require(defect['defect_type_id'] in catalog_ids['defect_types'], f'Unknown defect type: {event_id}')
                require(defect['component_id'] in {c['id'] for c in item_by_id[message['item_id']]['components']}, f'Wrong component: {event_id}')
                ref = f'{event_id}#{defect["finding_id"]}'
                require(ref not in finding_to_group, f'Duplicate finding ref: {ref}')
                group = (message['item_id'], defect['component_id'], defect['defect_type_id'], defect['region'])
                finding_to_group[ref] = group
                groups_to_observations[group].append(ref)
        elif kind == 'operation_started':
            run_id = message['operation_run_id']
            require(run_id not in starts, f'Duplicate operation start: {run_id}')
            require(data['operation_id'] in catalog_ids['operations'], f'Unknown operation: {event_id}')
            require(operations_by_id[data['operation_id']]['station_id'] == message['station_id'], f'Operation/station mismatch: {event_id}')
            starts[run_id] = message
            if data['previous_operation_run_id']:
                rework_runs += 1
        elif kind == 'operation_finished':
            run_id = message['operation_run_id']
            require(run_id not in finishes, f'Duplicate operation finish: {run_id}')
            require(data['reported_duration']['unit'] == 'minute', f'Unknown duration unit: {event_id}')
            require(data['reported_duration']['meaning'] == 'elapsed_station_time', f'Unknown interval meaning: {event_id}')
            require(operations_by_id[data['operation_id']]['station_id'] == message['station_id'], f'Operation/station mismatch: {event_id}')
            finishes[run_id] = message

    for run_id, finish in finishes.items():
        require(run_id in starts, f'Finish without start: {run_id}')
        start = starts[run_id]
        require(start['data']['operation_id'] == finish['data']['operation_id'], f'Operation mismatch: {run_id}')
        actual = (datetime.fromisoformat(finish['occurred_at']) - datetime.fromisoformat(start['occurred_at'])).total_seconds() / 60
        require(actual >= 0 and actual == finish['data']['reported_duration']['value'], f'Duration mismatch: {run_id}')
        require(start['item_id'] == finish['item_id'], f'Run assigned to different items: {run_id}')
    for run_id, start in starts.items():
        previous = start['data']['previous_operation_run_id']
        if previous:
            require(previous in finishes, f'Rework references unfinished run: {run_id}')
            require(starts[previous]['item_id'] == start['item_id'], f'Rework crosses items: {run_id}')
    for message in seen_events.values():
        run_id = message.get('operation_run_id')
        if not run_id:
            continue
        require(run_id in starts, f'Event references unknown run: {message["event_id"]}')
        require(starts[run_id]['item_id'] == message['item_id'], f'Run/item mismatch: {message["event_id"]}')
        if message['event_type'] not in {'operation_started'}:
            require(starts[run_id]['occurred_at'] <= message['occurred_at'], f'Event before run start: {message["event_id"]}')
        if message['event_type'] in {'machine_state', 'operator_action', 'inspection_result'} and run_id in finishes:
            if message['event_type'] in {'machine_state', 'operator_action'}:
                require(message['occurred_at'] <= finishes[run_id]['occurred_at'], f'In-operation event after finish: {message["event_id"]}')

    for message in seen_events.values():
        kind = message['event_type']
        data = message['data']
        if kind == 'quality_decision':
            require(message.get('actor_id') == 'QC-01', f'Decision without controller: {message["event_id"]}')
            require(message['source_id'] == 'QC-UI', f'Decision source mismatch: {message["event_id"]}')
            require(bool(data['reason'].strip()), f'Decision missing reason: {message["event_id"]}')
            for ref in data['finding_refs']:
                require(ref in finding_to_group, f'Decision refers to missing finding: {ref}')
                require(seen_events[ref.split('#')[0]]['occurred_at'] <= message['occurred_at'], f'Decision precedes finding: {ref}')
                group = finding_to_group[ref]
                require(group[0] == message['item_id'], f'Decision crosses items: {ref}')
                if data['decision'] == 'confirmed':
                    confirmed_groups.add(group)
                elif data['decision'] == 'rejected':
                    rejected_groups.add(group)
            for evidence in data['evidence_event_ids']:
                require(evidence in seen_events, f'Decision evidence missing: {evidence}')
                require(seen_events[evidence]['occurred_at'] <= message['occurred_at'], f'Decision precedes evidence: {evidence}')
        elif kind == 'cause_review':
            require(message.get('actor_id') == 'TECH-01', f'Cause review without technologist: {message["event_id"]}')
            require(message['source_id'] == 'TECH-UI', f'Cause review source mismatch: {message["event_id"]}')
            for ref in data['finding_refs']:
                require(ref in finding_to_group, f'Cause review missing finding: {ref}')
            for evidence in data['basis_event_ids']:
                require(evidence in seen_events, f'Cause review missing evidence: {evidence}')
                require(seen_events[evidence]['occurred_at'] <= message['occurred_at'], f'Cause review precedes evidence: {evidence}')
            if data['status'] == 'confirmed' and data['finding_refs']:
                cause_confirmed_items.add(message['item_id'])
            if data['status'] == 'confirmed' and data['cause_type'] == 'procedural_error':
                confirmed_procedural_errors += 1
    require(confirmed_groups.isdisjoint(rejected_groups), 'One finding both confirmed and rejected')
    require(sum(len(observations) - 1 for observations in groups_to_observations.values()) == 1, 'Expected exactly one additional observation of an existing defect')

    confirmed_by_type = Counter(group[2] for group in confirmed_groups)
    confirmed_by_station = Counter()
    for group in confirmed_groups:
        first_ref = groups_to_observations[group][0]
        first_event = seen_events[first_ref.split('#')[0]]
        confirmed_by_station[first_event['station_id']] += 1
    confirmed_items = {group[0] for group in confirmed_groups}
    completed_by_operation = Counter(starts[run_id]['data']['operation_id'] for run_id in finishes)
    derived = {
        'item_count': len(items),
        'items_with_any_assessable_inspection': len(any_inspected),
        'items_with_final_assessable_inspection': len(final_inspected),
        'items_with_confirmed_nonconformity_ever': len(confirmed_items),
        'confirmed_defect_cases_ever': len(confirmed_groups),
        'confirmed_defects_by_type': dict(confirmed_by_type),
        'confirmed_defects_by_station': dict(confirmed_by_station),
        'items_with_established_defect_cause': len(cause_confirmed_items),
        'items_without_established_defect_cause': len(confirmed_items - cause_confirmed_items),
        'rejected_findings': len(rejected_groups),
        'rework_runs': rework_runs,
        'unfinished_operations': len(starts.keys() - finishes.keys()),
        'confirmed_procedural_errors': confirmed_procedural_errors,
        'completed_milling_runs': completed_by_operation['OP-MILL'],
        'completed_assembly_runs': completed_by_operation['OP-ASSEMBLY'],
        'outbound_quality_results': len(outbound),
    }
    require(derived == metrics, f'Metrics mismatch: expected {metrics}, derived {derived}')
    require({s['item_id'] for s in scenarios} == set(item_by_id), 'Expected scenario missing or duplicated')
    for scenario in scenarios:
        item_id = scenario['item_id']
        count = sum(group[0] == item_id for group in confirmed_groups)
        require(count == scenario['confirmed_defect_cases'], f'Scenario defect count mismatch: {item_id}')
        item_events = sorted((m for m in seen_events.values() if m['item_id'] == item_id), key=lambda m: m['occurred_at'])
        item_starts = {m['operation_run_id'] for m in item_events if m['event_type'] == 'operation_started'}
        item_finishes = {m['operation_run_id'] for m in item_events if m['event_type'] == 'operation_finished'}
        decisions = [m for m in item_events if m['event_type'] == 'quality_decision']
        if item_starts - item_finishes:
            status = 'in_progress'
        elif decisions and decisions[-1]['data']['decision'] == 'release_after_rework':
            status = 'released_after_rework'
        elif decisions and decisions[-1]['data']['disposition'] == 'quarantine':
            status = 'quarantined'
        elif any(m['event_type'] == 'inspection_result' and m['data']['inspection_point_id'] == 'CP-FINAL' and m['data']['inspection_result'] == 'no_signs_detected' and m['data']['observation_quality'] == 'good' for m in item_events):
            status = 'accepted'
        else:
            status = 'unknown'
        require(status == scenario['final_status'], f'Scenario final status mismatch: {item_id}')
        if 'origin' in scenario:
            first_confirmed = min((seen_events[ref.split('#')[0]] for group in confirmed_groups if group[0] == item_id for ref in groups_to_observations[group]), key=lambda m: m['occurred_at'])
            if first_confirmed['data']['inspection_point_id'] == 'CP-IN':
                origin = 'incoming'
            elif any(m['event_type'] == 'inspection_result' and m['data']['inspection_point_id'] == 'CP-IN' and m['data']['inspection_result'] == 'no_signs_detected' and m['data']['observation_quality'] == 'good' and m['occurred_at'] < first_confirmed['occurred_at'] for m in item_events):
                origin = 'between_incoming_and_post_milling'
            else:
                origin = 'unknown'
            require(origin == scenario['origin'], f'Scenario origin mismatch: {item_id}')
        if 'confirmed_cause' in scenario:
            confirmed_reviews = [m['data']['cause_type'] for m in item_events if m['event_type'] == 'cause_review' and m['data']['status'] == 'confirmed' and m['data']['finding_refs']]
            require((confirmed_reviews[0] if confirmed_reviews else None) == scenario['confirmed_cause'], f'Scenario cause mismatch: {item_id}')
        if 'cause_hypothesis' in scenario:
            require(any(m['event_type'] == 'cause_review' and m['data']['status'] == 'hypothesis' and m['data']['cause_type'] == scenario['cause_hypothesis'] for m in item_events), f'Missing cause hypothesis: {item_id}')
        for field, actual in [
            ('rework_runs', sum(m['event_type'] == 'operation_started' and bool(m['data']['previous_operation_run_id']) for m in item_events)),
            ('rejected_findings', sum(group[0] == item_id for group in rejected_groups)),
            ('confirmed_procedural_errors', sum(m['event_type'] == 'cause_review' and m['data']['status'] == 'confirmed' and m['data']['cause_type'] == 'procedural_error' for m in item_events)),
            ('unfinished_operations', len(item_starts - item_finishes)),
            ('unique_post_inspections', sum(m['event_type'] == 'inspection_result' and m['data']['inspection_point_id'] == 'CP-POST-MILL' for m in item_events)),
        ]:
            if field in scenario:
                require(actual == scenario[field], f'Scenario {field} mismatch: {item_id}')

    order_by_id = {entry['message']['payload']['work_order_id']: entry for entry in orders}
    require(len(order_by_id) == manifest['work_order_count'], 'Work order count mismatch')
    require(target_profiles['profiles_are_examples_not_verified_connectors'] is True, 'Target profiles must not claim live integration')
    require({profile['system'] for profile in target_profiles['profiles']} == {'1C', 'Galaktika:ERP', 'MES', 'KOMPAS-3D'}, 'Target system profile missing')
    for order_id, entry in order_by_id.items():
        payload = entry['message']['payload']
        require(payload['quantity'] == len(payload['item_ids']), f'Wrong order quantity: {order_id}')
        require(set(payload['item_ids']) == {i['id'] for i in items if i['work_order_id'] == order_id}, f'Order items mismatch: {order_id}')
        require(entry['message']['schema_version'] == '1.0', f'Order version mismatch: {order_id}')
    require(len({x['correlation_key'] for x in outbound}) == len(outbound), 'Duplicate outbound key')
    require({x['payload']['item_id'] for x in outbound} == set(item_by_id) - {'ITEM-012'}, 'Outbound results mismatch')
    for result in outbound:
        require(result['schema_version'] == '1.0' and result['message_type'] == 'quality_result', 'Outbound contract mismatch')
        require(result['payload']['basis_event_ids'] and all(ref in seen_events for ref in result['payload']['basis_event_ids']), 'Outbound basis missing')
        require(result['payload']['work_order_id'] == item_by_id[result['payload']['item_id']]['work_order_id'], 'Outbound order mismatch')
    require(response_plan['overrides']['QC-RESULT-007'] == ['temporary_unavailable', 'accepted'], 'Recovery scenario missing')
    require(len(responses) == len(outbound) + 1, 'Response count mismatch')
    responses_by_key: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for response in responses:
        responses_by_key[response['correlation_key']].append(response)
    require(set(responses_by_key) == {x['correlation_key'] for x in outbound}, 'Acknowledgment keys mismatch')
    for key, values in responses_by_key.items():
        values.sort(key=lambda value: value['attempt'])
        expected_statuses = response_plan['overrides'].get(key, response_plan['default'])
        require([value['status'] for value in values] == expected_statuses, f'ERP responses mismatch: {key}')
        require([value['attempt'] for value in values] == list(range(1, len(values) + 1)), f'ERP attempt numbers mismatch: {key}')
        require(all(value['error_code'] == ('TEMPORARY_UNAVAILABLE' if value['status'] == 'temporary_unavailable' else None) for value in values), f'ERP error code mismatch: {key}')

    negative_by_id = {case['case_id']: case for case in invalid_deliveries}
    require(len(negative_by_id) == len(invalid_deliveries) == 6, 'Invalid case count mismatch')
    require('item_id' not in negative_by_id['missing_item_id']['message'], 'Missing-field case is actually valid')
    require(negative_by_id['unsupported_contract']['message']['schema_version'] != '1.0', 'Unsupported-version case is actually valid')
    require(negative_by_id['unknown_result']['message']['data']['inspection_result'] not in {'signs_detected', 'no_signs_detected', 'unable_to_assess'}, 'Unknown-enum case is actually valid')
    require(negative_by_id['unknown_item']['message']['item_id'] not in item_by_id, 'Unknown-item case is actually valid')
    conflicting = negative_by_id['conflicting_redelivery']['message']
    require(conflicting['event_id'] in seen_events and conflicting != seen_events[conflicting['event_id']], 'Conflicting-redelivery case is actually valid')
    require('operation_run_id' not in negative_by_id['missing_run_id']['message'], 'Missing-run case is actually valid')
    require(all(case['expected_behavior'] == 'quarantine_without_mutating_original_history' for case in invalid_deliveries), 'Invalid-case policy mismatch')

    for name in ['event-delivery.schema.json', 'integration-inbound.schema.json', 'integration-outbound.schema.json', 'integration-response.schema.json']:
        contract = json.loads((ROOT.parent / 'contracts' / name).read_text(encoding='utf-8'))
        require(contract['$schema'].endswith('/2020-12/schema'), f'Unsupported JSON Schema declaration: {name}')

    for checkpoint in checkpoints:
        visible = {
            record['message']['event_id']: record['message']
            for record in deliveries
            if record['message']['item_id'] == checkpoint['item_id']
            and record['deliver_at'] <= checkpoint['as_of_delivery_time']
        }
        visible_values = list(visible.values())
        visible_starts = {m['operation_run_id'] for m in visible_values if m['event_type'] == 'operation_started'}
        visible_finishes = {m['operation_run_id'] for m in visible_values if m['event_type'] == 'operation_finished'}
        visible_decisions = sorted((m for m in visible_values if m['event_type'] == 'quality_decision'), key=lambda m: m['occurred_at'])
        post_inspections = [m for m in visible_values if m['event_type'] == 'inspection_result' and m['data']['inspection_point_id'] == 'CP-POST-MILL' and m['data']['inspection_result'] == 'signs_detected']
        if post_inspections and any(m['event_type'] == 'inspection_result' and m['data']['inspection_point_id'] == 'CP-IN' and m['data']['inspection_result'] == 'no_signs_detected' and m['data']['observation_quality'] == 'good' and m['occurred_at'] < post_inspections[0]['occurred_at'] for m in visible_values):
            visible_origin = 'between_incoming_and_post_milling'
        else:
            visible_origin = 'unknown'
        final_clear = any(m['event_type'] == 'inspection_result' and m['data']['inspection_point_id'] == 'CP-FINAL' and m['data']['inspection_result'] == 'no_signs_detected' and m['data']['observation_quality'] == 'good' for m in visible_values)
        actual = {
            'assessable_final_inspections': sum(m['event_type'] == 'inspection_result' and m['data']['inspection_point_id'] == 'CP-FINAL' and m['data']['observation_quality'] == 'good' and m['data']['inspection_result'] != 'unable_to_assess' for m in visible_values),
            'incoming_inspections': sum(m['event_type'] == 'inspection_result' and m['data']['inspection_point_id'] == 'CP-IN' for m in visible_values),
            'post_mill_unique_inspections': sum(m['event_type'] == 'inspection_result' and m['data']['inspection_point_id'] == 'CP-POST-MILL' for m in visible_values),
            'confirmed_decisions': sum(m['event_type'] == 'quality_decision' and m['data']['decision'] == 'confirmed' for m in visible_values),
            'release_decisions': sum(m['event_type'] == 'quality_decision' and m['data']['decision'] == 'release_after_rework' for m in visible_values),
            'hypotheses': sum(m['event_type'] == 'cause_review' and m['data']['status'] == 'hypothesis' for m in visible_values),
            'confirmed_causes': sum(m['event_type'] == 'cause_review' and m['data']['status'] == 'confirmed' and bool(m['data']['finding_refs']) for m in visible_values),
            'unfinished_operations': len(visible_starts - visible_finishes),
            'quality_state': 'final_control_clear' if final_clear else 'not_finally_assessed',
            'current_disposition': visible_decisions[-1]['data']['disposition'] if visible_decisions else None,
            'origin': visible_origin,
        }
        for key, value in checkpoint['expect'].items():
            require(actual[key] == value, f'Checkpoint mismatch for {checkpoint["item_id"]} at {checkpoint["as_of_delivery_time"]}: {key} expected {value}, got {actual[key]}')

    require(len({action['action_id'] for action in workflow_actions}) == len(workflow_actions) == 7, 'Workflow action count or IDs mismatch')
    for action in workflow_actions:
        trigger = seen_events.get(action['trigger_event_id'])
        require(trigger is not None and trigger['item_id'] == action['item_id'], f'Invalid workflow trigger: {action["action_id"]}')
        if action['closed_by_event_id']:
            closing = seen_events.get(action['closed_by_event_id'])
            require(closing is not None and closing['item_id'] == action['item_id'], f'Invalid workflow close event: {action["action_id"]}')
            require(trigger['occurred_at'] < closing['occurred_at'], f'Workflow closes before opening: {action["action_id"]}')
        require(action['assignee_role'] in {'quality_controller', 'line_master', 'technologist'}, f'Unknown workflow role: {action["action_id"]}')

    baseline_entries = integrity['entries']
    require([x['event_id'] for x in baseline_entries] == first_order, 'Integrity order mismatch')
    previous = '0' * 64
    for entry in baseline_entries:
        message_hash = hashlib.sha256(canonical(seen_events[entry['event_id']])).hexdigest()
        require(message_hash == entry['message_sha256'], f'Message integrity mismatch: {entry["event_id"]}')
        previous = hashlib.sha256(bytes.fromhex(previous) + bytes.fromhex(message_hash)).hexdigest()
        require(previous == entry['chain_checkpoint'], f'Chain mismatch: {entry["event_id"]}')
    require(previous == integrity['final_checkpoint'], 'Final integrity checkpoint mismatch')
    tampered = copy.deepcopy(seen_events[tamper['target_event_id']])
    path = tamper['mutation_path'].split('.')
    target = tampered
    for key in path[:-1]:
        target = target[key]
    target[path[-1]] = tamper['replace_with']
    require(hashlib.sha256(canonical(tampered)).hexdigest() != next(x['message_sha256'] for x in baseline_entries if x['event_id'] == tamper['target_event_id']), 'Tamper test failed to detect change')

    print(f'OK: {len(items)} items, {len(seen_events)} unique events, {len(deliveries)} deliveries, {len(confirmed_groups)} confirmed defect cases')


if __name__ == '__main__':
    validate()
