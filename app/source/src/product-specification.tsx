import { productSpecification } from './product-catalog';
import { Badge } from './ui';
export function ProductSpecificationBlock({ item }: { item: string }) {
  const product = productSpecification(item);
  return <section className="product-specification"><div className="section-title"><h3>ЕСКД и документы качества</h3><Badge tone="blue">Цеховой контур №1</Badge></div><dl className="tech-detail-list"><div><dt>Обозначение по ЕСКД</dt><dd>{product.designation}</dd></div><div><dt>Материал / заготовка</dt><dd>{product.material}</dd></div><div><dt>Сертификат на материал</dt><dd>{product.materialCertificate ?? 'Документ не прикреплён к паспорту'}</dd></div><div><dt>Спецификация сборки</dt><dd>КОМПАС-3D: {product.cadFile} (ver. {product.cadRevision})</dd></div></dl></section>;
}
