"use client";

import { FormEvent, useCallback, useEffect, useState } from "react";
import QRCode from "qrcode";

import { cannabeatsPath } from "../lib/paths";
import {
  CATALOG_YEAR_MAX, CATALOG_YEAR_MIN, RULE_PRESET_OPTIONS, rulesForPreset, type GameRules,
} from "../lib/rules";
import {
  acceptReleaseAction, admitReleaseParticipant, clearPendingReleaseAction, createActionIntent,
  createReleaseGame, exchangeHostTicket, hostSnapshot, issueReleaseInvitation,
  loadPendingReleaseAction, loadPendingReleaseRecovery, loadReleaseSession, participantSnapshot,
  recoverHostGame, recoverParticipantGame, releaseReadiness, removeReleaseParticipant,
  savePendingReleaseAction, saveReleaseSession, sendReleaseAction, terminateReleaseGame,
  uuid, RELEASE_SESSION_KEY, ReleaseClientError, type ReleaseActionIntent, type ReleaseGameState,
  type ReleasePlaybackProjection, type ReleasePlayer, type ReleaseSession,
} from "../lib/release-game-client";
import { useReleaseAudioStream } from "../lib/use-release-audio-stream";

const PLAYER_NAME_KEY = "cannabeats-player-name";
const POLL_MS = 1_500;

const ERROR_TEXT: Record<string, string> = {
  audio_not_ready: "Start shared audio in the CannaBeats Host before beginning the round.",
  capacity_reached: "This game already has eight players.",
  catalog_exhausted: "No unused songs match these game settings.",
  database_corrupt: "The retained game could not be validated. The Host must check the server.",
  database_unavailable: "The game server is temporarily unavailable.",
  duplicate_name: "That player name is already in this game.",
  expired: "This invitation has expired. Ask the Host for a new one.",
  game_ended: "This game has ended.",
  incompatible_client: "This page is out of date. Reload CannaBeats before continuing.",
  invalid_request: "That request could not be accepted.",
  operation_rejected: "That move is no longer available in the current game state.",
  playback_capacity: "This game has reached its retained playback-command limit.",
  outcome_unknown: "The server may have accepted this action. Confirming it before another move…",
  request_conflict: "This action no longer matches its retained request identity.",
  stale_state: "The game changed on another device. The latest state has been restored.",
  unauthorized: "This device no longer has access to that game.",
  upgrade_required: "Install the current CannaBeats Host release before continuing.",
};

function message(error: unknown) {
  if (error instanceof ReleaseClientError) return ERROR_TEXT[error.code] ?? "The game request failed.";
  return "The game server is temporarily unavailable.";
}

function Timeline({ player, interactive, selected, locked, onSelect }: {
  player: ReleasePlayer;
  interactive: boolean;
  selected: number | null;
  locked: number | null;
  onSelect: (index: number) => void;
}) {
  const label = (index: number) => {
    if (index === 0) return `Earlier than ${player.timeline[0]?.year ?? "the first song"}`;
    if (index === player.timeline.length) return `Later than ${player.timeline[index - 1]?.year}`;
    return `Between ${player.timeline[index - 1].year} and ${player.timeline[index].year}`;
  };
  const gap = (index: number) => {
    if (locked === index) return (
      <article className="song-card mystery-song-card" aria-label="Mystery song locked here">
        <span className="song-year">?</span>
        <span className="song-details"><strong>Mystery song</strong><small>Locked here</small></span>
      </article>
    );
    if (!interactive) return null;
    return <button className={`timeline-gap ${selected === index ? "selected" : ""}`}
      onClick={() => onSelect(index)} type="button"><span>
        {selected === index ? "Mystery song goes here" : label(index)}</span></button>;
  };
  return <div className="timeline" aria-label={`${player.name}’s timeline`}>
    {player.timeline.map((song, index) => <div className="timeline-section" key={song.uri}>
      {gap(index)}
      <article className="song-card"><span className="song-year">{song.year}</span>
        <span className="song-details"><strong>{song.title}</strong><small>{song.artist}</small></span>
      </article>
    </div>)}
    {gap(player.timeline.length)}
  </div>;
}

