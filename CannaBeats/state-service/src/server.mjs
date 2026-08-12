import { timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { StateOwner } from "./owner.mjs";

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

export function createStateServer({ databasePath, serviceToken }) {
  if (!serviceToken) throw new Error("State service token is required.");
  const owner = new StateOwner(databasePath);
  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url, "http://state.internal");
      if (request.method === "GET" && url.pathname === "/ready") {
        return writeJson(response, 200, {
          ready: true, schemaGeneration: 1, protocolVersion: 2,
          authority: owner.authorityStatus(),
        });
      }
      if (!bearerMatches(request.headers.authorization, serviceToken)) {
        return writeJson(response, 401, { code: "unauthorized" });
      }
      const body = await readJson(request);
      const principalId = request.headers["x-cannabeats-principal"];
      if (request.method === "POST" && url.pathname === "/v1/admin/activate") {
        return writeJson(response, 200, owner.activate(body));
      }
      if (request.method === "POST" && url.pathname === "/v1/lobbies") {
        if (typeof principalId !== "string" || !principalId) {
          return writeJson(response, 400, { code: "principal_required" });
        }
        return writeJson(response, 200, owner.createLobby({
          commandId: body.commandId, code: body.code, hostPrincipalId: principalId,
        }));
      }
      if (request.method === "POST" && url.pathname === "/v1/admin/managed-sources") {
        return writeJson(response, 200, owner.registerManagedSource(body));
      }
      if (request.method === "POST" && url.pathname === "/v1/managed-commands") {
        if (typeof principalId !== "string" || !principalId) {
          return writeJson(response, 400, { code: "principal_required" });
        }
        return writeJson(response, 200, owner.createManagedCommand({
          ...body, requestedByPrincipalId: principalId,
        }));
      }
      const transition = url.pathname.match(/^\/v1\/managed-commands\/([^/]+)\/transitions$/);
      if (request.method === "POST" && transition) {
        return writeJson(response, 200, owner.transitionManagedCommand({
          ...body, commandId: transition[1],
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
  const tokenFile = process.env.CANNABEATS_STATE_SERVICE_TOKEN_FILE;
  if (!databasePath || !tokenFile) {
    throw new Error("CANNABEATS_STATE_DATABASE_PATH and CANNABEATS_STATE_SERVICE_TOKEN_FILE are required.");
  }
  const serviceToken = readFileSync(tokenFile, "utf8").trim();
  const port = Number(process.env.PORT || 3010);
  const server = createStateServer({ databasePath, serviceToken });
  server.listen(port, "0.0.0.0", () => {
    process.stdout.write(`CannaBeats state service listening on ${port}\n`);
  });
  return server;
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
  startStateServerFromEnvironment();
}
