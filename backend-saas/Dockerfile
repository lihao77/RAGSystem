FROM node:22.5-bookworm-slim AS build

WORKDIR /app
COPY . .
RUN npm ci \
    && npm run build:backend \
    && npm prune --omit=dev

FROM node:22.5-bookworm-slim AS runtime

ENV NODE_ENV=production
WORKDIR /app

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/packages ./packages
COPY --from=build /app/backend-core/package.json ./backend-core/package.json
COPY --from=build /app/backend-core/dist ./backend-core/dist
COPY --from=build /app/plugins ./plugins
COPY --from=build /app/backend-saas/package.json ./backend-saas/package.json
COPY --from=build /app/backend-saas/dist ./backend-saas/dist

WORKDIR /app/backend-saas
USER root
RUN mkdir -p /data && chown node:node /data
USER node
EXPOSE 5002
HEALTHCHECK --interval=10s --timeout=3s --start-period=10s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:5002/readyz').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"]
CMD ["node", "dist/main.js"]
