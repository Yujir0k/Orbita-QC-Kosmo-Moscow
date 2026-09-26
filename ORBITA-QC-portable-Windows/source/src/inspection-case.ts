import { cases, catalogs, eventsFor, items, mediaIndex, mediaUrl, type Case, type MediaAsset, type QualityEvent } from './domain';
import { controllerCaseData } from './controller-case';

export type DefectStatus = 'NEW_SIGNAL' | 'UNDER_REVIEW' | 'SENT_TO_REWORK' | 'REWORK_VERIFICATION' | 'CONFIRMED_DEFECT' | 'FALSE_POSITIVE' | 'ACCEPTED_AFTER_REWORK';
export type ObservationQuality = 'OPTIMAL' | 'GLARE_DETECTED' | 'BLURRED' | 'LIMITED' | 'NO_IMAGE';

export interface InspectionCase {
  id: string;
  itemId: string;
  partName: string;
  workOrder: string;
  batchId?: string;
  supplierLotId?: string;
  routeSheet?: string;
  drawingRevision: string;
  iteration: number;
  status: DefectStatus;
  urgency: 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW';
  createdAt: string;
  visualEvidence: {
    beforeImageUrl?: string;
    currentImageUrl?: string;
    hasImage: boolean;
    missingImageReason?: string;
    quality: ObservationQuality;
    aiConfidence?: number;
    defectType: string;
    defectBBox?: [number, number, number, number];
    cameraMeta: {
      cameraId?: string;
      viewAngle?: string;
      lightingProfile?: string;
      calibrationProfile?: string;
      calibrationStatus?: 'VALID' | 'EXPIRED';
      imageHash?: string;
      isHashValid?: boolean;
    };
  };
  machineContext: {
    stationId: string;
    operatorId?: string;
    machineId?: string;
    dpmCodeVerified?: boolean;
    toolWearPercent?: number;
    machineWarnings: string[];
  };
  technologistFinding?: {
    investigationStatus: 'IN_PROGRESS' | 'COMPLETED';
    rootCauseCategory?: 'MACHINE_FAULT' | 'OPERATOR_ERROR' | 'RAW_MATERIAL' | 'TOOL_WEAR';
    description?: string;
    reworkPermitted?: boolean;
    resolutionNumber?: string;
  };
  masterReworkReport?: {
    actionType: 'rework_completed' | 'inspection_support';
    completedAt: string;
    masterName: string;
    actionDescription: string;
    manualMeasurement?: {
      parameterName: string;
      measuredValue: number;
      nominalValue?: number;
      toleranceMin?: number;
      toleranceMax?: number;
      toolName?: string;
      toolVerificationValid?: boolean;
    };
    evidencePhotoUrl?: string;
  };
}

const stringValue = (value: unknown): string | undefined => typeof value === 'string' && value.trim() ? value : undefined;

