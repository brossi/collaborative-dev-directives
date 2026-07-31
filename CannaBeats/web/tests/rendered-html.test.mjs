import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("entry screen contains the host and player paths", async () => {
  const page = await readFile(new URL("../app/page.tsx", import.meta.url), "utf8");
  assert.match(page, /CannaBeats/);
  assert.match(page, /Host a game/);
  assert.match(page, /Join a game/);
  assert.match(page, /Lock placement/);
  assert.match(page, /Scan to join/);
  assert.match(page, /searchParams\.set\("room", room\.code\)/);
});

test("starter preview metadata and UI are gone", async () => {
  const [page, layout] = await Promise.all([
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/layout.tsx", import.meta.url), "utf8"),
  ]);
  assert.doesNotMatch(page, /SkeletonPreview/);
  assert.doesNotMatch(layout, /codex-preview/);
});
