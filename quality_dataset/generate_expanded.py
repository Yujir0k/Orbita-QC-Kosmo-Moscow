"""Build a reproducible, photo-linked synthetic production stream for UI demos."""

from __future__ import annotations

import copy
import hashlib
import json
import random
from collections import Counter
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

import generate as legacy


ROOT = Path(__file__).resolve().parent
OUT = ROOT / 'expanded_dataset'
MEDIA = ROOT / 'media'
TZ = timezone(timedelta(hours=3))
HUMAN_SOURCES = {'QC-UI', 'TECH-UI', 'MASTER-UI'}


def write_json(path: str, value: Any) -> None:
    target = OUT / path
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(json.dumps(value, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')


def write_jsonl(path: str, values: list[dict[str, Any]]) -> None:
    target = OUT / path
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(''.join(json.dumps(value, ensure_ascii=False, separators=(',', ':')) + '\n' for value in values), encoding='utf-8')


def iso(value: datetime) -> str:
    return value.isoformat(timespec='seconds')


def item_id(number: int) -> str:
    return f'ITEM-{number:03d}'


def item_type(number: int) -> str:
    return {19: 'TYPE-BRACKET-GUSSET', 20: 'TYPE-BRACKET-CLEVIS',
            25: 'TYPE-BRACKET-L', 28: 'TYPE-BRACKET-U'}.get(number, 'TYPE-BRACKET-01')


def synthetic_dimensions(number: int, defect: str) -> dict[str, Any]:
    """Return explicit fictional 2D CV estimates, never certified part measurements."""
    fixed = {19: (1.4, 0.12), 20: (1.9, 0.35), 21: (3.6, 0.18)}
    default = {
        'SCRATCH': (round(1.6 + number % 7 * 0.34, 2), round(0.10 + number % 3 * 0.02, 2)),
        'BURR': (round(0.9 + number % 5 * 0.27, 2), round(0.24 + number % 4 * 0.04, 2)),
        'DENT': (round(2.2 + number % 4 * 0.45, 2), round(1.1 + number % 3 * 0.22, 2)),
        'CRACK': (round(1.0 + number % 4 * 0.38, 2), round(0.05 + number % 2 * 0.02, 2)),
        'DISCOLORATION': (round(2.0 + number % 3 * 0.55, 2), round(1.2 + number % 3 * 0.25, 2)),
    }
    length, width = fixed.get(number, default[defect])
    return {
        'length_mm': length,
        'width_mm': width,
        'depth_estimated_mm': None,
        'defect_class': defect,
        'dimension_source': 'synthetic_calibrated_2d_cv_estimate',
        'dimension_uncertainty_mm': 0.2,
    }


def synthetic_kd_spec(number: int, severity: str) -> dict[str, Any]:
    """Choose a fictional drawing rule for the inspected surface zone."""
    zone = ('ZONE_A_CRITICAL' if severity == 'critical' or number == 21 else
            'ZONE_B_MATING' if number in {13, 14, 20, 28} else 'ZONE_C_NON_CRITICAL')
    return {
        'surface_zone_class': zone,
        'max_allowable_defect_length_mm': {'ZONE_A_CRITICAL': 0.0, 'ZONE_B_MATING': 1.0,
                                           'ZONE_C_NON_CRITICAL': 3.0}[zone],
        'standard_ref': f'КД-ДЕМО-{item_type(number)}-REV-A',
        'source_kind': 'synthetic_demo_assumption',
        'applies_to': 'SCRATCH',
    }


def media_index() -> list[dict[str, Any]]:
    entries = [
        ('M013-CV-BEFORE', 13, 'item-013-cv-before-machine.png', 'fixed_camera', 'before_machine', 'Та же деталь до операции: правая поверхность без риски.'),
        ('M013-CV-DEFECT', 13, 'item-013-cv-scratch.png', 'fixed_camera', 'before_rework', 'Поверхностная риска у правого отверстия; первичный кадр камеры.'),
        ('M013-MASTER-CLEAR', 13, 'item-013-master-clear.png', 'master_phone', 'after_rework', 'Та же деталь после разрешённой доработки; поверхность очищена.'),
        ('M014-CV-BEFORE', 14, 'item-014-cv-before-machine.png', 'fixed_camera', 'before_machine', 'Та же кромка до операции: заусенца нет.'),
        ('M014-CV-BURR', 14, 'item-014-cv-burr.png', 'fixed_camera', 'before_rework', 'Заусенец на внешней правой кромке.'),
        ('M014-MASTER-STILL', 14, 'item-014-master-burr-remains.png', 'master_phone', 'after_first_rework', 'Первый проход не убрал заусенец; повторный контроль не допускает изделие.'),
        ('M014-MASTER-CLEAR', 14, 'item-014-master-clear.png', 'master_phone', 'after_second_rework', 'После второго прохода кромка очищена.'),
        ('M015-MASTER-DENT', 15, 'item-015-master-dent.png', 'master_phone', 'additional_check', 'Первое пригодное фото: повреждена критическая наружная кромка.'),
        ('M016-CV-GLARE', 16, 'item-016-cv-glare.png', 'fixed_camera', 'ambiguous_observation', 'Блик похож на царапину; вывод модели требует проверки.'),
        ('M016-MASTER-CLEAR', 16, 'item-016-master-clear.png', 'master_phone', 'additional_check', 'После изменения освещения видно, что повреждения нет.'),
        ('M019-CV-BEFORE', 19, 'item-019-cv-incoming-scratch.png', 'fixed_camera', 'before_machine', 'Риска на передней левой полке уже присутствует при входном контроле.'),
        ('M019-CV-AFTER', 19, 'item-019-cv-after-machine-scratch.png', 'fixed_camera', 'after_machine', 'Та же риска на той же детали после станка; нового повреждения нет.'),
        ('M020-CV-BEFORE', 20, 'item-020-cv-before-machine.png', 'fixed_camera', 'before_machine', 'Входной кадр отдельной детали перед станком; видимые поверхности без признаков.'),
        ('M025-CV-BURR', 25, 'item-025-cv-burr.png', 'fixed_camera', 'after_machine', 'Другой тип детали: заусенец на передней кромке L-образного кронштейна.'),
        ('M025-MASTER-CLEAR', 25, 'item-025-master-clear.png', 'master_phone', 'after_rework', 'Та же L-образная деталь с очищенной кромкой.'),
        ('M028-CV-SCRATCH', 28, 'item-028-cv-scratch.png', 'fixed_camera', 'after_machine', 'U-образный кронштейн: риска на левой плоской полке.'),
        ('M028-MASTER-CLEAR', 28, 'item-028-master-clear.png', 'master_phone', 'after_rework', 'Та же левая полка после согласованной доработки.'),
        ('M029-CV-BURR', 29, 'item-029-cv-burr.png', 'fixed_camera', 'after_machine', 'Отдельная деталь: заусенец на верхней правой кромке.'),
    ]
    result = []
    for asset_id, number, filename, capture_source, stage, description in entries:
        path = MEDIA / filename
        if not path.is_file():
            raise FileNotFoundError(f'Missing demonstration image: {path}')
        result.append({
            'asset_id': asset_id,
            'item_id': item_id(number),
            'path_from_quality_dataset': f'media/{filename}',
            'sha256': hashlib.sha256(path.read_bytes()).hexdigest(),
            'capture_source': capture_source,
            'stage': stage,
            'description': description,
            'synthetic_generated_image': True,
            'not_a_measurement_or_authentic_production_record': True,
        })
    return result


class Builder:
    def __init__(self, deliveries: list[dict[str, Any]], media: list[dict[str, Any]]) -> None:
        self.deliveries = copy.deepcopy(deliveries)
        self.media_by_id = {asset['asset_id']: asset for asset in media}
        self.event_counter = 0
        self.delivery_counter = 0
        self.events_by_id = {d['message']['event_id']: d['message'] for d in deliveries}
        self.demo_refs: dict[str, dict[str, str]] = {}

    def base_time(self, number: int) -> datetime:
        position = number - 13
        slot = position % 20
        shift_start = 8 if slot < 10 else 16
        return datetime(2026, 2, 18, shift_start, tzinfo=TZ) + timedelta(days=position // 20, minutes=(slot % 10) * 40)

    def line(self, number: int) -> str:
        return 'LINE-02' if number == 15 or number > 18 and number % 2 == 0 else 'LINE-01'

    def station(self, number: int, kind: str) -> str:
        suffix = '' if self.line(number) == 'LINE-01' else '-02'
        return {'in': 'ST-IN', 'mill': 'ST-MILL', 'assembly': 'ST-ASSEMBLY', 'qc': 'ST-QC'}[kind] + suffix

    def operator(self, number: int) -> str:
        if (number - 13) % 20 < 10:
            return 'OP-03' if number % 2 else 'OP-04'
        return 'OP-05' if number % 2 else 'OP-06'

    def work_order(self, number: int) -> str:
        return f'WO-C{((number - 13) // 20) + 1:02d}'

    def emit(
        self,
        number: int,
        minute: int,
        event_type: str,
        source_id: str,
        station_kind: str,
        data: dict[str, Any],
        *,
        operation_run_id: str | None = None,
        actor_id: str | None = None,
        equipment_id: str | None = None,
        delivery_delay: int = 1,
    ) -> str:
        self.event_counter += 1
        self.delivery_counter += 1
        event_id = f'E2-{self.event_counter:06d}'
        occurred = self.base_time(number) + timedelta(minutes=minute)
        message: dict[str, Any] = {
            'event_id': event_id,
            'event_type': event_type,
            'schema_version': '2.0',
            'occurred_at': iso(occurred),
            'source_id': source_id,
            'item_id': item_id(number),
            'item_type_id': item_type(number),
            'line_id': self.line(number),
            'station_id': self.station(number, station_kind),
            'shift_id': 'SHIFT-A' if 8 <= occurred.hour < 16 else 'SHIFT-B',
            'data': data,
            'item_state': self.item_state(number, event_type, station_kind, data, equipment_id),
        }
        if operation_run_id:
            message['operation_run_id'] = operation_run_id
        if actor_id:
            message['actor_id'] = actor_id
        if equipment_id:
            message['equipment_id'] = equipment_id
        if source_id.startswith('VISION'):
            message['analyzer_version'] = 'vision-simulator-2.0'
        self.events_by_id[event_id] = message
        self.deliveries.append({
            'delivery_id': f'D2-{self.delivery_counter:06d}',
            'deliver_at': iso(occurred + timedelta(minutes=delivery_delay)),
            'message': message,
        })
        return event_id

    def item_state(self, number: int, event_type: str, station_kind: str,
                   data: dict[str, Any], equipment_id: str | None) -> dict[str, str]:
        """Snapshot physical routing at event time; never infer a later state from future events."""
        station = self.station(number, station_kind)
        previous = [event for event in self.events_by_id.values()
                    if event['item_id'] == item_id(number) and event.get('item_state')]
        earlier_state = max(previous, key=lambda event: event['occurred_at'])['item_state'] if previous else None
        if event_type in {'operation_started', 'machine_state', 'operation_paused'}:
            fixture = data.get('fixture_id') or 'FIX-01'
            return {'physical_location': f'{equipment_id or station}: зажата в приспособлении {fixture}',
                    'line_lock_status': 'HELD_AT_STATION'}
        if event_type == 'quality_decision':
            if data.get('disposition') == 'release':
                return {'physical_location': 'Передана на следующую операцию маршрута',
                        'line_lock_status': 'ROUTED_FORWARD'}
            return {'physical_location': f'{station}: зона удержания ОТК',
                    'line_lock_status': 'HELD_AT_STATION'}
        if event_type == 'inspection_result' and data.get('inspection_result') != 'no_signs_detected':
            return {'physical_location': f'{station}: ожидает решения ОТК',
                    'line_lock_status': 'HELD_AT_STATION'}
        if event_type == 'inspection_result' and data.get('inspection_point_id') == 'CP-FINAL':
            return {'physical_location': 'Передана на следующий этап после финального контроля',
                    'line_lock_status': 'ROUTED_FORWARD'}
        if event_type in {'technical_disposition', 'controller_check', 'manual_measurement'} or event_type == 'master_action' and data.get('action_type') == 'inspection_support':
            return {'physical_location': f'{self.station(number, "qc")}: удержана до решения ОТК',
                    'line_lock_status': 'HELD_AT_STATION'}
        if event_type == 'inspection_result' and data.get('method') == 'manual_verification':
            return {'physical_location': f'{self.station(number, "qc")}: ожидает решения после повторного контроля',
                    'line_lock_status': 'HELD_AT_STATION'}
        if event_type == 'cause_review' and earlier_state:
            return dict(earlier_state)
        return {'physical_location': f'{station}: межоперационный буфер',
                'line_lock_status': 'IN_BUFFER'}

    def media_slot(self, asset_id: str | None, absence_reason: str) -> dict[str, str | None]:
        if asset_id:
            asset = self.media_by_id[asset_id]
            return {'url': f'/media/{Path(asset["path_from_quality_dataset"]).name}',
                    'sha256_hash': asset['sha256'], 'status': 'AVAILABLE', 'absence_reason': 'NONE'}
        return {'url': None, 'sha256_hash': '', 'status': 'MISSING',
                'absence_reason': absence_reason}

    def repeat(self, event_id: str, minutes_after: int = 2) -> None:
        self.delivery_counter += 1
        original = self.events_by_id[event_id]
        first_delivery = next(record['deliver_at'] for record in self.deliveries if record['message']['event_id'] == event_id)
        self.deliveries.append({
            'delivery_id': f'D2-{self.delivery_counter:06d}',
            'deliver_at': iso(datetime.fromisoformat(first_delivery) + timedelta(minutes=minutes_after)),
            'message': copy.deepcopy(original),
        })

    def receive(self, number: int) -> str:
        return self.emit(number, 0, 'item_received', 'MES-EMU', 'in', {
            'work_order_id': self.work_order(number),
            'assembly_revision': 'A',
            'route_revision': 'R2',
            'supplier_lot_id': f'LOT-{((number - 13) // 12) + 1:02d}',
            'traveler_id': f'TRAV-{number:03d}',
            'component_ids': [f'COMP-{number:03d}-{part}' for part in ('BODY', 'INSERT', 'FASTENER-1', 'FASTENER-2')],
            'identity_method': 'barcode_scan',
        })

    def inspection(
        self,
        number: int,
        minute: int,
        point: str,
        result: str,
        *,
        defect: str | None = None,
        finding_id: str = 'F1',
        severity: str = 'medium',
        confidence: float | None = 0.97,
        quality: str = 'good',
        media: list[str] | None = None,
        method: str = 'external_analyzer',
        run: str | None = None,
        delay: int = 1,
        missing_reason: str | None = None,
    ) -> str:
        station = 'in' if point == 'CP-IN' else 'assembly' if point == 'CP-FINAL' else 'mill'
        source = 'QC-UI' if method == 'manual_verification' else 'VISION-IN' if station == 'in' else 'VISION-ASM' if station == 'assembly' else 'VISION-MILL'
        region = ({13: 'outer_right_face', 14: 'outer_right_edge', 15: 'outer_left_edge',
                   16: 'outer_right_face', 19: 'front_left_flange', 20: 'inner_slot_edge',
                   21: 'outer_right_face', 25: 'front_outer_edge', 28: 'left_outer_face',
                   29: 'right_upper_edge'}.get(number, 'body_outer_A' if defect == 'SCRATCH' else 'edge_B'))
        descriptions = {
            'SCRATCH': 'Линейный след на обработанной поверхности; глубина по обычному кадру не определяется.',
            'BURR': 'Выступающий металлический край после обработки; требуется проверить кромку очно.',
            'DENT': 'Локальное изменение формы наружной кромки; оценить допустимость по документации.',
            'CHIP': 'Скол на наружной кромке; оценить критичность и возможность восстановления.',
            'CRACK': 'Тонкая линия разрыва поверхности; оценить критичность и возможность восстановления.',
            'DISCOLORATION': 'Локальное отличие цвета поверхности; необходима проверка природы следа.',
        }
        features = {
            'SCRATCH': 'узкая линейная неоднородность отражения на поверхности',
            'BURR': 'локальный выступ за проектный контур видимой кромки',
            'DENT': 'локальное вдавливание с изменением видимого контура',
            'CHIP': 'разрыв ровной линии кромки и отсутствие части материала',
            'CRACK': 'тонкая непрерывная линия разрыва на видимой поверхности',
            'DISCOLORATION': 'локальная область изменения отражения и цвета',
        }
        dimensions = synthetic_dimensions(number, defect) if defect else {}
        if dimensions and method == 'manual_verification':
            dimensions['dimension_source'] = 'synthetic_manual_scale_estimate'
            dimensions['dimension_uncertainty_mm'] = 0.5
        defects = [] if defect is None else [{
            'finding_id': finding_id,
            'defect_type_id': defect,
            'component_id': f'COMP-{number:03d}-BODY',
            'region': region,
            'severity': severity,
            'description': descriptions[defect],
            'observed_feature': features[defect],
            **dimensions,
        }]
        earlier = [message for message in self.events_by_id.values()
                   if message['item_id'] == item_id(number) and message['event_type'] == 'inspection_result'
                   and message['data'].get('inspection_point_id') != 'CP-FINAL']
        previous = max(earlier, key=lambda message: message['occurred_at']) if earlier else None
        previous_result = previous['data']['inspection_result'] if previous else None
        comparison = ('Ранее признаков не было; интервал появления ограничен двумя контрольными точками, причина не установлена.'
                      if previous_result == 'no_signs_detected' and result == 'signs_detected' else
                      'Тот же признак уже был виден до этой операции; относить его возникновение к текущему станку нельзя.'
                      if previous_result == 'signs_detected' and result == 'signs_detected' else
                      'Ранее оценка была невозможна; момент появления признака неизвестен.'
                      if previous_result == 'unable_to_assess' and result == 'signs_detected' else
                      'Повторная проверка той же зоны после операции.' if previous else
                      'Первый контроль изделия в текущей истории.')
        data = {
            'inspection_point_id': point,
            'inspection_result': result,
            'observation_quality': quality,
            'confidence': confidence,
            'defects': defects,
            'kd_spec': synthetic_kd_spec(number, severity),
            'method': method,
            'evidence_refs': media or [],
            'observation_summary': descriptions[defect] if defect else 'Обозримые зоны без обнаруженных признаков.' if result == 'no_signs_detected' else 'Наблюдение не позволяет сделать вывод о состоянии поверхности.',
            'comparison': {'previous_inspection_event_id': previous['event_id'] if previous else None,
                           'previous_result': previous_result, 'summary': comparison},
            'next_verification': 'Очный осмотр зоны до подтверждения без кадра.' if defect and not media else
                                 'Проверить признак на кадре и при необходимости очно.' if defect else
                                 'Повторить контроль в пригодных условиях.' if result == 'unable_to_assess' else None,
            'triage_priority': 'critical' if severity == 'critical' else 'high' if severity == 'high' else 'medium' if defect else 'routine',
            'capture_context': {
                'camera_id': None if method == 'manual_verification' else f'CAM-{self.line(number)}-{point}',
                'view_id': 'front_face' if point != 'CP-FINAL' else 'assembly_front',
                'lighting_recipe_id': None if method == 'manual_verification' else 'LED-COOL-01',
                'calibration_profile_version': None if method == 'manual_verification' else 'CAL-DEMO-1',
                'missing_image_reason': missing_reason or ('no_camera_at_station' if method == 'external_analyzer' and not media else None),
            },
        }
        if point != 'CP-IN':
            before_asset = next((ref for ref in (previous['data'].get('evidence_refs', []) if previous else [])
                                 if ref in self.media_by_id), None)
            after_asset = next((ref for ref in (media or []) if ref in self.media_by_id), None) if method == 'external_analyzer' else None
            previous_method = previous['data'].get('method') if previous else None
            before_reason = ('NO_CAMERA_AT_STATION' if previous_method == 'manual_verification' or
                             previous is None or previous['data'].get('capture_context', {}).get('missing_image_reason') != 'classified_restricted'
                             else 'CLASSIFIED_RESTRICTED')
            after_reason = ('LOST_IN_TRANSIT' if missing_reason == 'camera_frame_lost_during_transfer' else
                            'CLASSIFIED_RESTRICTED' if missing_reason == 'classified_restricted' else 'NO_CAMERA_AT_STATION')
            data['media_evidence'] = {
                'before_operation': self.media_slot(before_asset, before_reason),
                'after_operation': self.media_slot(after_asset, after_reason),
            }
        return self.emit(number, minute, 'inspection_result', source, station, data,
                         operation_run_id=run, actor_id='QC-02' if method == 'manual_verification' else None,
                         delivery_delay=delay)

    def operation(self, number: int, kind: str, start: int, finish: int, *, attempt: int = 1, previous: str | None = None) -> tuple[str, str, str]:
        run = f'RUN-{number:03d}-{kind.upper()}-{attempt}'
        station = 'mill' if kind in {'milling', 'edge_rework', 'surface_rework'} else 'assembly'
        equipment = f'EQ-CNC-{1 if self.line(number) == "LINE-01" else 2:02d}' if station == 'mill' else f'EQ-ASSEMBLY-{1 if self.line(number) == "LINE-01" else 2:02d}'
        operation_id = 'OP-MILL' if kind == 'milling' else 'OP-ASSEMBLY' if kind == 'assembly' else 'OP-REWORK'
        shared = {
            'operation_id': operation_id,
            'previous_operation_run_id': previous,
            'route_revision': 'R2',
            'fixture_id': 'FIX-01' if station == 'mill' else 'FIX-ASM-01',
            'program_id': 'PRG-BRACKET-A' if station == 'mill' else None,
            'program_revision': '3' if station == 'mill' else None,
            'tool_id': 'TOOL-EDGE-02' if kind == 'edge_rework' else 'TOOL-FACE-01' if station == 'mill' else None,
        }
        if number % 11 == 0:
            shared['tool_id'] = None
            shared['data_quality'] = {'missing_optional_fields': ['tool_id'], 'reason': 'MES did not publish tool assignment'}
        first = self.emit(number, start, 'operation_started', 'MES-EMU', station, shared,
                          operation_run_id=run, actor_id=self.operator(number), equipment_id=equipment)
        finished_data = dict(shared)
        finished_data['reported_duration'] = {'value': finish - start, 'unit': 'minute', 'meaning': 'elapsed_station_time', 'origin': 'source_reported'}
        last = self.emit(number, finish, 'operation_finished', 'MES-EMU', station, finished_data,
                         operation_run_id=run, actor_id=None if number % 17 == 0 else self.operator(number), equipment_id=equipment,
                         delivery_delay=19 if number % 23 == 0 else 1)
        if number % 17 == 0:
            self.events_by_id[last]['data']['data_quality'] = {'missing_optional_fields': ['actor_id'], 'reason': 'operator badge not resolved at finish'}
        return first, last, run

    def machine(self, number: int, minute: int, run: str, warning: bool = False) -> str:
        return self.emit(number, minute, 'machine_state', 'MACHINE-CNC', 'mill', {
            'state': 'warning' if warning else 'running',
            'alarm_code': 'VIB-WARN-01' if warning else None,
            'spindle_load_peak_pct': 83 if warning else 58 + number % 12,
            'tool_life_used_min': 112 + number % 27,
            'coolant_state': 'on',
            'sample_window_seconds': 60,
            'measurement_kind': 'machine_telemetry_not_part_dimension',
        }, operation_run_id=run, equipment_id=f'EQ-CNC-{1 if self.line(number) == "LINE-01" else 2:02d}', delivery_delay=1)

    def qc(self, number: int, minute: int, refs: list[str], decision: str, disposition: str, reason: str, basis: list[str]) -> str:
        return self.emit(number, minute, 'quality_decision', 'QC-UI', 'qc', {
            'finding_refs': refs,
            'decision': decision,
            'disposition': disposition,
            'reason': reason,
            'evidence_event_ids': basis,
            'author_role': 'quality_controller',
        }, actor_id='QC-02')

    def controller_check(self, number: int, minute: int, observation_id: str, defect: str) -> str:
        observations = {
            'SCRATCH': 'При очном осмотре под рассеянным светом видна риска в зоне сигнала; требуется решение о допустимой доработке.',
            'BURR': 'При очном осмотре виден выступающий край в указанной зоне; кромка требует доработки.',
            'DENT': 'При очном осмотре подтверждена деформация кромки; обычный снимок не определяет допуск.',
            'CHIP': 'При очном осмотре подтверждено отсутствие материала на кромке; требуется решение технолога.',
            'CRACK': 'При очном осмотре подтверждена линия разрыва поверхности; требуется решение технолога.',
        }
        return self.emit(number, minute, 'controller_check', 'QC-UI', 'qc', {
            'case_id': f'{item_id(number)}-{defect}-F1',
            'inspection_result': 'signs_detected',
            'method': 'direct_visual_inspection',
            'reason': observations[defect],
            'observation_event_id': observation_id,
            'photo_available': False,
            'measurement_claimed': False,
        }, actor_id='QC-02')

    def master(self, number: int, minute: int, action: str, result: str, basis: list[str], media: list[str] | None = None) -> str:
        return self.emit(number, minute, 'master_action', 'MASTER-UI', 'mill', {
            'action_type': action,
            'result': result,
            'basis_event_ids': basis,
            'evidence_refs': media or [],
            'performed_by_operator_id': self.operator(number) if 'rework' in action else None,
            'note': 'Учебная запись мастера: выполнение и результат действия фиксируются отдельно от решения ОТК.',
        }, actor_id='MASTER-01')

    def tech(self, number: int, minute: int, disposition: str, reason: str, basis: list[str], *, max_stock_removal_mm: float | None = None) -> str:
        return self.emit(number, minute, 'technical_disposition', 'TECH-UI', 'qc', {
            'disposition': disposition,
            'reason': reason,
            'basis_event_ids': basis,
            'max_stock_removal_mm': max_stock_removal_mm,
            'drawing_revision': 'A',
            'assumption': 'Все значения и допуски учебные; согласуются с технологической документацией заказчика.',
        }, actor_id='TECH-01')

    def measurement(self, number: int, minute: int, run: str, value: float) -> str:
        return self.emit(number, minute, 'manual_measurement', 'QC-UI', 'qc', {
            'feature_id': 'WALL-NEAR-RIGHT-HOLE',
            'measured_value': value,
            'unit': 'mm',
            'lower_limit': 5.0,
            'upper_limit': None,
            'instrument_id': 'GAGE-01',
            'calibration_status': 'valid_in_demo',
            'result': 'within_assumed_limit' if value >= 5.0 else 'outside_assumed_limit',
            'is_camera_measurement': False,
        }, operation_run_id=run, actor_id='QC-02')

    def standard_start(self, number: int, *, incoming: str = 'no_signs_detected', machine_warning: bool = False) -> tuple[str, str, str]:
        self.receive(number)
        incoming_media = {13: ['M013-CV-BEFORE'], 14: ['M014-CV-BEFORE'],
                          20: ['M020-CV-BEFORE']}.get(number, [])
        incoming_id = self.inspection(number, 2, 'CP-IN', incoming,
                                      quality='poor' if incoming == 'unable_to_assess' else 'good',
                                      confidence=None if incoming == 'unable_to_assess' else 0.98,
                                      media=incoming_media,
                                      missing_reason='camera_frame_unavailable' if incoming == 'unable_to_assess' else None)
        _, _, run = self.operation(number, 'milling', 5, 20)
        machine_id = self.machine(number, 12, run, warning=machine_warning)
        return incoming_id, run, machine_id

    def finish_normal(self, number: int, minute: int = 30) -> None:
        _, _, run = self.operation(number, 'assembly', minute, minute + 12)
        self.inspection(number, minute + 14, 'CP-FINAL', 'no_signs_detected', run=run)

    def demo_013(self) -> None:
        number = 13
        incoming, run, machine = self.standard_start(number)
        detected = self.inspection(number, 22, 'CP-POST-MILL', 'signs_detected', defect='SCRATCH',
                                   severity='high', confidence=0.89, media=['M013-CV-DEFECT'], run=run)
        confirmed = self.qc(number, 25, [f'{detected}#F1'], 'confirmed', 'rework',
                            'Поверхностное повреждение подтверждено; доработка только после проверки допуска.', [detected, incoming])
        authorized = self.tech(number, 27, 'rework_allowed',
                               'Разрешён один контролируемый проход при сохранении учебной минимальной толщины 5,0 мм.',
                               [confirmed], max_stock_removal_mm=0.15)
        _, rework_finished, rework_run = self.operation(number, 'surface_rework', 31, 43, attempt=2, previous=run)
        completed = self.master(number, 44, 'rework_completed', 'surface_reworked', [authorized, rework_finished], ['M013-MASTER-CLEAR'])
        measured = self.measurement(number, 46, rework_run, 5.12)
        clear = self.inspection(number, 48, 'CP-POST-MILL', 'no_signs_detected', method='manual_verification',
                                media=['M013-MASTER-CLEAR'], run=rework_run)
        released = self.qc(number, 50, [f'{detected}#F1'], 'release_after_rework', 'release',
                           'Повторный осмотр без признака; замер 5,12 мм в рамках учебного допуска.',
                           [confirmed, authorized, completed, measured, clear])
        self.finish_normal(number, 54)
        self.demo_refs[item_id(number)] = {'before_machine': incoming, 'detected': detected, 'confirmed': confirmed, 'master_photo': completed,
                                           'recheck': clear, 'released': released, 'measurement': measured}

    def demo_014(self) -> None:
        number = 14
        incoming, run, machine = self.standard_start(number, machine_warning=True)
        detected = self.inspection(number, 22, 'CP-POST-MILL', 'signs_detected', defect='BURR',
                                   severity='medium', confidence=0.91, media=['M014-CV-BURR'], run=run)
        confirmed = self.qc(number, 25, [f'{detected}#F1'], 'confirmed', 'rework',
                            'Заусенец подтверждён; изделие направлено на контролируемое удаление кромки.', [detected])
        self.emit(number, 26, 'cause_review', 'TECH-UI', 'qc', {
            'finding_refs': [f'{detected}#F1'], 'cause_type': 'equipment_deviation', 'status': 'hypothesis',
            'basis_event_ids': [machine, detected], 'reason': 'Предупреждение станка совпало по времени, но причина не доказана.',
        }, actor_id='TECH-01')
        _, first_finished, first_run = self.operation(number, 'edge_rework', 30, 39, attempt=2, previous=run)
        first_master = self.master(number, 40, 'rework_completed', 'operator_reports_complete', [confirmed, first_finished], ['M014-MASTER-STILL'])
        still = self.inspection(number, 42, 'CP-POST-MILL', 'signs_detected', defect='BURR', finding_id='F1',
                                severity='medium', confidence=0.99, method='manual_verification',
                                media=['M014-MASTER-STILL'], run=first_run)
        again = self.qc(number, 44, [f'{detected}#F1', f'{still}#F1'], 'confirmed', 'rework',
                        'Заусенец сохраняется после первого прохода; выпуск запрещён.', [first_master, still])
        _, second_finished, second_run = self.operation(number, 'edge_rework', 48, 56, attempt=3, previous=first_run)
        second_master = self.master(number, 57, 'rework_completed', 'edge_cleaned', [again, second_finished], ['M014-MASTER-CLEAR'])
        clear = self.inspection(number, 59, 'CP-POST-MILL', 'no_signs_detected', method='manual_verification',
                                media=['M014-MASTER-CLEAR'], run=second_run)
        released = self.qc(number, 61, [f'{detected}#F1'], 'release_after_rework', 'release',
                           'После второго прохода заусенец не обнаружен при повторной проверке.', [second_master, clear])
        self.finish_normal(number, 65)
        self.demo_refs[item_id(number)] = {'before_machine': incoming, 'detected': detected, 'confirmed': confirmed, 'first_master': first_master,
                                           'failed_recheck': still, 'second_master': second_master,
                                           'successful_recheck': clear, 'released': released}

    def demo_015(self) -> None:
        number = 15
        _, run, _ = self.standard_start(number, incoming='unable_to_assess')
        unknown = self.inspection(number, 22, 'CP-POST-MILL', 'unable_to_assess', quality='poor',
                                  confidence=None, run=run, missing_reason='camera_frame_lost_during_transfer')
        requested = self.qc(number, 25, [], 'additional_check', 'hold',
                            'Кадр недоступен; требуется очный осмотр и пригодное фото.', [unknown])
        photo = self.master(number, 30, 'inspection_support', 'clear_photo_uploaded', [requested], ['M015-MASTER-DENT'])
        manual = self.inspection(number, 33, 'CP-POST-MILL', 'signs_detected', defect='DENT', severity='critical',
                                 confidence=None, method='manual_verification', media=['M015-MASTER-DENT'], run=run)
        confirmed = self.qc(number, 36, [f'{manual}#F1'], 'confirmed', 'quarantine',
                            'Повреждена наружная кромка; не считать деталь годной по неполному CV-сигналу.', [photo, manual])
        declined = self.tech(number, 40, 'rework_not_allowed',
                             'Учебный случай: восстановление критической кромки по заданному маршруту не допускается.', [confirmed])
        scrapped = self.qc(number, 44, [f'{manual}#F1'], 'scrap_approved', 'scrap',
                           'Списание после заключения технолога; дальнейшие операции не запускать.', [confirmed, declined])
        self.demo_refs[item_id(number)] = {'unassessable': unknown, 'requested': requested, 'master_photo': photo,
                                           'manual_defect': manual, 'confirmed': confirmed, 'technical_refusal': declined,
                                           'scrap': scrapped}

    def demo_016(self) -> None:
        number = 16
        _, run, _ = self.standard_start(number)
        suspected = self.inspection(number, 22, 'CP-POST-MILL', 'signs_detected', defect='SCRATCH',
                                    severity='low', confidence=0.43, quality='poor', media=['M016-CV-GLARE'], run=run)
        requested = self.qc(number, 24, [f'{suspected}#F1'], 'additional_check', 'hold',
                            'Низкая уверенность и блик; запросить осмотр при рассеянном свете.', [suspected])
        photo = self.master(number, 28, 'inspection_support', 'diffuse_light_photo_uploaded', [requested], ['M016-MASTER-CLEAR'])
        manual = self.inspection(number, 31, 'CP-POST-MILL', 'no_signs_detected', method='manual_verification',
                                 media=['M016-MASTER-CLEAR'], run=run)
        rejected = self.qc(number, 34, [f'{suspected}#F1'], 'rejected', 'release',
                           'Блик при первом освещении; повторный осмотр не подтвердил дефект.', [photo, manual])
        self.finish_normal(number, 38)
        self.demo_refs[item_id(number)] = {'suspected': suspected, 'requested': requested, 'master_photo': photo,
                                           'manual_clear': manual, 'rejected': rejected}

    def demo_017(self) -> None:
        number = 17
        _, run, machine = self.standard_start(number, machine_warning=True)
        detected = self.inspection(number, 22, 'CP-POST-MILL', 'signs_detected', defect='BURR',
                                   severity='medium', confidence=0.85, run=run)
        check = self.controller_check(number, 24, detected, 'BURR')
        confirmed = self.qc(number, 25, [f'{detected}#F1'], 'confirmed', 'rework',
                            'Заусенец подтверждён очным осмотром зоны; фото источник не передал.', [detected, check])
        _, rework_finished, rework = self.operation(number, 'edge_rework', 30, 39, attempt=2, previous=run)
        master = self.master(number, 40, 'rework_completed', 'edge_cleaned', [confirmed, rework_finished])
        clear = self.inspection(number, 42, 'CP-POST-MILL', 'no_signs_detected', method='manual_verification', run=rework)
        self.qc(number, 44, [f'{detected}#F1'], 'release_after_rework', 'release',
                'Доработка и повторная ручная проверка завершены.', [master, clear])
        self.finish_normal(number, 48)
        self.demo_refs[item_id(number)] = {'detected': detected, 'machine_warning': machine,
                                           'confirmed': confirmed, 'recheck': clear}

    def demo_018(self) -> None:
        number = 18
        self.receive(number)
        incoming = self.inspection(number, 2, 'CP-IN', 'no_signs_detected', delay=64)
        _, _, run = self.operation(number, 'milling', 5, 20)
        detected = self.inspection(number, 22, 'CP-POST-MILL', 'signs_detected', defect='SCRATCH',
                                   severity='medium', confidence=0.82, run=run)
        self.repeat(detected, 4)
        check = self.controller_check(number, 67, detected, 'SCRATCH')
        confirmed = self.qc(number, 68, [f'{detected}#F1'], 'confirmed', 'rework',
                            'Риска подтверждена очным осмотром; поздний входной контроль восстановил порядок, дубль не создал второй дефект.', [incoming, detected, check])
        self.demo_refs[item_id(number)] = {'incoming_late': incoming, 'detected': detected, 'confirmed': confirmed}

    def demo_019(self) -> None:
        """A visual mark exists before machining and remains unchanged afterward."""
        number = 19
        self.receive(number)
        incoming = self.inspection(number, 2, 'CP-IN', 'signs_detected', defect='SCRATCH',
                                   severity='low', confidence=0.91, media=['M019-CV-BEFORE'])
        first_decision = self.qc(number, 4, [f'{incoming}#F1'], 'accepted_within_spec', 'release',
                                 'Риска видна до станка; учебный лимит КД для зоны C не превышен. На обработку допускается.',
                                 [incoming])
        _, _, run = self.operation(number, 'milling', 5, 20)
        self.machine(number, 12, run)
        after = self.inspection(number, 22, 'CP-POST-MILL', 'signs_detected', defect='SCRATCH',
                                severity='low', confidence=0.92, media=['M019-CV-AFTER'], run=run)
        final_decision = self.qc(number, 25, [f'{after}#F1'], 'accepted_within_spec', 'release',
                                 'Та же риска видна на входном кадре; после станка размер не вырос в пределах учебной оценки CV. Вину оператора не выводим.',
                                 [incoming, first_decision, after])
        self.finish_normal(number)
        self.demo_refs[item_id(number)] = {'before_machine': incoming, 'incoming_decision': first_decision,
                                           'after_machine': after, 'final_decision': final_decision}

    def demo_020(self) -> None:
        """The pre-machine image is available while the post-machine frame is lost in transit."""
        number = 20
        incoming, run, _ = self.standard_start(number)
        detected = self.inspection(number, 22, 'CP-POST-MILL', 'signs_detected', defect='BURR',
                                   severity='high', confidence=0.88, run=run,
                                   missing_reason='camera_frame_lost_during_transfer')
        held = self.qc(number, 25, [f'{detected}#F1'], 'additional_check', 'hold',
                       'Послеоперационный кадр потерян при передаче. Изделие удержано для очной проверки кромки.',
                       [incoming, detected])
        self.demo_refs[item_id(number)] = {'before_machine': incoming, 'after_signal': detected, 'held': held}

    def demo_021(self) -> None:
        """Only structured CV and fictional drawing data leave the restricted image contour."""
        number = 21
        self.receive(number)
        incoming = self.inspection(number, 2, 'CP-IN', 'no_signs_detected',
                                   missing_reason='classified_restricted')
        _, _, run = self.operation(number, 'milling', 5, 20)
        self.machine(number, 12, run)
        detected = self.inspection(number, 22, 'CP-POST-MILL', 'signs_detected', defect='SCRATCH',
                                   severity='high', confidence=0.90, run=run,
                                   missing_reason='classified_restricted')
        held = self.qc(number, 25, [f'{detected}#F1'], 'additional_check', 'hold',
                       'Сырые изображения закрыты для внешнего интерфейса; доступны метрики CV и учебная КД. Нужна очная проверка внутри контура.',
                       [incoming, detected])
        self.demo_refs[item_id(number)] = {'incoming': incoming, 'restricted_signal': detected, 'held': held}

    def background(self, number: int, category: str) -> None:
        incoming_result = 'unable_to_assess' if category == 'uncertain' else 'no_signs_detected'
        incoming, run, machine = self.standard_start(number, incoming=incoming_result,
                                                     machine_warning=category == 'equipment_hypothesis')
        if category == 'normal':
            post = self.inspection(number, 22, 'CP-POST-MILL', 'no_signs_detected', run=run,
                                   delay=31 if number % 19 == 0 else 1)
            if number % 9 == 0:
                self.repeat(post, 3)
            self.finish_normal(number)
            return
        if category == 'uncertain':
            unknown = self.inspection(number, 22, 'CP-POST-MILL', 'unable_to_assess', quality='poor',
                                      confidence=None, run=run, missing_reason='blur_or_occlusion')
            self.qc(number, 25, [], 'additional_check', 'hold', 'Нельзя подтвердить годность при неоцениваемом кадре.', [unknown])
            clear = self.inspection(number, 31, 'CP-POST-MILL', 'no_signs_detected', method='manual_verification', run=run)
            self.qc(number, 34, [], 'recheck_clear', 'release', 'Ручная проверка не выявила признаков.', [clear])
            self.finish_normal(number, 38)
            return
        if category == 'false_positive':
            suspect = self.inspection(number, 22, 'CP-POST-MILL', 'signs_detected', defect='SCRATCH',
                                      severity='low', confidence=0.41, quality='poor', run=run)
            self.qc(number, 24, [f'{suspect}#F1'], 'additional_check', 'hold', 'Низкая уверенность; нужен очный контроль.', [suspect])
            clear = self.inspection(number, 29, 'CP-POST-MILL', 'no_signs_detected', method='manual_verification', run=run)
            self.qc(number, 32, [f'{suspect}#F1'], 'rejected', 'release', 'Признак не подтвердился вручную.', [clear])
            self.finish_normal(number, 36)
            return
        if category == 'critical_hold':
            defect = 'DENT' if number % 2 else 'CRACK'
            detected = self.inspection(number, 22, 'CP-POST-MILL', 'signs_detected',
                                       defect=defect,
                                       severity='critical', confidence=0.93, run=run)
            check = self.controller_check(number, 24, detected, defect)
            confirmed = self.qc(number, 25, [f'{detected}#F1'], 'confirmed', 'quarantine',
                                'Очный осмотр подтвердил повреждение критической зоны; требуется заключение технолога.', [detected, check])
            refused = self.tech(number, 30, 'rework_not_allowed',
                                'В учебном маршруте нет допустимого способа восстановить критическую зону.', [confirmed])
            self.qc(number, 34, [f'{detected}#F1'], 'scrap_approved', 'scrap',
                    'Списание утверждено после технологического заключения.', [refused])
            return
        defect = 'SCRATCH' if number % 4 == 0 else 'BURR'
        severity = 'high' if defect == 'SCRATCH' and number % 7 == 0 else 'medium'
        cv_media = {25: ['M025-CV-BURR'], 28: ['M028-CV-SCRATCH'], 29: ['M029-CV-BURR']}.get(number, [])
        detected = self.inspection(number, 22, 'CP-POST-MILL', 'signs_detected', defect=defect,
                                   severity=severity, confidence=0.87 + (number % 8) / 100,
                                   media=cv_media, run=run)
        check = None if cv_media else self.controller_check(number, 24, detected, defect)
        confirmed = self.qc(number, 25, [f'{detected}#F1'], 'confirmed', 'rework',
                            'Признак подтверждён по кадру и производственной истории.' if cv_media else
                            'Признак подтверждён очным осмотром зоны; назначена контролируемая доработка.',
                            [detected] + ([check] if check else []))
        if category == 'equipment_hypothesis':
            self.emit(number, 26, 'cause_review', 'TECH-UI', 'qc', {
                'finding_refs': [f'{detected}#F1'], 'cause_type': 'equipment_deviation', 'status': 'hypothesis',
                'basis_event_ids': [machine, detected], 'reason': 'Совпадение по времени не доказывает причинность.',
            }, actor_id='TECH-01')
        authorization_basis = confirmed
        if defect == 'SCRATCH' and severity == 'high':
            authorization_basis = self.tech(number, 27, 'rework_allowed',
                                            'Для нестандартной риски подтверждена допустимость доработки по учебному маршруту.',
                                            [confirmed], max_stock_removal_mm=0.15)
        rework_kind = 'surface_rework' if defect == 'SCRATCH' else 'edge_rework'
        _, rework_finished, rework = self.operation(number, rework_kind, 30, 40, attempt=2, previous=run)
        repaired_media = {25: ['M025-MASTER-CLEAR'], 28: ['M028-MASTER-CLEAR']}.get(number, [])
        master = self.master(number, 41, 'rework_completed', 'operator_reports_complete',
                             [authorization_basis, rework_finished], repaired_media)
        basis = [master]
        if defect == 'SCRATCH':
            basis.append(self.measurement(number, 43, rework, 5.05 + (number % 7) / 100))
        clear = self.inspection(number, 45, 'CP-POST-MILL', 'no_signs_detected',
                                method='manual_verification', media=repaired_media, run=rework)
        basis.append(clear)
        self.qc(number, 48, [f'{detected}#F1'], 'release_after_rework', 'release',
                'Повторная проверка после доработки без признака.', basis)
        self.finish_normal(number, 52)


def build_catalogs(original: dict[str, Any]) -> dict[str, Any]:
    catalogs = copy.deepcopy(original)
    catalogs['dataset_version'] = '2.0'
    catalogs['item_types'].extend([
        {'id': 'TYPE-BRACKET-GUSSET', 'name': 'Условный косыночный кронштейн', 'demo_item_id': 'ITEM-019'},
        {'id': 'TYPE-BRACKET-CLEVIS', 'name': 'Условный вилочный кронштейн', 'demo_item_id': 'ITEM-020'},
        {'id': 'TYPE-BRACKET-L', 'name': 'Условный L-образный кронштейн', 'demo_item_id': 'ITEM-025'},
        {'id': 'TYPE-BRACKET-U', 'name': 'Условный U-образный кронштейн', 'demo_item_id': 'ITEM-028'},
    ])
    catalogs['lines'].append({'id': 'LINE-02', 'name': 'Вторая учебная линия'})
    for stem, name in [('ST-IN', 'Входной контроль'), ('ST-MILL', 'Механическая обработка'),
                       ('ST-ASSEMBLY', 'Сборка'), ('ST-QC', 'Рассмотрение качества')]:
        catalogs['stations'].append({'id': stem + '-02', 'name': f'{name}, линия 2'})
    catalogs['operations'].append({'id': 'OP-REWORK', 'name': 'Контролируемая доработка', 'station_id': 'ST-MILL'})
    catalogs['defect_types'].extend([
        {'id': 'CRACK', 'name': 'Трещина'},
        {'id': 'DISCOLORATION', 'name': 'Изменение цвета поверхности'},
    ])
    catalogs['operators'].extend([
        {'id': 'OP-03', 'shift_id': 'SHIFT-A'}, {'id': 'OP-04', 'shift_id': 'SHIFT-A'},
        {'id': 'OP-05', 'shift_id': 'SHIFT-B'}, {'id': 'OP-06', 'shift_id': 'SHIFT-B'},
    ])
    catalogs['reviewers'].extend([{'id': 'QC-02', 'role': 'quality_controller'}, {'id': 'MASTER-01', 'role': 'line_master'}])
    catalogs['equipment'].append({'id': 'GAGE-01', 'station_id': 'ST-QC', 'purpose': 'Ручное измерение учебного размера'})
    catalogs['equipment'].extend([
        {'id': 'EQ-CNC-02', 'station_id': 'ST-MILL-02'},
        {'id': 'EQ-ASSEMBLY-02', 'station_id': 'ST-ASSEMBLY-02'},
    ])
    catalogs['sources'].append({'id': 'MASTER-UI'})
    return catalogs


def build_items(original: list[dict[str, Any]], builder: Builder) -> list[dict[str, Any]]:
    items = copy.deepcopy(original)
    for number in range(13, 181):
        items.append({
            'id': item_id(number),
            'item_type_id': item_type(number),
            'assembly_revision': 'A',
            'work_order_id': builder.work_order(number),
            'line_id': builder.line(number),
            'supplier_lot_id': f'LOT-{((number - 13) // 12) + 1:02d}',
            'components': [
                {'id': f'COMP-{number:03d}-{part}', 'component_type_id': 'FASTENER' if part.startswith('FASTENER') else part}
                for part in ('BODY', 'INSERT', 'FASTENER-1', 'FASTENER-2')
            ],
        })
    return items


def negative_cases(builder: Builder) -> list[dict[str, Any]]:
    representative = next(message for message in builder.events_by_id.values()
                          if message['item_id'] == 'ITEM-019' and message['event_type'] == 'inspection_result')
    records = []
    mutations = [
        ('missing_item_id', lambda m: m.pop('item_id')),
        ('unknown_item_id', lambda m: m.update({'item_id': 'ITEM-999'})),
        ('unsupported_schema', lambda m: m.update({'schema_version': '99.0'})),
        ('invalid_inspection_enum', lambda m: m['data'].update({'inspection_result': 'probably_good'})),
        ('negative_confidence', lambda m: m['data'].update({'confidence': -0.3})),
        ('missing_occurred_at', lambda m: m.pop('occurred_at')),
        ('unknown_station', lambda m: m.update({'station_id': 'ST-UNKNOWN'})),
        ('invalid_timestamp', lambda m: m.update({'occurred_at': 'not-a-time'})),
        ('conflicting_redelivery', lambda m: m['data'].update({'confidence': 0.11})),
        ('unknown_media_ref', lambda m: m['data'].update({'evidence_refs': ['MISSING-ASSET']})),
    ]
    for number in range(1, 31):
        case_name, mutation = mutations[(number - 1) % len(mutations)]
        message = copy.deepcopy(representative)
        if case_name != 'conflicting_redelivery':
            message['event_id'] = f'BAD-EVENT-{number:03d}'
        mutation(message)
        delivery_id = f'BAD-{number:03d}'
        records.append({
            'case_id': f'{case_name}_{number:03d}',
            'expected_error_code': case_name,
            'expected_behavior': 'quarantine_without_mutating_history',
            'delivery': {
                'delivery_id': delivery_id,
                'deliver_at': iso(datetime(2026, 2, 28, 8, tzinfo=TZ) + timedelta(minutes=number)),
                'message': message,
            },
        })
    return records


def computed_metrics(ordered: list[dict[str, Any]], invalid_count: int) -> dict[str, Any]:
    messages = {record['message']['event_id']: record['message'] for record in ordered}
    values = list(messages.values())
    decisions = [message for message in values if message['event_type'] == 'quality_decision']
    inspections = [message for message in values if message['event_type'] == 'inspection_result']
    defects: set[tuple[str, str, str, str]] = set()
    for decision in decisions:
        if decision['data']['decision'] != 'confirmed':
            continue
        for ref in decision['data']['finding_refs']:
            inspection_id, finding_id = ref.split('#', 1)
            observation = messages[inspection_id]
            finding = next(value for value in observation['data']['defects'] if value['finding_id'] == finding_id)
            defects.add((decision['item_id'], finding['component_id'], finding['defect_type_id'], finding['region']))
    late = sum((datetime.fromisoformat(record['deliver_at']) - datetime.fromisoformat(record['message']['occurred_at'])).total_seconds() > 600
               for record in ordered)
    counts = {
        'items': len({message['item_id'] for message in values}),
        'deliveries_received': len(ordered),
        'unique_events': len(messages),
        'duplicate_deliveries': len(ordered) - len(messages),
        'invalid_deliveries_quarantined': invalid_count,
        'late_deliveries_over_10_minutes': late,
        'cv_signs_detected': sum(message['data']['inspection_result'] == 'signs_detected' and message['data']['method'] == 'external_analyzer' for message in inspections),
        'cv_no_signs_detected': sum(message['data']['inspection_result'] == 'no_signs_detected' and message['data']['method'] == 'external_analyzer' for message in inspections),
        'cv_unable_to_assess': sum(message['data']['inspection_result'] == 'unable_to_assess' and message['data']['method'] == 'external_analyzer' for message in inspections),
        'confirmed_defect_cases_ever': len(defects),
        'items_with_confirmed_defect_ever': len({case[0] for case in defects}),
        'quality_decisions_confirmed': sum(message['data']['decision'] == 'confirmed' for message in decisions),
        'quality_decisions_rejected': sum(message['data']['decision'] == 'rejected' for message in decisions),
        'additional_check_decisions': sum(message['data']['decision'] == 'additional_check' for message in decisions),
        'release_after_rework_decisions': sum(message['data']['decision'] == 'release_after_rework' for message in decisions),
        'scrap_approved_decisions': sum(message['data']['decision'] == 'scrap_approved' for message in decisions),
        'rework_operation_runs': sum(message['event_type'] == 'operation_started' and bool(message['data']['previous_operation_run_id']) for message in values),
        'manual_measurements': sum(message['event_type'] == 'manual_measurement' for message in values),
        'inspections_with_attached_image': sum(bool(message['data']['evidence_refs']) for message in inspections),
        'events_with_explicit_missing_optional_fields': sum(bool(message['data'].get('data_quality', {}).get('missing_optional_fields')) for message in values),
    }
    return {
        'counts': counts,
        'definitions': {
            'cv_signs_detected': 'Автоматический сигнал о признаке, а не доказанный брак.',
            'confirmed_defect_cases_ever': 'Уникальная связка изделие + компонент + вид дефекта + область; история сохраняется после доработки.',
            'items_with_confirmed_defect_ever': 'Уникальные изделия с подтверждённым несоответствием в истории.',
            'late_deliveries_over_10_minutes': 'Доставки, а не уникальные события; задержка от occurred_at до deliver_at.',
            'rework_operation_runs': 'Новое выполнение операции со ссылкой на прежний запуск.',
            'scrap_approved_decisions': 'Отдельное решение контролёра после заключения технолога, не вывод CV.',
        },
    }


def main() -> None:
    legacy.main()
    old = legacy.OUT
    original_deliveries = [json.loads(line) for line in (old / 'events/deliveries.jsonl').read_text(encoding='utf-8').splitlines()]
    media = media_index()
    builder = Builder(original_deliveries, media)
    for number, method in [(13, builder.demo_013), (14, builder.demo_014), (15, builder.demo_015),
                           (16, builder.demo_016), (17, builder.demo_017), (18, builder.demo_018),
                           (19, builder.demo_019), (20, builder.demo_020), (21, builder.demo_021)]:
        method()
    categories = (['normal'] * 105 + ['rework_success'] * 36 + ['false_positive'] * 8 +
                  ['uncertain'] * 5 + ['critical_hold'] * 3 + ['equipment_hypothesis'] * 2)
    random.Random(2026).shuffle(categories)
    category_by_item = {'ITEM-019': 'incoming_defect', 'ITEM-020': 'lost_after_photo',
                        'ITEM-021': 'classified_restricted'}
    category_by_item.update({item_id(number): category for number, category in zip(range(22, 181), categories, strict=True)})
    if category_by_item['ITEM-049'] != 'critical_hold':
        displaced = next(key for key, value in category_by_item.items() if value == 'critical_hold')
        category_by_item[displaced], category_by_item['ITEM-049'] = category_by_item['ITEM-049'], 'critical_hold'
    for number in range(22, 181):
        builder.background(number, category_by_item[item_id(number)])
    extra_duplicate_ids = [event_id for event_id, message in builder.events_by_id.items()
                           if event_id.startswith('E2-') and message['source_id'] not in HUMAN_SOURCES and message['item_id'] not in builder.demo_refs]
    random.Random(77).shuffle(extra_duplicate_ids)
    for index, event_id in enumerate(extra_duplicate_ids[:96]):
        builder.repeat(event_id, minutes_after=2 + index % 17)
    ordered = sorted(builder.deliveries, key=lambda value: (value['deliver_at'], value['delivery_id']))
    unique_ids = {record['message']['event_id'] for record in ordered}
    source = [record for record in ordered if record['message']['source_id'] not in HUMAN_SOURCES]
    actions = [record for record in ordered if record['message']['source_id'] in HUMAN_SOURCES]
    old_items = json.loads((old / 'items.json').read_text(encoding='utf-8'))
    items = build_items(old_items, builder)
    negatives = negative_cases(builder)
    ingest = sorted(ordered + [entry['delivery'] for entry in negatives], key=lambda value: (value['deliver_at'], value['delivery_id']))
    write_json('manifest.json', {
        'dataset_id': 'cosmo-quality-synthetic-expanded-v2', 'dataset_version': '2.0', 'synthetic': True,
        'item_count': len(items), 'unique_event_count': len(unique_ids), 'delivery_count': len(ordered),
        'duplicate_delivery_count': len(ordered) - len(unique_ids), 'invalid_delivery_count': len(negatives),
        'source_delivery_count': len(source), 'scripted_human_action_count': len(actions),
        'media_asset_count': len(media), 'demo_item_ids': list(builder.demo_refs),
        'background_mix': dict(Counter(category_by_item.values())), 'rng_seed': 2026,
        'time_zone': 'UTC+03:00', 'no_real_personal_or_production_data': True,
        'note': 'Synthetic photos are illustrative evidence, not instrument readings. Legacy 12 cases are retained.',
    })
    write_json('catalogs.json', build_catalogs(json.loads((old / 'catalogs.json').read_text(encoding='utf-8'))))
    write_json('items.json', items)
    write_json('media_index.json', media)
    write_json('demo_routes.json', {
        'primary': [
            {'item_id': 'ITEM-013', 'scenario': 'Устранимая риска: кадр CV → ОТК → разрешение технолога → мастер → замер → повторный контроль → выпуск.'},
            {'item_id': 'ITEM-014', 'scenario': 'Заусенец остался после первой доработки: повторный круг и выпуск только после второго контроля.'},
            {'item_id': 'ITEM-015', 'scenario': 'Кадра нет: доппроверка с фото мастера выявляет критический дефект, доработка отклонена.'},
            {'item_id': 'ITEM-016', 'scenario': 'Блик и слабый сигнал: проверка мастера опровергает признак, контролёр выпускает изделие.'},
        ],
        'technical': [
            {'item_id': 'ITEM-017', 'scenario': 'Предупреждение станка — гипотеза, не установленная причина.'},
            {'item_id': 'ITEM-018', 'scenario': 'Поздний входной контроль и повторная доставка одного CV-сигнала.'},
            {'item_id': 'ITEM-007', 'scenario': 'Два дефекта в одном сигнале, один бракованный экземпляр.'},
        ],
        'additional_visual': [
            {'item_id': 'ITEM-025', 'scenario': 'Другой тип детали: L-образный кронштейн с заусенцем, затем чёткое фото очищенной кромки.'},
            {'item_id': 'ITEM-028', 'scenario': 'U-образный кронштейн с поверхностной риской, затем фото после доработки.'},
            {'item_id': 'ITEM-029', 'scenario': 'Ракурс второй камеры: ещё один дефект на отличающейся детали.'},
        ],
        'structured_evidence': [
            {'item_id': 'ITEM-013', 'scenario': 'Оба кадра доступны: новая риска появляется только после станка.'},
            {'item_id': 'ITEM-019', 'scenario': 'Риска есть до станка и после него: появление не связано с текущей операцией.'},
            {'item_id': 'ITEM-020', 'scenario': 'Входной кадр доступен, послеоперационный потерян при передаче edge-агента.'},
            {'item_id': 'ITEM-021', 'scenario': 'Оба сырых кадра закрыты для внешнего интерфейса; остаются геометрия CV и учебная КД.'},
        ],
        'event_refs': builder.demo_refs,
        'truth_source': 'expected/demo_timeline.json; not fed into core ingestion',
    })
    write_json('expected/demo_timeline.json', [
        {'item_id': item, 'step': step, 'event_id': event_id, 'occurred_at': builder.events_by_id[event_id]['occurred_at']}
        for item, refs in builder.demo_refs.items() for step, event_id in refs.items()
    ])
    write_json('expected/category_by_item.json', category_by_item)
    write_json('expected/metrics.json', computed_metrics(ordered, len(negatives)))
    write_json('expected/ingest_outcomes.json', [
        {'delivery_id': record['delivery_id'], 'outcome': 'duplicate' if record['message']['event_id'] in seen else 'accepted'}
        for seen, record in _progressive_seen(ordered)
    ] + [{'delivery_id': entry['delivery']['delivery_id'], 'outcome': 'quarantined',
          'error_code': entry['expected_error_code']} for entry in negatives])
    write_jsonl('events/deliveries.jsonl', ordered)
    write_jsonl('events/source_deliveries.jsonl', source)
    write_jsonl('events/ingest_stream.jsonl', ingest)
    write_jsonl('events/invalid_deliveries.jsonl', negatives)
    write_jsonl('interactions/scripted_actions.jsonl', actions)
    write_json('integration/compatibility.json', {
        'legacy_emulator_fixture': '../dataset/integration/',
        'expanded_work_orders': [
            {'work_order_id': f'WO-C{batch:02d}', 'item_ids': [item_id(n) for n in range(13 + (batch - 1) * 20, min(13 + batch * 20, 181))],
             'source': 'ERP-EMU', 'schema_version': '2.0'} for batch in range(1, 10)
        ],
        'target_profiles': '../dataset/integration/target_profiles.json',
        'adapter_note': 'Полный цикл двустороннего эмулятора остаётся в малом контрольном наборе; расширенные задания нужны для нагрузки и интерфейса.',
    })
    print(f'Expanded: {len(items)} items, {len(unique_ids)} unique events, {len(ordered)} deliveries, {len(negatives)} invalid cases, {len(media)} images')


def _progressive_seen(ordered: list[dict[str, Any]]) -> list[tuple[set[str], dict[str, Any]]]:
    result: list[tuple[set[str], dict[str, Any]]] = []
    seen: set[str] = set()
    for record in ordered:
        result.append((seen.copy(), record))
        seen.add(record['message']['event_id'])
    return result


if __name__ == '__main__':
    main()
