FROM node:22.5-bookworm-slim

# ripgrep：沙箱 glob/grep 工具的搜索引擎（helper.mjs spawn /usr/bin/rg）
RUN apt-get update \
    && apt-get install -y --no-install-recommends bash coreutils python3 ripgrep \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd --gid 10001 sandbox \
    && useradd --uid 10001 --gid 10001 --home-dir /work --shell /bin/bash sandbox \
    && mkdir -p /opt/ragsystem /input/uploads /work \
    && chown -R 10001:10001 /work

COPY helper.mjs runner.mjs /opt/ragsystem/

USER 10001:10001
WORKDIR /work
CMD ["sleep", "infinity"]
