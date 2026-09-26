# Прикладные модули

Запуск и описание продукта: [корневой README](../README.md). Рабочий сервер: [source/server](source/server/README.md).

- `source/src` — ролевой интерфейс и проекции предметной области.
- `source/server` — HTTPS API, PostgreSQL, очередь обмена и отдельное хранилище медиа.
- `contracts` — JSON Schema и единая политика ролей.
- `integration.mjs`, `erp-adapters.mjs`, `plant-integrations.mjs`, `mobileops.mjs` — протокольные клиенты и адаптеры хранения.
- `security.mjs`, `security-crypto.mjs`, `operations.mjs` — совместимые файловые реализации, необходимые регрессионным тестам адаптеров; Docker API использует серверные модули PostgreSQL.
- `licenses` — лицензии распространяемых компонентов.

Сборки, Node.js, архивы и журналы исполнения не хранятся в исходниках. Контейнер собирается из корневого Dockerfile.
