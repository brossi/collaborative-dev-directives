import assert from "node:assert/strict";
import { test } from "node:test";
import { leaseBoundStream } from "../lib/server/lease-bound-stream.ts";

test("an open listener is closed when its lease generation is no longer authoritative", async () => {
  const upstream = new TransformStream();
  const writer = upstream.writable.getWriter();
  let current = true;
  let cancelled = 0;
  const reader = leaseBoundStream(upstream.readable,async () => current,{
    intervalMs: 100,onCancel: () => { cancelled += 1; },
  }).getReader();
  await writer.write(new Uint8Array([1,2,3]));
  assert.deepEqual(Array.from((await reader.read()).value),[1,2,3]);
  current = false;
  const result = await Promise.race([
    reader.read(),
    new Promise((_,reject) => setTimeout(() => reject(new Error("listener was not revoked")),500)),
  ]);
  assert.equal(result.done,true);
  assert.equal(cancelled,1);
});

test("a hung authority dependency revokes the listener at its local deadline", async () => {
  const upstream = new TransformStream();
  const reader = leaseBoundStream(upstream.readable,async () => new Promise(() => {}),{
    intervalMs: 100,authorityTimeoutMs: 50,
  }).getReader();
  const result = await Promise.race([
    reader.read(),
    new Promise((_,reject) => setTimeout(() => reject(new Error("hung authority failed open")),400)),
  ]);
  assert.equal(result.done,true);
});

test("a listener pulls relay bytes only when its consumer has capacity", async () => {
  let pulls = 0;
  const source = new ReadableStream({
    pull(controller) {
      pulls += 1;
      controller.enqueue(new Uint8Array([pulls]));
    },
  });
  const stream = leaseBoundStream(source,async () => true,{
    intervalMs: 100,authorityTimeoutMs: 50,
  });
  await new Promise((resolve) => setTimeout(resolve,100));
  assert.ok(pulls <= 2,`relay source was pulled ${pulls} times without a consumer`);
  await stream.cancel();
});
