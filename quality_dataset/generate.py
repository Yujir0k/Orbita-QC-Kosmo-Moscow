"""Create a deterministic, entirely synthetic quality-control demonstration dataset."""

from __future__ import annotations

import hashlib
import json
import copy
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any


ROOT = Path(__file__).resolve().parent
OUT = ROOT / 'dataset'
TZ = timezone(timedelta(hours=3))
DAY = datetime(2026, 2, 17, tzinfo=TZ)
EVENTS: list[dict[str, Any]] = []
EVENT_BY_ID: dict[str, dict[str, Any]] = {}
EVENT_NUMBER = 0
DELIVERY_NUMBER = 0


def at(base: datetime, minute: int) -> str:
    return (base + timedelta(minutes=minute)).isoformat(timespec='seconds')


def canonical(value: Any) -> bytes:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(',', ':')).encode('utf-8')


def write_json(name: str, value: Any) -> None:
    path = OUT / name
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')


def write_jsonl(name: str, values: list[dict[str, Any]]) -> None:
    path = OUT / name
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(''.join(json.dumps(v, ensure_ascii=False, separators=(',', ':')) + '\n' for v in values), encoding='utf-8')


def base_for(item_number: int) -> datetime:
    if item_number <= 6:
        return DAY.replace(hour=8) + timedelta(minutes=(item_number - 1) * 50)
    return DAY.replace(hour=16) + timedelta(minutes=(item_number - 7) * 50)


def item_id(number: int) -> str:
    return f'ITEM-{number:03d}'


def body_id(number: int) -> str:
    return f'COMP-{number:03d}-BODY'


def operator_for(number: int) -> str:
    return 'OP-01' if number <= 6 else 'OP-02'


def shift_for(number: int) -> str:
    return 'SHIFT-A' if number <= 6 else 'SHIFT-B'


def delivery(message: dict[str, Any], deliver_at: str) -> None:
    global DELIVERY_NUMBER
    DELIVERY_NUMBER += 1
    EVENTS.append({
        'delivery_id': f'DLV-{DELIVERY_NUMBER:04d}',
        'deliver_at': deliver_at,
        'message': message,
    })


def event(
    number: int,
    minute: int,
    event_type: str,
    station_id: str,
    source_id: str,
    data: dict[str, Any],
    *,
    operation_run_id: str | None = None,
    equipment_id: str | None = None,
    actor_id: str | None = None,
    delivered_minute: int | None = None,
    analyzer_version: str | None = None,
) -> str:
    global EVENT_NUMBER
    EVENT_NUMBER += 1
    event_id = f'EVT-{EVENT_NUMBER:04d}'
    base = base_for(number)
    message: dict[str, Any] = {
        'event_id': event_id,
        'event_type': event_type,
        'schema_version': '1.0',
        'occurred_at': at(base, minute),
        'source_id': source_id,
        'item_id': item_id(number),
        'item_type_id': 'TYPE-BRACKET-01',
        'line_id': 'LINE-01',
        'station_id': station_id,
        'shift_id': shift_for(number),
        'data': data,
    }
    if operation_run_id:
        message['operation_run_id'] = operation_run_id
    if equipment_id:
        message['equipment_id'] = equipment_id
    if actor_id:
        message['actor_id'] = actor_id
    if analyzer_version:
        message['analyzer_version'] = analyzer_version
    EVENT_BY_ID[event_id] = message
    delivery(message, at(base, delivered_minute if delivered_minute is not None else minute + 1))
    return event_id


def repeat(event_id: str, number: int, delivered_minute: int) -> None:
    delivery(EVENT_BY_ID[event_id], at(base_for(number), delivered_minute))


def received(number: int) -> str:
    return event(number, 0, 'item_received', 'ST-IN', 'MES-EMU', {
        'work_order_id': 'WO-A' if number <= 6 else 'WO-B',
        'assembly_revision': 'A',
        'component_ids': [body_id(number), f'COMP-{number:03d}-INSERT', f'COMP-{number:03d}-FASTENER-1', f'COMP-{number:03d}-FASTENER-2'],
    })


def inspection(
    number: int,
    minute: int,
    point: str,
    result: str,
    defects: list[dict[str, Any]] | None = None,
    *,
    quality: str = 'good',
    confidence: float | None = 0.98,
    delivered_minute: int | None = None,
    manual: bool = False,
    operation_run_id: str | None = None,
) -> str:
    station = 'ST-IN' if point == 'CP-IN' else 'ST-ASSEMBLY' if point == 'CP-FINAL' else 'ST-MILL'
    source = 'QC-UI' if manual else 'VISION-IN' if point == 'CP-IN' else 'VISION-ASM' if point == 'CP-FINAL' else 'VISION-MILL'
    data: dict[str, Any] = {
        'inspection_point_id': point,
        'inspection_result': result,
        'observation_quality': quality,
        'confidence': confidence,
        'defects': defects or [],
        'method': 'manual' if manual else 'external_analyzer',
        'evidence_refs': [],
    }
    return event(
        number, minute, 'inspection_result', station, source, data,
        operation_run_id=operation_run_id,
        actor_id='QC-01' if manual else None,
        delivered_minute=delivered_minute,
        analyzer_version=None if manual else 'vision-simulator-1.0',
    )


def finding(number: int, finding_id: str, defect_type_id: str, region: str) -> dict[str, Any]:
    return {
        'finding_id': finding_id,
        'defect_type_id': defect_type_id,
        'component_id': body_id(number),
        'region': region,
        'severity': 'requires_review',
    }


