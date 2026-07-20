import type { RuntimeStorage } from "../../../../contracts/storage/runtime-storage.js";
import type { SuspendedSessionControlPort } from "../../../../contracts/runtime/runtime-async-ports.js";

export type AsyncSuspendedSessionControl = SuspendedSessionControlPort;

/** Compatibility adapter over the shared atomic RuntimeStorage session interruption. */
export class SaaSSessionControlApplication implements AsyncSuspendedSessionControl {
  constructor(private readonly storage: RuntimeStorage) {}

  async interruptSuspendedSession(sessionId: string): Promise<Array<{ runId: string; parentRunId: string | null }>> {
    const result = await this.storage.operations.interruptSession({
      sessionId,
      buildRunEndedRecord: (run) => ({
        outbox: {
          sessionId,
          runId: run.runId,
          eventId: `${run.runId}:session-stop:run_ended`,
          eventType: "client.run_ended",
          aggregateType: "run",
          aggregateId: run.runId,
          payload: {
            client_event: {
              type: "run_ended",
              session_id: sessionId,
              run_id: run.runId,
              payload: { status: "interrupted" },
            },
          },
        },
      }),
    });
    return result.interruptedRuns;
  }
}
