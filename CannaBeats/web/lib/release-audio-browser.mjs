import { E5BrowserSession } from './s2e-e5-browser-session.mjs';

export const RELEASE_AUDIO_CONTRACT_HEADER = 'x-cannabeats-audio-contract';
export const RELEASE_AUDIO_CONTRACT_VERSION = '1';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

export function createReleaseAudioBrowserSession({
  gameId, audioSessionId, basePath = '', workletUrl = '/s2e-e4-worklet.js',
  client, dependencies, onStatus, Session = E5BrowserSession,
}) {
  if (!UUID_PATTERN.test(gameId ?? '') || !UUID_PATTERN.test(audioSessionId ?? '')
      || typeof basePath !== 'string' || (basePath && !basePath.startsWith('/'))
      || !dependencies || typeof dependencies.fetch !== 'function') {
    throw new Error('release_audio_session_invalid');
  }
  const path = `${basePath}/api/games/${gameId}/audio/sessions/${audioSessionId}/listen`;
  const guardedDependencies = {
    ...dependencies,
    fetch: (url, options = {}) => {
      if (url !== path || options.headers !== undefined) {
        throw new Error('release_audio_request_invalid');
      }
      return dependencies.fetch(url, {
        ...options,
        credentials: 'same-origin',
        headers: { [RELEASE_AUDIO_CONTRACT_HEADER]: RELEASE_AUDIO_CONTRACT_VERSION },
      });
    },
  };
  return new Session({ streamUrl: path, workletUrl, client, dependencies: guardedDependencies,
    onStatus });
}