def operation(number: int, kind: str, start: int, finish: int | None, *, run: int = 1, previous: str | None = None) -> tuple[str, str | None, str]:
    is_mill = kind == 'milling'
    run_id = f'RUN-{number:03d}-{kind.upper()}-{run}'
    station = 'ST-MILL' if is_mill else 'ST-ASSEMBLY'
    equipment = 'EQ-CNC-01' if is_mill else 'EQ-ASSEMBLY-01'
    operation_id = 'OP-MILL' if is_mill else 'OP-ASSEMBLY'
    start_id = event(number, start, 'operation_started', station, 'MES-EMU', {
        'operation_id': operation_id,
        'previous_operation_run_id': previous,
    }, operation_run_id=run_id, equipment_id=equipment, actor_id=operator_for(number))
    finish_id = None
    if finish is not None:
        finish_id = event(number, finish, 'operation_finished', station, 'MES-EMU', {
            'operation_id': operation_id,
            'reported_duration': {
                'value': finish - start,
                'unit': 'minute',
                'meaning': 'elapsed_station_time',
                'origin': 'source_reported',
            },
        }, operation_run_id=run_id, equipment_id=equipment, actor_id=operator_for(number))
    return start_id, finish_id, run_id


def decision(number: int, minute: int, refs: list[str], status: str, disposition: str, reason: str, extra_evidence: list[str] | None = None) -> str:
    return event(number, minute, 'quality_decision', 'ST-QC', 'QC-UI', {
        'finding_refs': refs,
        'decision': status,
        'disposition': disposition,
        'reason': reason,
        'evidence_event_ids': extra_evidence or [],
    }, actor_id='QC-01')


def normal(number: int, *, final_recheck: bool = False) -> None:
    received(number)
    inspection(number, 2, 'CP-IN', 'no_signs_detected')
    _, _, mill_run = operation(number, 'milling', 5, 20)
    inspection(number, 22, 'CP-POST-MILL', 'no_signs_detected', operation_run_id=mill_run)
    _, _, assembly_run = operation(number, 'assembly', 25, 35)
    if final_recheck:
        inspection(number, 37, 'CP-FINAL', 'unable_to_assess', quality='poor', confidence=None, operation_run_id=assembly_run)
        inspection(number, 41, 'CP-FINAL', 'no_signs_detected', manual=True, operation_run_id=assembly_run)
    else:
        inspection(number, 37, 'CP-FINAL', 'no_signs_detected', operation_run_id=assembly_run)


def build_catalogs() -> dict[str, Any]:
    return {
        'synthetic': True,
        'dataset_version': '1.0',
        'item_types': [{'id': 'TYPE-BRACKET-01', 'name': 'Условный кронштейн приборного блока'}],
        'component_types': [
            {'id': 'BODY', 'name': 'Заготовка корпуса'},
            {'id': 'INSERT', 'name': 'Вставка'},
            {'id': 'FASTENER', 'name': 'Крепёжный элемент'},
        ],
        'lines': [{'id': 'LINE-01', 'name': 'Демонстрационная линия'}],
        'stations': [
            {'id': 'ST-IN', 'name': 'Входной контроль'},
            {'id': 'ST-MILL', 'name': 'Механическая обработка'},
            {'id': 'ST-ASSEMBLY', 'name': 'Сборка'},
            {'id': 'ST-QC', 'name': 'Рассмотрение качества'},
        ],
        'operations': [
            {'id': 'OP-MILL', 'name': 'Обработка корпуса', 'station_id': 'ST-MILL'},
            {'id': 'OP-ASSEMBLY', 'name': 'Сборка кронштейна', 'station_id': 'ST-ASSEMBLY'},
        ],
        'operators': [{'id': 'OP-01', 'shift_id': 'SHIFT-A'}, {'id': 'OP-02', 'shift_id': 'SHIFT-B'}],
        'reviewers': [{'id': 'QC-01', 'role': 'quality_controller'}, {'id': 'TECH-01', 'role': 'technologist'}],
        'shifts': [
            {'id': 'SHIFT-A', 'local_start': '08:00', 'local_end': '16:00'},
            {'id': 'SHIFT-B', 'local_start': '16:00', 'local_end': '00:00'},
        ],
        'equipment': [
            {'id': 'EQ-CNC-01', 'station_id': 'ST-MILL'},
            {'id': 'EQ-ASSEMBLY-01', 'station_id': 'ST-ASSEMBLY'},
        ],
        'inspection_points': [
            {'id': 'CP-IN', 'station_id': 'ST-IN'},
            {'id': 'CP-POST-MILL', 'station_id': 'ST-MILL'},
            {'id': 'CP-FINAL', 'station_id': 'ST-ASSEMBLY'},
        ],
        'defect_types': [
            {'id': 'DENT', 'name': 'Вмятина'},
            {'id': 'SCRATCH', 'name': 'Царапина'},
            {'id': 'BURR', 'name': 'Заусенец'},
        ],
        'sources': [
            {'id': value} for value in [
                'ERP-EMU', 'MES-EMU', 'VISION-IN', 'VISION-MILL', 'VISION-ASM',
                'MACHINE-CNC', 'OPVISION-EMU', 'QC-UI', 'TECH-UI',
            ]
        ],
    }


def build_items() -> list[dict[str, Any]]:
    return [{
        'id': item_id(n),
        'item_type_id': 'TYPE-BRACKET-01',
        'assembly_revision': 'A',
        'work_order_id': 'WO-A' if n <= 6 else 'WO-B',
        'components': [
            {'id': body_id(n), 'component_type_id': 'BODY'},
            {'id': f'COMP-{n:03d}-INSERT', 'component_type_id': 'INSERT'},
            {'id': f'COMP-{n:03d}-FASTENER-1', 'component_type_id': 'FASTENER'},
            {'id': f'COMP-{n:03d}-FASTENER-2', 'component_type_id': 'FASTENER'},
        ],
    } for n in range(1, 13)]


