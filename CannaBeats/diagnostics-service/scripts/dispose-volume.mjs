import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

import {
  E73TopologyError,
  validateDiagnosticVolumeDisposal,
  volumeTopologyFromEnvironment,
} from '../src/topology.mjs';

function docker(args) {
  const result = spawnSync('docker', args, { encoding: 'utf8' });
  if (result.error || result.status !== 0) throw new E73TopologyError('docker_operation_failed');
  return result.stdout.trim();
}

function argument(name, args) {
  const index = args.indexOf(name);
  if (index < 0 || index + 1 >= args.length || args[index + 1].startsWith('--')) {
    throw new E73TopologyError('volume_disposal_refused');
  }
  return args[index + 1];
}

export function disposeDiagnosticVolume({
  project,
  volume,
  environment = process.env,
  runDocker = docker,
}) {
  let inspected;
  try {
    inspected = JSON.parse(runDocker(['volume', 'inspect', volume, '--format', '{{json .}}']));
  } catch (error) {
    if (error instanceof E73TopologyError) throw error;
    throw new E73TopologyError('volume_disposal_refused');
  }
  const attached = runDocker([
    'ps', '-a', '--filter', `volume=${volume}`, '--format', '{{.ID}}',
  ]).split('\n').filter(Boolean);
  validateDiagnosticVolumeDisposal({
    project,
    volume,
    labels: inspected.Labels,
    attachedContainerIds: attached,
    topology: volumeTopologyFromEnvironment(environment),
  });
  runDocker(['volume', 'rm', volume]);
  return Object.freeze({ status: 'disposed' });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const result = disposeDiagnosticVolume({
      project: argument('--project', process.argv.slice(2)),
      volume: argument('--volume', process.argv.slice(2)),
    });
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    const code = error instanceof E73TopologyError ? error.code : 'volume_disposal_refused';
    process.stderr.write(`${JSON.stringify({ status: 'refused', code })}\n`);
    process.exitCode = 1;
  }
}
