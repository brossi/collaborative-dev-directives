#!/usr/bin/env node
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

const command = process.argv[2];
const action = process.argv[3];
const argument = (name, fallback) => {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? fallback : process.argv[index + 1];
};
const origin = new URL(process.env.CANNABEATS_STATE_SERVICE_ORIGIN ?? "http://state:3010").origin;
const token = (process.env.CANNABEATS_STATE_OPERATOR_TOKEN
  ?? readFileSync(process.env.CANNABEATS_STATE_OPERATOR_TOKEN_FILE, "utf8")).trim();
const requestId = (label) => {
  const bytes = Buffer.from(createHash("sha256").update(label).digest("hex").slice(0,32),"hex");
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}`;
};
async function state(pathname, { method = "GET",body } = {}) {
  const response = await fetch(`${origin}${pathname}`, {
    method,headers: { authorization: `Bearer ${token}`,"content-type": "application/json" },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const payload = await response.json();
  if (!response.ok) throw new Error(`State operation failed with ${payload.code ?? response.status}.`);
  return payload;
}

if (command === "operator" && action === "status") {
  const [validation,report] = await Promise.all([
    state("/v1/admin/validate"),state("/v1/admin/report?sinceHours=24"),
  ]);
  console.log(JSON.stringify({ validation,report }));
  process.exit(0);
}
if (command !== "history" || action !== "purge") {
  throw new Error("Usage: node scripts/operations.mjs history purge --retention-days 90 | operator status");
}
const retentionDays = Number(argument("retention-days",90));
if (!Number.isInteger(retentionDays) || retentionDays < 1 || retentionDays > 365) {
  throw new Error("Retention days must be an integer between 1 and 365.");
}
const eligibleBefore = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
const { candidates } = await state(
  `/v1/admin/history/candidates?eligibleBefore=${eligibleBefore}`,
);
const results = [];
for (const candidate of candidates) {
  if (candidate.lifecycle === "terminal_pending") {
    await state("/v1/admin/history/seal", {
      method: "POST",body: {
        commandId: requestId(`seal:${candidate.runId}`),runId: candidate.runId,
      },
    });
  }
  const purged = await state("/v1/admin/history/purge", {
    method: "POST",body: {
      commandId: requestId(`purge:${candidate.runId}:${eligibleBefore}`),
      runId: candidate.runId,eligibleBefore,
    },
  });
  results.push(purged);
}
console.log(JSON.stringify({ eligibleBefore,candidates: candidates.length,results }));