def inspection_plan() -> dict[str, Any]:
    return {
        'synthetic': True,
        'status': 'project_assumptions_to_verify_on_site',
        'control_points': [
            {
                'id': 'CP-IN', 'source_id': 'VISION-IN', 'purpose': 'Зафиксировать состояние корпуса до обработки.',
                'used_defect_types': ['DENT', 'SCRATCH'],
                'observation_conditions': ['Устойчивое положение детали', 'Несколько ракурсов при фиксированном освещении'],
                'limits': ['Скрытые поверхности не оцениваются', 'При плохом изображении результат unable_to_assess'],
            },
            {
                'id': 'CP-POST-MILL', 'source_id': 'VISION-MILL', 'purpose': 'Сравнить видимые поверхности и кромки с входным состоянием.',
                'used_defect_types': ['DENT', 'SCRATCH', 'BURR'],
                'observation_conditions': ['Повторяемое положение корпуса', 'Отдельный ракурс на кромку'],
                'limits': ['Сходство изображений само по себе не доказывает размер в допуске', 'Следы от станка лишь основание для гипотезы о причине'],
            },
            {
                'id': 'CP-FINAL', 'source_id': 'VISION-ASM', 'purpose': 'Проверить изделие после сборки и запросить ручной контроль при сомнении.',
                'used_defect_types': ['DENT', 'SCRATCH'],
                'observation_conditions': ['Обзор доступных поверхностей после сборки'],
                'limits': ['Закрытые сборкой поверхности не видны', 'Неоцениваемое наблюдение не подтверждает годность'],
            },
        ],
        'target_extensions': [
            {
                'defect_class': 'Поверхностные признаки плохого сварного шва',
                'required_source': 'Отдельная контрольная точка сварки и внешний анализатор',
                'limit': 'Внутренние дефекты шва требуют других методов контроля; в этом наборе сварки нет.',
            },
            {
                'defect_class': 'Отклонение геометрических размеров',
                'required_source': 'Калиброванное измерение или отдельное измерительное оборудование',
                'limit': 'Обычный признак с камеры не считается измерением допуска; числовые допуски в наборе не выдуманы.',
            },
        ],
        'unmeasured_parameters': ['разрешение камеры', 'частота кадров', 'минимальный размер дефекта', 'задержка анализа', 'производственная точность'],
    }


