import assert from "node:assert/strict";
import { createHash, createHmac, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { createStateServer } from "../src/server.mjs";
import { StateOwner } from "../src/owner.mjs";
import { createCatalogGameServices } from "../src/catalog.mjs";
import { DatabaseSync } from "node:sqlite";

const root = mkdtempSync(join(tmpdir(), "cannabeats-state-server-"));
after(() => rmSync(root, { recursive: true, force: true }));
const developmentOwner = (path) => new StateOwner(path, { allowDevelopmentActivation: true });

const scopedCredentials = Object.freeze({
  activationToken: "scope-activation", operatorToken: "scope-operator",
  accessToken: "scope-access", gameToken: "scope-game",
  accessPrincipalAssertionKey: "scope-access-assertion",
  gamePrincipalAssertionKey: "scope-game-assertion",
});

function signedPrincipalHeaders(principal, scope, now = 100) {
  const issuer = scope;
  const expiresAt = now + 1_000;
  const key = scope === "access"
    ? scopedCredentials.accessPrincipalAssertionKey : scopedCredentials.gamePrincipalAssertionKey;
  const claim = `${issuer}\ncannabeats-state\n${scope}\n${principal}\n${expiresAt}`;
  return {
    "x-cannabeats-principal": principal,
    "x-cannabeats-principal-issuer": issuer,
    "x-cannabeats-principal-expires-at": String(expiresAt),
    "x-cannabeats-principal-signature": createHmac("sha256", key).update(claim).digest("hex"),
  };
}

test("state server rejects collapsed credential scopes", () => {
  assert.throws(() => createStateServer({
    databasePath: join(root, "collapsed.sqlite"),
    credentials: {
      activationToken: "same", operatorToken: "same", accessToken: "same",
      gameToken: "same", accessPrincipalAssertionKey: "same",
      gamePrincipalAssertionKey: "same",
    },
  }), /must be distinct/i);
});

test("state server rejects retained source credentials that collide with service scopes", () => {
  const path = join(root, "retained-source-collision.sqlite");
  const credentials = {
    activationToken: "activation-a", operatorToken: "operator-a", accessToken: "access-a",
    gameToken: "game-a", accessPrincipalAssertionKey: "access-assertion-a",
    gamePrincipalAssertionKey: "game-assertion-a",
  };
  const owner = developmentOwner(path);
  owner.activate({ now: 1 });
  owner.registerManagedSource({
    sourceId: randomUUID(), displayName: "Retained Source",
    tokenHash: createHash("sha256").update(credentials.gameToken).digest("hex"), now: 2,
  });
  owner.close();
  assert.throws(() => createStateServer({ databasePath: path, credentials }), /collides/i);
});

test("every HTTP mutation and read route has one explicit credential scope", async () => {
  const path = join(root, "scope-matrix.sqlite");
  const sourceToken = "scope-source";
  const owner = developmentOwner(path);
  owner.activate({ now: 1 });
  owner.registerManagedSource({
    commandId: randomUUID(), sourceId: randomUUID(), displayName: "Source",
    tokenHash: createHash("sha256").update(sourceToken).digest("hex"), now: 2,
  });
  owner.close();
  const server = createStateServer({
    databasePath: path, credentials: scopedCredentials, clock: () => 100,
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const principal = "scope-principal";
  const tokens = {
    activation: scopedCredentials.activationToken,
    operator: scopedCredentials.operatorToken,
    access: scopedCredentials.accessToken,
    game: scopedCredentials.gameToken,
    source: sourceToken,
  };
  const commandId = randomUUID();
  const routes = [
    ["POST", "/v1/admin/activate", "activation"],
    ["POST", "/v1/admin/admission", "operator"],
    ["POST", "/v1/access/lobbies", "access"],
    ["GET", "/v1/access/lobbies", "access"],
    ["GET", "/v1/access/lobbies/ABC123", "access"],
    ["POST", "/v1/access/lobbies/ABC123/memberships", "access"],
    ["GET", "/v1/access/lobbies/ABC123/admission-context", "access"],
    ["POST", "/v1/lobbies", "game"],
    ["POST", "/v1/lobbies/ABC123/runs", "game"],
    ["GET", "/v1/lobbies/ABC123", "game"],
    ["GET", "/v1/lobbies/ABC123/audio", "game"],
    ["GET", `/v1/history/${commandId}`, "game"],
    ["POST", "/v1/lobbies/ABC123/actions", "game"],
    ["POST", "/v1/lobbies/ABC123/admissions", "access"],
    ["POST", "/v1/admin/managed-sources", "operator"],
    ["GET", "/v1/admin/managed-sources", "operator"],
    ["POST", `/v1/admin/managed-sources/${commandId}/rotate`, "operator"],
    ["POST", `/v1/admin/managed-sources/${commandId}/disable`, "operator"],
    ["POST", "/v1/admin/expire-managed-leases", "operator"],
    ["POST", "/v1/admin/history/seal", "operator"],
    ["POST", "/v1/admin/history/purge", "operator"],
    ["POST", "/v1/admin/history/sanitize", "operator"],
    ["GET", "/v1/admin/history/candidates?eligibleBefore=1", "operator"],
    ["GET", "/v1/admin/validate", "operator"],
    ["GET", "/v1/admin/report", "operator"],
    ["GET", "/v1/admin/export", "operator"],
    ["GET", "/v1/source/work", "source"],
    ["POST", `/v1/managed-commands/${commandId}/transitions`, "source"],
  ];
  try {
    for (const [method, pathname, acceptedScope] of routes) {
      for (const [scope, token] of Object.entries(tokens)) {
        const headers = {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
          ...(scope === "game" || scope === "access"
            ? signedPrincipalHeaders(principal, scope) : {}),
        };
        const response = await fetch(`${origin}${pathname}`, {
          method, headers, ...(method === "POST" ? { body: "{}" } : {}),
        });
        if (scope === acceptedScope) {
          assert.notEqual(response.status, 401, `${method} ${pathname} rejected its ${scope} scope`);
          assert.notEqual(response.status, 403, `${method} ${pathname} rejected its ${scope} scope`);
        } else {
          assert.equal(response.status, 403, `${method} ${pathname} accepted ${scope} scope`);
        }
      }
      const anonymous = await fetch(`${origin}${pathname}`, {
        method, headers: { "content-type": "application/json" },
        ...(method === "POST" ? { body: "{}" } : {}),
      });
      assert.equal(anonymous.status, acceptedScope === "source" ? 403 : 401,
        `${method} ${pathname} anonymous status`);
    }
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("HTTP boundary authenticates callers and derives the lobby host from its principal claim", async () => {
  const server = createStateServer({
    allowDevelopmentActivation: true,
    databasePath: join(root, "server.sqlite"),
    credentials: {
      activationToken: "activation-secret",
      operatorToken: "operator-secret",
      accessToken: "access-secret",
      gameToken: "game-secret",
      accessPrincipalAssertionKey: "access-principal-assertion-secret",
      gamePrincipalAssertionKey: "game-principal-assertion-secret",
    },
    clock: () => 100,
    gameServices: createCatalogGameServices([
      { title: "One", artist: "Artist", year: 1960, uri: "spotify:track:one" },
      { title: "Two", artist: "Artist", year: 1980, uri: "spotify:track:two" },
      { title: "Three", artist: "Artist", year: 2000, uri: "spotify:track:three" },
    ], { random: () => 0 }),
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  const origin = `http://127.0.0.1:${port}`;
  try {
    const contractResponse = await fetch(`${origin}/v1/contract`);
    assert.equal(contractResponse.status, 200);
    assert.deepEqual(await contractResponse.json(), {
      service: "cannabeats-state",
      httpContractVersion: 1,
      schemaGeneration: 2,
      protocolVersion: 3,
      projections: { room: 1, history: 1, accessLobby: 1 },
      gameCommands: [
        "add_host_player", "remove_player", "configure_rules", "start_game",
        "begin_round", "place_song", "retract_placement", "reveal_answer",
        "advance_round", "skip_track", "select_audio", "release_audio",
        "control_audio", "abandon_game",
      ],
      errors: {
        invalid_json: 400, invalid_request: 400, unauthorized: 401, forbidden: 403,
        principal_assertion_invalid: 403, source_forbidden: 403, not_found: 404,
        payload_too_large: 413, idempotency_conflict: 409, stale_context: 409,
        state_conflict: 409, database_busy: 503, internal_error: 500,
      },
    });
    const readiness = await (await fetch(`${origin}/ready`)).json();
    assert.equal(readiness.httpContractVersion, 1);
    const malformed = await fetch(`${origin}/v1/lobbies`, {
      method: "POST", headers: { "content-type": "application/json" }, body: "{secret",
    });
    assert.equal(malformed.status, 400);
    assert.deepEqual(await malformed.json(), { code: "invalid_json" });
    assert.equal((await fetch(`${origin}/v1/lobbies`, { method: "POST" })).status, 401);
    const principalHeaders = (principal, scope) => {
      const issuer = scope;
      const expiresAt = 1_000;
      const key = scope === "access"
        ? "access-principal-assertion-secret" : "game-principal-assertion-secret";
      const claim = `${issuer}\ncannabeats-state\n${scope}\n${principal}\n${expiresAt}`;
      return {
        "x-cannabeats-principal": principal,
        "x-cannabeats-principal-issuer": issuer,
        "x-cannabeats-principal-expires-at": String(expiresAt),
        "x-cannabeats-principal-signature": createHmac("sha256", key).update(claim).digest("hex"),
      };
    };
    const headers = {
      authorization: "Bearer game-secret",
      "content-type": "application/json",
      ...principalHeaders("opaque-principal-1", "game"),
    };
    const forgedPrincipal = await fetch(`${origin}/v1/lobbies`, {
      method: "POST",
      headers: { ...headers, "x-cannabeats-principal": "forged-host" },
      body: JSON.stringify({ commandId: "877e8bba-a9e2-42d6-a97c-425e90f65ef3", code: "BAD777" }),
    });
    assert.equal(forgedPrincipal.status, 403);
    const forbiddenActivation = await fetch(`${origin}/v1/admin/activate`, {
      method: "POST", headers,
      body: JSON.stringify({ commandId: "7353bdf0-38b1-47c9-a689-82dfac3a90df" }),
    });
    assert.equal(forbiddenActivation.status, 403);
    const candidate = await fetch(`${origin}/v1/lobbies`, {
      method: "POST", headers,
      body: JSON.stringify({ commandId: "b7246a76-3bcb-4da1-9d7a-11ef56ed3ea4", code: "BAD234" }),
    });
    assert.equal(candidate.status, 409);
    assert.deepEqual(await candidate.json(), { code: "state_conflict" });
    const wrongVolumeActivation = await fetch(`${origin}/v1/admin/activate`, {
      method: "POST", headers: { ...headers, authorization: "Bearer activation-secret" },
      body: JSON.stringify({
        commandId: randomUUID(), expectedSourceDigest: "a".repeat(64),
        expectedCandidateDigest: "b".repeat(64), expectedSchemaGeneration: 2,
        expectedProtocolVersion: 3, releaseEpoch: "release-test",
      }),
    });
    assert.equal(wrongVolumeActivation.status, 409);
    const activation = await fetch(`${origin}/v1/admin/activate`, {
      method: "POST", headers: { ...headers, authorization: "Bearer activation-secret" },
      body: JSON.stringify({
        commandId: "451653d1-0077-43f9-90db-68c9c71b6630",
        expectedSourceDigest: null, expectedCandidateDigest: null,
        expectedSchemaGeneration: 2, expectedProtocolVersion: 3,
        releaseEpoch: "development", now: -1,
      }),
    });
    const activationPayload = await activation.json();
    assert.equal(activationPayload.status, "active");
    assert.equal(activationPayload.activatedAt, 100);
    const exported = await fetch(`${origin}/v1/admin/export`,{
      headers: { authorization: "Bearer operator-secret" },
    });
    assert.equal(exported.status,200);
    assert.equal(exported.headers.get("x-cannabeats-release-epoch"),"development");
    assert.equal(exported.headers.get("x-cannabeats-schema-generation"),"2");
    assert.equal(exported.headers.get("x-cannabeats-protocol-version"),"3");
    const snapshot = Buffer.from(await exported.arrayBuffer());
    assert.equal(createHash("sha256").update(snapshot).digest("hex"),
      exported.headers.get("x-cannabeats-state-sha256"));
    const exportedPath = `${root}/server-export.sqlite`;
    writeFileSync(exportedPath,snapshot,{ mode: 0o600 });
    const exportedDb = new DatabaseSync(exportedPath,{ readOnly: true });
    assert.equal(exportedDb.prepare("PRAGMA integrity_check").get().integrity_check,"ok");
    assert.equal(exportedDb.prepare("SELECT status FROM state_authority").get().status,"active");
    exportedDb.close();
    const request = { commandId: "2c53f9fa-8882-45b0-9874-01ca670f4444", code: "SRV234" };
    const first = await fetch(`${origin}/v1/lobbies`, {
      method: "POST", headers, body: JSON.stringify(request),
    });
    assert.deepEqual(await first.json(), { code: "SRV234", status: "lobby", replayed: false });
    const replay = await fetch(`${origin}/v1/lobbies`, {
      method: "POST", headers, body: JSON.stringify(request),
    });
    assert.deepEqual(await replay.json(), { code: "SRV234", status: "lobby", replayed: true });
    const runId = "93de9358-d32a-4e2f-a46b-2841786c9180";
    const run = await fetch(`${origin}/v1/lobbies/SRV234/runs`, {
      method: "POST", headers,
      body: JSON.stringify({
        commandId: "d0fb60dd-1ec7-45bc-8105-abac00ff2ea6",
        runId,
      }),
    });
    assert.equal((await run.json()).revision, 0);
    const actionRequest = {
      actionId: "1857f452-b4d1-4b12-a3e4-b4126bfa4eea",
      expectedRunId: runId, expectedRunGeneration: 1,
      expectedRevision: 0, command: { type: "configure_rules", rules: { targetScore: 7 } },
    };
    const action = await fetch(`${origin}/v1/lobbies/SRV234/actions`, {
      method: "POST", headers, body: JSON.stringify(actionRequest),
    });
    const actionPayload = await action.json();
    assert.equal(actionPayload.revision, 1);
    assert.equal(actionPayload.replayed, false);
    const actionReplay = await fetch(`${origin}/v1/lobbies/SRV234/actions`, {
      method: "POST", headers, body: JSON.stringify(actionRequest),
    });
    assert.equal((await actionReplay.json()).replayed, true);
    const guestHeaders = {
      ...headers,
      ...principalHeaders("opaque-principal-2", "game"),
    };
    const forbiddenJoin = await fetch(`${origin}/v1/lobbies/SRV234/actions`, {
      method: "POST", headers: guestHeaders,
      body: JSON.stringify({
        actionId: "ba1af328-13f5-4b42-b132-2351a7846463",
        expectedRunId: runId, expectedRunGeneration: 1, expectedRevision: 1,
        command: { type: "join_player", name: "Guest" },
      }),
    });
    assert.equal(forbiddenJoin.status, 403);
    assert.deepEqual(await forbiddenJoin.json(), { code: "forbidden" });
    const join = await fetch(`${origin}/v1/lobbies/SRV234/admissions`, {
      method: "POST", headers: { ...guestHeaders, authorization: "Bearer access-secret",
        ...principalHeaders("opaque-principal-2", "access") },
      body: JSON.stringify({
        actionId: "ba1af328-13f5-4b42-b132-2351a7846463",
        expectedRunId: runId, expectedRunGeneration: 1, expectedRevision: 1,
        name: "Guest",
      }),
    });
    assert.equal((await join.json()).revision, 2);
    const room = await fetch(`${origin}/v1/lobbies/SRV234`, { headers: guestHeaders });
    const roomPayload = await room.json();
    assert.equal(roomPayload.revision, 2);
    assert.equal(roomPayload.state.players[0].id, "opaque-principal-2");

    const operatorHeaders = { ...headers, authorization: "Bearer operator-secret" };
    const operatorCannotImpersonate = await fetch(`${origin}/v1/lobbies`, {
      method: "POST", headers: operatorHeaders,
      body: JSON.stringify({ commandId: "ab618bdc-94e6-45e5-b640-34a23f34114e", code: "BAD999" }),
    });
    assert.equal(operatorCannotImpersonate.status, 403);
    const sourceId = "d619e0c2-7fc0-4402-937a-373b4383e987";
    const sourceToken = "managed-source-secret";
    const registration = await fetch(`${origin}/v1/admin/managed-sources`, {
      method: "POST", headers: operatorHeaders,
      body: JSON.stringify({
        commandId: "163bfebb-eed2-44ec-b1b8-548c34ecaf09",
        sourceId, displayName: "Source",
        tokenHash: createHash("sha256").update(sourceToken).digest("hex"),
      }),
    });
    assert.equal(registration.status, 200);
    assert.deepEqual(await (await fetch(`${origin}/v1/source/work`, {
      headers: { authorization: `Bearer ${sourceToken}` },
    })).json(), { protocolVersion: 3, lease: null, command: null });
    const gameAction = async (expectedRevision, command) => {
      const response = await fetch(`${origin}/v1/lobbies/SRV234/actions`, {
        method: "POST", headers,
        body: JSON.stringify({
          actionId: randomUUID(), expectedRunId: runId, expectedRunGeneration: 1,
          expectedRevision, command,
        }),
      });
      assert.equal(response.status, 200);
      return response.json();
    };
    await gameAction(2, { type: "select_audio", mode: "managed" });
    await gameAction(3, { type: "add_host_player", name: "Host" });
    await gameAction(4, { type: "start_game" });
    const begun = await gameAction(5, { type: "begin_round" });
    const managedCommandId = begun.managedCommands[0].commandId;
    const sourceWork = await fetch(`${origin}/v1/source/work`, {
      headers: { authorization: `Bearer ${sourceToken}` },
    });
    const sourcePayload = await sourceWork.json();
    assert.equal(sourcePayload.protocolVersion, 3);
    assert.equal(sourcePayload.lease.lobbyCode, "SRV234");
    assert.equal(sourcePayload.lease.expiresAt, 120_100);
    assert.deepEqual(sourcePayload.command, {
      id: managedCommandId, kind: "play", trackUri: begun.state.currentSong.uri,
    });
    const gameCannotClaim = await fetch(`${origin}/v1/managed-commands/${managedCommandId}/transitions`, {
      method: "POST", headers,
      body: JSON.stringify({ requestId: randomUUID(), action: "claim",
        claimGeneration: randomUUID(), now: -1 }),
    });
    assert.equal(gameCannotClaim.status, 403);
    const sourceClaim = await fetch(`${origin}/v1/managed-commands/${managedCommandId}/transitions`, {
      method: "POST",
      headers: { authorization: `Bearer ${sourceToken}`, "content-type": "application/json" },
      body: JSON.stringify({ requestId: "a38e6d45-f9d8-5f19-b440-32787e9c85c7", action: "claim",
        claimGeneration: randomUUID(), now: -1 }),
    });
    const claimPayload = await sourceClaim.json();
    assert.equal(claimPayload.state, "claimed");
    const retentionRequest = await fetch(`${origin}/v1/admin/history/seal`, {
      method: "POST",headers: operatorHeaders,
      body: JSON.stringify({
        commandId: "dff14c79-4273-50a7-9d38-51d7f6c0d32b",runId: randomUUID(),
      }),
    });
    assert.notEqual(retentionRequest.status,400,
      "the production retention client's deterministic UUIDv5 must reach the owner boundary");
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
