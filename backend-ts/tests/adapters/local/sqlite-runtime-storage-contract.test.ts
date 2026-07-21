import { SqliteRuntimeStorage } from "../../../src/adapters/local/sqlite-runtime-storage.js";
import { createConversationStore } from "../../../src/adapters/local/sqlite/conversation-store/index.js";
import { LOCAL_TENANT_ID } from "../../../src/services/identity/index.js";
import { runRuntimeStorageBehaviorContract } from "../../contracts/runtime-storage-behavior-contract.js";

runRuntimeStorageBehaviorContract("SQLite", () => {
  const store = createConversationStore({ dbPath: ":memory:", dataRoot: process.cwd() });
  return {
    storage: new SqliteRuntimeStorage(LOCAL_TENANT_ID, store),
    peerStorage: new SqliteRuntimeStorage(LOCAL_TENANT_ID, store),
    inspection: {
      getSession: async (sessionId) => store.getSession(sessionId),
      getMessage: async (sessionId, messageId) => store.getMessageById(sessionId, messageId),
      listMessages: async (sessionId) => store.listMessages(sessionId, 100, 0).items,
      getRun: async (sessionId, runId) => store.getRun(sessionId, runId),
      listRuns: async (sessionId) => store.listRuns(sessionId, 100).items,
      listSteps: async (sessionId, runId) => store.listRunSteps({ sessionId, runId, limit: 100 }),
      listOutbox: async (sessionId) => store.listOutboxForReplay({ sessionId, limit: 100 }),
    },
    outbox: {
      claimPending: async (limit, now) => store.claimPendingOutbox({ limit, ...(now ? { now } : {}) }),
      markDelivered: async (id) => store.markOutboxDelivered(id),
    },
    close: () => store.close(),
  };
});
