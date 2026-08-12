import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { StateOwner } from "./owner.mjs";
import { loadCatalogGameServices } from "./catalog.mjs";
import { STATE_SCHEMA_GENERATION } from "./schema.mjs";

const MAX_BODY_BYTES = 64 * 1024;

function bearerMatches(header, expected) {
  if (!header?.startsWith("Bearer ")) return false;
  const supplied = Buffer.from(header.slice(7));
  const wanted = Buffer.from(expected);
  return supplied.length === wanted.length && timingSafeEqual(supplied, wanted);
}

async function readJson(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new Error("Request body is too large.");
    chunks.push(chunk);
  }
  if (!size) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function writeJson(response, status, payload) {
  const body = JSON.stringify(payload);
  response.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store",
  });
  response.end(body);
}

function tokenHash(value) {
  return createHash("sha256").update(value).digest("hex");
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function requireRequestId(body, field) {
  if (!UUID_PATTERN.test(body?.[field] ?? "")) {
    throw new Error(`${field} must be a caller-persisted canonical UUID.`);
  }
}

function validPrincipalAssertion(request, principalId, { key, issuer, scope, now }) {
  const supplied = request.headers["x-cannabeats-principal-signature"];
  const suppliedIssuer = request.headers["x-cannabeats-principal-issuer"];
  const expiresAt = Number(request.headers["x-cannabeats-principal-expires-at"]);
  if (typeof principalId !== "string" || !principalId || typeof supplied !== "string"
      || suppliedIssuer !== issuer || !Number.isSafeInteger(expiresAt)
      || expiresAt < now || expiresAt > now + 60_000) return false;
  const claim = `${issuer}\ncannabeats-state\n${scope}\n${principalId}\n${expiresAt}`;
  const expected = createHmac("sha256", key).update(claim).digest("hex");
  return supplied.length === expected.length
    && timingSafeEqual(Buffer.from(supplied), Buffer.from(expected));
}

export function createStateServer({
  databasePath, lockDirectory, credentials, clock = Date.now, gameServices,
  allowDevelopmentActivation = false,
}) {
  const required = [
    "activationToken", "operatorToken", "accessToken", "gameToken",
    "accessPrincipalAssertionKey", "gamePrincipalAssertionKey",
  ];
  if (!credentials || required.some((name) => !credentials[name])) {
    throw new Error("Scoped state-service credentials are required.");
  }
  if (new Set(required.map((name) => credentials[name])).size !== required.length) {
    throw new Error("Scoped state-service credentials must be distinct.");
  }
  const owner = new StateOwner(databasePath, {
    ...gameServices, allowDevelopmentActivation, lockDirectory,
  });
  try {
    owner.assertManagedSourceCredentialSeparation(required.map((name) => tokenHash(credentials[name])));
  } catch (error) {
    owner.close();
    throw error;
  }
  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url, "http://state.internal");
      if (request.method === "GET" && url.pathname === "/ready") {
        const readiness = owner.readiness();
        return writeJson(response, 200, {
          ready: true, schemaGeneration: STATE_SCHEMA_GENERATION, protocolVersion: 3,
          authority: readiness.authority, sanitizationPending: readiness.sanitizationPending,
        });
      }
      const body = await readJson(request);
      const principalId = request.headers["x-cannabeats-principal"];
      const now = clock();
      if (!Number.isSafeInteger(now) || now <= 0) throw new Error("State service clock is invalid.");
      const gameCaller = () => bearerMatches(request.headers.authorization, credentials.gameToken);
      const accessCaller = () => bearerMatches(request.headers.authorization, credentials.accessToken);
      const operatorCaller = () => bearerMatches(request.headers.authorization, credentials.operatorToken);
      const activationCaller = () => bearerMatches(request.headers.authorization, credentials.activationToken);
      const requireCaller = (accepted) => {
        if (!accepted()) {
          writeJson(response, request.headers.authorization ? 403 : 401, {
            code: request.headers.authorization ? "forbidden" : "unauthorized",
          });
          return false;
        }
        return true;
      };
      const requirePrincipal = (scope) => {
        const assertion = scope === "access"
          ? { key: credentials.accessPrincipalAssertionKey, issuer: "access", scope, now }
          : { key: credentials.gamePrincipalAssertionKey, issuer: "game", scope, now };
        if (!validPrincipalAssertion(request, principalId, assertion)) {
          writeJson(response, 403, { code: "principal_assertion_invalid" });
          return false;
        }
        return true;
      };
      if (request.method === "POST" && url.pathname === "/v1/admin/activate") {
        if (!requireCaller(activationCaller)) return;
        requireRequestId(body, "commandId");
        const developmentActivation = allowDevelopmentActivation
          && body.expectedSourceDigest == null && body.expectedCandidateDigest == null
          && body.releaseEpoch === "development";
        if (!developmentActivation && (![body.expectedSourceDigest,body.expectedCandidateDigest]
          .every((value) => typeof value === "string" && /^[0-9a-f]{64}$/i.test(value))
          || body.expectedSchemaGeneration !== 2 || body.expectedProtocolVersion !== 3
          || typeof body.releaseEpoch !== "string" || !body.releaseEpoch.trim())) {
          throw new Error("Activation requires the exact published migration and release contract.");
        }
        return writeJson(response, 200, owner.activate({
          commandId: body.commandId,
          expectedSourceDigest: body.expectedSourceDigest,
          expectedCandidateDigest: body.expectedCandidateDigest,
          expectedSchemaGeneration: body.expectedSchemaGeneration,
          expectedProtocolVersion: body.expectedProtocolVersion,
          releaseEpoch: body.releaseEpoch,
          now,
        }));
      }
      if (request.method === "POST" && url.pathname === "/v1/lobbies") {
        if (!requireCaller(gameCaller)) return;
        if (!requirePrincipal("game")) return;
        requireRequestId(body, "commandId");
        return writeJson(response, 200, owner.createLobby({
          commandId: body.commandId, code: body.code, hostPrincipalId: principalId, now,
        }));
      }
      const runCollection = url.pathname.match(/^\/v1\/lobbies\/([^/]+)\/runs$/);
      if (request.method === "POST" && runCollection) {
        if (!requireCaller(gameCaller)) return;
        if (!requirePrincipal("game")) return;
        requireRequestId(body, "commandId");
        return writeJson(response, 200, owner.createRun({
          commandId: body.commandId, runId: body.runId, rules: body.rules, now,
          lobbyCode: runCollection[1], actorPrincipalId: principalId,
        }));
      }
      const lobbyResource = url.pathname.match(/^\/v1\/lobbies\/([^/]+)$/);
      if (request.method === "GET" && lobbyResource) {
        if (!requireCaller(gameCaller)) return;
        if (!requirePrincipal("game")) return;
        return writeJson(response, 200, owner.room({
          lobbyCode: lobbyResource[1], principalId,
        }));
      }
      const actionCollection = url.pathname.match(/^\/v1\/lobbies\/([^/]+)\/actions$/);
      if (request.method === "POST" && actionCollection) {
        if (!requireCaller(gameCaller)) return;
        if (!requirePrincipal("game")) return;
        requireRequestId(body, "actionId");
        return writeJson(response, 200, owner.applyGameCommand({
          actionId: body.actionId, expectedRunId: body.expectedRunId,
          expectedRunGeneration: body.expectedRunGeneration,
          expectedRevision: body.expectedRevision, command: body.command, now,
          lobbyCode: actionCollection[1], actorPrincipalId: principalId,
        }));
      }
      const admissionCollection = url.pathname.match(/^\/v1\/lobbies\/([^/]+)\/admissions$/);
      if (request.method === "POST" && admissionCollection) {
        if (!requireCaller(accessCaller)) return;
        if (!requirePrincipal("access")) return;
        requireRequestId(body, "actionId");
        return writeJson(response, 200, owner.admitPlayer({
          actionId: body.actionId, expectedRunId: body.expectedRunId,
          expectedRunGeneration: body.expectedRunGeneration,
          expectedRevision: body.expectedRevision, name: body.name, now,
          lobbyCode: admissionCollection[1], actorPrincipalId: principalId,
        }));
      }
      if (request.method === "POST" && url.pathname === "/v1/admin/managed-sources") {
        if (!requireCaller(operatorCaller)) return;
        requireRequestId(body, "commandId");
        if (required.some((name) => tokenHash(credentials[name]) === body.tokenHash)) {
          throw new Error("Managed source credential collides with a service credential scope.");
        }
        return writeJson(response, 200, owner.registerManagedSource({ ...body, now }));
      }
      if (request.method === "POST" && url.pathname === "/v1/admin/expire-managed-leases") {
        if (!requireCaller(operatorCaller)) return;
        requireRequestId(body, "commandId");
        return writeJson(response, 200, owner.expireManagedLeases({ commandId: body.commandId, now }));
      }
      if (request.method === "POST" && url.pathname === "/v1/admin/history/seal") {
        if (!requireCaller(operatorCaller)) return;
        requireRequestId(body, "commandId");
        return writeJson(response, 200, owner.sealHistory({ ...body, now }));
      }
      if (request.method === "POST" && url.pathname === "/v1/admin/history/purge") {
        if (!requireCaller(operatorCaller)) return;
        requireRequestId(body, "commandId");
        return writeJson(response, 200, owner.purgeHistory({ ...body, now }));
      }
      if (request.method === "POST" && url.pathname === "/v1/admin/history/sanitize") {
        if (!requireCaller(operatorCaller)) return;
        requireRequestId(body, "commandId");
        return writeJson(response, 200, owner.sanitizeHistory({
          commandId: body.commandId, runId: body.runId ?? null, now,
        }));
      }
      if (request.method === "GET" && url.pathname === "/v1/admin/validate") {
        if (!requireCaller(operatorCaller)) return;
        return writeJson(response, 200, owner.validate());
      }
      const leaseCollection = url.pathname.match(/^\/v1\/lobbies\/([^/]+)\/managed-lease$/);
      if (request.method === "POST" && leaseCollection) {
        if (!requireCaller(gameCaller)) return;
        if (!requirePrincipal("game")) return;
        requireRequestId(body, "commandId");
        return writeJson(response, 200, owner.acquireManagedLease({
          ...body, now, lobbyCode: leaseCollection[1], actorPrincipalId: principalId,
        }));
      }
      const leaseAction = url.pathname.match(/^\/v1\/managed-leases\/([^/]+)\/(renew|release)$/);
      if (request.method === "POST" && leaseAction) {
        if (!requireCaller(gameCaller)) return;
        if (!requirePrincipal("game")) return;
        requireRequestId(body, "commandId");
        const values = {
          commandId: body.commandId, leaseDurationMs: body.leaseDurationMs,
          now, leaseId: leaseAction[1], actorPrincipalId: principalId,
        };
        return writeJson(response, 200, leaseAction[2] === "renew"
          ? owner.renewManagedLease(values) : owner.releaseManagedLease(values));
      }
      if (request.method === "POST" && url.pathname === "/v1/managed-commands") {
        if (!requireCaller(gameCaller)) return;
        if (!requirePrincipal("game")) return;
        requireRequestId(body, "commandId");
        return writeJson(response, 200, owner.createManagedControl({
          ...body, now, requestedByPrincipalId: principalId,
        }));
      }
      if (request.method === "GET" && url.pathname === "/v1/source/work") {
        const authorization = request.headers.authorization ?? "";
        const bearer = authorization.startsWith("Bearer ") ? authorization.slice(7) : "";
        const authenticatedSourceId = bearer
          ? owner.managedSourceForTokenHash(tokenHash(bearer)) : null;
        if (!authenticatedSourceId) return writeJson(response, 403, { code: "source_forbidden" });
        return writeJson(response, 200, owner.managedSourceWork({ authenticatedSourceId, now }));
      }
      const transition = url.pathname.match(/^\/v1\/managed-commands\/([^/]+)\/transitions$/);
      if (request.method === "POST" && transition) {
        const authorization = request.headers.authorization ?? "";
        const bearer = authorization.startsWith("Bearer ") ? authorization.slice(7) : "";
        const authenticatedSourceId = bearer
          ? owner.managedSourceForTokenHash(tokenHash(bearer)) : null;
        if (!authenticatedSourceId) return writeJson(response, 403, { code: "source_forbidden" });
        requireRequestId(body, "requestId");
        return writeJson(response, 200, owner.transitionManagedCommand({
          ...body, now, authenticatedSourceId, commandId: transition[1],
        }));
      }
      return writeJson(response, 404, { code: "not_found" });
    } catch (error) {
      return writeJson(response, 409, {
        code: "state_command_rejected",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  });
  server.on("close", () => owner.close());
  return server;
}

