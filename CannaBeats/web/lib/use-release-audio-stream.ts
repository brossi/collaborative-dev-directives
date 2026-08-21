"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { actionUuid } from "./game-request";
import { CANNABEATS_BASE_PATH } from "./paths";
import { createReleaseAudioBrowserSession } from "./release-audio-browser.mjs";

export type ReleaseAudioStatus = "idle" | "connecting" | "waiting" | "buffering" | "playing" | "error";

const LABELS: Record<ReleaseAudioStatus, string> = {
  idle: "Shared audio is off",
  connecting: "Connecting to shared audio…",
  waiting: "Waiting for the Host audio…",
  buffering: "Shared audio is buffering…",
  playing: "Listening to shared audio",
  error: "Shared audio needs to reconnect",
};

export function useReleaseAudioStream({
  gameId, audioSessionId,
}: { gameId: string; audioSessionId: string | null }) {
  const [status, setStatus] = useState<ReleaseAudioStatus>("idle");
  const sessionRef = useRef<{ start(): Promise<unknown>; stop(reason?: string): Promise<unknown> } | null>(null);
  const identityRef = useRef<string | null>(null);
  const generationRef = useRef(0);

  const stop = useCallback(() => {
    generationRef.current += 1;
    const session = sessionRef.current;
    sessionRef.current = null;
    identityRef.current = null;
    setStatus("idle");
    if (session) void session.stop("requested");
  }, []);

  const start = useCallback(async () => {
    if (!audioSessionId) { setStatus("waiting"); return; }
    const generation = ++generationRef.current;
    const previous = sessionRef.current;
    sessionRef.current = null;
    if (previous) await previous.stop("requested");
    if (generation !== generationRef.current) return;
    setStatus("connecting");
    const contextProfile = {
      baseLatencyMs: { status: "unknown" }, outputLatencyMs: { status: "unknown" },
      browserFamily: "other", browserMajor: { status: "unknown" }, osFamily: "other",
      displayMode: "browser", implementationVersion: 1,
    };
    const supportsLongTasks = typeof PerformanceObserver !== "undefined"
      && PerformanceObserver.supportedEntryTypes?.includes("longtask");
    const dependencies = {
      now: () => performance.now(), uuid: () => actionUuid(), fetch: window.fetch.bind(window),
      createAbortController: () => new AbortController(),
      createAudioContext: async () => new AudioContext({ latencyHint: "interactive" }),
      createWorkletNode: (context: AudioContext) => new AudioWorkletNode(
        context, "cannabeats-e4-pcm-player",
        { numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [2] },
      ),
      scheduleTimeout: (callback: () => void, delay: number) => window.setTimeout(callback, delay),
      cancelTimeout: (timer: number) => window.clearTimeout(timer), visibilityTarget: document,
      ...(supportsLongTasks ? {
        createLongTaskObserver: (callback: (entries: PerformanceObserverEntryList) => void) =>
          new PerformanceObserver(callback),
      } : {}),
    };
    try {
      const session = createReleaseAudioBrowserSession({
        gameId, audioSessionId, basePath: CANNABEATS_BASE_PATH,
        workletUrl: `${CANNABEATS_BASE_PATH}/s2e-e4-worklet.js`, client: contextProfile,
        dependencies, onStatus: (next: string) => {
          if (generation !== generationRef.current) return;
          if (["connecting", "waiting", "buffering", "playing", "error"].includes(next)) {
            setStatus(next as ReleaseAudioStatus);
          } else if (next === "stopped") {
            sessionRef.current = null;
            identityRef.current = null;
            setStatus("idle");
          }
        },
      });
      sessionRef.current = session;
      identityRef.current = `${gameId}:${audioSessionId}`;
      await session.start();
      if (generation !== generationRef.current) await session.stop("requested");
    } catch {
      if (generation === generationRef.current) {
        sessionRef.current = null;
        setStatus("error");
      }
    }
  }, [audioSessionId, gameId]);

  useEffect(() => {
    const expected = audioSessionId ? `${gameId}:${audioSessionId}` : null;
    if (sessionRef.current && identityRef.current !== expected) {
      stop();
    }
  }, [audioSessionId, gameId, stop]);

  useEffect(() => () => {
    generationRef.current += 1;
    const session = sessionRef.current;
    sessionRef.current = null;
    identityRef.current = null;
    if (session) void session.stop("page_teardown");
  }, []);

  const effectiveStatus = !audioSessionId && status !== "idle" ? "waiting" : status;
  return {
    status: effectiveStatus, label: LABELS[effectiveStatus],
    enabled: effectiveStatus !== "idle", start, stop,
  };
}
