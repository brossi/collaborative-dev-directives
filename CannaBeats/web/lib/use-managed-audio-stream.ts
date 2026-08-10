"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { cannabeatsPath } from "./paths";

export type ManagedAudioStatus = "idle" | "connecting" | "waiting" | "buffering" | "playing" | "error";

const STATUS_LABELS: Record<ManagedAudioStatus, string> = {
  idle: "Shared audio is off",
  connecting: "Connecting to shared audio…",
  waiting: "Waiting for the Linux audio source…",
  buffering: "Shared audio is buffering…",
  playing: "Listening to shared audio",
  error: "Shared audio needs to reconnect",
};

export function useManagedAudioStream() {
  const [enabled, setEnabled] = useState(false);
  const [ready, setReady] = useState(false);
  const [status, setStatus] = useState<ManagedAudioStatus>("idle");
  const contextRef = useRef<AudioContext | null>(null);
  const nodeRef = useRef<AudioWorkletNode | null>(null);
  const controllerRef = useRef<AbortController | null>(null);
  const generationRef = useRef(0);

  const stop = useCallback(() => {
    generationRef.current += 1;
    controllerRef.current?.abort();
    controllerRef.current = null;
    nodeRef.current?.disconnect();
    nodeRef.current = null;
    const context = contextRef.current;
    contextRef.current = null;
    if (context) void context.close();
    setEnabled(false);
    setReady(false);
    setStatus("idle");
  }, []);

  const start = useCallback(async (code: string) => {
    stop();
    const generation = generationRef.current;
    setEnabled(true);
    setStatus("connecting");
    try {
      const context = new AudioContext({ latencyHint: "interactive" });
      contextRef.current = context;
      await context.resume();
      await context.audioWorklet.addModule(cannabeatsPath("/pcm-player-worklet.js"));
      if (generation !== generationRef.current) return;
      const node = new AudioWorkletNode(context, "cannabeats-pcm-player", {
        numberOfInputs: 0,
        numberOfOutputs: 1,
        outputChannelCount: [2],
      });
      node.connect(context.destination);
      node.port.onmessage = (event: MessageEvent<{ type?: string }>) => {
        if (generation !== generationRef.current) return;
        if (event.data.type === "playing") setStatus("playing");
        if (event.data.type === "buffering") setStatus((current) => current === "waiting" ? current : "buffering");
      };
      nodeRef.current = node;

      while (generation === generationRef.current) {
        const controller = new AbortController();
        controllerRef.current = controller;
        try {
          setStatus((current) => current === "playing" ? current : "connecting");
          const response = await fetch(`${cannabeatsPath("/api/audio-stream")}?${new URLSearchParams({ code })}`, {
            cache: "no-store",
            signal: controller.signal,
          });
          if (response.status === 503) {
            setStatus("waiting");
            await new Promise((resolve) => window.setTimeout(resolve, 1500));
            continue;
          }
          if (!response.ok || !response.body) throw new Error(`Shared audio request failed (${response.status}).`);
          const sampleRate = Number(response.headers.get("x-audio-rate"));
          const channels = Number(response.headers.get("x-audio-channels"));
          const encoding = response.headers.get("x-audio-encoding");
          if (!Number.isFinite(sampleRate) || sampleRate < 8000 || ![1, 2].includes(channels) || encoding !== "s16le") {
            throw new Error("The shared audio format is unsupported.");
          }
          node.port.postMessage({ type: "configure", sampleRate, channels });
          setReady(true);
          setStatus("buffering");
          const reader = response.body.getReader();
          let remainder = new Uint8Array(0);
          const bytesPerFrame = channels * 2;
          while (generation === generationRef.current) {
            const { done, value } = await reader.read();
            if (done) break;
            const combined = new Uint8Array(remainder.length + value.length);
            combined.set(remainder);
            combined.set(value, remainder.length);
            const alignedLength = combined.length - (combined.length % bytesPerFrame);
            if (alignedLength) {
              const pcm = combined.slice(0, alignedLength);
              node.port.postMessage({ type: "pcm", buffer: pcm.buffer }, [pcm.buffer]);
            }
            remainder = combined.slice(alignedLength);
          }
          setReady(false);
          node.port.postMessage({ type: "reset" });
        } catch (reason) {
          if (controller.signal.aborted || generation !== generationRef.current) return;
          const message = reason instanceof Error ? reason.message : "Shared audio failed.";
          if (/\((401|403|404|409)\)/.test(message) || message.includes("unsupported")) {
            setReady(false);
            setStatus("error");
            return;
          }
          setReady(false);
          setStatus("waiting");
        }
        if (generation === generationRef.current) {
          await new Promise((resolve) => window.setTimeout(resolve, 1500));
        }
      }
    } catch {
      if (generation === generationRef.current) {
        setReady(false);
        setStatus("error");
      }
    }
  }, [stop]);

  useEffect(() => stop, [stop]);

  return { enabled, ready, status, label: STATUS_LABELS[status], start, stop };
}
