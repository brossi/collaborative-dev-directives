import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { openDatabase, sha256 } from "../../spikes/access-spotify-poc/db.mjs";
import { database } from "../lib/server/database.ts";
import {
  acquireManagedAudioLease,
  beginManagedAudioCommand,
  claimManagedAudioCommand,
  completeManagedAudioCommand,
  enqueueManagedAudioCommand,
  markManagedAudioCommandOutcomeUnknown,
  pollManagedAudioSource,
  releaseManagedAudioLease,
} from "../lib/server/managed-audio.ts";

const root = mkdtempSync(join(tmpdir(), "cannabeats-managed-audio-lifecycle-"));
after(() => rmSync(root, { recursive: true, force: true }));

function fixture(name) {
  const databasePath = join(root, `${name}.sqlite`);
  const access = openDatabase(databasePath);
  const hostId = randomUUID();
  const runId = randomUUID();
  const sourceId = randomUUID();
  const now = Date.now();
  access.prepare("INSERT INTO users (id, display_name, role, created_at) VALUES (?, 'Host', 'host', ?)")
    .run(hostId, now);
  access.prepare(`
    INSERT INTO game_sessions (code, host_user_id, status, active_run_id, created_at, updated_at)
    VALUES ('AUD234', ?, 'playing', ?, ?, ?)
  `).run(hostId, runId, now, now);
  access.close();
  process.env.CANNABEATS_DATABASE_PATH = databasePath;
  const db = database();
  db.prepare(`
    INSERT INTO game_runs (id, session_code, state, created_at, updated_at)
    VALUES (?, 'AUD234', '{"phase":"playing"}', ?, ?)
  `).run(runId, now, now);
  db.prepare(`
    INSERT INTO managed_audio_sources
      (id, display_name, token_hash, enabled, created_at, last_seen_at)
    VALUES (?, 'Source', ?, 1, ?, ?)
  `).run(sourceId, sha256(`source-${name}`), now, now);
  return { db, hostId, sourceId };
}

test("a completion outcome remains replayable after its transient lease is released", () => {
  const { hostId, sourceId } = fixture("terminal-replay");
  acquireManagedAudioLease("AUD234", hostId);
  const command = enqueueManagedAudioCommand(
    "AUD234", hostId, "play", "spotify:track:terminalReplayFixture",
  );
  const claimGeneration = randomUUID();
  claimManagedAudioCommand(sourceId, command.commandId, claimGeneration);
  beginManagedAudioCommand(sourceId, command.commandId, claimGeneration);
  assert.deepEqual(
    completeManagedAudioCommand(
      sourceId, command.commandId, true, "playing", null, claimGeneration,
    ),
    { status: "completed" },
  );
  releaseManagedAudioLease("AUD234");
  assert.deepEqual(
    completeManagedAudioCommand(
      sourceId, command.commandId, true, "playing", null, claimGeneration,
    ),
    { status: "replayed" },
  );
});

test("an executed command can report its first completion after lease release", () => {
  const { db, hostId, sourceId } = fixture("late-first-completion");
  acquireManagedAudioLease("AUD234", hostId);
  const command = enqueueManagedAudioCommand(
    "AUD234", hostId, "play", "spotify:track:lateFirstCompletion",
  );
  const claimGeneration = randomUUID();
  assert.deepEqual(claimManagedAudioCommand(sourceId, command.commandId, claimGeneration), {
    status: "claimed", replayed: false,
  });
  assert.deepEqual(beginManagedAudioCommand(sourceId, command.commandId, claimGeneration), {
    status: "executing", replayed: false,
  });
  releaseManagedAudioLease("AUD234");
  assert.deepEqual(
    completeManagedAudioCommand(sourceId, command.commandId, true, "playing", null),
    { status: "completed" },
  );
  assert.equal(db.prepare(`
    SELECT COUNT(*) AS count FROM game_events
    WHERE event_type = 'audio_command_completed' AND command_ref = ?
  `).get(command.commandId).count, 1);
});

