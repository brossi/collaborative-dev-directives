"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { actionUuid } from "./game-request";
import { cannabeatsPath } from "./paths";
import { E5BrowserSession } from "./s2e-e5-browser-session.mjs";
import { createE6LocalCopy, projectE6LocalPanel } from "./s2e-e6-local-panel.mjs";

export type ManagedAudioStatus = "idle" | "connecting" | "waiting" | "buffering" | "playing" | "error";
export type ManagedAudioDiagnostics = ReturnType<typeof projectE6LocalPanel>;

const STATUS_LABELS: Record<ManagedAudioStatus, string> = {
  idle: "Shared audio is off",
  connecting: "Connecting to shared audio…",
  waiting: "Waiting for the Linux audio source…",
  buffering: "Shared audio is buffering…",
  playing: "Listening to shared audio",
  error: "Shared audio needs to reconnect",
};

function browserProfile() {
  const agent = navigator.userAgent;
  const match = agent.match(/(?:Chrome|CriOS)\/(\d+)/)
    ?? agent.match(/Firefox\/(\d+)/)
    ?? agent.match(/Version\/(\d+).*Safari/);
  const browserFamily = /(?:Chrome|CriOS)\//.test(agent) ? "chromium"
    : /Firefox\//.test(agent) ? "firefox"
      : /Safari\//.test(agent) && /Version\//.test(agent) ? "safari" : "other";
  const osFamily = /Android/.test(agent) ? "android"
    : /iPhone|iPad|iPod/.test(agent) ? "ios"
      : /Mac OS X/.test(agent) ? "macos"
        : /Windows/.test(agent) ? "windows"
          : /CrOS/.test(agent) ? "chromeos"
            : /Linux/.test(agent) ? "linux" : "other";
  const standalone = window.matchMedia?.("(display-mode: standalone)").matches === true;
  return {
    baseLatencyMs: { status: "unknown" },
    outputLatencyMs: { status: "unknown" },
    browserFamily,
    browserMajor: match ? { status: "observed", value: Number(match[1]) } : { status: "unknown" },
    osFamily,
    displayMode: standalone ? "standalone" : "browser",
    implementationVersion: 1,
  };
}

function observedLatency(seconds: unknown) {
  const milliseconds = typeof seconds === "number" ? seconds * 1000 : NaN;
  return Number.isFinite(milliseconds) && milliseconds >= 0 && milliseconds <= 60_000
    ? { status: "observed", value: milliseconds }
    : { status: "unsupported" };
}

export function useManagedAudioStream() {
  const [enabled, setEnabled] = useState(false);
  const [status, setStatus] = useState<ManagedAudioStatus>("idle");
  const sessionRef = useRef<InstanceType<typeof E5BrowserSession> | null>(null);
  const generationRef = useRef(0);

  const stop = useCallback(() => {
    generationRef.current += 1;
    const session = sessionRef.current;
    sessionRef.current = null;
    setEnabled(false);
    setStatus("idle");
    if (session) void session.stop("requested");
  }, []);

  const start = useCallback(async (code: string) => {
    generationRef.current += 1;
    const generation = generationRef.current;
    const priorSession = sessionRef.current;
    sessionRef.current = null;
    setEnabled(true);
    setStatus("connecting");
    if (priorSession) await priorSession.stop("requested");
    if (generation !== generationRef.current) return;
    const client = browserProfile();
    const supportsLongTasks = typeof PerformanceObserver !== "undefined"
      && PerformanceObserver.supportedEntryTypes?.includes("longtask");
    const dependencies = {
      now: () => performance.now(),
      uuid: () => actionUuid(),
      fetch: window.fetch.bind(window),
      createAbortController: () => new AbortController(),
      createAudioContext: async () => {
        const context = new AudioContext({ latencyHint: "interactive" });
        client.baseLatencyMs = observedLatency(context.baseLatency);
        client.outputLatencyMs = observedLatency((context as AudioContext & { outputLatency?: number }).outputLatency);
        return context;
      },
      createWorkletNode: (context: AudioContext) => new AudioWorkletNode(context, "cannabeats-e4-pcm-player", {
        numberOfInputs: 0,
        numberOfOutputs: 1,
        outputChannelCount: [2],
      }),
      scheduleTimeout: (callback: () => void, delay: number) => window.setTimeout(callback, delay),
      cancelTimeout: (timer: number) => window.clearTimeout(timer),
      visibilityTarget: document,
      ...(supportsLongTasks ? {
        createLongTaskObserver: (callback: (entries: PerformanceObserverEntryList) => void) => new PerformanceObserver(callback),
      } : {}),
    };
    const session = new E5BrowserSession({
      streamUrl: `${cannabeatsPath("/api/audio-stream")}?${new URLSearchParams({ code })}`,
      workletUrl: cannabeatsPath("/s2e-e4-worklet.js"),
      client,
      dependencies,
      onStatus: (next: string) => {
        if (generation !== generationRef.current) return;
        if (["connecting", "waiting", "buffering", "playing", "error"].includes(next)) {
          setStatus(next as ManagedAudioStatus);
        } else if (next === "stopped") {
          setStatus("idle");
          setEnabled(false);
        }
      },
    });
    sessionRef.current = session;
    try {
      await session.start();
      if (generation !== generationRef.current) await session.stop("requested");
    } catch {
      if (generation === generationRef.current) {
        sessionRef.current = null;
        setEnabled(false);
        setStatus("error");
      }
    }
  }, []);

  const diagnostics = useCallback((): ManagedAudioDiagnostics | null => {
    const session = sessionRef.current;
    if (!session?.lifecycle) return null;
    try {
      return projectE6LocalPanel({ status: session.status, lifecycle: session.lifecycle });
    } catch {
      return null;
    }
  }, []);

  const copyDiagnostics = useCallback(async () => {
    const session = sessionRef.current;
    if (!session?.lifecycle || !navigator.clipboard?.writeText) throw new Error("copy_failed");
    const copy = createE6LocalCopy({
      lifecycle: session.lifecycle,
      generatedAtMonotonicMs: performance.now(),
    });
    try {
      await navigator.clipboard.writeText(copy.text);
    } catch {
      throw new Error("copy_failed");
    }
    return "copied" as const;
  }, []);

  const resetDiagnostics = useCallback(async () => {
    const session = sessionRef.current;
    if (!session) throw new Error("reset_failed");
    try {
      await session.resetDiagnostics();
    } catch {
      throw new Error("reset_failed");
    }
    return "reset" as const;
  }, []);

  useEffect(() => () => {
    generationRef.current += 1;
    const session = sessionRef.current;
    sessionRef.current = null;
    if (session) void session.stop("page_teardown");
  }, []);

  const ready = status === "buffering" || status === "playing";
  return {
    enabled, ready, status, label: STATUS_LABELS[status], start, stop,
    diagnostics, copyDiagnostics, resetDiagnostics,
  };
}
