const MAX_JSON_RESPONSE_BYTES = 1024 * 1024;
const decoder = new TextDecoder("utf-8",{ fatal: true });

export async function boundedJsonResponse(response, maxBytes = MAX_JSON_RESPONSE_BYTES) {
  if (!response?.body || !Number.isSafeInteger(maxBytes) || maxBytes < 1) {
    throw new Error("response_invalid");
  }
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { done,value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        try { void reader.cancel().catch(() => {}); } catch {}
        throw new Error("response_invalid");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk,offset);
    offset += chunk.byteLength;
  }
  return JSON.parse(decoder.decode(bytes));
}
