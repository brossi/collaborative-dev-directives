const VOLUME_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
const PROJECT_NAME = /^[a-z0-9][a-z0-9_-]{0,62}$/;

export class E73TopologyError extends Error {
  constructor(code) {
    super(code);
    this.name = 'E73TopologyError';
    this.code = code;
  }
}

function fail(code) {
  throw new E73TopologyError(code);
}

function volumeName(value) {
  if (typeof value !== 'string' || !VOLUME_NAME.test(value)) fail('volume_identity_invalid');
  return value;
}

export function volumeTopologyFromEnvironment(environment = process.env) {
  return Object.freeze({
    diagnostics: environment.CANNABEATS_DIAGNOSTICS_DATA_VOLUME
      || 'cannabeats_diagnostics_data',
    access: environment.CANNABEATS_DATA_VOLUME || 'cannabeats_poc_data',
    state: environment.CANNABEATS_STATE_DATA_VOLUME || 'cannabeats_state_data',
  });
}

export function validateDiagnosticVolumeTopology(input) {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    fail('volume_identity_invalid');
  }
  const topology = Object.freeze({
    diagnostics: volumeName(input.diagnostics),
    access: volumeName(input.access),
    state: volumeName(input.state),
  });
  if (new Set(Object.values(topology)).size !== 3) fail('volume_identity_conflict');
  return topology;
}

export function validateDiagnosticVolumeDisposal({
  project,
  volume,
  labels,
  attachedContainerIds,
  topology,
}) {
  const resolved = validateDiagnosticVolumeTopology(topology);
  if (typeof project !== 'string' || !PROJECT_NAME.test(project)
    || volumeName(volume) !== resolved.diagnostics
    || labels === null || typeof labels !== 'object' || Array.isArray(labels)
    || labels['com.docker.compose.project'] !== project
    || labels['com.docker.compose.volume'] !== 'cannabeats_diagnostics_data'
    || !Array.isArray(attachedContainerIds)
    || attachedContainerIds.some((id) => typeof id !== 'string' || id.length === 0)) {
    fail('volume_disposal_refused');
  }
  if (attachedContainerIds.length !== 0) fail('volume_in_use');
  return Object.freeze({ project, volume });
}
