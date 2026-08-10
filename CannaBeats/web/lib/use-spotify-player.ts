"use client";

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";

type PlaybackStatus = "disconnected" | "connecting" | "ready" | "playing" | "paused" | "error";

type StoredToken = {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
};

type PendingAuthorization = {
  verifier: string;
  state: string;
};

export type SpotifyTrackArtwork = {
  imageUrl: string;
  spotifyUrl: string;
};

type SpotifyPlayer = {
  addListener(event: string, listener: (value: never) => void): boolean;
  activateElement(): Promise<void>;
  connect(): Promise<boolean>;
  disconnect(): void;
  pause(): Promise<void>;
  resume(): Promise<void>;
};

type SpotifyConstructor = new (options: {
  name: string;
  getOAuthToken: (callback: (token: string) => void) => void;
  volume: number;
  enableMediaSession: boolean;
}) => SpotifyPlayer;

declare global {
  interface Window {
    Spotify?: { Player: SpotifyConstructor };
    onSpotifyWebPlaybackSDKReady?: () => void;
  }
}

const TOKEN_KEY = "cannabeats-spotify-token";
const AUTH_KEY = "cannabeats-spotify-authorization";
const ACCESS_POC_REFRESH_KEY = "cannabeats.spotify.refreshToken";
const CALLBACK_RETURN_KEY = "cannabeats.spotify.gameCallbackReturn";
const CLIENT_ID = process.env.NEXT_PUBLIC_SPOTIFY_CLIENT_ID?.trim() ?? "";
const SCOPES = ["streaming", "user-read-email", "user-read-private", "user-modify-playback-state"];
const artworkCache = new Map<string, SpotifyTrackArtwork>();
const artworkRequests = new Map<string, Promise<SpotifyTrackArtwork | null>>();

function supportedOrigin() {
  if (typeof window === "undefined") return false;
  return window.location.protocol === "https:"
    || window.location.hostname === "127.0.0.1"
    || window.location.hostname === "::1";
}

function subscribeToOrigin() {
  return () => {};
}

function redirectUri() {
  return `${window.location.origin}/spotify/callback`;
}

function randomString(length = 64) {
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  return Array.from(bytes, (byte) => "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~"[byte % 66]).join("");
}

async function challengeFor(verifier: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return btoa(String.fromCharCode(...new Uint8Array(digest)))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
}

function storedToken(): StoredToken | null {
  const value = localStorage.getItem(TOKEN_KEY);
  if (!value) {
    const refreshToken = localStorage.getItem(ACCESS_POC_REFRESH_KEY)?.trim() ?? "";
    return refreshToken ? { accessToken: "", refreshToken, expiresAt: 0 } : null;
  }
  try {
    return JSON.parse(value) as StoredToken;
  } catch {
    localStorage.removeItem(TOKEN_KEY);
    return null;
  }
}

function saveToken(payload: { access_token: string; refresh_token?: string; expires_in: number }, previous?: StoredToken) {
  const token: StoredToken = {
    accessToken: payload.access_token,
    refreshToken: payload.refresh_token ?? previous?.refreshToken ?? "",
    expiresAt: Date.now() + payload.expires_in * 1000,
  };
  localStorage.setItem(TOKEN_KEY, JSON.stringify(token));
  if (token.refreshToken) localStorage.setItem(ACCESS_POC_REFRESH_KEY, token.refreshToken);
  return token;
}

async function freshAccessToken() {
  const token = storedToken();
  if (!token) throw new Error("Connect Spotify before starting the game.");
  if (token.expiresAt > Date.now() + 60_000) return token.accessToken;
  if (!token.refreshToken) throw new Error("Spotify authorization expired. Connect again.");

  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: token.refreshToken,
    client_id: CLIENT_ID,
  });
  const response = await fetch("https://accounts.spotify.com/api/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!response.ok) {
    localStorage.removeItem(TOKEN_KEY);
    throw new Error("Spotify authorization expired. Connect again.");
  }
  const payload = await response.json() as { access_token: string; refresh_token?: string; expires_in: number };
  return saveToken(payload, token).accessToken;
}

