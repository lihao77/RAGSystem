# LLM 线级抓取（wire capture）

开发基础设施：在 agent-llm 的线层 fetch 边界记录**发送的请求与收到的原始响应**（未经任何解析的 wire 数据）。用于 provider usage/缓存字段口径排障（例如网关 usage 字段名与标准协议不一致）、线协议形状对比、SSE 事件序列检查。

实现位于 `packages/agent-llm/src/wire-capture.ts`，经 `transport.ts` 的 `resolveSdkFetch` 挂入全部四个方言（openai-chat / openai-responses / anthropic / gemini——线级传输统一走 `providers/wire.ts` 的 fetch 注入口）。

## 开启方式

环境变量（默认关闭，关闭时零开销）：

```bash
# 用默认目录 <进程 cwd>/llm-wire-logs
RAGSYSTEM_LLM_WIRE_CAPTURE=1

# 或直接指定目录
RAGSYSTEM_LLM_WIRE_CAPTURE=D:/test/llm-wire

# 可选：只抓指定 provider（逗号分隔 provider key，缺省全抓）
RAGSYSTEM_LLM_WIRE_CAPTURE_PROVIDERS=pqy_zhipuai,ds_deepseek
```

Windows 本地起服务（start_server.bat）时，在 bat 里 `set RAGSYSTEM_LLM_WIRE_CAPTURE=1` 后重启即可；跑完建议关掉（请求体含用户对话内容，落盘无自动清理）。

程序化配置（host 启动期，优先于环境变量）：

```ts
import { configureWireCapture } from "@ragsystem/agent-llm";
configureWireCapture({ dir: "D:/test/llm-wire", providers: ["pqy_zhipuai"] });
```

## 产物格式

目录下按天一个 `wire-YYYY-MM-DD.jsonl`，每次 HTTP 交换两行，以 `id` 配对：

- `{ kind: "request", id, ts, provider, method, url, headers, body }` —— 请求即写（崩溃也留痕）
- `{ kind: "response", id, ts, provider, status, headers, stream, body, interrupted? }` —— 流式响应经 `body.tee()` 旁路收集，SDK 消费完后补写完整原始文本

敏感头（authorization / x-api-key / api-key / token / cookie）的值脱敏为 `<redacted:sha256前8位>`；请求体不脱敏。

## 查看器

```bash
npm run llm:wire-report                                # 最近 20 条交换概览（含 wire usage）
npm run llm:wire-report -- --usage-shapes              # 按 provider 汇总 usage 字段形状（排障首选）
npm run llm:wire-report -- --provider pqy_zhipuai      # 过滤 provider
npm run llm:wire-report -- --raw <id前缀>              # 打印某次交换的完整原始记录
npm run llm:wire-report -- --dir D:/test/llm-wire      # 指定目录
```

`--usage-shapes` 直接回答"这家网关的 usage 里输入 token 字段叫什么、缓存字段有没有报"——例如排查 glm 网关 `token_in=0` 时，先抓一次会话再看 shapes，若 wire 上根本没有 `input_tokens` 而是别的字段名，把该字段补进 `packages/agent-llm/src/internal/usage.ts` 的对应提取器即可。

## 回放与夹具（capture → 回归）

抓到的真实会话可以零加工变成测试回归：

```bash
node packages/agent-llm/test/helpers/wire-replay.mjs llm-wire-logs/wire-2026-09-09.jsonl --list          # 列出交换（id/provider/URL/状态）
node packages/agent-llm/test/helpers/wire-replay.mjs llm-wire-logs/wire-2026-09-09.jsonl --export <id>   # 导出可提交的自包含夹具
```

测试内 `readWireCapture` + `replayFetch(exchanges)` stub `globalThis.fetch` 即按 method+path 匹配回放（自证用例见 `packages/agent-llm/test/wire-replay.test.mjs`：经真实抓取链路录制后回放，两次解析结果一致）。夹具中鉴权头保持脱敏形态，可安全入库。

## 特性与边界

- 抓取路径上的任何错误（目录不可写、流收集失败等）静默吞掉并向 stderr 记一次告警，绝不影响真实请求。
- 单次响应收集上限 64MB，超出截断并标记 `interrupted: true`。
- 同文件追加经进程内队列串行化，JSONL 行不交错；多进程写同一目录时按天分文件，行级追加安全。
- 与 ipc_socket 组网传输正交组合，互不干扰。
