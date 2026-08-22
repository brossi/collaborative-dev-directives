import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadCatalogArtifacts } from './catalog.mjs';
import {
  ReleaseStoreError, createReleaseStore, releaseStoreErrorCode,
} from './store.mjs';

const serverDirectory = dirname(fileURLToPath(import.meta.url));
const defaultCatalogPath = resolve(serverDirectory, '../../../data/catalog.json');
const defaultManifestPath = resolve(serverDirectory, '../../../data/catalog-manifest.json');
const FINITE_REASONS = new Set([
  'database_unavailable', 'database_incompatible', 'database_corrupt',
  'database_capacity', 'catalog_incompatible',
]);
const globalRuntime = globalThis;

export function unifiedRuntimeEnabled(environment = process.env) {
  return environment.CANNABEATS_RUNTIME === 'unified';
}

function finiteReason(error) {
  const candidate = releaseStoreErrorCode(error) ?? error?.message;
  return FINITE_REASONS.has(candidate) ? candidate : 'database_unavailable';
}

export function createReleaseRuntime({
  databasePath,
  catalogPath = defaultCatalogPath,
  manifestPath = defaultManifestPath,
  now = Date.now(),
  loadCatalog = loadCatalogArtifacts,
  createStore = createReleaseStore,
  storeOptions = {},
}) {
  let store = null;
  let initializationReason = null;
  try {
    if (typeof databasePath !== 'string' || !databasePath) {
      throw new ReleaseStoreError('database_unavailable');
    }
    const catalog = loadCatalog({ catalogPath, manifestPath });
    store = createStore(databasePath, { catalog, now, ...storeOptions });
  } catch (error) {
    initializationReason = finiteReason(error);
  }
  let closed = false;
  const owner = () => {
    if (closed || !store) throw new ReleaseStoreError(initializationReason ?? 'database_unavailable');
    return store;
  };
  return Object.freeze({
    health() {
      return Object.freeze({ ok: true, service: 'cannabeats' });
    },
    readiness() {
      if (closed || !store) {
        return Object.freeze({ ready: false, reason: initializationReason ?? 'database_unavailable' });
      }
      const result = store.readiness();
      return result.ready
        ? Object.freeze({
          ready: true,
          reason: 'ready',
          service: 'cannabeats',
          schemaGeneration: result.schemaGeneration,
          catalogVersion: result.catalogVersion,
        })
        : Object.freeze({ ready: false, reason: finiteReason({ message: result.reason }) });
    },
    close() {
      if (closed) return;
      closed = true;
      store?.close();
      store = null;
    },
    issueEnrollment(input) { return owner().issueEnrollment(input); },
    redeemEnrollment(input) { return owner().redeemEnrollment(input); },
    issueHostChallenge(input) { return owner().issueHostChallenge(input); },
    proveHostChallenge(input) { return owner().proveHostChallenge(input); },
    issueHostWebTicket(input) { return owner().issueHostWebTicket(input); },
    exchangeHostWebTicket(input) { return owner().exchangeHostWebTicket(input); },
    revokeHostDevice(input) { return owner().revokeHostDevice(input); },
    operatorRevokeHostDevice(input) { return owner().operatorRevokeHostDevice(input); },
    authorizeHostSession(input) { return owner().authorizeHostSession(input); },
    listHostDevices(input) { return owner().listHostDevices(input); },
    createAuthorizedGame(input) { return owner().createAuthorizedGame(input); },
    issueGameInvitation(input) { return owner().issueGameInvitation(input); },
    revokeGameInvitation(input) { return owner().revokeGameInvitation(input); },
    admitParticipant(input) { return owner().admitParticipant(input); },
    removeParticipant(input) { return owner().removeParticipant(input); },
    terminateGame(input) { return owner().terminateGame(input); },
    authorizeParticipantSession(input) { return owner().authorizeParticipantSession(input); },
    participantSnapshot(input) { return owner().participantSnapshot(input); },
    hostGameSnapshot(input) { return owner().hostGameSnapshot(input); },
    recoverHostGame(input) { return owner().recoverHostGame(input); },
    applyHostGameAction(input) { return owner().applyHostGameAction(input); },
    applyParticipantGameAction(input) { return owner().applyParticipantGameAction(input); },
    nextPlaybackCommand(input) { return owner().nextPlaybackCommand(input); },
    transitionPlaybackCommand(input) { return owner().transitionPlaybackCommand(input); },
    openAudioSession(input) { return owner().openAudioSession(input); },
    currentAudioSession(input) { return owner().currentAudioSession(input); },
    claimAudioIngest(input) { return owner().claimAudioIngest(input); },
    activateAudioIngest(input) { return owner().activateAudioIngest(input); },
    interruptAudioIngest(input) { return owner().interruptAudioIngest(input); },
    endAudioSession(input) { return owner().endAudioSession(input); },
    authorizeAudioHostStream(input) { return owner().authorizeAudioHostStream(input); },
    authorizeAudioParticipantStream(input) {
      return owner().authorizeAudioParticipantStream(input);
    },
    recordDiagnostic(input) { return owner().recordDiagnostic(input); },
    exportDiagnostics(input) { return owner().exportDiagnostics(input); },
    operatorPurgeDiagnostics(input) { return owner().operatorPurgeDiagnostics(input); },
    operatorStatus() { return owner().operatorStatus(); },
    operatorActiveGameSummary() { return owner().operatorActiveGameSummary(); },
  });
}

export function releaseRuntime(environment = process.env) {
  if (!unifiedRuntimeEnabled(environment)) {
    throw new ReleaseStoreError('database_unavailable');
  }
  if (!globalRuntime.__cannabeatsUnifiedRuntime) {
    globalRuntime.__cannabeatsUnifiedRuntime = createReleaseRuntime({
      databasePath: environment.CANNABEATS_DATABASE_PATH,
    });
  }
  return globalRuntime.__cannabeatsUnifiedRuntime;
}

export function closeReleaseRuntime() {
  globalRuntime.__cannabeatsUnifiedRuntime?.close();
  delete globalRuntime.__cannabeatsUnifiedRuntime;
}
