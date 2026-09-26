/** Historical training archive. Separate from live deliveries and production KPIs. */
export interface HistoricalRun {
  id: string; item: string; equipment: string; program: string; revision: string;
  occurredAt: string; status: 'SUCCESS' | 'DEFECT'; defCount: number; defType?: string;
  spindleRpm: number; feedRate: number; vibration: number; coolantBar: number;
  durationSec: number; operator: string; comment: string; synthetic: true;
}
const defects: Record<number, Partial<HistoricalRun>> = {
  2: { defType: 'INCOMING_DEFECT', comment: 'Раковина литья (входной брак заготовки)' },
  6: { defType: 'TOOL_WEAR', vibration: 4.9, comment: 'Скол фрезы, наработка 140 ч' },
  7: { defType: 'BURR', spindleRpm: 6050, feedRate: 485, vibration: 7.1, coolantBar: 4.1, durationSec: 900, comment: 'Заусенец кромки B; диагностика привода шпинделя' },
  12: { defType: 'SETUP', vibration: 4.2, comment: 'След переустановки: оснастка смещена' },
};
let successful = 0;
export const historicalRuns: HistoricalRun[] = Array.from({ length: 20 }, (_, index) => {
  const n = index + 1, issue = defects[n];
  const variation = issue ? 0 : [0, -0.2, 0.2, 0, 0, 0.2, -0.2, 0][successful++ % 8];
  return {
    id: `RUN-${String(n).padStart(3, '0')}`, item: 'ITEM-007', equipment: 'EQ-CNC-01',
    program: 'PRG-BRACKET-A', revision: '3',
    occurredAt: n === 7 ? '2026-02-17T16:05:00+03:00' : n === 5 ? '2026-02-16T10:05:00+03:00' : `2026-02-${String(14 + index % 3).padStart(2, '0')}T${String(8 + Math.floor(index / 3)).padStart(2, '0')}:05:00+03:00`,
    status: issue ? 'DEFECT' : 'SUCCESS', defCount: issue ? 1 : 0,
    spindleRpm: n === 5 ? 6000 : 6000 + Math.round(variation * 100),
    feedRate: n === 5 ? 475 : 475 + Math.round(variation * 10),
    vibration: Number((2.4 + variation).toFixed(1)), coolantBar: 4, durationSec: 840,
    operator: n % 2 ? 'OP-01' : 'OP-02', comment: 'Принято ОТК: дефектов нет', synthetic: true,
    ...issue,
  };
});
const good = historicalRuns.filter(run => run.status === 'SUCCESS');
export const historicalBaseline = {
  sampleSize: good.length, vibrationMin: 2, vibrationMax: 3.5,
  vibrationAvg: Number((good.reduce((sum, run) => sum + run.vibration, 0) / good.length).toFixed(2)),
  feedRateNorm: good.reduce((sum, run) => sum + run.feedRate, 0) / good.length,
  rpmNorm: good.reduce((sum, run) => sum + run.spindleRpm, 0) / good.length,
  warningThreshold: 5, feedLower: 450, feedUpper: 510,
};
export const historicalDefectLabels: Record<string, string> = { INCOMING_DEFECT: 'Входной брак', TOOL_WEAR: 'Износ инструмента', BURR: 'Заусенец', SCRATCH: 'Царапина', SETUP: 'Оснастка' };
export function parameterDelta(actual: number, reference: number) { return reference === 0 ? undefined : (actual - reference) / reference * 100; }
