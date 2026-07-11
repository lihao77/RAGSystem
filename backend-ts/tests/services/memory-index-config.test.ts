import { describe, expect, it, vi } from "vitest";

import { SystemConfigService } from "../../src/services/config/system-config-service.js";
import {
  buildMemoryIndexContextSourceOptions,
  MemoryIndexContextSource,
} from "../../src/services/agent/memory/memory-index-source.js";
import type { IMemoryStore } from "../../src/contracts/memory-store/index.js";

describe("memory index system config assembly", () => {
  it("passes configured index limits through to loadIndexHead", () => {
    const systemConfig = new SystemConfigService({ configPath: "" });
    systemConfig.updateConfig({ memory: { index_max_lines: 50, index_max_chars: 6400 } });
    const loadIndexHead = vi.fn(() => "# Session Memory");
    const memoryStore = { loadIndexHead } as unknown as IMemoryStore;
    const source = new MemoryIndexContextSource(
      { getSession: () => ({ metadata: {} }), updateSessionMetadata: () => null },
      { auto_inject: true, allowed_scopes: ["session"], write_scopes: [], archive_scopes: [] },
      "agent",
      { ...buildMemoryIndexContextSourceOptions(systemConfig.getMemoryConfig(), "."), memoryStore },
    );

    source.build({
      sessionId: "session",
      threadKey: "root",
      microcompact: false,
      microcompactKeepRecentTools: 5,
      cacheAlive: false,
      touch: false,
    });

    expect(loadIndexHead).toHaveBeenCalledWith(
      expect.objectContaining({ scope: "session", session_id: "session" }),
      { maxLines: 50, maxChars: 6400 },
    );
  });
});
