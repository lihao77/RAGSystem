import { withArtifactIndexLock } from "@ragsystem/agent-sdk";

const [root, staleArg, updateArg] = process.argv.slice(2);
if (!root || !staleArg || !updateArg) throw new Error("missing lock child arguments");

let releaseAction!: () => void;
const actionReleased = new Promise<void>((resolve) => { releaseAction = resolve; });

process.on("message", (message) => {
  if (message === "release") releaseAction();
  if (message === "block") {
    process.send?.("blocking");
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Number(staleArg) * 3);
    process.send?.("block-complete");
  }
});

try {
  await withArtifactIndexLock(root, async () => {
    process.send?.("entered");
    await actionReleased;
  }, {
    staleMs: Number(staleArg),
    updateMs: Number(updateArg),
    retries: 200,
  });
  process.send?.("released");
} catch (error) {
  process.send?.({ error: error instanceof Error ? error.message : String(error) });
  process.exitCode = 1;
}
