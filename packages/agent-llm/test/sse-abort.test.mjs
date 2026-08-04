import assert from "node:assert/strict";
import test from "node:test";

import { readSse } from "../dist/internal/sse.js";

test("pre-aborted SSE reads cancel and release their body reader", async () => {
  let cancelCalls = 0;
  const response = new Response(new ReadableStream({
    cancel() {
      cancelCalls += 1;
    },
  }));
  const controller = new AbortController();
  controller.abort(new DOMException("aborted", "AbortError"));

  await readSse(response, 100, async () => undefined, controller.signal);

  assert.equal(cancelCalls, 1);
  assert.equal(response.body.locked, false);
});