function RulesPanel({ rules, busy, onApply }: {
  rules: GameRules;
  busy: boolean;
  onApply: (rules: GameRules) => void;
}) {
  const [draft, setDraft] = useState<GameRules>(() => ({ ...rules, eraWeights: { ...rules.eraWeights } }));
  return <section className="rules-panel">
    <div className="rules-heading"><div><p className="step-label">Game setup</p>
      <h2>{rules.preset.replaceAll("-", " ")}</h2></div>
      <span>{rules.minYear}–{rules.maxYear} · First to {rules.targetScore}</span></div>
    <div className="preset-grid" aria-label="Music mix presets">
      {RULE_PRESET_OPTIONS.map((option) => <button
        className={rules.preset === option.id ? "selected" : ""} disabled={busy}
        key={option.id} onClick={() => onApply(rulesForPreset(option.id))} type="button">
        <strong>{option.name}</strong><small>{option.description}</small></button>)}
    </div>
    <details className="advanced-rules"><summary>Advanced settings</summary>
      <form onSubmit={(event) => { event.preventDefault(); onApply({ ...draft, preset: "custom" }); }}>
        <div className="year-fields">
          <label>Earliest year<input type="number" min={CATALOG_YEAR_MIN} max={draft.maxYear}
            value={draft.minYear} onChange={(event) => setDraft((value) => ({ ...value, minYear: Number(event.target.value) }))} /></label>
          <label>Latest year<input type="number" min={draft.minYear} max={CATALOG_YEAR_MAX}
            value={draft.maxYear} onChange={(event) => setDraft((value) => ({ ...value, maxYear: Number(event.target.value) }))} /></label>
          <label>Winning score<input type="number" min="3" max="20" value={draft.targetScore}
            onChange={(event) => setDraft((value) => ({ ...value, targetScore: Number(event.target.value) }))} /></label>
        </div>
        <label className="toggle-rule"><input type="checkbox" checked={draft.allowRetraction}
          onChange={(event) => setDraft((value) => ({ ...value, allowRetraction: event.target.checked }))} /> Allow one retraction per round</label>
        <button className="secondary-button" disabled={busy}>Apply custom rules</button>
      </form>
    </details>
  </section>;
}

function Welcome({ busy, error, invite, name, onName, onJoin, onCreate, onReturnToHost }: {
  busy: boolean;
  error: string;
  invite: { gameId: string; token: string } | null;
  name: string;
  onName: (name: string) => void;
  onJoin: (event: FormEvent) => void;
  onCreate: () => void;
  onReturnToHost?: () => void;
}) {
  return <main className="welcome-shell"><section className="welcome-copy">
    <p className="eyebrow">A family music timeline game</p>
    {/* eslint-disable-next-line @next/next/no-img-element */}
    <div className="logo-frame"><img src={cannabeatsPath("/cannabeats-logo-640.jpg")}
      width="640" height="640" alt="CannaBeats — Premium Quality" /></div>
    <p className="welcome-lede">Listen closely. Place the song in time. Trust your ears.</p>
  </section><section className="entry-card">
    {invite ? <form className="entry-block" onSubmit={onJoin}>
      <p className="step-label">Private game invitation</p><h2>Join the game</h2>
      <label>Your name<input className="player-name-input" value={name}
        onChange={(event) => onName(event.target.value)} maxLength={24}
        autoComplete="name" required /></label>
      <button className="primary-button" disabled={busy || !name.trim()}>Join game</button>
      {onReturnToHost && <button className="text-button" disabled={busy}
        onClick={onReturnToHost} type="button">Return to Host lobby</button>}
    </form> : <div className="entry-block"><p className="step-label">On the shared Mac</p>
      <h2>Host a game</h2><p>Open this screen from the CannaBeats Host app. If this Mac is already authorized, continue below.</p>
      <button className="primary-button" disabled={busy} onClick={onCreate} type="button">Create game</button>
    </div>}
    {error && <p className="error-message" role="alert">{error}</p>}
  </section></main>;
}

