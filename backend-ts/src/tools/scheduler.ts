import { throwIfAborted } from "@ragsystem/agent-sdk-core";

const DEFAULT_MAX_TOOL_CONCURRENCY = 8;

export interface ToolSchedulerCall {
  index: number;
  arguments: Record<string, unknown>;
}

export interface ToolSchedulerExecutor<TCall extends ToolSchedulerCall, TResult> {
  classify(call: TCall): boolean;
  run(call: TCall): Promise<TResult>;
  signal?: AbortSignal | undefined;
  maxConcurrency?: number | undefined;
}

export async function runToolBatchWithScheduler<TCall extends ToolSchedulerCall, TResult>(
  calls: TCall[],
  executor: ToolSchedulerExecutor<TCall, TResult>,
): Promise<TResult[]> {
  const maxConcurrency = readMaxConcurrency(executor.maxConcurrency);
  const results: TResult[] = [];
  for (const group of partitionToolCalls(calls, executor.classify, maxConcurrency)) {
    throwIfAborted(executor.signal, "Agent run aborted");
    if (group.parallel) {
      results.push(...await Promise.all(group.calls.map((call) => executor.run(call))));
    } else {
      for (const call of group.calls) {
        results.push(await executor.run(call));
      }
    }
  }
  return results;
}

export function partitionToolCalls<TCall extends ToolSchedulerCall>(
  calls: TCall[],
  classify: (call: TCall) => boolean,
  maxConcurrency = DEFAULT_MAX_TOOL_CONCURRENCY,
): Array<{ parallel: boolean; calls: TCall[] }> {
  const groups: Array<{ parallel: boolean; calls: TCall[] }> = [];
  let parallelCalls: TCall[] = [];
  const flushParallel = (): void => {
    if (!parallelCalls.length) {
      return;
    }
    groups.push({ parallel: parallelCalls.length > 1, calls: parallelCalls });
    parallelCalls = [];
  };
  for (const call of calls) {
    if (classify(call)) {
      parallelCalls.push(call);
      if (parallelCalls.length >= maxConcurrency) {
        flushParallel();
      }
      continue;
    }
    flushParallel();
    groups.push({ parallel: false, calls: [call] });
  }
  flushParallel();
  return groups;
}

function readMaxConcurrency(value: number | undefined): number {
  const fromEnv = Number(process.env.RUNTIME_MAX_TOOL_CONCURRENCY ?? "");
  const raw = typeof value === "number" && Number.isInteger(value)
    ? value
    : Number.isInteger(fromEnv)
      ? fromEnv
      : DEFAULT_MAX_TOOL_CONCURRENCY;
  if (raw < 1) {
    return DEFAULT_MAX_TOOL_CONCURRENCY;
  }
  return Math.max(1, Math.min(raw, 64));
}
