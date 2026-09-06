// TC04 基准测试驱动：N 轮 × 并发，team "1" + selected_llm 覆盖模型，走本地后端 HTTP API。
// 用法：node scripts/tc04-benchmark.mjs [--rounds 12] [--concurrency 3]
// 产物：C:/Users/qingy/Desktop/test/TC04-results/run-<时间戳>/ 下每轮 JSON + 图片 + 汇总表。

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const BASE = process.env.RAG_BASE ?? "http://127.0.0.1:5003/api/agent";
const TEAM_NAME = process.env.TC04_TEAM ?? "1";
const PERMISSION_MODE = "dangerously_skip_permissions";
const SELECTED_LLM = process.env.TC04_SELECTED_LLM ?? "ali|alibaba|deepseek-v4-flash";
const THINKING_LEVEL = "high";
const PROMPT =
  "基于所有海温散点进行反距离权重插值，值从小到大对应颜色从#9CE3FF到#EB99FF,并使用country.gpkg作为陆地掩膜,最终生成一张海温分布专题图";
const DATA_ROOT = process.env.TC04_DATA_ROOT ?? "C:/Users/qingy/Desktop/test/TC04";
const DATA_FILES = [
  `${DATA_ROOT}/country.gpkg`,
  `${DATA_ROOT}/temperature_points.gpkg`,
];
const OUT_ROOT = process.env.TC04_OUT_ROOT ?? "C:/Users/qingy/Desktop/test/TC04-results";
const POLL_INTERVAL_MS = 5000;
const ROUND_TIMEOUT_MS = 40 * 60 * 1000;

const args = process.argv.slice(2);
function argValue(name, fallback) {
  const i = args.indexOf(`--${name}`);
  if (i < 0 || args[i + 1] === undefined) return fallback;
  const value = Number(args[i + 1]);
  if (!Number.isInteger(value) || value < 1) {
    console.error(`--${name} 需要正整数，收到: ${args[i + 1]}`);
    process.exit(1);
  }
  return value;
}
const ROUNDS = argValue("rounds", 12);
const CONCURRENCY = argValue("concurrency", 3);

const RUN_ID = `run-${new Date().toISOString().replace(/[:T]/g, "-").slice(0, 17)}`;
const OUT_DIR = join(OUT_ROOT, RUN_ID);
mkdirSync(OUT_DIR, { recursive: true });

function ts() {
  return new Date().toLocaleTimeString("zh-CN", { hour12: false });
}
function log(msg) {
  console.log(`[${ts()}] ${msg}`);
}

async function api(path, { method = "GET", body, formData, raw = false } = {}) {
  const headers = {};
  let payload;
  if (formData) {
    payload = formData;
  } else if (body !== undefined) {
    headers["content-type"] = "application/json";
    payload = JSON.stringify(body);
  }
  const res = await fetch(`${BASE}${path}`, { method, headers, body: payload });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`${method} ${path} -> ${res.status}: ${text.slice(0, 500)}`);
  }
  return raw ? res : res.json();
}

function pickFiles(body) {
  return body?.files ?? body?.data?.files ?? [];
}

function extractText(message) {
  const parts = message?.content_parts ?? [];
  const texts = parts
    .filter((p) => p && p.type === "text" && typeof p.text === "string")
    .map((p) => p.text)
    .filter((t) => t.length > 0);
  if (texts.length) return texts.join("\n");
  if (typeof message?.content === "string") return message.content;
  return "";
}

function extractFileRefs(messages) {
  const refs = [];
  for (const m of messages) {
    for (const p of m?.content_parts ?? []) {
      if (p.type === "file_ref" && p.file_path) refs.push(p.file_path);
    }
  }
  return refs;
}

const IMAGE_REF_RE = /[\w./\\-]+\.(?:png|jpe?g|webp|gif|tiff?|svg|bmp)/gi;
function extractImageRefs(text) {
  if (!text) return [];
  const refs = new Set();
  for (const m of text.matchAll(IMAGE_REF_RE)) {
    let p = m[0].replace(/\\/g, "/");
    p = p.replace(/^\.\//, "");
    // 只保留相对工作区的最末两段，降低正则误抓
    const segs = p.split("/");
    if (segs.length > 2) p = segs.slice(-2).join("/");
    refs.add(p);
  }
  return [...refs];
}

async function downloadWorkspaceFile(sessionId, relPath, savePath) {
  try {
    const res = await api(
      `/sessions/${sessionId}/workspace-files/content?path=${encodeURIComponent(relPath)}`,
      { raw: true },
    );
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length === 0) return null;
    mkdirSync(dirname(savePath), { recursive: true });
    writeFileSync(savePath, buf);
    return { name: relPath, size: buf.length };
  } catch {
    return null;
  }
}

