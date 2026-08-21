import { logGameLifecycle } from "./lib/server/observability";
import {
  closeReleaseRuntime,
  releaseRuntime,
  unifiedRuntimeEnabled,
} from "./lib/server/release/runtime.mjs";

const globalState = globalThis as typeof globalThis & { __cannabeatsGameLifecycleInstalled?: boolean };
if (!globalState.__cannabeatsGameLifecycleInstalled) {
  globalState.__cannabeatsGameLifecycleInstalled = true;
  logGameLifecycle("service.started");
  if (unifiedRuntimeEnabled()) releaseRuntime();
  process.once("exit", (code) => {
    if (unifiedRuntimeEnabled()) closeReleaseRuntime();
    logGameLifecycle("service.stopping", `exit_${code}`);
  });
}