def build_scenarios() -> None:
    for number in (1, 2, 3):
        normal(number, final_recheck=number == 3)

    # 004: the defect is observed and confirmed before any production operation.
    received(4)
    incoming = inspection(4, 2, 'CP-IN', 'signs_detected', [finding(4, 'F1', 'DENT', 'body_outer_A')])
    decision(4, 4, [f'{incoming}#F1'], 'confirmed', 'quarantine', 'Вмятина подтверждена при входном контроле.')
    event(4, 6, 'cause_review', 'ST-QC', 'TECH-UI', {
        'finding_refs': [f'{incoming}#F1'], 'cause_type': 'incoming_defect', 'status': 'confirmed',
        'basis_event_ids': [incoming], 'reason': 'Признак зафиксирован до первой операции.',
    }, actor_id='TECH-01')

    # 005: a new observation after a good incoming inspection.
    received(5)
    inspection(5, 2, 'CP-IN', 'no_signs_detected')
    _, _, run = operation(5, 'milling', 5, 20)
    post = inspection(5, 22, 'CP-POST-MILL', 'signs_detected', [finding(5, 'F1', 'SCRATCH', 'body_outer_A')], operation_run_id=run)
    decision(5, 25, [f'{post}#F1'], 'confirmed', 'quarantine', 'Царапина подтверждена; виновная сторона не установлена.')

    # 006: a poor incoming view does not prove the part was clear before milling.
    received(6)
    inspection(6, 2, 'CP-IN', 'unable_to_assess', quality='poor', confidence=None)
    _, _, run = operation(6, 'milling', 5, 20)
    post = inspection(6, 22, 'CP-POST-MILL', 'signs_detected', [finding(6, 'F1', 'SCRATCH', 'body_outer_A')], operation_run_id=run)
    decision(6, 25, [f'{post}#F1'], 'confirmed', 'quarantine', 'Дефект подтверждён; момент возникновения неизвестен.')

    # 007: one inspection reports two findings; the machine warning is only a hypothesis.
    received(7)
    inspection(7, 2, 'CP-IN', 'no_signs_detected')
    _, _, run = operation(7, 'milling', 5, 20)
    machine = event(7, 12, 'machine_state', 'ST-MILL', 'MACHINE-CNC', {
        'state': 'warning', 'parameter': 'vibration_index', 'value': 7.1,
        'unit': 'synthetic_index', 'configured_limit': 5.0,
    }, operation_run_id=run, equipment_id='EQ-CNC-01')
    post = inspection(7, 22, 'CP-POST-MILL', 'signs_detected', [
        finding(7, 'F1', 'BURR', 'edge_B'), finding(7, 'F2', 'SCRATCH', 'body_outer_A'),
    ], operation_run_id=run)
    decision(7, 25, [f'{post}#F1', f'{post}#F2'], 'confirmed', 'quarantine', 'Оба признака подтверждены.', [machine])
    event(7, 28, 'cause_review', 'ST-QC', 'TECH-UI', {
        'finding_refs': [f'{post}#F1', f'{post}#F2'], 'cause_type': 'equipment_deviation',
        'status': 'hypothesis', 'basis_event_ids': [machine, post],
        'reason': 'Предупреждение станка совпало по времени; причинная связь не доказана.',
    }, actor_id='TECH-01')

    # 008: two observations of one burr, then a separate rework run and release.
    received(8)
    inspection(8, 2, 'CP-IN', 'no_signs_detected')
    _, _, run1 = operation(8, 'milling', 5, 20)
    post1 = inspection(8, 22, 'CP-POST-MILL', 'signs_detected', [finding(8, 'F1', 'BURR', 'edge_B')], operation_run_id=run1)
    post2 = inspection(8, 23, 'CP-POST-MILL', 'signs_detected', [finding(8, 'F1', 'BURR', 'edge_B')], operation_run_id=run1)
    confirmed = decision(8, 25, [f'{post1}#F1', f'{post2}#F1'], 'confirmed', 'rework', 'Один заусенец подтверждён двумя наблюдениями.')
    _, _, run2 = operation(8, 'milling', 28, 40, run=2, previous=run1)
    clear = inspection(8, 42, 'CP-POST-MILL', 'no_signs_detected', manual=True, operation_run_id=run2)
    decision(8, 44, [f'{post1}#F1'], 'release_after_rework', 'release', 'Повторная обработка завершена, ручной контроль без признаков.', [confirmed, clear])
    _, _, assembly = operation(8, 'assembly', 48, 58)
    inspection(8, 60, 'CP-FINAL', 'no_signs_detected', operation_run_id=assembly)

    # 009: an analyzer warning is rejected after manual inspection.
    received(9)
    inspection(9, 2, 'CP-IN', 'no_signs_detected')
    _, _, run = operation(9, 'milling', 5, 20)
    weak = inspection(9, 22, 'CP-POST-MILL', 'signs_detected', [finding(9, 'F1', 'SCRATCH', 'body_outer_A')], quality='poor', confidence=0.43, operation_run_id=run)
    manual = inspection(9, 24, 'CP-POST-MILL', 'no_signs_detected', manual=True, operation_run_id=run)
    decision(9, 26, [f'{weak}#F1'], 'rejected', 'release', 'Ручная проверка не подтвердила признак.', [manual])
    _, _, assembly = operation(9, 'assembly', 28, 38)
    inspection(9, 40, 'CP-FINAL', 'no_signs_detected', operation_run_id=assembly)

    # 010: incoming good result arrives after post-milling detection; post message is redelivered.
    received(10)
    inspection(10, 2, 'CP-IN', 'no_signs_detected', delivered_minute=50)
    _, _, run = operation(10, 'milling', 5, 20)
    post = inspection(10, 22, 'CP-POST-MILL', 'signs_detected', [finding(10, 'F1', 'SCRATCH', 'body_outer_A')], operation_run_id=run)
    repeat(post, 10, 24)
    decision(10, 55, [f'{post}#F1'], 'confirmed', 'quarantine', 'Дефект подтверждён после получения запоздавшего входного контроля.')

    # 011: a confirmed procedural error is recorded without claiming that it caused a defect.
    received(11)
    inspection(11, 2, 'CP-IN', 'no_signs_detected')
    _, _, run = operation(11, 'milling', 5, 20)
    skipped = event(11, 12, 'operator_action', 'ST-MILL', 'OPVISION-EMU', {
        'action_type': 'required_checkpoint_skipped', 'procedure_step_id': 'CHECK-TOOL-01',
        'observation_quality': 'good', 'confidence': 0.96,
    }, operation_run_id=run, equipment_id='EQ-CNC-01', actor_id='OP-02', analyzer_version='operator-simulator-1.0')
    machine_log = event(11, 13, 'machine_state', 'ST-MILL', 'MACHINE-CNC', {
        'state': 'warning', 'parameter': 'tool_check_acknowledged', 'value': False,
        'unit': 'boolean', 'expected_value': True,
    }, operation_run_id=run, equipment_id='EQ-CNC-01')
    inspection(11, 22, 'CP-POST-MILL', 'no_signs_detected', operation_run_id=run)
    event(11, 26, 'cause_review', 'ST-QC', 'TECH-UI', {
        'finding_refs': [], 'operation_run_id': run, 'cause_type': 'procedural_error',
        'status': 'confirmed', 'basis_event_ids': [skipped, machine_log],
        'reason': 'Наблюдение действия и журнал станка согласуются; дефект изделию не приписан.',
    }, actor_id='TECH-01')
    _, _, assembly = operation(11, 'assembly', 28, 38)
    inspection(11, 40, 'CP-FINAL', 'no_signs_detected', operation_run_id=assembly)

    # 012: an unfinished run must not acquire a fabricated duration or final quality status.
    received(12)
    inspection(12, 2, 'CP-IN', 'no_signs_detected')
    _, _, run = operation(12, 'milling', 5, None)
    event(12, 10, 'operation_paused', 'ST-MILL', 'MES-EMU', {
        'reason_code': 'awaiting_setup_check',
    }, operation_run_id=run, equipment_id='EQ-CNC-01', actor_id='OP-02')