async function runRound(n) {
  const roundDir = join(OUT_DIR, `round-${String(n).padStart(2, "0")}`);
  const record = {
    round: n,
    team_name: TEAM_NAME,
    selected_llm: SELECTED_LLM,
    thinking_level: THINKING_LEVEL,
    prompt: PROMPT,
    started_at: new Date().toISOString(),
    status: "error",
    error: null,
    auto_approvals: 0,
    model_verified: null,
    images: [],
  };
  let sessionId = null;
  try {
    // 1. 建会话（干净工作区）
    const created = await api("/sessions", {
      method: "POST",
      body: { team_name: TEAM_NAME, permission_mode: PERMISSION_MODE },
    });
    const data = created?.data ?? created;
    sessionId = data?.session_id ?? data?.id ?? data?.session?.session_id;
    if (!sessionId) throw new Error(`createSession 响应缺 session_id: ${JSON.stringify(created).slice(0, 300)}`);
    record.session_id = sessionId;
    log(`R${n} 会话已建: ${sessionId}`);

    // 2. 验证 selected_llm 解析到目标模型
    const snap = await api(
      `/context-snapshot?session_id=${sessionId}&selected_llm=${encodeURIComponent(SELECTED_LLM)}`,
    );
    const cfg = snap?.data?.config ?? snap?.config ?? {};
    record.model_verified = cfg.model ?? null;
    if (record.model_verified !== "deepseek-v4-flash") {
      throw new Error(`模型解析异常: context-snapshot 返回 "${record.model_verified}"，期望 deepseek-v4-flash`);
    }
    log(`R${n} 模型验证通过: ${cfg.model}`);

    // 3. 上传数据文件
    const fd = new FormData();
    for (const file of DATA_FILES) {
      fd.append("files", new Blob([readFileSync(file)]), file.split("/").pop());
    }
    const uploaded = await api(`/sessions/${sessionId}/files/upload`, { method: "POST", formData: fd });
    const files = pickFiles(uploaded);
    const fileIds = files.map((f) => f.file_id ?? f.id).filter(Boolean);
    if (fileIds.length !== DATA_FILES.length) {
      throw new Error(`上传返回 ${fileIds.length} 个 file_id: ${JSON.stringify(uploaded).slice(0, 300)}`);
    }
    log(`R${n} 文件已上传: ${files.map((f) => f.original_name ?? f.file_id).join(", ")}`);

    // 4. 启动执行
    const started = await api("/stream", {
      method: "POST",
      body: {
        task: PROMPT,
        session_id: sessionId,
        selected_llm: SELECTED_LLM,
        thinking_level: THINKING_LEVEL,
        attachments: fileIds.map((file_id) => ({ file_id })),
      },
    });
    const startData = started?.data ?? started;
    const runId = startData?.run_id ?? null;
    if (!startData?.started) throw new Error(`startStream 未启动: ${JSON.stringify(started).slice(0, 300)}`);
    record.run_id = runId;
    log(`R${n} 执行已启动 (run ${runId ?? "?"})`);

    // 5. 轮询直到终态
    const deadline = Date.now() + ROUND_TIMEOUT_MS;
    let sawActive = false;
    let idleTicks = 0;
    let lastState = "";
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
      const rt = await api(`/sessions/${sessionId}/runtime`);
      const r = rt?.data ?? rt;
      const state = r?.state ?? "unknown";
      if (state !== lastState) {
        log(`R${n} 状态: ${state}`);
        lastState = state;
      }
      if (state === "running" || state === "waiting_interaction" || state === "resuming") sawActive = true;

      // 意外交互自动放行（yolo 下理论上不会出现）
      const pendings = r?.pending_interactions ?? [];
      for (const p of pendings) {
        try {
          if (p.kind === "user_input") {
            await api(`/sessions/${sessionId}/interactions/${p.interaction_id}/respond`, {
              method: "POST",
              body: { kind: "user_input", value: "" },
            });
            log(`R${n} 自动回应 user_input ${p.interaction_id}`);
          } else {
            await api(`/sessions/${sessionId}/interactions/${p.interaction_id}/respond`, {
              method: "POST",
              body: { kind: "approval", approved: true, message: "benchmark auto-approve" },
            });
            record.auto_approvals += 1;
            log(`R${n} 自动批准 ${p.interaction_id}`);
          }
        } catch (err) {
          log(`R${n} 交互响应失败: ${err.message}`);
        }
      }

      const lastRunId = r?.last_run?.run_id ?? null;
      const terminalByRun = runId && lastRunId === runId;
      if (state === "idle") {
        if (terminalByRun || sawActive) {
          idleTicks += 1;
          if (idleTicks >= 2) break; // 连续两拍 idle 才算结束，防启动间隙误判
        }
      } else {
        idleTicks = 0;
      }
    }
    if (Date.now() >= deadline) {
      record.status = "timeout";
      try {
        await api("/stream/stop", { method: "POST", body: { session_id: sessionId } });
      } catch {}
      throw new Error(`单轮超时 (${Math.round(ROUND_TIMEOUT_MS / 60000)} 分钟)，已停止`);
    }

    // 6. 收最终回答
    const msgs = await api(`/sessions/${sessionId}/messages?limit=1000&offset=0`);
    const list = msgs?.data?.items ?? msgs?.data?.messages ?? msgs?.messages ?? [];
    record.message_count = list.length;
    const assistantMsgs = list.filter((m) => (m.role ?? m.participant_role) === "assistant");
    const lastAssistant = assistantMsgs[assistantMsgs.length - 1] ?? null;
    record.final_answer = extractText(lastAssistant);
    record.last_run_status = (await api(`/sessions/${sessionId}/runtime`))?.data?.last_run?.status ?? null;

    // 7. 收产出图片（file_ref 优先，文本路径兜底）
    const allText = assistantMsgs.map(extractText).join("\n");
    const refs = [...new Set([...extractFileRefs(assistantMsgs), ...extractImageRefs(allText)])];
    const savedImages = [];
    for (const ref of refs.slice(0, 8)) {
      const hit = await downloadWorkspaceFile(sessionId, ref, join(roundDir, ref.split("/").pop()));
      if (hit) savedImages.push(hit);
    }
    record.images = savedImages;
    record.status = "completed";
    log(
      `R${n} 完成: ${record.last_run_status}，消息 ${list.length} 条，图片 ${savedImages.length} 张，` +
        `回答 ${record.final_answer.length} 字`,
    );
  } catch (err) {
    record.error = err.message;
    log(`R${n} 失败: ${err.message}`);
  }
  record.ended_at = new Date().toISOString();
  record.duration_s = Math.round((new Date(record.ended_at) - new Date(record.started_at)) / 1000);
  mkdirSync(roundDir, { recursive: true });
  writeFileSync(join(roundDir, "record.json"), JSON.stringify(record, null, 2), "utf8");
  if (record.final_answer) {
    writeFileSync(join(roundDir, "final-answer.md"), record.final_answer, "utf8");
  }
  return record;
}

