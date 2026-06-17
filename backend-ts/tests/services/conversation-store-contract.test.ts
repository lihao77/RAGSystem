import { describe, expect, it } from "vitest";

import { createConversationStore } from "../../src/services/stores/conversation-store/index.js";
import type {
  AddMessageInput,
  IConversationTransactionRunner,
  IMessageStore,
  IOutboxStore,
  IRunStore,
  ISessionStore,
} from "../../src/contracts/conversation-store/index.js";
import { AddMessageInputSchema } from "../../src/contracts/conversation-store/types.js";

/**
 * conversation-store 契约测试样本（路线图④替换验证雏形）。
 *
 * 关键设计：测试只依赖 IXxxStore 窄接口（身份证的能力面），不引用任何实现类
 * （SessionOps/MessageOps 等）。每个用例把 store 实例赋给窄接口类型再调用——
 * 证明「实现服从契约」。将来换库时，新实现注入同一组测试都应通过，这才是可替换的证明。
 *
 * 深合约语义在此被验证为可执行规约：getSession/getRun 不存在返回 null、
 * listMessages 按 seq 升序、addRunStep 的 step_order 自增、getNextSessionSeq 唯一递增、
 * 事务原子性（全成或全回滚）、输入边界 zod 校验。
 */

const build = () => createConversationStore({ dbPath: ":memory:" });

const baseMessage = (sessionId: string): AddMessageInput => ({
  sessionId,
  role: "user",
  content: "hello",
});

describe("ISessionStore 契约", () => {
  it("getSession 不存在返回 null（深合约：非抛异常）", () => {
    const sessions: ISessionStore = build();
    expect(sessions.getSession("missing")).toBeNull();
  });

  it("createSession 幂等（ON CONFLICT 覆盖）且可读回", () => {
    const sessions: ISessionStore = build();
    sessions.createSession("s1", "u1", { title: "t" });
    sessions.createSession("s1", "u2", {});
    const got = sessions.getSession("s1");
    expect(got).not.toBeNull();
    expect(got?.user_id).toBe("u2");
  });

  it("listSessions 分页 has_more = offset+limit < total", () => {
    const sessions: ISessionStore = build();
    for (let i = 0; i < 3; i += 1) sessions.createSession(`s${i}`);
    const page = sessions.listSessions(2, 0);
    expect(page.items).toHaveLength(2);
    expect(page.total).toBe(3);
    expect(page.has_more).toBe(true);
  });
});

describe("IMessageStore 契约", () => {
  it("addMessage 写入并回读，listMessages 按 seq 升序", () => {
    const messages: IMessageStore = build();
    messages.addMessage({ ...baseMessage("s1"), content: "a" });
    messages.addMessage({ ...baseMessage("s1"), content: "b" });
    const list = messages.listMessages("s1", 20);
    expect(list.items).toHaveLength(2);
    expect(list.items[0].content).toBe("a");
    expect(list.items[1].content).toBe("b");
    expect(list.items[0].seq).toBeLessThan(list.items[1].seq);
  });

  it("getMessageBySeq 不存在返回 null", () => {
    const messages: IMessageStore = build();
    expect(messages.getMessageBySeq("s1", 999)).toBeNull();
  });
});

describe("IRunStore 契约", () => {
  it("addRunStep 的 step_order 在 (session,run) 内自增", () => {
    const store = build();
    store.createSession("s1");
    const runs: IRunStore = store;
    runs.createRun({ runId: "r1", sessionId: "s1" });
    const step1 = runs.addRunStep({ sessionId: "s1", runId: "r1", stepType: "x", payload: {} });
    const step2 = runs.addRunStep({ sessionId: "s1", runId: "r1", stepType: "y", payload: {} });
    expect(step2.step_order).toBe(step1.step_order + 1);
  });

  it("getRun 不存在返回 null", () => {
    const runs: IRunStore = build();
    expect(runs.getRun("s1", "missing")).toBeNull();
  });
});

describe("IOutboxStore 契约", () => {
  it("getNextSessionSeq 跨调用唯一递增（原子自增，前置：session 须先存在）", () => {
    const store = build();
    store.createSession("s1");
    const outbox: IOutboxStore = store;
    const a = outbox.getNextSessionSeq("s1");
    const b = outbox.getNextSessionSeq("s1");
    expect(b).toBe(a + 1);
  });

  it("appendOutbox 入库后可被 fetchPendingOutbox 取到", () => {
    const outbox: IOutboxStore = build();
    outbox.appendOutbox({
      sessionId: "s1",
      eventType: "e",
      aggregateType: "a",
      aggregateId: "x",
      payload: { k: 1 },
    });
    const pending = outbox.fetchPendingOutbox(10);
    expect(pending).toHaveLength(1);
    expect(pending[0].event_type).toBe("e");
  });
});

describe("IConversationTransactionRunner 契约——原子性", () => {
  it("事务内多域写入要么全成（提交后均可见）", () => {
    const store = build();
    store.createSession("s1");
    const runner: IConversationTransactionRunner = store;
    const result = runner.runInTransaction((tx) => {
      tx.addMessage({ ...baseMessage("s1"), content: "tx-msg" });
      tx.appendOutbox({
        sessionId: "s1",
        eventType: "e",
        aggregateType: "a",
        aggregateId: "x",
        payload: {},
      });
      return "ok";
    });
    expect(result).toBe("ok");
    expect(store.listMessages("s1").items).toHaveLength(1);
    expect(store.fetchPendingOutbox(10)).toHaveLength(1);
  });

  it("事务内抛异常则全部回滚（写入不可见）", () => {
    const store = build();
    store.createSession("s1");
    const runner: IConversationTransactionRunner = store;
    const messages: IMessageStore = store;
    expect(() =>
      runner.runInTransaction((tx) => {
        tx.addMessage({ ...baseMessage("s1"), content: "will-rollback" });
        throw new Error("boom");
      }),
    ).toThrow("boom");
    expect(messages.listMessages("s1").items).toHaveLength(0);
  });
});

describe("输入边界 zod 契约", () => {
  it("AddMessageInputSchema 拒绝非法 role", () => {
    expect(() =>
      AddMessageInputSchema.parse({ sessionId: "s1", role: "invalid", content: "x" }),
    ).toThrow();
  });

  it("addMessage 入口拒绝非法 role（zod 边界生效）", () => {
    const messages: IMessageStore = build();
    expect(() =>
      messages.addMessage({
        sessionId: "s1",
        role: "invalid" as AddMessageInput["role"],
        content: "x",
      }),
    ).toThrow();
  });
});
