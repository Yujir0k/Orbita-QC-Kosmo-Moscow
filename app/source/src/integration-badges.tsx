import { useEffect, useState } from 'react';
import manifest from './integrity-manifest.json';
import { sourceDeliveries, contextDeliveries, seedDecisions, items } from './domain';
import { Badge } from './ui';
export function IntegrationBadges({ item }: { item: string }) {
  const [audit, setAudit] = useState('Проверка SHA-256…');
  useEffect(() => {
    let active=true;
    const rows=[...sourceDeliveries,...contextDeliveries,...seedDecisions].filter(row=>row.message.item_id===item);
    const verify=async()=>{
      try {
        const hashes=manifest as Record<string,string>;
        const checked=await Promise.all(rows.map(async row=>{
          const digest=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify(row.message)));
          return [...new Uint8Array(digest)].map(n=>n.toString(16).padStart(2,'0')).join('')===hashes[row.delivery_id];
        }));
        if(active)setAudit(checked.length && checked.every(Boolean)?`SHA-256 Validated · ${checked.length} исходных сообщений`: 'SHA-256: несоответствие манифесту');
      }catch{if(active)setAudit('Проверка SHA-256 недоступна');}
    };void verify();return()=>{active=false;};
  },[item]);
  const workOrder = items.find(row => row.id === item)?.work_order_id ?? 'не указан';
  return <div className="tech-integration-badges"><span className="eyebrow">СВЯЗИ С ИСТОЧНИКАМИ</span><Badge tone="blue">КОМПАС-3D: {item==='ITEM-007'?'КР-007-СБ.m3d · спецификация ver 2.4':'структура сборки'}</Badge><Badge tone="blue">Заказ в общем наборе: {workOrder}</Badge><Badge tone={audit.startsWith('SHA-256 Validated')?'green':'amber'}>{audit}</Badge><small>Хеши проверены по встроенному манифесту учебного набора. Проверка целостности исходных сообщений; статус подключения ERP и CAD доступен в центре интеграций.</small></div>;
}