async function main() {
  log(`TC04 基准测试: ${ROUNDS} 轮 × 并发 ${CONCURRENCY}，team "${TEAM_NAME}"，模型 ${SELECTED_LLM}，思考 ${THINKING_LEVEL}`);
  log(`结果目录: ${OUT_DIR}`);
  const results = new Array(ROUNDS).fill(null);
  let next = 0;
  async function worker(w) {
    while (true) {
      const i = next++;
      if (i >= ROUNDS) return;
      log(`worker${w} 领取 R${i + 1}`);
      results[i] = await runRound(i + 1);
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, (_, w) => worker(w + 1)));

  // 汇总
  writeFileSync(join(OUT_DIR, "summary.json"), JSON.stringify(results, null, 2), "utf8");
  const lines = [
    `# TC04 基准测试汇总`,
    ``,
    `- 时间: ${new Date().toISOString()}`,
    `- 轮数: ${ROUNDS}，并发: ${CONCURRENCY}`,
    `- Team: ${TEAM_NAME}，模型: ${SELECTED_LLM}，思考档位: ${THINKING_LEVEL}，审批: ${PERMISSION_MODE}`,
    `- 提示词: ${PROMPT}`,
    ``,
    `| 轮次 | 状态 | run 终态 | 耗时(分) | 图片数 | 自动批准 | 会话 |`,
    `| --- | --- | --- | --- | --- | --- | --- |`,
  ];
  for (const r of results) {
    if (!r) continue;
    lines.push(
      `| R${r.round} | ${r.status}${r.error ? ` (${r.error.slice(0, 60)})` : ""} | ${r.last_run_status ?? "-"} | ` +
        `${(r.duration_s / 60).toFixed(1)} | ${r.images.length} | ${r.auto_approvals} | ${r.session_id ?? "-"} |`,
    );
  }
  writeFileSync(join(OUT_DIR, "summary.md"), lines.join("\n"), "utf8");
  log("全部轮次结束，汇总已写入 summary.md");
  const ok = results.filter((r) => r?.status === "completed").length;
  log(`完成 ${ok}/${ROUNDS}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
