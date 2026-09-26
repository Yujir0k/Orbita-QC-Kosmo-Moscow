/** Preserve the final manufacturing disposition when translating the ERP result. */
export function erpQualityStatus(event) {
  if (event.data.disposition === 'scrap') return 'scrapped';
  if (event.data.disposition === 'rework') return 'rework_required';
  if (event.data.decision === 'release_after_rework') return 'released_after_rework';
  return event.data.disposition === 'release' ? 'accepted' : 'quarantined';
}