test("external outcomes require a durable claim and executing transition", () => {
  const { hostId, sourceId } = fixture("claim-before-execution");
  acquireManagedAudioLease("AUD234", hostId);
  const command = enqueueManagedAudioCommand(
    "AUD234", hostId, "play", "spotify:track:claimBeforeExecution",
  );
  const claimGeneration = randomUUID();
  assert.throws(
    () => completeManagedAudioCommand(
      sourceId, command.commandId, true, "playing", null, claimGeneration,
    ),
    /forbidden transition/i,
  );
  assert.deepEqual(claimManagedAudioCommand(sourceId, command.commandId, claimGeneration), {
    status: "claimed", replayed: false,
  });
  assert.deepEqual(claimManagedAudioCommand(sourceId, command.commandId, claimGeneration), {
    status: "claimed", replayed: true,
  });
  assert.throws(
    () => claimManagedAudioCommand(sourceId, command.commandId, randomUUID()),
    /generation conflict/i,
  );
  assert.deepEqual(beginManagedAudioCommand(sourceId, command.commandId, claimGeneration), {
    status: "executing", replayed: false,
  });
  assert.deepEqual(
    completeManagedAudioCommand(
      sourceId, command.commandId, true, "playing", null, claimGeneration,
    ),
    { status: "completed" },
  );
});

test("SQLite enforces managed-command transition edges and generation invariants", () => {
  const { db, hostId } = fixture("command-db-authority");
  acquireManagedAudioLease("AUD234", hostId);
  const command = enqueueManagedAudioCommand(
    "AUD234", hostId, "play", "spotify:track:dbAuthority",
  );
  assert.throws(() => db.prepare(`
    UPDATE managed_audio_command_outcomes
    SET command_state = 'completed', completed_at = ?, completion_fingerprint = '{"ok":true}'
    WHERE command_id = ?
  `).run(Date.now(), command.commandId), /command transition/i);
  assert.throws(() => db.prepare(`
    UPDATE managed_audio_command_outcomes
    SET command_state = 'claimed' WHERE command_id = ?
  `).run(command.commandId), /claim generation/i);
});

test("claim and begin require the command's exact unexpired live lease", () => {
  const { db, hostId, sourceId } = fixture("expired-authority");
  acquireManagedAudioLease("AUD234", hostId);
  const command = enqueueManagedAudioCommand(
    "AUD234", hostId, "play", "spotify:track:expiredAuthority",
  );
  db.prepare("UPDATE managed_audio_leases SET expires_at = ? WHERE session_code = 'AUD234'")
    .run(Date.now() - 1);
  const generation = randomUUID();
  assert.throws(
    () => claimManagedAudioCommand(sourceId, command.commandId, generation),
    /lease authority/i,
  );

  const live = fixture("begin-expired-authority");
  acquireManagedAudioLease("AUD234", live.hostId);
  const begun = enqueueManagedAudioCommand(
    "AUD234", live.hostId, "play", "spotify:track:beginExpiredAuthority",
  );
  const beginGeneration = randomUUID();
  claimManagedAudioCommand(live.sourceId, begun.commandId, beginGeneration);
  live.db.prepare("UPDATE managed_audio_leases SET expires_at = ? WHERE session_code = 'AUD234'")
    .run(Date.now() - 1);
  assert.throws(
    () => beginManagedAudioCommand(live.sourceId, begun.commandId, beginGeneration),
    /lease authority/i,
  );
});

test("a restarted executing source converges the authoritative command to outcome unknown", () => {
  const { db, hostId, sourceId } = fixture("restart-unknown-convergence");
  acquireManagedAudioLease("AUD234", hostId);
  const command = enqueueManagedAudioCommand(
    "AUD234", hostId, "play", "spotify:track:unknownConvergence",
  );
  const generation = randomUUID();
  claimManagedAudioCommand(sourceId, command.commandId, generation);
  beginManagedAudioCommand(sourceId, command.commandId, generation);
  assert.deepEqual(
    markManagedAudioCommandOutcomeUnknown(sourceId, command.commandId, generation),
    { status: "outcome_unknown", replayed: false },
  );
  assert.deepEqual(
    markManagedAudioCommandOutcomeUnknown(sourceId, command.commandId, generation),
    { status: "outcome_unknown", replayed: true },
  );
  assert.equal(db.prepare(`
    SELECT command_state FROM managed_audio_command_outcomes WHERE command_id = ?
  `).get(command.commandId).command_state, "outcome_unknown");
  assert.equal(db.prepare(`
    SELECT COUNT(*) AS count FROM game_events
    WHERE command_ref = ? AND event_type = 'audio_command_outcome_unknown'
  `).get(command.commandId).count, 1);
});

