export function leaseBoundStream(
  source: ReadableStream<Uint8Array>,
  authorityCurrent: (signal: AbortSignal) => Promise<boolean>,
  { intervalMs = 1_000,authorityTimeoutMs,onCancel = () => {} }: {
    intervalMs?: number; authorityTimeoutMs?: number; onCancel?: () => void;
  } = {},
) {
  if (!Number.isSafeInteger(intervalMs) || intervalMs < 100 || intervalMs > 10_000) {
    throw new Error("Listener authority interval is invalid.");
  }
  const authorityDeadline = authorityTimeoutMs ?? Math.min(750,intervalMs);
  if (!Number.isSafeInteger(authorityDeadline) || authorityDeadline < 50
      || authorityDeadline > intervalMs) {
    throw new Error("Listener authority timeout is invalid.");
  }
  const reader = source.getReader();
  let finished = false;
  let validating = false;
  let timer: ReturnType<typeof setInterval> | null = null;
  let controller: ReadableStreamDefaultController<Uint8Array> | null = null;
  let authorityController: AbortController | null = null;

  async function finish() {
    if (finished) return;
    finished = true;
    if (timer) clearInterval(timer);
    authorityController?.abort();
    onCancel();
    await reader.cancel().catch(() => {});
    try { controller?.close(); } catch {}
  }

  return new ReadableStream<Uint8Array>({
    start(nextController) {
      controller = nextController;
      timer = setInterval(async () => {
        if (finished || validating) return;
        validating = true;
        try {
          authorityController = new AbortController();
          let timeout: ReturnType<typeof setTimeout>;
          const deadline = new Promise<boolean>((resolve) => {
            timeout = setTimeout(() => {
              authorityController?.abort();
              resolve(false);
            },authorityDeadline);
          });
          const current = await Promise.race([
            authorityCurrent(authorityController.signal),
            deadline,
          ]);
          clearTimeout(timeout!);
          if (!current) await finish();
        } catch {
          await finish();
        } finally {
          validating = false;
        }
      },intervalMs);
    },
    async pull(nextController) {
      if (finished) return;
      try {
        const next = await reader.read();
        if (finished) return;
        if (next.done) return void await finish();
        nextController.enqueue(next.value);
      } catch {
        await finish();
      }
    },
    async cancel() { await finish(); },
  });
}