export default function Home() {
  const [session, setSession] = useState<ReleaseSession | null>(null);
  const [state, setState] = useState<ReleaseGameState | null>(null);
  const [lifecycle, setLifecycle] = useState<"lobby" | "active" | "completed" | "abandoned" | null>(null);
  const [invite, setInvite] = useState<{ gameId: string; token: string } | null>(null);
  const [returnToHostSession, setReturnToHostSession] = useState<ReleaseSession | null>(null);
  const [inviteUrl, setInviteUrl] = useState("");
  const [qrCodeUrl, setQrCodeUrl] = useState("");
  const [inviteCopied, setInviteCopied] = useState(false);
  const [name, setName] = useState("");
  const [hostPlayerName, setHostPlayerName] = useState("");
  const [selection, setSelection] = useState<{ round: number; index: number } | null>(null);
  const [pending, setPending] = useState<ReleaseActionIntent | null>(null);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState("");
  const [audioSessionId, setAudioSessionId] = useState<string | null>(null);
  const [playback, setPlayback] = useState<ReleasePlaybackProjection>({
    state: "unknown", pending: null, failed: null,
  });
  const [playbackControlBusy, setPlaybackControlBusy] = useState(false);
  const sharedAudio = useReleaseAudioStream({
    gameId: session?.gameId ?? "", audioSessionId,
  });

  const selected = selection && selection.round === state?.round ? selection.index : null;
  const activePlayer = state?.players.find(({ id }) => id === state.activePlayerId) ?? null;
  const currentPlayer = session?.participantId
    ? state?.players.find(({ id }) => id === session.participantId) ?? null : null;
  const isMyTurn = Boolean(currentPlayer && currentPlayer.id === state?.activePlayerId);
  const hostControlsTurn = Boolean(session?.role === "host" && activePlayer?.control === "host");
  const winner = state?.players.find(({ id }) => id === state.winnerId) ?? null;

  const acceptSnapshot = useCallback((snapshot: {
    audio?: { audioSessionId: string; generation: number; state: "active" } | null;
    playback?: ReleasePlaybackProjection;
    lifecycle: "lobby" | "active" | "completed" | "abandoned";
    state: ReleaseGameState;
  }) => {
    setState((current) => !current || snapshot.state.revision >= current.revision
      ? snapshot.state : current);
    setLifecycle(snapshot.lifecycle);
    if (snapshot.audio !== undefined) setAudioSessionId(snapshot.audio?.audioSessionId ?? null);
    if (snapshot.playback !== undefined) setPlayback(snapshot.playback);
  }, []);

  const acceptActionState = useCallback((next: ReleaseGameState) => {
    const accepted = acceptReleaseAction(localStorage, next);
    setState(accepted.state);
    setLifecycle(accepted.lifecycle);
  }, []);

  const refresh = useCallback(async (current: ReleaseSession) => {
    const snapshot = current.role === "host"
      ? await hostSnapshot(current.gameId) : await participantSnapshot(current.gameId);
    acceptSnapshot(snapshot);
    return snapshot;
  }, [acceptSnapshot]);

  const restore = useCallback(async () => {
    const pendingRecovery = loadPendingReleaseRecovery(localStorage);
    const saved = pendingRecovery?.session ?? loadReleaseSession(localStorage);
    const hostTicket = new URLSearchParams(window.location.search).get("hostTicket");
    if (hostTicket) {
      await exchangeHostTicket(hostTicket);
      const url = new URL(window.location.href);
      url.searchParams.delete("hostTicket");
      window.history.replaceState({}, "", `${url.pathname}${url.search}${url.hash}`);
    }
    if (pendingRecovery) {
      setSession(pendingRecovery.session);
      setPending(pendingRecovery.pending);
      return;
    }
    const fragment = new URLSearchParams(window.location.hash.replace(/^#/u, ""));
    const gameId = new URLSearchParams(window.location.search).get("game");
    const inviteToken = fragment.get("invite");
    if (gameId && inviteToken) {
      setInvite({ gameId, token: inviteToken });
      setReturnToHostSession(saved?.role === "host" && saved.gameId === gameId ? saved : null);
      setName(localStorage.getItem(PLAYER_NAME_KEY) ?? "");
      return;
    }
    if (saved) {
      try {
        const snapshot = saved.role === "host"
          ? await hostSnapshot(saved.gameId) : await participantSnapshot(saved.gameId);
        setSession(saved); acceptSnapshot(snapshot); return;
      } catch (reason) {
        if (!(reason instanceof ReleaseClientError) || reason.code !== "unauthorized") throw reason;
      }
    }
    const participantFirst = saved?.role === "participant";
    const attempts = participantFirst
      ? [recoverParticipantGame, recoverHostGame] : [recoverHostGame, recoverParticipantGame];
    for (const recover of attempts) {
      try {
        const result = await recover();
        const snapshot = "game" in result ? result.game : result;
        if (!snapshot) continue;
        const next: ReleaseSession = "participantId" in snapshot && snapshot.participantId
          ? { gameId: snapshot.gameId, participantId: snapshot.participantId, role: "participant" }
          : { gameId: snapshot.gameId, role: "host" };
        saveReleaseSession(localStorage, next);
        setSession(next); acceptSnapshot(snapshot); return;
      } catch (reason) {
        if (!(reason instanceof ReleaseClientError) || reason.code !== "unauthorized") throw reason;
      }
    }
  }, [acceptSnapshot]);

  useEffect(() => {
    let cancelled = false;
    const timer = window.setTimeout(() => {
      void restore().catch((reason) => { if (!cancelled) setError(message(reason)); })
        .finally(() => { if (!cancelled) setBusy(false); });
    }, 0);
    return () => { cancelled = true; window.clearTimeout(timer); };
  }, [restore]);

  const reconcile = useCallback(async (intent: ReleaseActionIntent) => {
    setBusy(true); setPending(intent); setError(ERROR_TEXT.outcome_unknown);
    try {
      const result = await sendReleaseAction(intent);
      setPending(null); acceptActionState(result.state); setError("");
    } catch (reason) {
      if (reason instanceof ReleaseClientError && reason.code !== "outcome_unknown") {
        clearPendingReleaseAction(localStorage); setPending(null);
        if (reason.code === "stale_state" && session) await refresh(session).catch(() => {});
      }
      setError(message(reason));
    } finally { setBusy(false); }
  }, [acceptActionState, refresh, session]);

  useEffect(() => {
    if (!session) return;
    const retained = loadPendingReleaseAction(localStorage);
    if (retained && retained.gameId === session.gameId && retained.role === session.role) {
      const timer = window.setTimeout(() => { void reconcile(retained); }, 0);
      return () => window.clearTimeout(timer);
    }
  }, [reconcile, session]);

  useEffect(() => {
    if (!session || pending) return;
    const timer = window.setInterval(() => {
      void refresh(session).catch((reason) => {
        if (reason instanceof ReleaseClientError && reason.code === "unauthorized" && state?.winnerId) {
          setLifecycle("completed");
        } else setError("Reconnecting to the authoritative game state…");
      });
    }, POLL_MS);
    return () => window.clearInterval(timer);
  }, [pending, refresh, session, state?.winnerId]);

  useEffect(() => {
    if (!inviteUrl) return;
    let cancelled = false;
    void QRCode.toDataURL(inviteUrl, { width: 240, margin: 1 })
      .then((url) => { if (!cancelled) setQrCodeUrl(url); });
    return () => { cancelled = true; };
  }, [inviteUrl]);

  const act = useCallback(async (operation: string, payload: Record<string, unknown> = {}) => {
    if (!session || !state || busy || pending) return false;
    const intent = createActionIntent(session, state.revision, operation, payload);
    savePendingReleaseAction(localStorage, intent); setPending(intent); setBusy(true);
    setError("Saving this action…");
    try {
      const result = await sendReleaseAction(intent);
      setPending(null); acceptActionState(result.state);
      setSelection(null); setError(""); return true;
    } catch (reason) {
      if (!(reason instanceof ReleaseClientError) || reason.code !== "outcome_unknown") {
        clearPendingReleaseAction(localStorage); setPending(null);
        if (reason instanceof ReleaseClientError && reason.code === "stale_state") {
          await refresh(session).catch(() => {});
        }
      }
      setError(message(reason)); return false;
    } finally { setBusy(false); }
  }, [acceptActionState, busy, pending, refresh, session, state]);

  async function controlPlayback(operation: string) {
    if (playbackControlBusy) return;
    setPlaybackControlBusy(true);
    try {
      if (await act(operation) && session) {
        await refresh(session).catch((reason) => setError(message(reason)));
      }
    } finally { setPlaybackControlBusy(false); }
  }

  async function createGame(rules: GameRules = rulesForPreset("family")) {
    setBusy(true); setError("");
    try {
      const readiness = await releaseReadiness();
      const created = await createReleaseGame(readiness.catalogVersion, rules);
      const next = { gameId: created.gameId, role: "host" as const };
      saveReleaseSession(localStorage, next); setSession(next);
      setAudioSessionId(null);
      setPlayback({ state: "unknown", pending: null, failed: null });
      const snapshot = created.state
        ? { lifecycle: "lobby" as const, state: created.state } : await hostSnapshot(created.gameId);
      acceptSnapshot(snapshot); setInviteUrl(""); setQrCodeUrl("");
    } catch (reason) { setError(message(reason)); }
    finally { setBusy(false); }
  }

  async function join(event: FormEvent) {
    event.preventDefault(); if (!invite) return;
    setBusy(true); setError("");
    try {
      const admitted = await admitReleaseParticipant({
        displayName: name, gameId: invite.gameId, inviteToken: invite.token,
      });
      const next: ReleaseSession = {
        gameId: invite.gameId, participantId: admitted.participantId, role: "participant",
      };
      localStorage.setItem(PLAYER_NAME_KEY, name.trim()); saveReleaseSession(localStorage, next);
      window.history.replaceState({}, "", cannabeatsPath("/"));
      setInvite(null); setSession(next); acceptSnapshot(await participantSnapshot(next.gameId));
    } catch (reason) { setError(message(reason)); }
    finally { setBusy(false); }
  }

  async function makeInvitation() {
    if (!state || !session) return;
    setBusy(true); setError("");
    try {
      const issued = await issueReleaseInvitation(state.gameId, state.revision);
      await refresh(session);
      const url = new URL(cannabeatsPath("/"), window.location.origin);
      url.searchParams.set("game", state.gameId);
      url.hash = new URLSearchParams({ invite: issued.inviteToken }).toString();
      setInviteCopied(false); setInviteUrl(url.toString());
    } catch (reason) { setError(message(reason)); }
    finally { setBusy(false); }
  }

  async function copyInvitation() {
    if (!inviteUrl) return;
    try {
      await navigator.clipboard.writeText(inviteUrl);
      setInviteCopied(true);
    } catch {
      const field = document.getElementById("invite-share-url") as HTMLInputElement | null;
      field?.focus(); field?.select();
    }
  }

  async function returnToHost() {
    if (!returnToHostSession) return;
    setBusy(true); setError("");
    try {
      const snapshot = await hostSnapshot(returnToHostSession.gameId);
      window.history.replaceState({}, "", cannabeatsPath("/"));
      setInvite(null); setReturnToHostSession(null); setSession(returnToHostSession);
      acceptSnapshot(snapshot);
    } catch (reason) { setError(message(reason)); }
    finally { setBusy(false); }
  }

  async function removePlayer(player: ReleasePlayer) {
    if (!state || !session) return;
    if (player.control === "host") { await act("remove_host_player", { playerId: player.id }); return; }
    setBusy(true); setError("");
    try { await removeReleaseParticipant(state.gameId, player.id, state.revision); await refresh(session); }
    catch (reason) { setError(message(reason)); }
    finally { setBusy(false); }
  }

  async function endGame() {
    if (!state) return;
    setBusy(true);
    try {
      await terminateReleaseGame(state.gameId, state.revision);
      localStorage.removeItem(RELEASE_SESSION_KEY);
      setSession(null); setState(null); setLifecycle(null); setInviteUrl("");
      setAudioSessionId(null);
      setPlayback({ state: "unknown", pending: null, failed: null });
    } catch (reason) { setError(message(reason)); }
    finally { setBusy(false); }
  }

  if (busy && !state && !invite) return <main className="join-shell"><section className="join-card">
    <div className="join-note" aria-hidden="true">♪</div><h1>Opening CannaBeats…</h1>
    <p className="helper" role="status">Restoring the authoritative game state.</p>
  </section></main>;

  if (!session || !state) return <Welcome busy={busy} error={error} invite={invite}
    name={name} onName={setName} onJoin={join} onCreate={() => void createGame()}
    onReturnToHost={returnToHostSession ? () => void returnToHost() : undefined} />;

  if (state.phase === "lobby") return <main className="game-shell lobby-shell">
    <header className="game-header"><div><p className="eyebrow">CannaBeats lobby</p>
      <h1>{state.players.length}/8 players</h1></div>
      {session.role === "host" && <button className="text-button" disabled={busy}
        onClick={() => void endGame()}>End game</button>}
    </header><section className="lobby-card"><p className="step-label">Players</p>
      <h2>{state.players.length ? "The band is assembling" : "Add or invite players"}</h2>
      {session.role === "host" && <form className="host-player-form" onSubmit={(event) => {
        event.preventDefault(); const playerName = hostPlayerName.trim(); if (!playerName) return;
        void act("add_host_player", { name: playerName, playerId: uuid() })
          .then((accepted) => { if (accepted) setHostPlayerName(""); });
      }}><label className="visually-hidden" htmlFor="host-player-name">Player name</label>
        <input id="host-player-name" maxLength={24} value={hostPlayerName}
          onChange={(event) => setHostPlayerName(event.target.value)} placeholder="Shared-screen player" />
        <button className="secondary-button" disabled={busy || !hostPlayerName.trim()}>Add player</button>
      </form>}
      <div className="player-list">{state.players.map((player, index) => <div className="player-pill" key={player.id}>
        <span>{index + 1}</span>{player.name}<small className={`player-control-badge ${player.control}`}>
          {player.control === "host" ? "Shared screen" : "Phone"}</small>
        {session.role === "host" && <button type="button" disabled={busy}
          aria-label={`Remove ${player.name}`} onClick={() => void removePlayer(player)}>Remove</button>}
      </div>)}</div>
      {session.role === "host" ? <><RulesPanel key={JSON.stringify(state.rules)} rules={state.rules}
        busy={busy} onApply={(rules) => { void act("configure_game", { rules }); }} />
        <div className="join-invite"><div className="qr-card">{qrCodeUrl
          // eslint-disable-next-line @next/next/no-img-element
          ? <img src={qrCodeUrl} width="240" height="240" alt="Private game invitation QR code" />
          : <div className="qr-placeholder" aria-label="No active invitation" />}</div>
          <div><p className="step-label">Private invitation</p>
            <p className="helper">Create a link for family joining from their phones.</p>
            <button className="secondary-button" disabled={busy || state.players.length >= 8}
              type="button" onClick={() => void makeInvitation()}>{inviteUrl ? "Replace invitation" : "Create invitation"}</button>
            {inviteUrl && <div className="invite-share"><label htmlFor="invite-share-url">Share link</label>
              <div className="invite-share-row"><input id="invite-share-url" readOnly value={inviteUrl}
                onFocus={(event) => event.currentTarget.select()} aria-describedby="invite-share-help" />
                <button className="secondary-button" type="button" onClick={() => void copyInvitation()}>
                  {inviteCopied ? "Copied" : "Copy link"}</button></div>
              <small id="invite-share-help">This is the same private invitation encoded by the QR code.</small>
              <a href={inviteUrl} target="_blank" rel="noopener noreferrer">
                Preview invitation in new tab</a></div>}</div></div>
        <button className="primary-button" disabled={busy || state.players.length === 0}
          onClick={() => void act("start_game")}>Set up game</button>
      </> : <p className="waiting-note"><i /> Waiting for the Host to start</p>}
    </section>{error && <p className="error-message" role="alert">{error}</p>}
    {pending && <button className="secondary-button" disabled={busy}
      onClick={() => void reconcile(pending)}>Confirm pending action</button>}
  </main>;

  const participantLocked = session.role === "participant" && isMyTurn && state.phase === "placed"
    ? state.placement ?? null : null;
  const hostLocked = session.role === "host" && hostControlsTurn && state.phase === "placed"
    ? state.placement ?? null : null;
  const playbackTarget = playback.pending ?? playback.state;
  const playbackOperation = playbackTarget === "paused" ? "resume_playback" : "pause_playback";
  const playbackLabel = playbackControlBusy ? "Confirming music…"
    : playback.pending === "paused" ? "Pausing music…"
    : playback.pending === "playing" ? "Resuming music…"
      : playback.state === "paused" ? "Resume music"
        : playback.state === "playing" ? "Pause music" : "Playback unavailable";
  const playbackControlsAvailable = ["playing", "placed", "revealed"].includes(state.phase);

  return <main className={`game-shell ${session.role === "host" ? "host-game-shell" : "player-shell"}`}>
    <header className="game-header"><div><p className="eyebrow">Round {state.round}</p>
      <h1>{winner ? `${winner.name} wins!` : `${activePlayer?.name ?? "Player"}’s turn`}</h1></div>
      {session.role === "host" && lifecycle !== "completed" && <button className="text-button"
        disabled={busy} onClick={() => void endGame()}>End game</button>}</header>
    {session.role === "host" && state.phase === "ready" && <section
      className="shared-audio-panel compact" aria-label="Host shared audio readiness">
      <div><p className="step-label">Host audio</p><strong><i className={
        audioSessionId ? "ready" : ""
      } />{audioSessionId ? "Spotify and shared audio ready"
          : "Preparing Spotify and shared audio"}</strong><small>{audioSessionId
        ? "Remote players can start their audio before the first song."
        : "Keep Spotify open and signed in. If macOS asks, allow System Audio Recording; use the Readiness tab if this does not become ready."}</small></div>
    </section>}
    {session.role === "participant" && lifecycle === "active" && <section
      className="shared-audio-panel compact" aria-label="Shared audio controls">
      <div><p className="step-label">Game audio</p><strong><i className={
        sharedAudio.status === "playing" ? "ready" : ""
      } />{sharedAudio.label}</strong><small>{audioSessionId
        ? "Audio starts only when you tap the button."
        : "Waiting for the Host to start shared audio."}</small></div>
      <button className="secondary-button" type="button" disabled={!audioSessionId}
        onClick={() => {
          if (["connecting", "buffering", "playing"].includes(sharedAudio.status)) {
            sharedAudio.stop();
          } else void sharedAudio.start();
        }}>{["connecting", "buffering", "playing"].includes(sharedAudio.status)
          ? "Stop audio" : sharedAudio.status === "error" ? "Reconnect" : "Start audio"}</button>
    </section>}
    {session.role === "host" && state.phase !== "finished" && <section className="host-round-bar" aria-label="Current round controls">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img className="host-brand-icon" src={cannabeatsPath("/cannabeats-logo-640.jpg")}
        width="104" height="104" alt="CannaBeats" />
      <div className="host-round-copy"><p className="host-round-state">{state.phase === "ready" ? "Ready"
        : state.phase === "placed" ? "Locked" : state.phase === "revealed"
          ? state.result?.correct ? "Correct placement" : "Not quite" : "Mystery song"}</p>
        <h2>{activePlayer?.name}</h2>{state.phase === "revealed" && state.currentSong
          ? <p className="host-answer"><strong>{state.currentSong.year}</strong> · {state.currentSong.title} · {state.currentSong.artist}</p>
          : <p className="helper">Spotify playback is performed by the CannaBeats Host app.</p>}</div>
      <div className="host-round-controls">
        {state.phase === "ready" && <button className="primary-button"
          disabled={busy || !audioSessionId}
          onClick={() => void act("begin_round")}>Start first song</button>}
        {state.phase === "placed" && <button className="primary-button" disabled={busy}
          onClick={() => void act("reveal_answer")}>Reveal answer</button>}
        {state.phase === "revealed" && <button className="primary-button" disabled={busy}
          onClick={() => void act("advance_round")}>{state.winnerId ? "Finish game" : "Next player"}</button>}
        {(state.phase === "playing" || state.phase === "placed") && <button className="text-button"
          disabled={busy} onClick={() => void act("skip_track")}>Skip unavailable song</button>}
        {playbackControlsAvailable && <><button className="secondary-button"
          disabled={busy || playbackControlBusy || playback.pending !== null
            || playback.state === "unknown"}
          onClick={() => void controlPlayback(playbackOperation)} type="button">{playbackLabel}</button>
          <small className="playback-control-status" role="status">{playbackControlBusy
            ? "Loading authoritative Spotify state."
            : playback.failed
            ? `${playback.failed === "paused" ? "Pause" : "Resume"} failed. Try again.`
            : playback.pending ? "Waiting for verified Spotify state."
              : `Spotify verified ${playback.state}.`}</small></>}
        {state.phase === "placed" && hostControlsTurn && state.rules.allowRetraction && !state.retractionUsed
          && <button className="text-button" disabled={busy}
            onClick={() => void act("retract_placement")}>Change placement</button>}
      </div></section>}
    {winner && (state.phase === "finished" || lifecycle === "completed") ? <section className="winner-card">
      <p className="step-label">That’s the timeline</p><h2>{winner.name} wins!</h2>
      <p>First to {state.rules.targetScore} songs.</p>{session.role === "host" && <button
        className="primary-button" disabled={busy} onClick={() => void createGame(state.rules)}>Play again</button>}
    </section> : <>
      {session.role === "participant" && currentPlayer && <section className="player-board">
        <p className={`player-status ${isMyTurn && state.phase === "playing" ? "active" : ""}`}>
          {state.phase === "revealed" && state.currentSong
            ? `${state.result?.correct ? "Correct!" : "Not quite"} ${state.currentSong.title} · ${state.currentSong.artist} · ${state.currentSong.year}`
            : isMyTurn && state.phase === "playing" ? "Place the mystery song"
              : state.phase === "placed" ? "Locked in — waiting for the reveal"
                : `Waiting for ${activePlayer?.name ?? "the active player"}`}</p>
        <Timeline player={currentPlayer} interactive={isMyTurn && state.phase === "playing"}
          selected={selected} locked={participantLocked}
          onSelect={(index) => setSelection({ round: state.round, index })} />
        {isMyTurn && state.phase === "playing" && <button className="primary-button sticky-action"
          disabled={selected === null || busy} onClick={() => void act("place_song", { index: selected })}>Lock placement</button>}
        {isMyTurn && state.phase === "placed" && state.rules.allowRetraction && !state.retractionUsed
          && <button className="secondary-button retract-button" disabled={busy}
            onClick={() => void act("retract_placement")}>Retract placement</button>}
      </section>}
      {session.role === "host" && <section className="host-scoreboard">{state.players.map((player) => <article
        className="host-player-row" key={player.id}><header><h2>{player.name}</h2>
          <span>{player.timeline.length} / {state.rules.targetScore}</span></header>
        <Timeline player={player} interactive={hostControlsTurn && player.id === state.activePlayerId
          && state.phase === "playing"} selected={selected}
          locked={player.id === state.activePlayerId ? hostLocked : null}
          onSelect={(index) => setSelection({ round: state.round, index })} />
        {hostControlsTurn && player.id === state.activePlayerId && state.phase === "playing"
          && <button className="primary-button" disabled={selected === null || busy}
            onClick={() => void act("place_song", { index: selected })}>Lock placement</button>}
      </article>)}</section>}
    </>}
    <p className="visually-hidden" aria-live="polite">{busy ? "Action pending." : "Game ready."}</p>
    {error && <p className="error-message" role="alert">{error}</p>}
    {pending && <button className="secondary-button" disabled={busy}
      onClick={() => void reconcile(pending)}>Confirm pending action</button>}
  </main>;
}