test("SQLite preserves command identity and classifies lease loss for every writer", () => {
  const { db, hostId, sourceId } = fixture("db-lease-loss-authority");
  acquireManagedAudioLease("AUD234", hostId);
  const queued = enqueueManagedAudioCommand(
    "AUD234", hostId, "play", "spotify:track:queuedLeaseLoss",
  );
  const executing = enqueueManagedAudioCommand("AUD234", hostId, "pause");
  const generation = randomUUID();
  claimManagedAudioCommand(sourceId, executing.commandId, generation);
  beginManagedAudioCommand(sourceId, executing.commandId, generation);
  assert.throws(() => db.prepare(`
    UPDATE managed_audio_command_outcomes SET run_id = NULL WHERE command_id = ?
  `).run(executing.commandId), /identity is immutable/i);
  assert.throws(() => db.prepare(`
    UPDATE managed_audio_commands SET kind = 'resume' WHERE id = ?
  `).run(executing.commandId), /intent is immutable/i);
  db.prepare("DELETE FROM managed_audio_leases WHERE session_code = 'AUD234'").run();
  const states = new Map(db.prepare(`
    SELECT command_id, command_state FROM managed_audio_command_outcomes
    WHERE command_id IN (?, ?)
  `).all(queued.commandId, executing.commandId).map((row) => [row.command_id, row.command_state]));
  assert.equal(states.get(queued.commandId), "cancelled");
  assert.equal(states.get(executing.commandId), "outcome_unknown");
  assert.throws(() => db.prepare("DELETE FROM managed_audio_sources WHERE id = ?").run(sourceId),
    /durable command outcomes/i);
});

test("lease release cancels unclaimed work but preserves uncertain executed work", () => {
  const { db, hostId, sourceId } = fixture("release-state-machine");
  acquireManagedAudioLease("AUD234", hostId);
  const queued = enqueueManagedAudioCommand(
    "AUD234", hostId, "play", "spotify:track:cancelQueued",
  );
  const executing = enqueueManagedAudioCommand(
    "AUD234", hostId, "pause",
  );
  const claimGeneration = randomUUID();
  claimManagedAudioCommand(sourceId, executing.commandId, claimGeneration);
  beginManagedAudioCommand(sourceId, executing.commandId, claimGeneration);

  const released = releaseManagedAudioLease("AUD234");
  assert.deepEqual(released.commands, [
    { id: queued.commandId, kind: "play", status: "cancelled" },
    { id: executing.commandId, kind: "pause", status: "outcome_unknown" },
  ]);
  const states = db.prepare(`
    SELECT command_id, command_state FROM managed_audio_command_outcomes ORDER BY command_id
  `).all();
  assert.deepEqual(new Map(states.map((row) => [row.command_id, row.command_state])), new Map([
    [queued.commandId, "cancelled"],
    [executing.commandId, "outcome_unknown"],
  ]));
  assert.deepEqual(
    completeManagedAudioCommand(
      sourceId, executing.commandId, true, "paused", null, claimGeneration,
    ),
    { status: "completed" },
  );
});

test("successful completions must match the command's authoritative playback state", () => {
  const { hostId, sourceId } = fixture("completion-state");
  acquireManagedAudioLease("AUD234", hostId);
  for (const [kind, invalidStatus] of [
    ["play", "ready"],
    ["play", "paused"],
    ["play", "error"],
    ["pause", "playing"],
    ["resume", "paused"],
  ]) {
    const command = enqueueManagedAudioCommand(
      "AUD234", hostId, kind, kind === "play" ? "spotify:track:completionState" : undefined,
    );
    const claimGeneration = randomUUID();
    claimManagedAudioCommand(sourceId, command.commandId, claimGeneration);
    beginManagedAudioCommand(sourceId, command.commandId, claimGeneration);
    assert.throws(
      () => completeManagedAudioCommand(
        sourceId, command.commandId, true, invalidStatus, null, claimGeneration,
      ),
      /completion state does not match/i,
    );
  }
});

test("source polling does not persist its provider device identifier", () => {
  const { db, sourceId } = fixture("device-privacy");
  pollManagedAudioSource(sourceId);
  assert.equal(db.prepare("SELECT device_id FROM managed_audio_sources WHERE id = ?").get(sourceId).device_id, null);
});
