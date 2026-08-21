const DIGEST_IMAGE = /^(?:sha256:[0-9a-f]{64}|[a-z0-9]+(?:[._/-][a-z0-9]+)*(?::[a-zA-Z0-9._-]+)?@sha256:[0-9a-f]{64})$/u;

export const DEPLOYMENT_PATHS = Object.freeze({
  CANNABEATS_CADDY_DATA_DIR: '/var/lib/cannabeats-caddy/data',
  CANNABEATS_CADDY_CONFIG_DIR: '/var/lib/cannabeats-caddy/config',
  CANNABEATS_DATA_DIR: '/var/lib/cannabeats',
  CANNABEATS_RELAY_INGEST_TOKEN_HOST_FILE:
    '/etc/cannabeats/secrets/relay-ingest-token',
  CANNABEATS_RELAY_LISTEN_TOKEN_HOST_FILE:
    '/etc/cannabeats/secrets/relay-listen-token',
});

export const DEPLOYMENT_IMAGE_NAMES = Object.freeze([
  'CANNABEATS_CADDY_IMAGE', 'CANNABEATS_WEB_IMAGE', 'CANNABEATS_RELAY_IMAGE',
]);

export function validateDeploymentEnvironment(environment) {
  const issues = [];
  for (const name of DEPLOYMENT_IMAGE_NAMES) {
    const value = environment?.[name];
    if (typeof value !== 'string' || !value) issues.push({ code: 'missing', name });
    else if (!DIGEST_IMAGE.test(value)) issues.push({ code: 'invalid', name });
  }
  for (const [name, expected] of Object.entries(DEPLOYMENT_PATHS)) {
    const value = environment?.[name];
    if (typeof value !== 'string' || !value) issues.push({ code: 'missing', name });
    else if (value !== expected) issues.push({ code: 'invalid', name });
  }
  return Object.freeze({
    status: issues.length ? 'invalid' : 'valid',
    issues: Object.freeze(issues.map(Object.freeze)),
  });
}
