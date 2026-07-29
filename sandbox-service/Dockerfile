FROM node:22.5-bookworm-slim AS build
WORKDIR /app/sandbox-service
COPY sandbox-service/package.json ./package.json
RUN npm install --ignore-scripts --no-package-lock
COPY sandbox-service/tsconfig.json ./tsconfig.json
COPY sandbox-service/src ./src
RUN npm run build

FROM node:22.5-bookworm-slim
ENV NODE_ENV=production
WORKDIR /app/sandbox-service
ARG DOCKER_CLI_VERSION=29.2.0
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl \
    && curl --fail --location --silent --show-error --retry 5 --retry-all-errors --connect-timeout 30 \
      "https://download.docker.com/linux/static/stable/x86_64/docker-${DOCKER_CLI_VERSION}.tgz" \
      | tar -xz -C /usr/local/bin --strip-components=1 docker/docker \
    && chmod 0755 /usr/local/bin/docker \
    && rm -rf /var/lib/apt/lists/*
COPY --from=build /app/sandbox-service/package.json ./package.json
COPY --from=build /app/sandbox-service/dist ./dist
USER root
EXPOSE 5003
HEALTHCHECK --interval=10s --timeout=3s --start-period=10s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:5003/readyz').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"]
CMD ["node", "dist/main.js"]