def integration_data() -> None:
    write_json('integration/target_profiles.json', {
        'synthetic': True,
        'profiles_are_examples_not_verified_connectors': True,
        'erp_selection_rule': 'На конкретном предприятии выбирается авторитетный ERP-источник задания; профили 1С и Галактики здесь альтернативны.',
        'profiles': [
            {
                'system': '1C', 'implementation_status': 'contract_only',
                'technical_interface': 'Опубликованный OData-интерфейс 1С или настроенный HTTP-сервис; выбор зависит от конфигурации заказчика.',
                'inbound': ['work_order', 'item_catalog'], 'outbound': ['quality_result'],
                'id_mapping': {'erp_order_key': 'work_order_id', 'erp_item_key': 'item_id', 'erp_item_type_key': 'item_type_id'},
                'authoritative_for': ['work_order', 'item_catalog'],
                'error_policy': 'retry_transient; quarantine_unknown_identifier; retain_original_message',
            },
            {
                'system': 'Galaktika:ERP', 'implementation_status': 'contract_only',
                'technical_interface': 'Прикладной веб-сервис или адаптер интеграционной шины при наличии этих компонентов у заказчика.',
                'inbound': ['work_order', 'item_catalog'], 'outbound': ['quality_result'],
                'id_mapping': {'erp_order_key': 'work_order_id', 'erp_item_key': 'item_id', 'erp_item_type_key': 'item_type_id'},
                'authoritative_for': ['work_order', 'item_catalog'],
                'error_policy': 'retry_transient; quarantine_unknown_identifier; retain_original_message',
            },
            {
                'system': 'MES', 'implementation_status': 'contract_only',
                'technical_interface': 'Версионированный HTTP/JSON-контракт как проектное предположение; конкретный транспорт согласуется с установленной MES.',
                'inbound': ['operation_started', 'operation_finished', 'operation_paused', 'operator_action', 'machine_state'],
                'outbound': ['nonconformity_status'],
                'id_mapping': {'mes_run_key': 'operation_run_id', 'mes_station_key': 'station_id', 'mes_equipment_key': 'equipment_id'},
                'authoritative_for': ['operation_facts', 'equipment_assignment'],
                'error_policy': 'deduplicate_by_event_id; replay_late_events; quarantine_unknown_run',
            },
            {
                'system': 'KOMPAS-3D', 'implementation_status': 'file_fixture; direct_API_target',
                'technical_interface': 'Локальный адаптер через SDK/API КОМПАС-3D; в MVP импорт файла условной сборки.',
                'inbound': ['assembly_structure'], 'outbound': [],
                'id_mapping': {'cad_assembly_key': 'assembly_id', 'cad_revision_key': 'revision', 'cad_component_key': 'component_type_id'},
                'authoritative_for': ['assembly_structure', 'assembly_revision'],
                'error_policy': 'quarantine_unknown_revision; retain_import_source',
            },
        ],
        'note': 'Внешние имена полей условные и требуют сопоставления с конфигурацией заказчика. Указанные технические интерфейсы являются целевым проектом, а не испытанным подключением.',
    })
    orders = []
    for order_id, numbers, send_at in [
        ('WO-A', list(range(1, 7)), DAY.replace(hour=7, minute=45)),
        ('WO-B', list(range(7, 13)), DAY.replace(hour=15, minute=45)),
    ]:
        orders.append({
            'delivery_id': f'ERP-IN-{order_id}',
            'deliver_at': send_at.isoformat(timespec='seconds'),
            'message': {
                'message_id': f'MSG-{order_id}', 'message_type': 'work_order',
                'schema_version': '1.0', 'source_system': 'ERP-EMU',
                'sent_at': send_at.isoformat(timespec='seconds'),
                'payload': {
                    'work_order_id': order_id, 'item_type_id': 'TYPE-BRACKET-01',
                    'assembly_revision': 'A', 'item_ids': [item_id(n) for n in numbers],
                    'quantity': len(numbers),
                },
            },
        })
    write_jsonl('integration/inbound.jsonl', orders)

    statuses = {
        1: 'accepted', 2: 'accepted', 3: 'accepted', 4: 'quarantined',
        5: 'quarantined', 6: 'quarantined', 7: 'quarantined',
        8: 'released_after_rework', 9: 'accepted', 10: 'quarantined', 11: 'accepted',
    }
    outbound = []
    for n, status in statuses.items():
        related = [m for m in EVENT_BY_ID.values() if m['item_id'] == item_id(n)]
        if status == 'quarantined':
            reference = next(m['event_id'] for m in reversed(related) if m['event_type'] == 'quality_decision' and m['data']['decision'] == 'confirmed')
        elif status == 'released_after_rework':
            reference = next(m['event_id'] for m in reversed(related) if m['event_type'] == 'quality_decision' and m['data']['decision'] == 'release_after_rework')
        else:
            reference = next(m['event_id'] for m in reversed(related) if m['event_type'] == 'inspection_result' and m['data']['inspection_point_id'] == 'CP-FINAL')
        outbound.append({
            'message_id': f'MSG-QC-RESULT-{n:03d}',
            'message_type': 'quality_result',
            'schema_version': '1.0',
            'source_system': 'QUALITY-MVP',
            'correlation_key': f'QC-RESULT-{n:03d}',
            'requires_ack': True,
            'payload': {
                'item_id': item_id(n),
                'work_order_id': 'WO-A' if n <= 6 else 'WO-B',
                'quality_status': status,
                'basis_event_ids': [reference],
            },
        })
    write_jsonl('integration/expected_outbound.jsonl', outbound)
    write_json('integration/emulator_response_plan.json', {
        'default': ['accepted'],
        'overrides': {
            'QC-RESULT-007': ['temporary_unavailable', 'accepted'],
        },
        'idempotency_key_field': 'correlation_key',
        'note': 'Повторная отправка результата ITEM-007 после восстановления не создаёт вторую запись в ERP-эмуляторе.',
    })
    responses = []
    for result in outbound:
        correlation_key = result['correlation_key']
        statuses_for_result = ['temporary_unavailable', 'accepted'] if correlation_key == 'QC-RESULT-007' else ['accepted']
        for attempt, status in enumerate(statuses_for_result, 1):
            responses.append({
                'message_id': f'ERP-ACK-{correlation_key}-{attempt}',
                'message_type': 'quality_result_ack',
                'schema_version': '1.0',
                'source_system': 'ERP-EMU',
                'correlation_key': correlation_key,
                'attempt': attempt,
                'status': status,
                'error_code': 'TEMPORARY_UNAVAILABLE' if status == 'temporary_unavailable' else None,
            })
    write_jsonl('integration/emulator_responses.jsonl', responses)


