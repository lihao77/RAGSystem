FROM node:24-bookworm-slim AS build

WORKDIR /app
COPY . .
RUN npm ci \
    && npm -w @ragsystem/agent-protocol run build \
    && npm -w @ragsystem/agent-llm run build \
    && npm -w @ragsystem/agent-sdk run build \
    && npm -w @ragsystem/backend-ts run build \
    && npm prune --omit=dev \
    && mkdir -p backend-ts/node_modules

FROM node:24-bookworm-slim AS runtime

ENV NODE_ENV=production
WORKDIR /app

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/packages/agent-protocol/package.json ./packages/agent-protocol/package.json
COPY --from=build /app/packages/agent-protocol/dist ./packages/agent-protocol/dist
COPY --from=build /app/packages/agent-llm/package.json ./packages/agent-llm/package.json
COPY --from=build /app/packages/agent-llm/dist ./packages/agent-llm/dist
COPY --from=build /app/packages/agent-sdk/package.json ./packages/agent-sdk/package.json
COPY --from=build /app/packages/agent-sdk/dist ./packages/agent-sdk/dist
COPY --from=build /app/backend-ts/package.json ./backend-ts/package.json
COPY --from=build /app/backend-ts/dist ./backend-ts/dist
COPY --from=build /app/backend-ts/skills ./backend-ts/skills
COPY --from=build /app/backend-ts/node_modules ./backend-ts/node_modules

WORKDIR /app/backend-ts
USER root
RUN mkdir -p /data && chown node:node /data
USER node
EXPOSE 5002
HEALTHCHECK --interval=10s --timeout=3s --start-period=10s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:5002/readyz').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"]
CMD ["node", "dist/main.js"]
