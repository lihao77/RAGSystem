FROM node:24-bookworm-slim AS build

WORKDIR /app
COPY . .
RUN npm ci \
    && npm run build:contracts \
    && npm -w @ragsystem/agent-llm run build \
    && npm -w @ragsystem/agent-sdk run build \
    && npm -w @ragsystem/backend-core run build \
    && npm -w @ragsystem/backend-local run build \
    && npm prune --omit=dev \
    && node -e "import('sqlite-vec').then(({ getLoadablePath }) => getLoadablePath())"

FROM node:24-bookworm-slim AS runtime

ENV NODE_ENV=production
WORKDIR /app

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/packages ./packages
COPY --from=build /app/backend-core/package.json ./backend-core/package.json
COPY --from=build /app/backend-core/dist ./backend-core/dist
COPY --from=build /app/backend-core/skills ./backend-core/skills
COPY --from=build /app/plugins/backend-plugin-artifacts/package.json ./plugins/backend-plugin-artifacts/package.json
COPY --from=build /app/plugins/backend-plugin-artifacts/dist ./plugins/backend-plugin-artifacts/dist
COPY --from=build /app/backend-local/package.json ./backend-local/package.json
COPY --from=build /app/backend-local/dist ./backend-local/dist

WORKDIR /app/backend-local
USER root
RUN mkdir -p /data && chown node:node /data
USER node
EXPOSE 5002
HEALTHCHECK --interval=10s --timeout=3s --start-period=10s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:5002/readyz').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"]
CMD ["node", "dist/main.js"]