async function loadPlaybackSdk() {
  if (window.Spotify) return window.Spotify;
  return new Promise<NonNullable<Window["Spotify"]>>((resolve, reject) => {
    const previous = window.onSpotifyWebPlaybackSDKReady;
    window.onSpotifyWebPlaybackSDKReady = () => {
      previous?.();
      if (window.Spotify) resolve(window.Spotify);
      else reject(new Error("Spotify playback did not initialize."));
    };
    const existing = document.querySelector<HTMLScriptElement>('script[src="https://sdk.scdn.co/spotify-player.js"]');
    if (existing) return;
    const script = document.createElement("script");
    script.src = "https://sdk.scdn.co/spotify-player.js";
    script.async = true;
    script.onerror = () => reject(new Error("Unable to load Spotify playback."));
    document.head.append(script);
  });
}

export function useSpotifyPlayer() {
  const playerRef = useRef<SpotifyPlayer | null>(null);
  const deviceIdRef = useRef("");
  const shuttingDownRef = useRef(false);
  const [status, setStatus] = useState<PlaybackStatus>("disconnected");
  const [error, setError] = useState("");
  const [isReady, setIsReady] = useState(false);
  const isSupportedOrigin = useSyncExternalStore(subscribeToOrigin, supportedOrigin, () => false);

  const initialize = useCallback(async () => {
    if (playerRef.current || !storedToken()) return;
    shuttingDownRef.current = false;
    setStatus("connecting");
    const spotify = await loadPlaybackSdk();
    const player = new spotify.Player({
      name: "CannaBeats",
      getOAuthToken: (callback) => { void freshAccessToken().then(callback).catch((reason: Error) => setError(reason.message)); },
      volume: 0.8,
      enableMediaSession: false,
    });
    playerRef.current = player;
    player.addListener("ready", (({ device_id }: { device_id: string }) => {
      deviceIdRef.current = device_id;
      setIsReady(true);
      setStatus("ready");
      setError("");
    }) as (value: never) => void);
    player.addListener("not_ready", (() => {
      deviceIdRef.current = "";
      setIsReady(false);
      setStatus("disconnected");
    }) as (value: never) => void);
    player.addListener("player_state_changed", ((state: { paused: boolean } | null) => {
      if (state) setStatus(state.paused ? "paused" : "playing");
    }) as (value: never) => void);
    for (const event of ["initialization_error", "authentication_error", "account_error", "playback_error"]) {
      player.addListener(event, ((details: { message: string }) => {
        setError(details.message);
        setStatus("error");
      }) as (value: never) => void);
    }
    if (!await player.connect()) throw new Error("Spotify could not connect this browser.");
  }, []);

  const shutdown = useCallback(() => {
    if (shuttingDownRef.current) return;
    shuttingDownRef.current = true;
    const player = playerRef.current;
    const deviceId = deviceIdRef.current;
    const token = storedToken();

    if (player) {
      void player.pause().catch(() => {}).finally(() => player.disconnect());
    }
    if (deviceId && token?.accessToken) {
      void fetch(`https://api.spotify.com/v1/me/player/pause?device_id=${encodeURIComponent(deviceId)}`, {
        method: "PUT",
        headers: { authorization: `Bearer ${token.accessToken}` },
        keepalive: true,
      }).catch(() => {});
    }
    playerRef.current = null;
    deviceIdRef.current = "";
  }, []);

  useEffect(() => {
    if (!supportedOrigin() || !CLIENT_ID) return;
    const handlePageExit = () => shutdown();
    window.addEventListener("pagehide", handlePageExit);
    window.addEventListener("beforeunload", handlePageExit);
    const params = new URLSearchParams(window.location.search);
    const code = params.get("code");
    const returnedState = params.get("state");
    const authError = params.get("error");

    async function finishAuthorization() {
      if (authError) throw new Error("Spotify authorization was cancelled.");
      if (!code) {
        await initialize();
        return;
      }
      const saved = localStorage.getItem(AUTH_KEY);
      if (!saved) throw new Error("Spotify authorization could not be verified.");
      const pending = JSON.parse(saved) as PendingAuthorization;
      if (!returnedState || returnedState !== pending.state) throw new Error("Spotify authorization state did not match.");

      const response = await fetch("https://accounts.spotify.com/api/token", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          code,
          redirect_uri: redirectUri(),
          client_id: CLIENT_ID,
          code_verifier: pending.verifier,
        }),
      });
      if (!response.ok) throw new Error("Spotify did not accept the authorization response.");
      const payload = await response.json() as { access_token: string; refresh_token: string; expires_in: number };
      saveToken(payload);
      localStorage.removeItem(AUTH_KEY);
      localStorage.removeItem(CALLBACK_RETURN_KEY);
      window.history.replaceState({}, "", window.location.pathname);
      await initialize();
    }

    void finishAuthorization().catch((reason: Error) => {
      setError(reason.message);
      setStatus("error");
    });
    return () => {
      window.removeEventListener("pagehide", handlePageExit);
      window.removeEventListener("beforeunload", handlePageExit);
      shutdown();
      setIsReady(false);
    };
  }, [initialize, shutdown]);

  const connect = useCallback(async () => {
    setError("");
    if (!CLIENT_ID) {
      setError("Spotify is not configured for this build.");
      return;
    }
    if (!supportedOrigin()) {
      setError("Open the host screen at 127.0.0.1 to use blind Spotify playback.");
      return;
    }
    const verifier = randomString();
    const state = randomString(32);
    localStorage.setItem(AUTH_KEY, JSON.stringify({ verifier, state } satisfies PendingAuthorization));
    localStorage.setItem(CALLBACK_RETURN_KEY, window.location.pathname);
    const authorize = new URL("https://accounts.spotify.com/authorize");
    authorize.search = new URLSearchParams({
      client_id: CLIENT_ID,
      response_type: "code",
      redirect_uri: redirectUri(),
      code_challenge_method: "S256",
      code_challenge: await challengeFor(verifier),
      state,
      scope: SCOPES.join(" "),
    }).toString();
    window.location.assign(authorize);
  }, []);

  const play = useCallback(async (uri: string) => {
    const player = playerRef.current;
    const deviceId = deviceIdRef.current;
    if (!player || !deviceId) throw new Error("Spotify is not ready yet.");
    await player.activateElement();
    const response = await fetch(`https://api.spotify.com/v1/me/player/play?device_id=${encodeURIComponent(deviceId)}`, {
      method: "PUT",
      headers: {
        authorization: `Bearer ${await freshAccessToken()}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ uris: [uri] }),
    });
    if (!response.ok) throw new Error(`Spotify could not play this song (${response.status}).`);
    setStatus("playing");
  }, []);

  const pause = useCallback(async () => {
    if (!playerRef.current) throw new Error("Spotify is not ready yet.");
    await playerRef.current.pause();
    setStatus("paused");
  }, []);

  const stop = useCallback(async () => {
    if (!playerRef.current) return;
    await playerRef.current.pause();
    setStatus("paused");
  }, []);

  const resume = useCallback(async () => {
    if (!playerRef.current) throw new Error("Spotify is not ready yet.");
    await playerRef.current.activateElement();
    await playerRef.current.resume();
    setStatus("playing");
  }, []);

  const trackArtwork = useCallback(async (uri: string) => {
    const cached = artworkCache.get(uri);
    if (cached) return cached;
    const pending = artworkRequests.get(uri);
    if (pending) return pending;
    const uriParts = uri.split(":");
    const trackId = uriParts.length === 3 && uriParts[0] === "spotify" && uriParts[1] === "track" ? uriParts[2] : "";
    if (!trackId) return null;

    const request = (async () => {
      try {
        const response = await fetch(`https://api.spotify.com/v1/tracks/${encodeURIComponent(trackId)}`, {
          headers: { authorization: `Bearer ${await freshAccessToken()}` },
        });
        if (!response.ok) return null;
        const payload = await response.json() as {
          album: { images: Array<{ url: string; width: number | null; height: number | null }> };
          external_urls: { spotify?: string };
        };
        const image = payload.album.images.find((candidate) => (candidate.width ?? 0) >= 200 && (candidate.width ?? 0) <= 400)
          ?? payload.album.images[0];
        if (!image) return null;
        const artwork = {
          imageUrl: image.url,
          spotifyUrl: payload.external_urls.spotify ?? `https://open.spotify.com/track/${trackId}`,
        };
        artworkCache.set(uri, artwork);
        return artwork;
      } catch {
        return null;
      } finally {
        artworkRequests.delete(uri);
      }
    })();
    artworkRequests.set(uri, request);
    return request;
  }, []);

  return {
    connect,
    error,
    isConfigured: Boolean(CLIENT_ID),
    isReady,
    pause,
    play,
    resume,
    stop,
    status,
    supportedOrigin: isSupportedOrigin,
    trackArtwork,
  };
}
