// TC04 结果收割：对已跑完的会话重新收集最终回答与产出图片（修复 items/file_ref 解析）。
// 用法：node scripts/tc04-collect.mjs <benchmark结果目录>
// 读取目录下 round-*/record.json 的 session_id，重新拉取消息与产物，覆盖写入。

import { readFileSync, writeFileSync, mkdirSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";

const BASE = process.env.RAG_BASE ?? "http://127.0.0.1:5003/api/agent";

const rootDir = process.argv[2];
if (!rootDir) {
  console.error("用法: node scripts/tc04-collect.mjs <benchmark结果目录>");
  process.exit(1);
}

async function api(path, { raw = false } = {}) {
  const res = await fetch(`${BASE}${path}`);
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`GET ${path} -> ${res.status}: ${text.slice(0, 300)}`);
  }
  return raw ? res : res.json();
}

function textOf(message) {
  return (message?.content_parts ?? [])
    .filter((p) => p.type === "text" && typeof p.text === "string")
    .map((p) => p.text)
    .join("\n");
}

function fileRefs(messages) {
  const refs = [];
  for (const m of messages) {
    for (const p of m?.content_parts ?? []) {
      if (p.type === "file_ref" && p.file_path) refs.push({ file_path: p.file_path, caption: p.caption ?? "" });
    }
  }
  return refs;
}

const IMAGE_RE = /[\w./\\-]+\.(?:png|jpe?g|webp|gif|tiff?|svg|bmp)/gi;
function textImageRefs(text) {
  const out = new Set();
  for (const m of (text ?? "").matchAll(IMAGE_RE)) {
    let p = m[0].replace(/\\/g, "/").replace(/^\.\//, "");
    const segs = p.split("/");
    if (segs.length > 2) p = segs.slice(-2).join("/");
    out.add(p);
  }
  return [...out];
}

async function main() {
  const roundDirs = readdirSync(rootDir)
    .filter((n) => n.startsWith("round-"))
    .sort();
  const results = [];
  for (const name of roundDirs) {
    const roundDir = join(rootDir, name);
    let record;
    try {
      record = JSON.parse(readFileSync(join(roundDir, "record.json"), "utf8"));
    } catch {
      console.log(`${name}: 无 record.json，跳过`);
      continue;
    }
    const sessionId = record.session_id;
    const n = record.round;
    if (!sessionId) {
      console.log(`${name}: 无 session_id，跳过`);
      continue;
    }
    try {
      const msgsBody = await api(`/sessions/${sessionId}/messages?limit=1000&offset=0`);
      const items = msgsBody?.data?.items ?? [];
      const assistants = items.filter((m) => m.role === "assistant");
      const last = assistants[assistants.length - 1] ?? null;
      record.final_answer = last ? textOf(last) : "";
      record.message_count = items.length;

      // 执行步骤（工具调用计数）；无 assistant 消息的轮次记空并继续收集图片/状态。
      record.tool_steps = null;
      record.step_count = null;
      if (last) {
        try {
          const exec = await api(
            `/sessions/${sessionId}/messages/${encodeURIComponent(last.id)}/execution`,
          );
          const execData = exec?.data ?? {};
          writeFileSync(join(roundDir, "execution.json"), JSON.stringify(execData, null, 2), "utf8");
          const steps = execData.steps ?? execData.items ?? [];
          record.tool_steps = steps.filter((s) => /tool/i.test(s.type ?? s.kind ?? "")).length;
          record.step_count = steps.length;
        } catch (err) {
          record.tool_steps = null;
          console.log(`R${n} 执行视图获取失败: ${err.message.slice(0, 120)}`);
        }
      }

      // 图片：file_ref 优先，兜底从文本抓路径
      const refs = fileRefs(assistants).map((r) => r.file_path);
      for (const extra of textImageRefs(assistants.map(textOf).join("\n"))) {
        if (!refs.includes(extra)) refs.push(extra);
      }
      const images = [];
      for (const ref of refs.slice(0, 8)) {
        try {
          const res = await api(`/sessions/${sessionId}/workspace-files/content?path=${encodeURIComponent(ref)}`, { raw: true });
          const buf = Buffer.from(await res.arrayBuffer());
          if (buf.length === 0) continue;
          const savePath = join(roundDir, ref.split("/").pop());
          mkdirSync(dirname(savePath), { recursive: true });
          writeFileSync(savePath, buf);
          images.push({ name: ref, size: buf.length });
          console.log(`R${n} 图片已存: ${ref} (${buf.length} bytes)`);
        } catch {
          console.log(`R${n} 图片拉取失败: ${ref}`);
        }
      }
      record.images = images;

      const rt = await api(`/sessions/${sessionId}/runtime`);
      record.last_run_status = rt?.data?.last_run?.status ?? null;
      record.run_started_at = rt?.data?.last_run?.started_at ?? null;
      record.run_finished_at = rt?.data?.last_run?.finished_at ?? null;

      // 保留原始 status（timeout/error 的失败语义不因有回答而丢失）；收割结果单独记。
      record.collect_status = record.final_answer ? "completed" : "empty_answer";
      writeFileSync(join(roundDir, "record.json"), JSON.stringify(record, null, 2), "utf8");
      if (record.final_answer) {
        writeFileSync(join(roundDir, "final-answer.md"), record.final_answer, "utf8");
      }
      console.log(
        `R${n}: ${record.status ?? "-"}/${record.collect_status}，消息 ${record.message_count}，工具步 ${record.tool_steps ?? "?"}，图片 ${images.length}`,
      );
    } catch (err) {
      record.collect_error = err.message;
      console.log(`R${n} 收集失败: ${err.message}`);
    }
    results.push(record);
  }

  writeFileSync(join(rootDir, "summary.json"), JSON.stringify(results, null, 2), "utf8");
  const lines = [
    `# TC04 基准测试汇总（重收）`,
    ``,
    `- 模型: ali|alibaba|deepseek-v4-flash（非 0731），思考档位: high，审批: yolo`,
    `- 提示词: ${results[0]?.prompt ?? ""}`,
    ``,
    `| 轮次 | run 终态 | 耗时(秒) | 消息数 | 工具步 | 图片 | 会话 |`,
    `| --- | --- | --- | --- | --- | --- | --- |`,
  ];
  for (const r of results) {
    const dur =
      r.run_started_at && r.run_finished_at
        ? Math.round((new Date(r.run_finished_at) - new Date(r.run_started_at)) / 1000)
        : r.duration_s ?? "?";
    lines.push(
      `| R${r.round} | ${r.last_run_status ?? "-"} | ${dur} | ${r.message_count ?? "-"} | ` +
        `${r.tool_steps ?? "-"} | ${(r.images ?? []).map((i) => i.name).join(", ") || "-"} | ${r.session_id} |`,
    );
  }
  writeFileSync(join(rootDir, "summary.md"), lines.join("\n"), "utf8");
  console.log(`汇总已写入 ${join(rootDir, "summary.md")}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
