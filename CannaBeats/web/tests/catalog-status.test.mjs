import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";

const run = promisify(execFile);
const statusScript = new URL("../../tools/status.py", import.meta.url).pathname;

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "cannabeats-status-"));
  await mkdir(join(root, "tools"));
  await mkdir(join(root, "catalog", "years"), { recursive: true });
  await mkdir(join(root, "catalog", "themes"), { recursive: true });
  await mkdir(join(root, "CannaBeats", "Resources", "Catalog"), { recursive: true });
  await copyFile(statusScript, join(root, "tools", "status.py"));
  const rejected = {
    title: "Rejected recording",
    artist: "Wrong performer",
    year: 1931,
    uri: "spotify:track:1234567890123456789012",
  };
  await writeFile(join(root, "catalog", "release-overrides.json"), JSON.stringify({
    rejectedMappings: [{ ...rejected, reason: "wrong recording" }],
  }));
  await writeFile(join(root, "catalog", "years", "1931.json"), JSON.stringify({
    songs: [{ ...rejected, uri: null }],
  }));
  await writeFile(join(root, "catalog", "themes", "safe.json"), JSON.stringify({
    songs: [{
      title: "Safe recording",
      artist: "Safe performer",
      year: 1931,
      uri: "spotify:track:abcdefghijklmnopqrstuv",
    }],
  }));
  await writeFile(join(root, "CannaBeats", "Resources", "Catalog", "1931.json"), JSON.stringify({
    songs: [rejected],
  }));
  return root;
}

test("catalog status exits nonzero when the native bundle differs from source", async () => {
  const root = await fixture();
  try {
    await assert.rejects(
      run("python3", [join(root, "tools", "status.py")]),
      (error) => error.code === 1 && /1 differ from source/.test(error.stdout),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("catalog sync never rescues a URI that source has removed", async () => {
  const root = await fixture();
  try {
    await run("python3", [join(root, "tools", "status.py"), "--sync"]);
    const synced = JSON.parse(await readFile(
      join(root, "CannaBeats", "Resources", "Catalog", "1931.json"), "utf8",
    ));
    assert.equal(synced.songs[0].uri, null);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