def expected_data() -> None:
    def locate(number: int, kind: str, predicate: Any = None) -> str:
        matches = [m for m in EVENT_BY_ID.values() if m['item_id'] == item_id(number) and m['event_type'] == kind and (predicate is None or predicate(m))]
        if len(matches) != 1:
            raise ValueError(f'Expected exactly one {kind} event for {item_id(number)}; found {len(matches)}')
        return matches[0]['event_id']

    scenarios = [
        {'item_id': 'ITEM-001', 'scenario': 'normal_a', 'final_status': 'accepted', 'confirmed_defect_cases': 0},
        {'item_id': 'ITEM-002', 'scenario': 'normal_b', 'final_status': 'accepted', 'confirmed_defect_cases': 0},
        {'item_id': 'ITEM-003', 'scenario': 'poor_final_view_then_manual_clear', 'final_status': 'accepted', 'confirmed_defect_cases': 0, 'must_not_pass_before_manual_recheck': True},
        {'item_id': 'ITEM-004', 'scenario': 'incoming_defect', 'final_status': 'quarantined', 'confirmed_defect_cases': 1, 'origin': 'incoming', 'confirmed_cause': 'incoming_defect'},
        {'item_id': 'ITEM-005', 'scenario': 'new_post_milling_defect', 'final_status': 'quarantined', 'confirmed_defect_cases': 1, 'origin': 'between_incoming_and_post_milling', 'confirmed_cause': None},
        {'item_id': 'ITEM-006', 'scenario': 'insufficient_pre_operation_observation', 'final_status': 'quarantined', 'confirmed_defect_cases': 1, 'origin': 'unknown', 'confirmed_cause': None},
        {'item_id': 'ITEM-007', 'scenario': 'machine_warning_two_defects', 'final_status': 'quarantined', 'confirmed_defect_cases': 2, 'origin': 'between_incoming_and_post_milling', 'cause_hypothesis': 'equipment_deviation', 'confirmed_cause': None},
        {'item_id': 'ITEM-008', 'scenario': 'same_burr_twice_and_rework', 'final_status': 'released_after_rework', 'confirmed_defect_cases': 1, 'rework_runs': 1, 'confirmed_cause': None},
        {'item_id': 'ITEM-009', 'scenario': 'false_positive', 'final_status': 'accepted', 'confirmed_defect_cases': 0, 'rejected_findings': 1},
        {'item_id': 'ITEM-010', 'scenario': 'late_incoming_and_duplicate_post', 'final_status': 'quarantined', 'confirmed_defect_cases': 1, 'origin': 'between_incoming_and_post_milling', 'unique_post_inspections': 1, 'confirmed_cause': None},
        {'item_id': 'ITEM-011', 'scenario': 'confirmed_procedural_error_no_defect', 'final_status': 'accepted', 'confirmed_defect_cases': 0, 'confirmed_procedural_errors': 1},
        {'item_id': 'ITEM-012', 'scenario': 'unfinished_operation', 'final_status': 'in_progress', 'confirmed_defect_cases': 0, 'unfinished_operations': 1, 'expected_outbound': False},
    ]
    write_json('expected/scenarios.json', scenarios)
    write_json('expected/metrics.json', {
        'at_end_of_replay': {
            'item_count': 12,
            'items_with_any_assessable_inspection': 12,
            'items_with_final_assessable_inspection': 6,
            'items_with_confirmed_nonconformity_ever': 6,
            'confirmed_defect_cases_ever': 7,
            'confirmed_defects_by_type': {'DENT': 1, 'SCRATCH': 4, 'BURR': 2},
            'confirmed_defects_by_station': {'ST-IN': 1, 'ST-MILL': 6},
            'items_with_established_defect_cause': 1,
            'items_without_established_defect_cause': 5,
            'rejected_findings': 1,
            'rework_runs': 1,
            'unfinished_operations': 1,
            'confirmed_procedural_errors': 1,
            'completed_milling_runs': 11,
            'completed_assembly_runs': 6,
            'outbound_quality_results': 11,
        },
        'definitions': {
            'items_with_confirmed_nonconformity_ever': 'Уникальные изделия с хотя бы одним подтверждённым дефектом за всю историю; повторная обработка не стирает факт.',
            'confirmed_defect_cases_ever': 'Уникальные подтверждённые случаи, а не количество сигналов или доставок.',
            'items_with_final_assessable_inspection': 'Изделия с качественным оцениваемым контролем после сборки.',
            'confirmed_procedural_errors': 'Подтверждённые нарушения процедуры; не являются автоматически причиной дефекта.',
            'duration': 'Разница между началом и завершением выполнения операции; сообщённая источником длительность хранится отдельно со своим смыслом.',
        },
    })
    write_json('expected/checkpoints.json', [
        {
            'item_id': 'ITEM-003', 'as_of_delivery_time': at(base_for(3), 39),
            'expect': {'assessable_final_inspections': 0, 'quality_state': 'not_finally_assessed'},
            'meaning': 'Плохой финальный обзор не означает годность.',
        },
        {
            'item_id': 'ITEM-003', 'as_of_delivery_time': at(base_for(3), 43),
            'expect': {'assessable_final_inspections': 1, 'quality_state': 'final_control_clear'},
            'meaning': 'После ручной проверки появляется оцениваемый результат.',
        },
        {
            'item_id': 'ITEM-008', 'as_of_delivery_time': at(base_for(8), 27),
            'expect': {'confirmed_decisions': 1, 'release_decisions': 0, 'current_disposition': 'rework'},
            'meaning': 'Подтверждение дефекта направляет изделие на доработку.',
        },
        {
            'item_id': 'ITEM-008', 'as_of_delivery_time': at(base_for(8), 46),
            'expect': {'confirmed_decisions': 1, 'release_decisions': 1, 'current_disposition': 'release'},
            'meaning': 'Допуск после доработки не удаляет прошлое подтверждение.',
        },
        {
            'item_id': 'ITEM-010', 'as_of_delivery_time': at(base_for(10), 25),
            'expect': {'incoming_inspections': 0, 'post_mill_unique_inspections': 1, 'origin': 'unknown'},
            'meaning': 'До запоздавшего сообщения входное состояние неизвестно; дубль не удваивает контроль.',
        },
        {
            'item_id': 'ITEM-010', 'as_of_delivery_time': at(base_for(10), 51),
            'expect': {'incoming_inspections': 1, 'post_mill_unique_inspections': 1, 'origin': 'between_incoming_and_post_milling'},
            'meaning': 'Позднее событие меняет хронологию и основания вывода.',
        },
        {
            'item_id': 'ITEM-007', 'as_of_delivery_time': at(base_for(7), 30),
            'expect': {'hypotheses': 1, 'confirmed_causes': 0},
            'meaning': 'Предупреждение станка остаётся гипотезой о причине.',
        },
        {
            'item_id': 'ITEM-012', 'as_of_delivery_time': at(base_for(12), 50),
            'expect': {'unfinished_operations': 1},
            'meaning': 'Для незавершённой операции длительность не придумывается.',
        },
    ])
    actions = [
        {
            'action_id': 'ACTION-003-RECHECK', 'item_id': 'ITEM-003', 'action_type': 'repeat_inspection',
            'assignee_role': 'quality_controller',
            'trigger_event_id': locate(3, 'inspection_result', lambda m: m['data']['inspection_point_id'] == 'CP-FINAL' and m['data']['inspection_result'] == 'unable_to_assess'),
            'closed_by_event_id': locate(3, 'inspection_result', lambda m: m['data']['inspection_point_id'] == 'CP-FINAL' and m['data']['method'] == 'manual'),
        },
        {
            'action_id': 'ACTION-004-QUARANTINE', 'item_id': 'ITEM-004', 'action_type': 'quarantine_item',
            'assignee_role': 'line_master',
            'trigger_event_id': locate(4, 'quality_decision'), 'closed_by_event_id': None,
        },
        {
            'action_id': 'ACTION-006-INVESTIGATE', 'item_id': 'ITEM-006', 'action_type': 'investigate_unknown_origin',
            'assignee_role': 'technologist',
            'trigger_event_id': locate(6, 'quality_decision'), 'closed_by_event_id': None,
        },
        {
            'action_id': 'ACTION-007-EQUIPMENT', 'item_id': 'ITEM-007', 'action_type': 'inspect_equipment',
            'assignee_role': 'technologist',
            'trigger_event_id': locate(7, 'machine_state'), 'closed_by_event_id': None,
        },
        {
            'action_id': 'ACTION-008-REWORK', 'item_id': 'ITEM-008', 'action_type': 'rework_item',
            'assignee_role': 'line_master',
            'trigger_event_id': locate(8, 'quality_decision', lambda m: m['data']['decision'] == 'confirmed'),
            'closed_by_event_id': locate(8, 'quality_decision', lambda m: m['data']['decision'] == 'release_after_rework'),
        },
        {
            'action_id': 'ACTION-009-MANUAL', 'item_id': 'ITEM-009', 'action_type': 'manual_recheck',
            'assignee_role': 'quality_controller',
            'trigger_event_id': locate(9, 'inspection_result', lambda m: m['data']['inspection_result'] == 'signs_detected'),
            'closed_by_event_id': locate(9, 'inspection_result', lambda m: m['data']['method'] == 'manual'),
        },
        {
            'action_id': 'ACTION-012-PAUSE', 'item_id': 'ITEM-012', 'action_type': 'resolve_operation_pause',
            'assignee_role': 'line_master',
            'trigger_event_id': locate(12, 'operation_paused'), 'closed_by_event_id': None,
        },
    ]
    write_json('expected/workflow_actions.json', actions)


