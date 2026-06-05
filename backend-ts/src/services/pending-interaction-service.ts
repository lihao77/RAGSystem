import { randomUUID } from "node:crypto";

import type { ClientEvent } from "../contracts/events.js";
import type { UserInputRequest } from "../contracts/execution.js";
import type { InMemoryEventBus } from "./event-bus.js";

export interface PendingUserInputRequest {
  sessionId: string;
  runId?: string | null | undefined;
  taskId?: string | null | undefined;
  requestId?: string | null | undefined;
  toolCallId?: string | null | undefined;
  agentName?: string | null | undefined;
  prompt: string;
  inputType?: string | null | undefined;
  options?: string[] | undefined;
  extra?: Record<string, unknown> | undefined;
  signal?: AbortSignal | undefined;
}

export interface PendingUserInputResolution {
  inputId: string;
  value: string;
  respondedAt: string;
}

interface PendingInputEntry {
  sessionId: string;
  inputId: string;
  abortListener?: (() => void) | undefined;
  resolve(value: PendingUserInputResolution): void;
  reject(error: Error): void;
}

export class PendingInteractionService {
  private readonly pendingInputs = new Map<string, PendingInputEntry>();

  constructor(private readonly events: InMemoryEventBus) {}

  waitForUserInput(input: PendingUserInputRequest): Promise<PendingUserInputResolution> {
    const sessionId = input.sessionId.trim();
    if (!sessionId) {
      return Promise.reject(new Error("request_user_input 缺少 session_id"));
    }
    if (input.signal?.aborted) {
      return Promise.reject(new Error("request_user_input cancelled"));
    }

    const inputId = randomUUID();
    const prompt = input.prompt.trim();
    const inputType = normalizeInputType(input.inputType);
    const options = input.options ?? [];
    const extra = input.extra ?? {};

    const promise = new Promise<PendingUserInputResolution>((resolve, reject) => {
      const entry: PendingInputEntry = {
        sessionId,
        inputId,
        resolve,
        reject,
      };
      if (input.signal) {
        const onAbort = (): void => {
          this.pendingInputs.delete(inputId);
          reject(new Error("request_user_input cancelled"));
        };
        input.signal.addEventListener("abort", onAbort, { once: true });
        entry.abortListener = () => input.signal?.removeEventListener("abort", onAbort);
      }
      this.pendingInputs.set(inputId, entry);
    });

    const payload = {
      input_id: inputId,
      tool_call_id: input.toolCallId ?? null,
      tool_name: "request_user_input",
      agent_name: input.agentName ?? null,
      prompt,
      input_type: inputType,
      options,
      extra,
      run_id: input.runId ?? null,
      task_id: input.taskId ?? null,
      request_id: input.requestId ?? null,
    };
    const event: ClientEvent = {
      type: "user.input_required",
      session_id: sessionId,
      data: payload,
      content: payload,
    };
    if (input.runId) {
      event.run_id = input.runId;
    }
    this.events.publish(sessionId, event);

    return promise;
  }

  respondUserInput(sessionId: string, inputId: string, payload: UserInputRequest): boolean {
    const entry = this.pendingInputs.get(inputId);
    if (!entry || entry.sessionId !== sessionId) {
      return false;
    }
    this.pendingInputs.delete(inputId);
    entry.abortListener?.();
    entry.resolve({
      inputId,
      value: payload.value ?? "",
      respondedAt: new Date().toISOString(),
    });
    return true;
  }

  cancelSession(sessionId: string, reason = "request_user_input cancelled"): void {
    for (const [inputId, entry] of this.pendingInputs.entries()) {
      if (entry.sessionId !== sessionId) {
        continue;
      }
      this.pendingInputs.delete(inputId);
      entry.abortListener?.();
      entry.reject(new Error(reason));
    }
  }

  isUserInputPending(sessionId: string, inputId: string): boolean {
    const entry = this.pendingInputs.get(inputId);
    return Boolean(entry && entry.sessionId === sessionId);
  }
}

function normalizeInputType(value: string | null | undefined): string {
  const normalized = value?.trim();
  return normalized === "select" ? "select" : "text";
}
