import type dataset from './demo-data.json';
const runtime = window as unknown as { __ORBITA_DATASET__: typeof dataset };
if (!runtime.__ORBITA_DATASET__) throw new Error('Данные не загружены с сервера');
export default runtime.__ORBITA_DATASET__;