def integrity_data(sorted_deliveries: list[dict[str, Any]]) -> None:
    seen: set[str] = set()
    entries = []
    previous = '0' * 64
    for delivery_record in sorted_deliveries:
        message = delivery_record['message']
        event_id = message['event_id']
        if event_id in seen:
            continue
        seen.add(event_id)
        message_hash = hashlib.sha256(canonical(message)).hexdigest()
        checkpoint = hashlib.sha256(bytes.fromhex(previous) + bytes.fromhex(message_hash)).hexdigest()
        entries.append({'event_id': event_id, 'message_sha256': message_hash, 'chain_checkpoint': checkpoint})
        previous = checkpoint
    write_json('integrity/baseline.json', {
        'algorithm': 'SHA-256 over canonical JSON; chain = SHA-256(previous_chain || message_hash)',
        'record_order': 'first delivery order',
        'entries': entries,
        'final_checkpoint': previous,
        'security_note': 'Это проверочный эталон датасета, а не производственная цифровая подпись. В целевой системе контрольная точка должна подписываться и храниться отдельно.',
    })
    target = next(m for m in EVENT_BY_ID.values() if m['item_id'] == 'ITEM-004' and m['event_type'] == 'quality_decision')
    write_json('integrity/tamper_case.json', {
        'target_event_id': target['event_id'],
        'mutation_path': 'data.decision',
        'replace_with': 'rejected',
        'expected_integrity_result': 'mismatch_detected',
        'note': 'Меняется только копия исходного сообщения; исходный набор остаётся неизменным.',
    })


