export interface ProductSpecification {
  name: string; assembly: string; designation: string; material: string;
  materialCertificate?: string; cadFile: string; cadRevision: string;
}
const specified: Record<string, Partial<ProductSpecification>> = {
  'ITEM-001': { name: 'Корпус оптико-электронного блока', assembly: 'Узел БОЭ-14' },
  'ITEM-002': { name: 'Корпус оптико-электронного блока', assembly: 'Узел БОЭ-14' },
  'ITEM-003': { name: 'Корпус оптико-электронного блока', assembly: 'Узел БОЭ-14' },
  'ITEM-004': { name: 'Заготовка фланца гермовывода (Литьё АЛ9)', assembly: 'Узел гермовывода', material: 'АЛ9 · литая заготовка' },
  'ITEM-005': { name: 'Корпус датчика угловых скоростей', assembly: 'Блок измерения угловой скорости' },
  'ITEM-006': { name: 'Корпус датчика угловых скоростей', assembly: 'Блок измерения угловой скорости' },
  'ITEM-007': { name: 'Кронштейн гиростабилизатора', assembly: 'Гиростабилизатор', designation: '7К.0410-2101.002', material: 'Сплав 1201-Т1 ГОСТ 4784-97 (поковка / авиационный алюминий)', materialCertificate: 'Сертификат № 4812/2026-ВИЛС (входной контроль пройден)', cadFile: 'КР-007-СБ.m3d', cadRevision: '2.4' },
  'ITEM-008': { name: 'Кронштейн гиростабилизатора (серийный выпуск)', assembly: 'Гиростабилизатор' },
  'ITEM-013': { name: 'Панель приборного отсека (титановый сплав ВТ6)', assembly: 'Приборный отсек', material: 'ВТ6 · титановый сплав' },
  'ITEM-028': { name: 'Крышка теплообменного контура', assembly: 'Теплообменный контур' },
};
/** Presentation specification supplied for the demonstration; source item IDs are unchanged. */
export function productSpecification(id: string): ProductSpecification {
  const number = Number(id.replace('ITEM-', '')) || 1;
  const families = ['Корпус оптико-электронного блока', 'Корпус датчика угловых скоростей', 'Кронштейн гиростабилизатора', 'Крышка теплообменного контура'];
  return { name: families[(number-1)%families.length], assembly: 'Приборная сборка', designation: `7К.0410-2201.${String(number).padStart(3,'0')}`, material: 'Сплав 1201-Т1 · поковка', cadFile: `КР-${String(number).padStart(3,'0')}-СБ.m3d`, cadRevision: '2.4', ...specified[id] };
}
