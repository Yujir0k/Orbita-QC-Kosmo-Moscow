# Разработка ОРБИТА.QC

Полный запуск описан в [корневом README](../../README.md), серверные соглашения — в [server/README.md](server/README.md).

Для разработки используются Node.js 24.14+ и pnpm 11.25:

```sh
pnpm install --frozen-lockfile
pnpm contracts:check
pnpm test
pnpm build
pnpm build:server
pnpm test:crypto
```

`pnpm dev` требует доступного HTTPS API и настройки доверенного CA через `NODE_EXTRA_CA_CERTS` и `ORBITA_DEV_API_URL`. Основной проверяемый путь разработки — пересборка Docker: интерфейс использует реальные серверные данные. Команды PostgreSQL-тестов и smoke-проверки приведены в `docs/verification.md` в корне.

При изменении контрактов выполните `pnpm contracts:generate`. Исходная политика прав находится в `../contracts/workflow-policy.json`; сгенерированные типы не редактируются вручную.