def negative_data() -> None:
    inspection_message = next(m for m in EVENT_BY_ID.values() if m['item_id'] == 'ITEM-001' and m['event_type'] == 'inspection_result')
    finish_message = next(m for m in EVENT_BY_ID.values() if m['item_id'] == 'ITEM-001' and m['event_type'] == 'operation_finished')
    cases = []
    for case_id, error_code, original, changes in [
        ('missing_item_id', 'missing_required_field', inspection_message, {'remove': 'item_id'}),
        ('unsupported_contract', 'unsupported_schema_version', inspection_message, {'schema_version': '9.0'}),
        ('unknown_result', 'unknown_enum_value', inspection_message, {'inspection_result': 'probably_clear'}),
        ('unknown_item', 'unknown_item_id', inspection_message, {'item_id': 'ITEM-999'}),
        ('conflicting_redelivery', 'event_id_payload_conflict', inspection_message, {'confidence': 0.12}),
        ('missing_run_id', 'missing_required_field', finish_message, {'remove': 'operation_run_id'}),
    ]:
        mutated = copy.deepcopy(original)
        if 'remove' in changes:
            mutated.pop(changes['remove'])
        elif 'inspection_result' in changes:
            mutated['data']['inspection_result'] = changes['inspection_result']
        elif 'confidence' in changes:
            mutated['data']['confidence'] = changes['confidence']
        else:
            mutated.update(changes)
        cases.append({
            'case_id': case_id,
            'message': mutated,
            'expected_error_code': error_code,
            'expected_behavior': 'quarantine_without_mutating_original_history',
        })
    write_jsonl('events/invalid_deliveries.jsonl', cases)


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    build_scenarios()
    ordered = sorted(EVENTS, key=lambda x: (x['deliver_at'], x['delivery_id']))
    write_json('manifest.json', {
        'dataset_id': 'cosmo-quality-synthetic-v1',
        'dataset_version': '1.0',
        'synthetic': True,
        'time_zone': 'UTC+03:00',
        'item_count': 12,
        'unique_event_count': len(EVENT_BY_ID),
        'delivery_count': len(ordered),
        'source_delivery_count': sum(record['message']['source_id'] not in {'QC-UI', 'TECH-UI'} for record in ordered),
        'scripted_human_action_count': sum(record['message']['source_id'] in {'QC-UI', 'TECH-UI'} for record in ordered),
        'work_order_count': 2,
        'source_of_truth': {
            'orders': 'ERP-EMU',
            'assembly_structure': 'assemblies.json',
            'operation_facts': 'MES-EMU',
            'inspection_observations': 'VISION-* and QC-UI',
            'quality_decisions': 'QC-UI',
        },
        'no_real_personal_or_production_data': True,
    })
    write_json('catalogs.json', build_catalogs())
    write_json('assemblies.json', [{
        'assembly_id': 'ASM-BRACKET-01',
        'item_type_id': 'TYPE-BRACKET-01',
        'revision': 'A',
        'geometry_included': False,
        'components': [
            {'component_type_id': 'BODY', 'quantity': 1, 'parent': 'ASM-BRACKET-01'},
            {'component_type_id': 'INSERT', 'quantity': 1, 'parent': 'ASM-BRACKET-01'},
            {'component_type_id': 'FASTENER', 'quantity': 2, 'parent': 'ASM-BRACKET-01'},
        ],
        'note': 'Условная структура сборки; прямой импорт через API КОМПАС-3D проектируется отдельно.',
    }])
    write_json('items.json', build_items())
    write_json('inspection_plan.json', inspection_plan())
    write_jsonl('events/deliveries.jsonl', ordered)
    source_deliveries = [record for record in ordered if record['message']['source_id'] not in {'QC-UI', 'TECH-UI'}]
    scripted_actions = [record for record in ordered if record['message']['source_id'] in {'QC-UI', 'TECH-UI'}]
    write_jsonl('events/source_deliveries.jsonl', source_deliveries)
    write_jsonl('interactions/scripted_actions.jsonl', scripted_actions)
    write_json('demo_route.json', {
        'short_route': [
            {'item_id': 'ITEM-004', 'focus': 'Входной брак и отсутствие необоснованной вины оператора.'},
            {'item_id': 'ITEM-007', 'focus': 'Два дефекта, предупреждение станка как гипотеза и восстановление ERP-обмена.'},
            {'item_id': 'ITEM-010', 'focus': 'Поздний входной контроль и повторная доставка без двойного учёта.'},
        ],
        'extended_route': [
            {'item_id': 'ITEM-003', 'focus': 'Плохой финальный обзор и ручная проверка.'},
            {'item_id': 'ITEM-008', 'focus': 'Доработка с сохранением истории подтверждённого дефекта.'},
            {'item_id': 'ITEM-009', 'focus': 'Отклонение ложного сигнала.'},
            {'item_id': 'ITEM-011', 'focus': 'Подтверждённая процедурная ошибка без дефекта.'},
        ],
        'presentation_time_note': 'Короткий маршрут рассчитан на ограниченное выступление; расширенный показывается при наличии времени.',
    })
    integration_data()
    expected_data()
    integrity_data(ordered)
    negative_data()
    print(f'Generated {len(EVENT_BY_ID)} unique events, {len(ordered)} deliveries and 12 items in {OUT}')


if __name__ == '__main__':
    main()