/** Project a controller case from received events without inventing evidence or measurements. */
export function inspectionCaseFrom(record: Case): InspectionCase {
  const product = items.find(item => item.id === record.item)!;
  const data = controllerCaseData(record, product, mediaIndex);
  const observation = data.observation;
  const own = eventsFor(record.item);
  const received = own.find(event => event.event_type === 'item_received');
  const decision = record.decisions.at(-1);
  const latestItemDecision = own.filter(event => event.event_type === 'quality_decision').at(-1);
  const master = own.filter(event => event.event_type === 'master_action').at(-1);
  const afterMaster = !!master && (!latestItemDecision || Date.parse(master.occurred_at) > Date.parse(latestItemDecision.occurred_at));
  const currentAsset = afterMaster ? mediaIndex.find(asset => master.data.evidence_refs?.includes(asset.asset_id)) : data.image;
  const beforeAsset = afterMaster ? data.image : undefined;
  const machine = own.filter(event => event.event_type === 'machine_state' && (!observation.operation_run_id || event.operation_run_id === observation.operation_run_id)).at(-1);
  const operation = own.filter(event => event.event_type === 'operation_started' && (!observation.operation_run_id || event.operation_run_id === observation.operation_run_id)).at(-1);
  const technologist = own.filter(event => event.event_type === 'technical_disposition' || event.event_type === 'cause_review').at(-1);
  const measurement = own.filter(event => event.event_type === 'manual_measurement').at(-1);
  const currentQuality = afterMaster ? master.data.observation_quality : observation.data.observation_quality;
  const quality: ObservationQuality = !currentAsset ? 'NO_IMAGE' : currentQuality === 'poor' ? /блик|glare/i.test(currentAsset.description) ? 'GLARE_DETECTED' : /размыт|blur/i.test(currentAsset.description) ? 'BLURRED' : 'LIMITED' : 'OPTIMAL';
  const status: DefectStatus = afterMaster ? master.data.action_type === 'rework_completed' ? 'REWORK_VERIFICATION' : 'UNDER_REVIEW' : decision?.data.decision === 'rejected' ? 'FALSE_POSITIVE' : decision?.data.decision === 'release_after_rework' ? 'ACCEPTED_AFTER_REWORK' : decision?.data.decision === 'confirmed' ? decision.data.disposition === 'rework' ? 'SENT_TO_REWORK' : 'CONFIRMED_DEFECT' : decision ? 'UNDER_REVIEW' : 'NEW_SIGNAL';
  const assetWithHash = currentAsset as (MediaAsset & { sha256?: string }) | undefined;
  const capture = observation.data.capture_context ?? {};
  const missingImageReason = stringValue(capture.missing_image_reason);
  return {
    id: record.id,
    itemId: record.item,
    partName: catalogs.item_types.find(type => type.id === product.item_type_id)?.name ?? product.item_type_id,
    workOrder: product.work_order_id,
    supplierLotId: stringValue(received?.data.supplier_lot_id),
    routeSheet: stringValue(received?.data.traveler_id),
    drawingRevision: product.assembly_revision,
    iteration: own.filter(event => event.event_type === 'master_action').length + 1,
    status,
    urgency: record.priority >= 120 ? 'CRITICAL' : record.priority >= 70 ? 'HIGH' : record.priority >= 40 ? 'MEDIUM' : 'LOW',
    createdAt: record.observations[0].occurred_at,
    visualEvidence: {
      beforeImageUrl: beforeAsset ? mediaUrl(beforeAsset) : undefined,
      currentImageUrl: currentAsset ? mediaUrl(currentAsset) : undefined,
      hasImage: !!currentAsset,
      missingImageReason,
      quality,
      aiConfidence: typeof observation.data.confidence === 'number' ? Math.round(observation.data.confidence * 100) : undefined,
      defectType: record.type,
      cameraMeta: {
        cameraId: stringValue(capture.camera_id),
        viewAngle: stringValue(capture.view_id),
        lightingProfile: stringValue(capture.lighting_recipe_id),
        calibrationProfile: stringValue(capture.calibration_profile_version),
        imageHash: assetWithHash?.sha256,
      },
    },
    machineContext: {
      stationId: observation.station_id,
      operatorId: operation?.actor_id,
      machineId: machine?.equipment_id,
      machineWarnings: machine?.data.state === 'warning' ? [`${stringValue(machine.data.alarm_code) ?? 'Предупреждение станка'} · ${machine.occurred_at}`] : [],
    },
    technologistFinding: technologist ? {
      investigationStatus: technologist.data.status === 'confirmed' || technologist.event_type === 'technical_disposition' ? 'COMPLETED' : 'IN_PROGRESS',
      description: stringValue(technologist.data.reason),
      reworkPermitted: technologist.event_type === 'technical_disposition' ? technologist.data.disposition === 'rework_allowed' : undefined,
    } : undefined,
    masterReworkReport: master ? {
      actionType: master.data.action_type === 'rework_completed' ? 'rework_completed' : 'inspection_support',
      completedAt: master.occurred_at,
      masterName: master.actor_id ?? '',
      actionDescription: stringValue(master.data.comment) ?? stringValue(master.data.reason) ?? '',
      evidencePhotoUrl: currentAsset && afterMaster ? mediaUrl(currentAsset) : undefined,
      manualMeasurement: measurement && typeof measurement.data.measured_value === 'number' ? {
        parameterName: stringValue(measurement.data.feature_id) ?? 'Параметр не указан',
        measuredValue: measurement.data.measured_value,
        toleranceMin: typeof measurement.data.lower_limit === 'number' ? measurement.data.lower_limit : undefined,
        toleranceMax: typeof measurement.data.upper_limit === 'number' ? measurement.data.upper_limit : undefined,
        toolName: stringValue(measurement.data.instrument_id),
        toolVerificationValid: measurement.data.calibration_status === 'operator_confirmed',
      } : undefined,
    } : undefined,
  };
}

/** Return true only when the record contains enough evidence to support release. */
export function canReleaseAfterRework(record: InspectionCase, affectsDimensions: boolean): boolean {
  return record.masterReworkReport?.actionType === 'rework_completed' && record.visualEvidence.hasImage && record.visualEvidence.quality === 'OPTIMAL' && (!affectsDimensions || !!record.masterReworkReport.manualMeasurement);
}

export function controllerCases(): InspectionCase[] { return cases.map(inspectionCaseFrom); }

export function caseSource(record: InspectionCase): QualityEvent | undefined { return cases.find(row => row.id === record.id)?.observations.at(-1); }
