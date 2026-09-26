import { cases, catalogs, eventsFor, items, mediaIndex, mediaUrl, type Case, type MediaAsset, type MediaSlot, type QualityEvent } from './domain';
import { controllerCaseData } from './controller-case';
import { controllerEvidenceFrom } from './controller-evidence';

export type DefectStatus = 'NEW_SIGNAL' | 'UNDER_REVIEW' | 'SENT_TO_REWORK' | 'REWORK_VERIFICATION' | 'CONFIRMED_DEFECT' | 'FALSE_POSITIVE' | 'ACCEPTED_WITHIN_SPEC' | 'ACCEPTED_AFTER_REWORK';
export type ObservationQuality = 'OPTIMAL' | 'GLARE_DETECTED' | 'BLURRED' | 'LIMITED' | 'NO_IMAGE';

export interface InspectionFrame {
  url?: string;
  hash?: string;
  absenceReason?: MediaSlot['absence_reason'];
  capturedAt?: string;
  checkpoint?: string;
}

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
    before: InspectionFrame;
    after: InspectionFrame;
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
  const beforeSlot = observation.data.media_evidence?.before_operation;
  const afterSlot = observation.data.media_evidence?.after_operation;
  const previousInspection = own.find(event => event.event_id === observation.data.comparison?.previous_inspection_event_id)
    ?? own.filter(event => event.event_type === 'inspection_result' && Date.parse(event.occurred_at) < Date.parse(observation.occurred_at)).at(-1);
  const beforeImageUrl = beforeAsset ? mediaUrl(beforeAsset) : beforeSlot?.status === 'AVAILABLE' ? beforeSlot.url ?? undefined : undefined;
  const currentImageUrl = afterMaster ? currentAsset ? mediaUrl(currentAsset) : undefined
    : afterSlot ? afterSlot.status === 'AVAILABLE' ? afterSlot.url ?? undefined : undefined : currentAsset ? mediaUrl(currentAsset) : undefined;
  const { machine, operation } = controllerEvidenceFrom(record, own, !!currentAsset);
  const technologist = own.filter(event => event.event_type === 'cause_review').at(-1);
  const measurement = own.filter(event => event.event_type === 'manual_measurement').at(-1);
  const currentQuality = afterMaster ? master.data.observation_quality : observation.data.observation_quality;
  const quality: ObservationQuality = !currentImageUrl ? 'NO_IMAGE' : currentQuality === 'good' ? 'OPTIMAL' : /блик|glare/i.test(currentAsset?.description ?? '') ? 'GLARE_DETECTED' : /размыт|blur/i.test(currentAsset?.description ?? '') ? 'BLURRED' : 'LIMITED';
  const freshObservation = decision && Date.parse(record.observations.at(-1)!.occurred_at) > Date.parse(decision.occurred_at);
  const status: DefectStatus = freshObservation ? 'NEW_SIGNAL' : afterMaster ? master.data.action_type === 'rework_completed' ? 'REWORK_VERIFICATION' : 'UNDER_REVIEW' : decision?.data.decision === 'rejected' ? 'FALSE_POSITIVE' : decision?.data.decision === 'accepted_within_spec' ? 'ACCEPTED_WITHIN_SPEC' : decision?.data.decision === 'release_after_rework' ? 'ACCEPTED_AFTER_REWORK' : decision?.data.decision === 'confirmed' ? decision.data.disposition === 'rework' ? 'SENT_TO_REWORK' : 'CONFIRMED_DEFECT' : decision ? 'UNDER_REVIEW' : 'NEW_SIGNAL';
  const assetWithHash = currentAsset as (MediaAsset & { sha256?: string }) | undefined;
  const capture = observation.data.capture_context ?? {};
  const missingImageReason = observation.data.media_evidence?.after_operation.status === 'MISSING'
    ? observation.data.media_evidence.after_operation.absence_reason : stringValue(capture.missing_image_reason);
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
      before: {
        url: beforeImageUrl,
        hash: beforeAsset?.sha256 ?? beforeSlot?.sha256_hash,
        absenceReason: beforeSlot?.absence_reason,
        capturedAt: beforeAsset ? observation.occurred_at : previousInspection?.occurred_at,
        checkpoint: beforeAsset ? observation.data.inspection_point_id ?? observation.station_id : previousInspection?.data.inspection_point_id ?? previousInspection?.station_id,
      },
      after: {
        url: currentImageUrl,
        hash: afterMaster ? currentAsset?.sha256 : afterSlot?.sha256_hash ?? assetWithHash?.sha256,
        absenceReason: afterMaster ? undefined : afterSlot?.absence_reason,
        capturedAt: afterMaster ? master.occurred_at : observation.occurred_at,
        checkpoint: afterMaster ? master.station_id : observation.data.inspection_point_id ?? observation.station_id,
      },
      beforeImageUrl,
      currentImageUrl,
      hasImage: !!currentImageUrl,
      missingImageReason,
      quality,
      aiConfidence: typeof observation.data.confidence === 'number' ? Math.round(observation.data.confidence * 100) : undefined,
      defectType: record.type,
      cameraMeta: {
        cameraId: stringValue(capture.camera_id),
        viewAngle: stringValue(capture.view_id),
        lightingProfile: stringValue(capture.lighting_recipe_id),
        calibrationProfile: stringValue(capture.calibration_profile_version),
        imageHash: afterMaster ? assetWithHash?.sha256 : afterSlot?.sha256_hash ?? assetWithHash?.sha256,
      },
    },
    machineContext: {
      stationId: observation.station_id,
      operatorId: operation?.actor_id,
      machineId: machine?.equipment_id ?? operation?.equipment_id,
      machineWarnings: machine?.data.state === 'warning' ? [`${stringValue(machine.data.alarm_code) ?? 'Предупреждение станка'} · ${machine.occurred_at}`] : [],
    },
    technologistFinding: technologist ? {
      investigationStatus: technologist.data.status === 'confirmed' ? 'COMPLETED' : 'IN_PROGRESS',
      description: stringValue(technologist.data.reason),
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
