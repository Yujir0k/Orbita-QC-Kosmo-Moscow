FROM node:24.14.0-bookworm-slim AS build
WORKDIR /app/source
RUN corepack enable && corepack prepare pnpm@11.25.0 --activate
COPY app/source/package.json app/source/pnpm-lock.yaml app/source/pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile
COPY app/source/ ./
COPY app/*.mjs /app/
COPY app/contracts/ /app/contracts/
RUN pnpm build && node scripts/build-domain.mjs && pnpm prune --prod

FROM node:24.14.0-bookworm-slim AS api
ENV NODE_ENV=production
WORKDIR /app/source
COPY --from=build /app/*.mjs /app/
COPY --from=build /app/contracts/ /app/contracts/
COPY --from=build /app/source/node_modules/ ./node_modules/
COPY --from=build /app/source/package.json ./package.json
COPY --from=build /app/source/server/ ./server/
COPY --from=build /app/source/scripts/ ./scripts/
COPY --from=build /app/source/src/demo-data.json ./src/demo-data.json
COPY --from=build /app/source/integration-fixtures/ ./integration-fixtures/
COPY --from=build /app/source/public/media/ ./public/media/
USER node
EXPOSE 8443
CMD ["node", "server/app.mjs"]

FROM nginx:1.28-alpine AS web
COPY --from=build /app/source/dist/ /usr/share/nginx/html/
RUN rm -rf /usr/share/nginx/html/media /usr/share/nginx/html/demo
COPY deployment/nginx.conf /etc/nginx/nginx.conf
EXPOSE 8443
