"use client";

import { FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import QRCode from "qrcode";
import type { AudioControlView, Player, RoomView } from "../lib/game";
import { CATALOG_YEAR_MAX, CATALOG_YEAR_MIN, ERA_BUCKETS, RULE_PRESET_OPTIONS, rulesForPreset, type GameRules } from "../lib/rules";
import { HOST_RULES_KEY, PLAYER_NAME_KEY, SESSION_KEY, type GameSession } from "../lib/session";
import {
  clearPendingGameIntent,
  commitGamePayload,
  commitJoinResult,
  commitRecoveryResult,
  commitRoomSnapshot,
  GameApiError,
  loadPendingGameIntent,
  reconcilePendingGameRequest,
  requestGame,
  savePendingGameIntent,
  type RoomSnapshotCursor,
} from "../lib/game-request";
import { useSpotifyPlayer, type SpotifyTrackArtwork } from "../lib/use-spotify-player";
import { useManagedAudioStream, type ManagedAudioDiagnostics, type ManagedAudioSharing, type ManagedAudioStatus } from "../lib/use-managed-audio-stream";
import { E6_EMPTY_PANEL_STATE, E6PanelController } from "../lib/s2e-e6-local-panel.mjs";
import { CANNABEATS_BASE_PATH, cannabeatsPath } from "../lib/paths";
import { GAME_CLIENT_CONTRACT_HEADER, GAME_CLIENT_CONTRACT_VERSION } from "../lib/game-client-contract.ts";

async function gameRequest(
  body: Record<string, unknown>,
  options: Parameters<typeof requestGame>[2] = {},
) {
  return requestGame(cannabeatsPath("/api/game"), body, options);
}

const ROOM_REFRESH_TIMEOUT_MS = 8_000;

function normalizeNumberDisplay(input: HTMLInputElement, value: number) {
  input.value = String(value);
}

function Timeline({ player, interactive, selected, locked, onSelect }: {
  player: Player;
  interactive: boolean;
  selected: number | null;
  locked: number | null;
  onSelect: (index: number) => void;
}) {
  const placementLabel = (index: number) => {
    if (index === 0) return `Earlier than ${player.timeline[0].year}`;
    if (index === player.timeline.length) return `Later than ${player.timeline[index - 1].year}`;
    return `Between ${player.timeline[index - 1].year} and ${player.timeline[index].year}`;
  };

  const placementTarget = (index: number) => {
    if (locked === index) {
      return (
        <article className="song-card mystery-song-card" aria-label="Mystery song locked here">
          <span className="song-year">?</span>
          <span className="song-details"><strong>Mystery song</strong><small>Locked here</small></span>
        </article>
      );
    }
    if (!interactive) return null;
    return (
      <button
        className={`timeline-gap ${selected === index ? "selected" : ""}`}
        onClick={() => onSelect(index)}
        type="button"
      >
        <span>{selected === index ? "Mystery song goes here" : placementLabel(index)}</span>
      </button>
    );
  };

  return (
    <div className="timeline" aria-label={`${player.name}’s timeline`}>
      {player.timeline.map((song, index) => (
        <div className="timeline-section" key={`${song.year}-${song.title}-${index}`}>
          {placementTarget(index)}
          <article className="song-card">
            <span className="song-year">{song.year}</span>
            <span className="song-details">
              <strong>{song.title}</strong>
              <small>{song.artist}</small>
            </span>
          </article>
        </div>
      ))}
      {placementTarget(player.timeline.length)}
    </div>
  );
}

function GameSetup({ rules, busy, onApply }: {
  rules: GameRules;
  busy: boolean;
  onApply: (rules: GameRules) => void;
}) {
  const [draft, setDraft] = useState<GameRules>(() => ({ ...rules, eraWeights: { ...rules.eraWeights } }));
  const presetName = RULE_PRESET_OPTIONS.find((option) => option.id === rules.preset)?.name ?? "Custom";

  return (
    <section className="rules-panel">
      <div className="rules-heading">
        <div><p className="step-label">Game setup</p><h2>{presetName}</h2></div>
        <span>{rules.minYear}–{rules.maxYear} · First to {rules.targetScore}</span>
      </div>
      <div className="preset-grid" aria-label="Music mix presets">
        {RULE_PRESET_OPTIONS.map((option) => (
          <button
            className={rules.preset === option.id ? "selected" : ""}
            disabled={busy}
            key={option.id}
            onClick={() => onApply(rulesForPreset(option.id))}
            type="button"
          >
            <strong>{option.name}</strong><small>{option.description}</small>
          </button>
        ))}
      </div>
      <details className="advanced-rules">
        <summary>Advanced settings</summary>
        <form onSubmit={(event) => { event.preventDefault(); onApply({ ...draft, preset: "custom" }); }}>
          <div className="year-fields">
            <label>Earliest year<input type="number" min={CATALOG_YEAR_MIN} max={draft.maxYear} value={draft.minYear} onBlur={(event) => normalizeNumberDisplay(event.currentTarget, draft.minYear)} onChange={(event) => setDraft((current) => ({ ...current, minYear: Number(event.target.value) }))} /></label>
            <label>Latest year<input type="number" min={draft.minYear} max={CATALOG_YEAR_MAX} value={draft.maxYear} onBlur={(event) => normalizeNumberDisplay(event.currentTarget, draft.maxYear)} onChange={(event) => setDraft((current) => ({ ...current, maxYear: Number(event.target.value) }))} /></label>
            <label>Winning score<input type="number" min="3" max="20" value={draft.targetScore} onBlur={(event) => normalizeNumberDisplay(event.currentTarget, draft.targetScore)} onChange={(event) => setDraft((current) => ({ ...current, targetScore: Number(event.target.value) }))} /></label>
          </div>
          <fieldset className="era-fields">
            <legend>Relative era weighting</legend>
            {ERA_BUCKETS.map((era) => (
              <label key={era.id}>
                <span>{era.label}<strong>{draft.eraWeights[era.id]}</strong></span>
                <input type="range" min="0" max="100" step="5" value={draft.eraWeights[era.id]} onChange={(event) => setDraft((current) => ({ ...current, eraWeights: { ...current.eraWeights, [era.id]: Number(event.target.value) } }))} />
              </label>
            ))}
          </fieldset>
          <label className="toggle-rule"><input type="checkbox" checked={draft.allowRetraction} onChange={(event) => setDraft((current) => ({ ...current, allowRetraction: event.target.checked }))} /> Allow one retraction per round</label>
          <button className="secondary-button" disabled={busy}>Apply custom rules</button>
        </form>
      </details>
    </section>
  );
}

function SharedAudioPanel({
  code, runId, enabled, ready, status, label, compact = false, onStart, onStop,
  diagnosticGeneration, onDiagnostics, onCopyDiagnostics, onResetDiagnostics,
  sharing, onShareDiagnostics, onStopSharing,
}: {
  code: string;
  runId: string;
  enabled: boolean;
  ready: boolean;
  status: ManagedAudioStatus;
  label: string;
  compact?: boolean;
  onStart: (code: string) => void;
  onStop: () => void;
  diagnosticGeneration: number;
  onDiagnostics: () => ManagedAudioDiagnostics | null;
  onCopyDiagnostics: () => Promise<"copied">;
  onResetDiagnostics: () => Promise<"reset">;
  sharing: ManagedAudioSharing;
  onShareDiagnostics: (runId: string) => Promise<boolean>;
  onStopSharing: () => Promise<boolean>;
}) {
  const [panelState, setPanelState] = useState<{
    open: boolean;
    diagnostics: ManagedAudioDiagnostics | null;
    busy: boolean;
    notice: string;
  }>(E6_EMPTY_PANEL_STATE);
  const panelController = useMemo(() => new E6PanelController({
      read: onDiagnostics,
      copy: onCopyDiagnostics,
      reset: onResetDiagnostics,
      scheduleInterval: (callback: () => void, delay: number) => window.setInterval(callback, delay),
      cancelInterval: (timer: number) => window.clearInterval(timer),
      onChange: setPanelState,
    }), [onCopyDiagnostics, onDiagnostics, onResetDiagnostics]);

  useEffect(() => {
    panelController.sync({ enabled, generation: diagnosticGeneration });
  }, [diagnosticGeneration, enabled, panelController]);

  useEffect(() => () => panelController.dispose(), [panelController]);

  const diagnostics = panelState.diagnostics as ManagedAudioDiagnostics | null;
  const diagnosticNotice = panelState.notice === "copied" ? "Local diagnostic report copied."
    : panelState.notice === "reset" ? "Local diagnostics reset. Audio kept playing."
      : panelState.notice === "copy_unavailable" ? "A report will be available after the first diagnostic window."
        : panelState.notice === "copy_failed" ? "The report could not be copied. Audio is unchanged."
          : panelState.notice === "reset_failed" ? "Diagnostics could not be reset. Check the audio status above."
            : "";
  const sharingNotice = sharing.notice === "sharing_enabled"
    ? "Future diagnostic windows are being shared with this game’s host."
    : sharing.notice === "sharing_stopped" ? "Diagnostic sharing stopped."
      : sharing.notice === "accepted" || sharing.notice === "replayed"
        ? `${sharing.uploadedCount} diagnostic report${sharing.uploadedCount === 1 ? "" : "s"} shared.`
        : sharing.notice === "grant_lost"
          ? "The sharing session expired after restart. Start sharing again to continue."
          : sharing.notice ? "Diagnostic sharing could not complete. Local audio and reports are unchanged." : "";

  return (
    <section className={`shared-audio-panel ${compact ? "compact" : ""} ${enabled ? "has-diagnostics" : ""}`}>
      <div>
        <p className="step-label">Shared game audio</p>
        <strong aria-live="polite"><i className={ready ? "ready" : ""} />{label}</strong>
        {!compact && <small>Enable once on this device. Temporary source interruptions reconnect automatically.</small>}
      </div>
      {!enabled || status === "error" ? (
        <button className="secondary-button" type="button" onClick={() => onStart(code)}>{status === "error" ? "Retry audio" : "Enable shared audio"}</button>
      ) : (
        <button className="text-button" type="button" onClick={onStop}>Stop listening</button>
      )}
      {enabled && (
        <details className="audio-diagnostics" open={panelState.open} onToggle={(event) => panelController.setOpen(event.currentTarget.open)}>
          <summary>Local audio diagnostics</summary>
          <div className="audio-diagnostics-body">
            <p className="helper">{sharing.status === "enabled"
              ? "Sharing is on for future reports only. Existing local reports stay on this device."
              : "Upload disabled. These measurements stay in this browser unless you copy them."}</p>
            {diagnostics ? (
              <dl className="audio-diagnostics-grid">
                <div><dt>Stream</dt><dd>{diagnostics.status}</dd></div>
                <div><dt>Windows</dt><dd>{diagnostics.windowCount}</dd></div>
                <div><dt>Transitions</dt><dd>{diagnostics.transitionCount}</dd></div>
                <div><dt>Coverage gaps</dt><dd>{diagnostics.gapCount}</dd></div>
                <div><dt>Dropped transitions</dt><dd>{diagnostics.droppedTransitionCount}</dd></div>
                <div><dt>Buffer</dt><dd>{diagnostics.latestWindow?.bufferStatus === "observed" ? `${Math.round(diagnostics.latestWindow.bufferCurrentMs ?? 0)} ms` : "Collecting"}</dd></div>
                <div><dt>Context</dt><dd>{diagnostics.latestWindow?.audioContextState ?? "Collecting"}</dd></div>
                <div><dt>Signal</dt><dd>{diagnostics.latestWindow?.signalPresence ?? "Collecting"}</dd></div>
                <div><dt>Clipping</dt><dd>{diagnostics.latestWindow?.clippingSeverity ?? "Collecting"}</dd></div>
                <div><dt>Underruns</dt><dd>{diagnostics.latestWindow?.underrunCount ?? 0}</dd></div>
                <div><dt>Overflows</dt><dd>{diagnostics.latestWindow?.overflowCount ?? 0}</dd></div>
              </dl>
            ) : <p className="helper">Diagnostics will appear after audio initialization.</p>}
            <p className="audio-copy-disclosure">{diagnostics?.disclosure ?? "A local report will be available after audio initialization."}</p>
            <div className="audio-diagnostics-actions">
              <button className="text-button" disabled={panelState.busy || !diagnostics?.copyAvailable} onClick={() => void panelController.copy()} type="button">Copy local report</button>
              <button className="text-button" disabled={panelState.busy || !diagnostics} onClick={() => void panelController.reset()} type="button">Reset diagnostics</button>
              {sharing.status === "enabled" ? (
                <button className="text-button" onClick={() => void onStopSharing()} type="button">Stop sharing</button>
              ) : sharing.status === "stopping" ? (
                <button className="text-button" onClick={() => void onStopSharing()} type="button">Retry stop sharing</button>
              ) : (
                <button className="text-button" disabled={!diagnostics || sharing.status === "enabling"} onClick={() => void onShareDiagnostics(runId)} type="button">{sharing.status === "enabling" ? "Starting sharing…" : "Share future diagnostics"}</button>
              )}
            </div>
            <p className="visually-hidden" aria-live="polite" role="status">{diagnosticNotice}</p>
            {diagnosticNotice && <p className="audio-diagnostics-notice" aria-hidden="true">{diagnosticNotice}</p>}
            {sharingNotice && <p className="audio-diagnostics-notice" aria-live="polite">{sharingNotice}</p>}
          </div>
        </details>
      )}
    </section>
  );
}

function HostScoreboard({ players, activePlayerId, lockedPlacement, artworkByUri, targetScore, round, interactive, selected, busy, onSelect, onLock }: {
  players: Player[];
  activePlayerId: string | null;
  lockedPlacement: number | null;
  artworkByUri: Record<string, SpotifyTrackArtwork>;
  targetScore: number;
  round: number;
  interactive: boolean;
  selected: number | null;
  busy: boolean;
  onSelect: (index: number) => void;
  onLock: () => void;
}) {
  const activeTrackRef = useRef<HTMLDivElement | null>(null);
  const activeTimelineLength = players.find((player) => player.id === activePlayerId)?.timeline.length ?? 0;

  useEffect(() => {
    const track = activeTrackRef.current;
    if (!track) return;
    const target = lockedPlacement !== null
      ? track.querySelector<HTMLElement>(".host-mystery-card")
      : selected !== null
        ? track.querySelector<HTMLElement>(".host-placement-gap.selected")
        : track.querySelector<HTMLElement>(".host-song-card:last-child");
    if (!target) return;
    track.scrollTo({
      left: target.offsetLeft - (track.clientWidth - target.clientWidth) / 2,
      behavior: "smooth",
    });
  }, [activePlayerId, activeTimelineLength, interactive, lockedPlacement, round, selected]);

  return (
    <section className="host-scoreboard" aria-label="Player timelines">
      <div className="host-scoreboard-rows">
        {players.map((player) => {
          const isActive = player.id === activePlayerId;
          const locked = player.id === activePlayerId ? lockedPlacement : null;
          const placementLabel = (index: number) => {
            if (index === 0) return `Earlier than ${player.timeline[0].year}`;
            if (index === player.timeline.length) return `Later than ${player.timeline[index - 1].year}`;
            return `Between ${player.timeline[index - 1].year} and ${player.timeline[index].year}`;
          };
          const placementTarget = (index: number) => {
            if (locked === index) {
              return <article className="host-song-card host-mystery-card" key={`locked-${index}`}><div className="host-song-art">?</div><div className="host-song-copy"><b>Mystery song</b><span>Locked here</span></div></article>;
            }
            if (!isActive || !interactive) return null;
            const isSelected = selected === index;
            return (
              <button
                aria-label={placementLabel(index)}
                aria-pressed={isSelected}
                className={`host-placement-gap ${isSelected ? "selected" : ""}`}
                key={`gap-${index}`}
                onClick={() => onSelect(index)}
                type="button"
              >
                <strong>{isSelected ? "Selected" : "Place here"}</strong>
                <small>{placementLabel(index)}</small>
              </button>
            );
          };
          const cards = player.timeline.flatMap((song, songIndex) => {
            const artwork = song.uri ? artworkByUri[song.uri] : undefined;
            const card = (
              <article className="host-song-card" key={`song-${songIndex}-${song.uri ?? song.title}`}>
                <div className="host-song-art">
                  {artwork ? (
                    <>
                      {/* Spotify artwork is displayed uncropped in the shared timeline. */}
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img src={artwork.imageUrl} width="300" height="300" alt="" />
                    </>
                  ) : <span aria-hidden="true">♪</span>}
                </div>
                <div className="host-song-copy">
                  <strong className="host-song-year">{song.year}</strong>
                  <b>{song.title}</b>
                  <span>{song.artist}</span>
                </div>
              </article>
            );
            const target = placementTarget(songIndex);
            return target ? [target, card] : [card];
          });
          const lastTarget = placementTarget(player.timeline.length);
          if (lastTarget) cards.push(lastTarget);
          return (
            <article className={`host-score-row ${isActive ? "active" : ""} ${isActive && interactive ? "placing" : ""}`} key={player.id}>
              <header>
                <div className="host-player-name"><strong>{player.name}</strong>{isActive && <span>Round {round}</span>}</div>
                <small>{player.timeline.length} / {targetScore} songs · {player.control === "host" ? "Host screen" : "Phone"}</small>
              </header>
              <div className="host-timeline-track" ref={isActive ? activeTrackRef : undefined}>{cards}</div>
              {isActive && interactive && <button className="host-row-lock" disabled={selected === null || busy} onClick={onLock} type="button">Lock placement</button>}
            </article>
          );
        })}
      </div>
    </section>
  );
}

export default function Home() {
  const [room, setRoom] = useState<RoomView | null>(null);
  const roomSequence = useRef(0);
  const roomCursor = useRef<RoomSnapshotCursor>({ room: null, sequence: 0 });
  const actRef = useRef<(body: Record<string, unknown>, playNewSong?: boolean) => Promise<boolean>>(
    async () => false,
  );
  const [audio, setAudio] = useState<AudioControlView>({ selection: "managed", mode: "local", sourceOnline: false, status: "disconnected" });
  const [session, setSession] = useState<GameSession | null>(null);
  const [name, setName] = useState("");
  const [hostPlayerName, setHostPlayerName] = useState("");
  const [roomCode, setRoomCode] = useState("");
  const [selection, setSelection] = useState<{ round: number; index: number } | null>(null);
  const [qrCodeUrl, setQrCodeUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [blockedOutcome, setBlockedOutcome] = useState(false);
  const [pendingIntentVersion, setPendingIntentVersion] = useState(0);
  const [error, setError] = useState("");
  const [recoveryChoices, setRecoveryChoices] = useState<Array<{ code: string; isHost: boolean }>>([]);
  const [artworkByUri, setArtworkByUri] = useState<Record<string, SpotifyTrackArtwork>>({});
  const spotify = useSpotifyPlayer();
  const managedAudio = useManagedAudioStream();
  const stopManagedAudio = managedAudio.stop;
  const spotifyIsReady = spotify.isReady;
  const trackArtwork = spotify.trackArtwork;
  const hostRules = room?.isHost ? JSON.stringify(room.rules) : "";

  const beginRoomRequest = useCallback(() => {
    roomSequence.current += 1;
    return roomSequence.current;
  }, []);

  const applyRoomSnapshot = useCallback((incoming: RoomView, sequence: number, expectedCode: string) => {
    const reconciled = commitRoomSnapshot(roomCursor.current, incoming, sequence, expectedCode, setRoom);
    roomCursor.current = reconciled;
    return reconciled.room;
  }, []);

  const applyRoomPayload = useCallback((payload: Awaited<ReturnType<typeof gameRequest>>, sequence: number, expectedCode: string) => {
    const reconciled = commitGamePayload(
      roomCursor.current,
      payload,
      sequence,
      expectedCode,
      setRoom,
      setAudio,
    );
    roomCursor.current = reconciled;
    return reconciled.room;
  }, []);

  const refresh = useCallback(async (current: GameSession) => {
    const sequence = beginRoomRequest();
    const params = new URLSearchParams({ code: current.code });
    if (current.hostToken) params.set("hostToken", current.hostToken);
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), ROOM_REFRESH_TIMEOUT_MS);
    try {
      const response = await fetch(`${cannabeatsPath("/api/game")}?${params}`, {
        cache: "no-store",
        headers: { [GAME_CLIENT_CONTRACT_HEADER]: GAME_CLIENT_CONTRACT_VERSION },
        signal: controller.signal,
      });
      const payload = await response.json() as { room?: RoomView; audio?: AudioControlView; error?: string };
      if (!response.ok) throw new Error(payload.error ?? "Unable to refresh the room.");
      const acceptedRoom = applyRoomPayload(payload, sequence, current.code);
      return acceptedRoom;
    } finally {
      window.clearTimeout(timeout);
    }
  }, [applyRoomPayload, beginRoomRequest]);

  const recoverSession = useCallback(async (preferredCode?: string) => {
    const sequence = beginRoomRequest();
    const params = new URLSearchParams({ recover: "1",clientContractVersion: GAME_CLIENT_CONTRACT_VERSION });
    if (preferredCode) params.set("preferredLobbyCode",preferredCode);
    const pending = loadPendingGameIntent(sessionStorage);
    if (pending?.code) params.set("pendingActionLobbyCode",String(pending.code));
    const response = await fetch(`${cannabeatsPath("/api/game")}?${params}`, {
      cache: "no-store",
      headers: { [GAME_CLIENT_CONTRACT_HEADER]: GAME_CLIENT_CONTRACT_VERSION },
    });
    const payload = await response.json() as {
      recovery?: {
        outcome?: string;
        pendingActionRejected?: boolean;
        lobbies?: Array<{ code: string; isHost: boolean }>;
      };
      session?: GameSession;
      room?: RoomView;
      audio?: AudioControlView;
      error?: string;
    };
    if (!response.ok) throw new Error(payload.error ?? "Unable to recover the game session.");
    if (payload.recovery?.pendingActionRejected) {
      clearPendingGameIntent(sessionStorage);
      setBlockedOutcome(false);
      setBusy(false);
      setPendingIntentVersion((version) => version + 1);
    }
    if (!["resume","action_reconciliation_required"].includes(payload.recovery?.outcome ?? "")
        || !payload.session || !payload.room || !payload.audio) {
      sessionStorage.removeItem(SESSION_KEY);
      setSession(null);
      roomCursor.current = { room: null,sequence };
      setRoom(null);
      if (payload.recovery?.outcome === "choose") {
        setRecoveryChoices(payload.recovery.lobbies ?? []);
        setError("Choose which active game to resume.");
      } else if (preferredCode && ["credential_expired","client_upgrade_required"].includes(
        payload.recovery?.outcome ?? "",
      )) {
        setError(payload.recovery?.outcome === "client_upgrade_required"
          ? "Reload after updating CannaBeats to resume this game."
          : "This phone credential has expired. Ask the host for a new invitation.");
      }
      return null;
    }
    const next: GameSession = {
      code: payload.session.code,
      ...(payload.session.playerId ? { playerId: payload.session.playerId } : {}),
      joinOrigin: `${window.location.origin}${CANNABEATS_BASE_PATH}`,
    };
    setRecoveryChoices([]);
    if (payload.recovery?.outcome === "action_reconciliation_required") {
      setBusy(true);
      setBlockedOutcome(true);
      setError("Confirming an interrupted action before continuing…");
    }
    const committed = commitRecoveryResult(payload,next.code,
      (incoming) => applyRoomPayload({ ...payload,room: incoming },sequence,next.code),() => {
        sessionStorage.setItem(SESSION_KEY,JSON.stringify(next));
        setSession(next);
      });
    if (!committed) return null;
    setError(payload.recovery?.pendingActionRejected
      ? "The interrupted action no longer has game authority and was not retried."
      : "");
    return next;
  }, [applyRoomPayload,beginRoomRequest]);

  const chooseRecovery = useCallback(async (code: string) => {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      await recoverSession(code);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Unable to resume this game.");
    } finally {
      setBusy(false);
    }
  },[busy,recoverSession]);

  useEffect(() => {
    const sharedCode = new URLSearchParams(window.location.search).get("session")?.trim().toUpperCase();
    const saved = sessionStorage.getItem(SESSION_KEY);
    const savedName = localStorage.getItem(PLAYER_NAME_KEY)?.trim();
    const timer = window.setTimeout(() => {
      if (savedName) setName((current) => current || savedName);
      if (sharedCode) {
        const launched: GameSession = {
          code: sharedCode,
          joinOrigin: `${window.location.origin}${CANNABEATS_BASE_PATH}`,
        };
        sessionStorage.setItem(SESSION_KEY, JSON.stringify(launched));
        setSession(launched);
        window.history.replaceState({}, "", cannabeatsPath("/"));
        void refresh(launched)
          .catch(async () => {
            const sequence = beginRoomRequest();
            const payload = await gameRequest({ action: "prepare", code: sharedCode });
            return applyRoomPayload(payload, sequence, sharedCode);
          })
          .catch((reason: Error) => setError(reason.message));
        return;
      }
      let preferredCode: string | undefined;
      if (saved) {
        try {
          const restored = JSON.parse(saved) as GameSession;
          preferredCode = restored.code;
        } catch {
          sessionStorage.removeItem(SESSION_KEY);
        }
      }
      void recoverSession(preferredCode).catch(() => {
        if (preferredCode) setError("The room is temporarily unavailable. Retrying…");
      });
    }, 0);
    return () => window.clearTimeout(timer);
  }, [applyRoomPayload, beginRoomRequest, recoverSession, refresh]);

  useEffect(() => {
    if (!session) return;
    const timer = window.setInterval(() => {
      void refresh(session)
        .then(() => { if (!blockedOutcome) setError(""); })
        .catch(() => { if (!blockedOutcome) setError("The room is temporarily unavailable. Retrying…"); });
    }, 1200);
    return () => window.clearInterval(timer);
  }, [blockedOutcome, refresh, session]);

  useEffect(() => {
    if (!session) return;
    const pending = loadPendingGameIntent(sessionStorage);
    if (!pending) return;
    let cancelled = false;
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      if (cancelled) return;
      setBusy(true);
      setBlockedOutcome(true);
      const pendingCode = String(pending.code);
      const sameLobby = pendingCode === session.code;
      setError(sameLobby
        ? "Confirming an interrupted action before allowing another move…"
        : `Confirming an interrupted action from lobby ${pendingCode} before continuing…`);
      void reconcilePendingGameRequest(pending, gameRequest, {
        signal: controller.signal,
        onPending(request) {
          savePendingGameIntent(sessionStorage, request);
          if (!cancelled) {
            setError("This action is still pending. CannaBeats will keep reconciling it automatically.");
          }
        },
      }).then(async (result) => {
        if (cancelled) return;
        if (result.kind === "aborted") return;
        if (result.kind === "rejected") {
          clearPendingGameIntent(sessionStorage);
          setBlockedOutcome(false);
          setBusy(false);
          try {
            await refresh(session);
          } catch {
            // A definitive rejection is safe to unblock even when refresh is unavailable.
          }
          setError(result.error instanceof Error ? result.error.message : "The interrupted action was rejected.");
          return;
        }
        if (sameLobby) {
          const sequence = beginRoomRequest();
          applyRoomPayload(result.payload, sequence, session.code);
        } else {
          try {
            await refresh(session);
          } catch {
            // The old action is definitive; normal polling can recover this lobby.
          }
        }
        clearPendingGameIntent(sessionStorage);
        setBlockedOutcome(false);
        setBusy(false);
        setError(sameLobby
          ? "The interrupted action was confirmed against the current game."
          : `The interrupted action from lobby ${pendingCode} was confirmed.`);
      });
    }, 0);
    return () => {
      cancelled = true;
      controller.abort();
      window.clearTimeout(timer);
    };
  }, [applyRoomPayload, beginRoomRequest, pendingIntentVersion, refresh, session]);

  useEffect(() => {
    if (hostRules) localStorage.setItem(HOST_RULES_KEY, hostRules);
  }, [hostRules]);

  useEffect(() => {
    if (!session || audio.selection !== "managed") stopManagedAudio();
  }, [audio.selection, session, stopManagedAudio]);

  useEffect(() => {
    if (!room?.isHost || room.phase !== "lobby") return;
    let cancelled = false;
    void gameRequest({ action: "guestInvite", code: room.code }).then(async (payload) => {
      if (!payload.guestInvite) throw new Error("The guest invitation response was incomplete.");
      const joinUrl = new URL(session?.joinOrigin ?? window.location.origin);
      joinUrl.pathname = cannabeatsPath(`/join/${room.code}`);
      joinUrl.search = "";
      joinUrl.hash = new URLSearchParams({ invite: payload.guestInvite }).toString();
      return QRCode.toDataURL(joinUrl.toString(), {
        width: 240,
        margin: 1,
        color: { dark: "#171c2b", light: "#fff5c9" },
      });
    }).then((url) => {
      if (!cancelled) setQrCodeUrl(url);
    }).catch(() => setError("Unable to create a secure guest QR code."));
    return () => { cancelled = true; };
  }, [room?.code, room?.isHost, room?.phase, session?.joinOrigin]);

  const timelineUriKey = room?.isHost
    ? Array.from(new Set(room.players.flatMap((player) => player.timeline.flatMap((song) => song.uri ? [song.uri] : [])))).join("|")
    : "";

  useEffect(() => {
    if (!timelineUriKey || !spotifyIsReady) return;
    let cancelled = false;
    const uris = timelineUriKey.split("|");
    void Promise.all(uris.map(async (uri) => [uri, await trackArtwork(uri)] as const)).then((entries) => {
      if (cancelled) return;
      setArtworkByUri((current) => {
        let changed = false;
        const next = { ...current };
        for (const [uri, artwork] of entries) {
          if (artwork && current[uri] !== artwork) {
            next[uri] = artwork;
            changed = true;
          }
        }
        return changed ? next : current;
      });
    });
    return () => { cancelled = true; };
  }, [spotifyIsReady, timelineUriKey, trackArtwork]);

  const currentPlayer = useMemo(
    () => room?.players.find((player) => player.id === session?.playerId) ?? null,
    [room, session?.playerId],
  );
  const activePlayer = room?.players.find((player) => player.id === room.activePlayerId) ?? null;
  const winner = room?.players.find((player) => player.id === room.winnerId) ?? null;
  const isMyTurn = Boolean(currentPlayer?.control === "phone" && room?.activePlayerId === currentPlayer.id);
  const hostControlsActivePlayer = Boolean(room?.isHost && activePlayer?.control === "host");
  const selected = selection && selection.round === room?.round ? selection.index : null;
  const managedPlaybackActive = audio.selection === "managed" && audio.mode === "managed"
    && ["starting", "playing", "resuming"].includes(audio.status);
  const playbackLabel = audio.selection === "managed"
    ? managedPlaybackActive ? "Pause" : "Resume"
    : spotify.status === "playing"
    ? "Pause"
    : spotify.status === "paused"
      ? "Resume"
      : "Play";
  const playbackReady = audio.selection === "managed"
    ? audio.mode === "managed" && audio.sourceOnline && managedAudio.ready
    : spotify.isReady;
  const managedHandoffMessage = audio.handoff?.outcome === "busy"
    ? "The managed source is reserved by another game."
    : audio.handoff?.outcome === "recovering"
      ? "The managed source is confirming playback stopped for this game."
      : audio.handoff?.outcome === "quarantined"
        ? "The managed source is quarantined while an earlier game is reconciled."
        : null;

  async function act(body: Record<string, unknown>, playNewSong = false) {
    if (!session) return false;
    const existingIntent = loadPendingGameIntent(sessionStorage);
    if (existingIntent) {
      setBusy(true);
      setBlockedOutcome(true);
      setError("An earlier action must be resolved before another move can be sent.");
      setPendingIntentVersion((version) => version + 1);
      return false;
    }
    setBusy(true);
    setBlockedOutcome(false);
    setError("");
    let keepBlocked = false;
    const applyActionResult = async (payload: Awaited<ReturnType<typeof gameRequest>>, sequence: number) => {
      if (!payload.room) return;
      const acceptedRoom = applyRoomPayload(payload, sequence, session.code);
      const managed = (payload.audio ?? audio).selection === "managed";
      if (!managed && playNewSong && acceptedRoom?.phase === "playing" && acceptedRoom.currentSong?.uri) {
        await spotify.play(acceptedRoom.currentSong.uri);
      }
    };
    try {
      const actionContext = room
        ? {
          expectedRunId: room.runId,
          expectedRunGeneration: room.runGeneration,
          expectedRevision: room.revision,
        }
        : {};
      const sequence = beginRoomRequest();
      const payload = await gameRequest(
        { ...body, ...actionContext, code: session.code },
        { onRequestPrepared: (request) => savePendingGameIntent(sessionStorage, request) },
      );
      await applyActionResult(payload, sequence);
      clearPendingGameIntent(sessionStorage);
      return true;
    } catch (reason) {
      if (reason instanceof GameApiError && reason.pendingRequest) {
        savePendingGameIntent(sessionStorage, reason.pendingRequest);
        keepBlocked = true;
        setBlockedOutcome(true);
        setPendingIntentVersion((version) => version + 1);
        setError("This action is still pending. CannaBeats will keep reconciling it automatically.");
      } else if (reason instanceof GameApiError && reason.code === "invalid_response") {
        clearPendingGameIntent(sessionStorage);
        try {
          await refresh(session);
          setError("The transition response was incomplete, so the current game was refreshed.");
        } catch {
          keepBlocked = true;
          setError("The transition result is uncertain and the current game could not be refreshed. Reload before retrying.");
        }
      } else {
        clearPendingGameIntent(sessionStorage);
        setError(reason instanceof Error ? reason.message : "Something went wrong.");
      }
      return false;
    } finally {
      setBlockedOutcome(keepBlocked);
      if (!keepBlocked) setBusy(false);
    }
  }

  useEffect(() => {
    actRef.current = act;
  });
  useEffect(() => {
    if (!room?.isHost || room.phase === "finished" || audio.selection !== "managed"
        || audio.mode !== "managed" || busy || blockedOutcome) return;
    const timer = window.setTimeout(() => {
      void actRef.current({ action: "audioAcquire" });
    }, 40_000);
    return () => window.clearTimeout(timer);
  }, [audio.mode, audio.selection, blockedOutcome, busy, room?.isHost, room?.phase, room?.revision]);

  async function retractPlacement() {
    const credentials = hostControlsActivePlayer
      ? { hostToken: session?.hostToken }
      : { playerId: session?.playerId };
    if (await act({ action: "retract", ...credentials })) setSelection(null);
  }

  async function addHostPlayer(event: FormEvent) {
    event.preventDefault();
    const chosenName = hostPlayerName.trim();
    if (!chosenName) return;
    if (await act({ action: "addPlayer", hostToken: session?.hostToken, name: chosenName })) {
      setHostPlayerName("");
    }
  }

  async function joinRoom(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      const sequence = beginRoomRequest();
      const code = roomCode.trim().toUpperCase();
      const chosenName = name.trim();
      const payload = await gameRequest({ action: "join", code, name: chosenName });
      commitJoinResult(
        payload,
        (joinedRoom) => applyRoomSnapshot(joinedRoom, sequence, code),
        (playerId) => {
          const next = { code, playerId };
          localStorage.setItem(PLAYER_NAME_KEY, chosenName);
          sessionStorage.setItem(SESSION_KEY, JSON.stringify(next));
          setSession(next);
        },
      );
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Unable to join the room.");
    } finally {
      setBusy(false);
    }
  }

  async function leaveRoom() {
    if (blockedOutcome || loadPendingGameIntent(sessionStorage)) {
      setError("Wait for the pending action to resolve before leaving this game.");
      return;
    }
    if (room?.isHost) {
      if (room.phase !== "finished") {
        if (!await act({ action: "abandon" })) return;
      } else {
        void spotify.stop();
      }
    }
    managedAudio.stop();
    sessionStorage.removeItem(SESSION_KEY);
    setSession(null);
    roomSequence.current += 1;
    roomCursor.current = { room: null, sequence: roomSequence.current };
    setRoom(null);
    setAudio({ selection: "managed", mode: "local", sourceOnline: false, status: "disconnected" });
    setSelection(null);
    setBlockedOutcome(false);
    setBusy(false);
    setError("");
  }

  async function controlPlayback(action: () => Promise<void>) {
    setBusy(true);
    setError("");
    try {
      await action();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Spotify playback failed.");
    } finally {
      setBusy(false);
    }
  }

  async function controlSharedPlayback() {
    if (audio.selection === "managed") {
      await act({ action: "audioControl", command: managedPlaybackActive ? "pause" : "resume" });
      return;
    }
    await controlPlayback(() => spotify.status === "playing"
      ? spotify.pause()
      : spotify.status === "paused"
        ? spotify.resume()
        : spotify.play(room!.currentSong!.uri!));
  }

  if (session && !room) {
    return (
      <main className="join-shell">
        <section className="join-card">
          <div className="join-note" aria-hidden="true">♪</div>
          <p className="eyebrow">Lobby {session.code}</p>
          <h1>Rejoining the game…</h1>
          <p className="helper">Your place is saved. We’ll reconnect automatically.</p>
          {error && <p className="error-message" role="status">{error}</p>}
          <button className="text-button" type="button" onClick={() => void leaveRoom()}>Leave room</button>
        </section>
      </main>
    );
  }

  if (!room || !session) {
    return (
      <main className="welcome-shell">
        <section className="welcome-copy">
          <p className="eyebrow">A family music timeline game</p>
          <div className="logo-frame">
            {/* This local, already-sized brand image does not need runtime optimization. */}
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={cannabeatsPath("/cannabeats-logo-640.jpg")} width="640" height="640" alt="CannaBeats — Premium Quality" />
          </div>
          <p className="welcome-lede">Listen closely. Place the song in time. Trust your ears.</p>
        </section>
        <section className="entry-card">
          <div className="entry-block">
            <p className="step-label">On the shared screen</p>
            <h2>Host a game</h2>
            <p>Start in the CannaBeats Host app. It creates or selects the lobby, prepares shared audio, and opens this full setup screen automatically.</p>
            <p className="spotify-status"><i /> Lobby creation is restricted to an authorized Host app</p>
          </div>
          <div className="or-rule"><span>or</span></div>
          <form className="entry-block" onSubmit={joinRoom}>
            <p className="step-label">On each player’s phone</p>
            <h2>Join a game</h2>
            <label>Lobby code<input value={roomCode} onChange={(event) => setRoomCode(event.target.value.toUpperCase())} maxLength={6} autoCapitalize="characters" required /></label>
            <label>Your name<input value={name} onChange={(event) => setName(event.target.value)} maxLength={24} required /></label>
            <button className="secondary-button" disabled={busy}>Join lobby</button>
          </form>
          {recoveryChoices.length > 0 && (
            <div className="entry-block" aria-label="Active games">
              <p className="step-label">Your active games</p>
              <h2>Choose a game to resume</h2>
              {recoveryChoices.map((choice) => (
                <button
                  className="secondary-button"
                  key={choice.code}
                  disabled={busy}
                  onClick={() => void chooseRecovery(choice.code)}
                  type="button"
                >
                  {choice.code}{choice.isHost ? " — Host" : " — Player"}
                </button>
              ))}
            </div>
          )}
          {error && <p className="error-message" role="alert">{error}</p>}
        </section>
      </main>
    );
  }

  if (room.phase === "lobby") {
    return (
      <main className="game-shell lobby-shell">
        <header className="game-header">
          <div><p className="eyebrow">CannaBeats lobby</p><h1>{room.code}</h1></div>
          <button className="text-button" onClick={() => void leaveRoom()}>Leave</button>
        </header>
        <section className="lobby-card">
          <p className="step-label">Players</p>
          <h2>{room.players.length ? "The band is assembling" : "Add or invite players"}</h2>
          {room.isHost && (
            <form className="host-player-form" onSubmit={addHostPlayer}>
              <label className="visually-hidden" htmlFor="host-player-name">Player name</label>
              <input id="host-player-name" maxLength={24} onChange={(event) => setHostPlayerName(event.target.value)} placeholder="Player name" value={hostPlayerName} />
              <button className="secondary-button" disabled={busy || !hostPlayerName.trim()}>Add player</button>
            </form>
          )}
          <div className="player-list">
            {room.players.map((player, index) => (
              <div className="player-pill" key={player.id}>
                <span>{index + 1}</span>{player.name}
                <small className={`player-control-badge ${player.control}`}>{player.control === "host" ? "Host screen" : "Phone"}</small>
                {room.isHost && <button aria-label={`Remove ${player.name}`} disabled={busy} onClick={() => void act({ action: "removePlayer", hostToken: session.hostToken, playerId: player.id })} type="button">Remove</button>}
              </div>
            ))}
          </div>
          {audio.selection === "managed" && (
            <SharedAudioPanel
              code={room.code}
              runId={room.runId}
              enabled={managedAudio.enabled}
              ready={managedAudio.ready}
              status={managedAudio.status}
              label={managedAudio.label}
              onStart={(code) => { void managedAudio.start(code); }}
              onStop={managedAudio.stop}
              diagnosticGeneration={managedAudio.diagnosticGeneration}
              onDiagnostics={managedAudio.diagnostics}
              onCopyDiagnostics={managedAudio.copyDiagnostics}
              onResetDiagnostics={managedAudio.resetDiagnostics}
              sharing={managedAudio.sharing}
              onShareDiagnostics={managedAudio.optInDiagnostics}
              onStopSharing={managedAudio.stopDiagnosticsSharing}
            />
          )}
          {room.isHost ? (
            <>
              <GameSetup
                key={JSON.stringify(room.rules)}
                rules={room.rules}
                busy={busy}
                onApply={(rules) => { void act({ action: "rules", hostToken: session.hostToken, rules }); }}
              />
              <div className="join-invite">
                <div className="qr-card">
                  {qrCodeUrl ? (
                    // This generated data URL is the QR code itself, not site content.
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={qrCodeUrl} width="240" height="240" alt={`QR code to join room ${room.code}`} />
                  ) : <div className="qr-placeholder" aria-label="Preparing QR code" />}
                </div>
                <div>
                  <p className="step-label">Scan to join</p>
                  <p className="helper">Phone guests scan this private invitation; add shared-screen players above. Room code: <strong>{room.code}</strong></p>
                </div>
              </div>
              <label className="audio-source-picker">
                Audio source
                <select
                  disabled={busy}
                  value={audio.selection}
                  onChange={(event) => void act({ action: "audioSelect", mode: event.target.value })}
                >
                  <option value="managed">CannaBeats Linux Spotify source</option>
                  <option value="local">Spotify on this device</option>
                </select>
              </label>
              {audio.selection === "managed" ? (
                <>
                  <p className="spotify-status"><i /> {managedHandoffMessage
                    ?? (audio.mode === "managed" && audio.sourceOnline
                      ? `${audio.sourceName ?? "Managed source"} is reserved for this game`
                      : "Linux Spotify source is reconnecting")}</p>
                  {audio.mode !== "managed" && (
                    <button className="secondary-button"
                      disabled={busy || audio.handoff?.mayAcquire === false}
                      type="button" onClick={() => void act({ action: "audioAcquire" })}>
                      Reserve managed source
                    </button>
                  )}
                  {managedHandoffMessage && audio.handoff?.localFallback && (
                    <button className="text-button" disabled={busy} type="button"
                      onClick={() => void act({ action: "audioSelect",mode: "local" })}>
                      Use Spotify on this device
                    </button>
                  )}
                </>
              ) : (
                <>
                  <p className="spotify-status"><i /> {spotify.isReady ? "Spotify is ready on this device" : "Connect Spotify on this device"}</p>
                  {!spotify.isReady && <button className="secondary-button" type="button" onClick={() => void spotify.connect()}>Connect Spotify on this device</button>}
                </>
              )}
              <button className="primary-button" disabled={!room.players.length || busy || !playbackReady} onClick={() => act({ action: "start", hostToken: session.hostToken })}>Set up game</button>
            </>
          ) : <p className="waiting-note"><i /> Waiting for the host to start</p>}
        </section>
        {error && <p className="error-message" role="alert">{error}</p>}
      </main>
    );
  }

  return (
    <main className={`game-shell ${room.isHost ? "host-game-shell" : "player-shell"}`}>
      {room.isHost ? room.phase !== "finished" && (
        <section className="host-round-bar" aria-label="Current round controls">
          {/* The square brand artwork becomes a compact game icon on the shared screen. */}
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img className="host-brand-icon" src={cannabeatsPath("/cannabeats-logo-640.jpg")} width="104" height="104" alt="CannaBeats" />
          <div className="host-round-copy">
            <p className={`host-round-state ${room.phase === "revealed" && room.result ? (room.result.correct ? "correct" : "incorrect") : ""}`}>
              {room.phase === "ready"
                ? "Up first"
                : room.phase === "placed"
                ? "Locked"
                : room.phase === "revealed"
                  ? room.result?.correct ? "Correct placement" : "Not quite"
                  : activePlayer?.control === "phone" ? "Choosing on phone" : "Choosing on this screen"}
            </p>
            <h1>{room.phase === "ready" ? `${activePlayer?.name ?? "Player"} goes first` : `${activePlayer?.name ?? "Player"}’s turn`}</h1>
            <p className={`host-round-detail ${room.phase === "revealed" ? "host-answer" : ""}`}>
              {room.phase === "revealed" && room.currentSong ? (
                <><strong>{room.currentSong.year}</strong> · {room.currentSong.title} · <span>{room.currentSong.artist}</span></>
              ) : room.phase === "ready" ? "Let the first player know, then start when everyone is ready." : <span aria-hidden="true">&nbsp;</span>}
            </p>
          </div>
          <div className="host-round-controls">
            {room.phase === "ready" && (
              <button className="primary-button" disabled={busy || !room.currentSong?.uri} onClick={() => act({ action: "begin", hostToken: session.hostToken }, true)}>Start first song</button>
            )}
            {room.phase === "playing" && (
              <button
                className="spotify-button"
                type="button"
                aria-label={`${playbackLabel} mystery song`}
                disabled={busy || !room.currentSong?.uri}
                onClick={() => void controlSharedPlayback()}
              >
                {playbackLabel}
              </button>
            )}
            {room.phase === "placed" && (
              <button className="primary-button" disabled={busy} onClick={() => act({ action: "reveal", hostToken: session.hostToken })}>Reveal answer</button>
            )}
            {room.phase === "revealed" && (
              <button className="primary-button" disabled={busy} onClick={() => act({ action: "advance", hostToken: session.hostToken }, !room.winnerId)}>{room.winnerId ? "Finish game" : "Next player"}</button>
            )}
            <div className="host-round-secondary-actions">
              {room.phase === "playing" && (
                <button className="text-button" disabled={busy} onClick={() => act({ action: "skip", hostToken: session.hostToken }, true)}>Skip unavailable song</button>
              )}
              {room.phase === "placed" && (
                <>
                <button
                  className="text-button"
                  type="button"
                  aria-label={`${playbackLabel} mystery song`}
                  disabled={busy || !room.currentSong?.uri}
                  onClick={() => void controlSharedPlayback()}
                >
                  {playbackLabel}
                </button>
                {hostControlsActivePlayer && room.rules.allowRetraction && !room.retractionUsed && <button className="text-button" disabled={busy} onClick={() => void retractPlacement()}>Change placement</button>}
                </>
              )}
            </div>
          </div>
        </section>
      ) : currentPlayer && (
        <header className="player-header">
          <strong>{currentPlayer.name}</strong>
          <span>{currentPlayer.timeline.length} / {room.rules.targetScore}</span>
          {audio.selection === "managed" && (room.phase === "playing" || room.phase === "placed") && (
            <button className="text-button" disabled={busy || !audio.sourceOnline} onClick={() => void controlSharedPlayback()} type="button">{playbackLabel}</button>
          )}
        </header>
      )}

      {audio.selection === "managed" && (
        <SharedAudioPanel
          compact
          code={room.code}
          runId={room.runId}
          enabled={managedAudio.enabled}
          ready={managedAudio.ready}
          status={managedAudio.status}
          label={managedAudio.label}
          onStart={(code) => { void managedAudio.start(code); }}
          onStop={managedAudio.stop}
          diagnosticGeneration={managedAudio.diagnosticGeneration}
          onDiagnostics={managedAudio.diagnostics}
          onCopyDiagnostics={managedAudio.copyDiagnostics}
          onResetDiagnostics={managedAudio.resetDiagnostics}
          sharing={managedAudio.sharing}
          onShareDiagnostics={managedAudio.optInDiagnostics}
          onStopSharing={managedAudio.stopDiagnosticsSharing}
        />
      )}

      {winner && room.phase === "finished" ? (
        <section className="winner-card"><p className="step-label">That’s the timeline</p><h2>{winner.name} wins!</h2><p>First to {room.rules.targetScore} songs, and officially in tune with history.</p></section>
      ) : (
        <>
          {room.isHost && room.phase === "revealed" && room.currentSong && (
            <section className={`host-answer-card ${room.result?.correct ? "correct" : "incorrect"}`} aria-live="polite">
              <div>
                <p className="step-label">Answer</p>
                <strong className="host-answer-year">{room.currentSong.year}</strong>
              </div>
              <div>
                <h2>{room.currentSong.title}</h2>
                <p>{room.currentSong.artist}</p>
              </div>
              <strong>{room.result?.correct ? "Correct placement" : "Incorrect placement"}</strong>
            </section>
          )}
          {!room.isHost && room.phase !== "revealed" && (
            <p className={`player-status ${isMyTurn && room.phase === "playing" ? "active" : ""}`}>
              {room.phase === "ready"
                ? isMyTurn ? "You’re going first — waiting for the host" : `${activePlayer?.name ?? "Another player"} goes first`
                : isMyTurn && room.phase === "playing"
                ? "Place the mystery song"
                : room.phase === "placed"
                  ? "Locked in — waiting for the reveal"
                  : `${activePlayer?.name ?? "Another player"} is choosing`}
            </p>
          )}

          {!room.isHost && currentPlayer && (
            <section className="player-board">
              {room.phase === "revealed" && room.currentSong && (
                <div className={`mobile-result ${room.result?.correct ? "correct" : "incorrect"}`}>
                  <strong>{room.result?.correct ? "Correct!" : "Not quite"}</strong>
                  <span>{room.currentSong.title} · {room.currentSong.artist} · {room.currentSong.year}</span>
                </div>
              )}
              <Timeline
                player={currentPlayer}
                interactive={isMyTurn && room.phase === "playing"}
                selected={selected}
                locked={isMyTurn && room.phase === "placed" ? room.placement : null}
                onSelect={(index) => setSelection({ round: room.round, index })}
              />
              {isMyTurn && room.phase === "playing" && (
                <button className="primary-button sticky-action" disabled={selected === null || busy} onClick={() => act({ action: "place", playerId: session.playerId, index: selected })}>Lock placement</button>
              )}
              {isMyTurn && room.phase === "placed" && room.rules.allowRetraction && !room.retractionUsed && (
                <button className="secondary-button retract-button" disabled={busy} onClick={() => void retractPlacement()}>Retract placement</button>
              )}
            </section>
          )}

          {room.isHost && (
            <>
              <HostScoreboard
                players={room.players}
                activePlayerId={room.activePlayerId}
                lockedPlacement={room.phase === "placed" ? room.placement : null}
                artworkByUri={artworkByUri}
                targetScore={room.rules.targetScore}
                round={room.round}
                interactive={hostControlsActivePlayer && room.phase === "playing"}
                selected={selected}
                busy={busy}
                onSelect={(index) => setSelection({ round: room.round, index })}
                onLock={() => { void act({ action: "place", hostToken: session.hostToken, index: selected }); }}
              />
            </>
          )}
        </>
      )}
      {error && <p className="error-message" role="alert">{error}</p>}
      <button className="leave-link" onClick={() => void leaveRoom()}>{room.isHost ? "Leave room" : `Room ${room.code} · Leave`}</button>
    </main>
  );
}
