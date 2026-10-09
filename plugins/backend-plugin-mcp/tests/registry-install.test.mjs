import assert from "node:assert/strict";
import test from "node:test";

import { buildServerConfigFromRegistryInstall } from "../dist/index.js";

const npmOption = {
  id: "pkg-0",
  kind: "package",
  supported: true,
  recipe: {
    registryType: "npm",
    identifier: "@example/fs-server",
    version: "1.2.3",
    transport: { type: "stdio" },
    packageArguments: [{ type: "positional", value: "/data" }],
    environmentVariables: [{ name: "MODE", value: "ro" }],
  },
  default_server_name: "fs_server",
};

const remoteOption = {
  id: "remote-0",
  kind: "remote",
  supported: true,
  recipe: {
    type: "streamable-http",
    url: "https://example.com/mcp",
    headers: [{ name: "Authorization", value: "Bearer a" }],
  },
  default_server_name: "remote_server",
};

test("package 安装:extra_args 追加在配方参数之后,extra_env 可覆盖同名变量", () => {
  const config = buildServerConfigFromRegistryInstall({
    install_option: npmOption,
    server_name: "fs",
    extra_args: ["/extra-dir", "--verbose", "  "],
    extra_env: { API_KEY: "secret", MODE: "rw" },
  });
  assert.equal(config.command, "npx");
  assert.deepEqual(config.args, ["-y", "@example/fs-server@1.2.3", "/data", "/extra-dir", "--verbose"]);
  assert.deepEqual(config.env, { MODE: "rw", API_KEY: "secret" });
});

test("package 安装:不带 extra 时保持配方解析结果不变", () => {
  const config = buildServerConfigFromRegistryInstall({ install_option: npmOption, server_name: "fs" });
  assert.deepEqual(config.args, ["-y", "@example/fs-server@1.2.3", "/data"]);
  assert.deepEqual(config.env, { MODE: "ro" });
});

test("remote 安装:extra_headers 合并,extra_args/extra_env 对远程服务不生效", () => {
  const config = buildServerConfigFromRegistryInstall({
    install_option: remoteOption,
    server_name: "remote",
    extra_headers: { "X-Team": "core" },
    extra_args: ["--ignored"],
    extra_env: { IGNORED: "x" },
  });
  assert.equal(config.transport, "streamable_http");
  assert.equal(config.url, "https://example.com/mcp");
  assert.deepEqual(config.headers, { Authorization: "Bearer a", "X-Team": "core" });
  assert.deepEqual(config.args, []);
  assert.deepEqual(config.env, {});
});

test("remote 安装:请求头按大小写不敏感覆盖,实际 Headers 不拼接旧认证值", () => {
  const config = buildServerConfigFromRegistryInstall({
    install_option: remoteOption,
    server_name: "remote",
    extra_headers: { authorization: "Bearer b", "X-Team": "one", "x-team": "two" },
  });
  assert.deepEqual(config.headers, { authorization: "Bearer b", "x-team": "two" });
  const headers = new Headers(config.headers);
  assert.equal(headers.get("Authorization"), "Bearer b");
  assert.equal(headers.get("X-Team"), "two");
});
