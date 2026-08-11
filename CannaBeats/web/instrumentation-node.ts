import { logGameLifecycle } from "./lib/server/observability";

const globalState = globalThis as typeof globalThis & { __cannabeatsGameLifecycleInstalled?: boolean };
if (!globalState.__cannabeatsGameLifecycleInstalled) {
  globalState.__cannabeatsGameLifecycleInstalled = true;
  logGameLifecycle("service.started");
  process.once("exit", (code) => {
    logGameLifecycle("service.stopping", `exit_${code}`);
  });
}