export function startStateServerFromEnvironment() {
  const databasePath = process.env.CANNABEATS_STATE_DATABASE_PATH;
  const lockDirectory = process.env.CANNABEATS_STATE_LOCK_DIRECTORY;
  const activationTokenFile = process.env.CANNABEATS_STATE_ACTIVATION_TOKEN_FILE;
  const operatorTokenFile = process.env.CANNABEATS_STATE_OPERATOR_TOKEN_FILE;
  const accessTokenFile = process.env.CANNABEATS_STATE_ACCESS_TOKEN_FILE;
  const gameTokenFile = process.env.CANNABEATS_STATE_GAME_TOKEN_FILE;
  const accessPrincipalAssertionKeyFile = process.env.CANNABEATS_STATE_ACCESS_PRINCIPAL_ASSERTION_KEY_FILE;
  const gamePrincipalAssertionKeyFile = process.env.CANNABEATS_STATE_GAME_PRINCIPAL_ASSERTION_KEY_FILE;
  const catalogPath = process.env.CANNABEATS_STATE_CATALOG_PATH;
  if (!databasePath || !lockDirectory || !activationTokenFile || !operatorTokenFile || !accessTokenFile
      || !gameTokenFile || !accessPrincipalAssertionKeyFile
      || !gamePrincipalAssertionKeyFile || !catalogPath) {
    throw new Error("State database, catalog, and scoped credential files are required.");
  }
  const credentials = {
    activationToken: readFileSync(activationTokenFile, "utf8").trim(),
    operatorToken: readFileSync(operatorTokenFile, "utf8").trim(),
    accessToken: readFileSync(accessTokenFile, "utf8").trim(),
    gameToken: readFileSync(gameTokenFile, "utf8").trim(),
    accessPrincipalAssertionKey: readFileSync(accessPrincipalAssertionKeyFile, "utf8").trim(),
    gamePrincipalAssertionKey: readFileSync(gamePrincipalAssertionKeyFile, "utf8").trim(),
  };
  const port = Number(process.env.PORT || 3010);
  const server = createStateServer({
    databasePath, lockDirectory, credentials, gameServices: loadCatalogGameServices(catalogPath),
  });
  server.listen(port, "0.0.0.0", () => {
    process.stdout.write(`CannaBeats state service listening on ${port}\n`);
  });
  return server;
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
  startStateServerFromEnvironment();
}
