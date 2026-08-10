"use client";

import { FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import QRCode from "qrcode";
import type { Player, RoomView } from "../lib/game";
import { CATALOG_YEAR_MAX, CATALOG_YEAR_MIN, ERA_BUCKETS, RULE_PRESET_OPTIONS, rulesForPreset, type GameRules } from "../lib/rules";
import { HOST_RULES_KEY, PLAYER_NAME_KEY, SESSION_KEY, type GameSession } from "../lib/session";
import { useSpotifyPlayer, type SpotifyTrackArtwork } from "../lib/use-spotify-player";
import { CANNABEATS_BASE_PATH, cannabeatsPath } from "../lib/paths";

async function gameRequest(body: Record<string, unknown>) {
  const response = await fetch(cannabeatsPath("/api/game"), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const payload = await response.json() as { room?: RoomView; error?: string; hostToken?: string; playerId?: string; joinOrigin?: string };
  if (!response.ok) throw new Error(payload.error ?? "Something went wrong.");
  return payload;
}

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
  const [session, setSession] = useState<GameSession | null>(null);
  const [name, setName] = useState("");
  const [hostPlayerName, setHostPlayerName] = useState("");
  const [roomCode, setRoomCode] = useState("");
  const [selection, setSelection] = useState<{ round: number; index: number } | null>(null);
  const [qrCodeUrl, setQrCodeUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [artworkByUri, setArtworkByUri] = useState<Record<string, SpotifyTrackArtwork>>({});
  const spotify = useSpotifyPlayer();
  const spotifyIsReady = spotify.isReady;
  const trackArtwork = spotify.trackArtwork;
  const hostRules = room?.isHost ? JSON.stringify(room.rules) : "";

  const refresh = useCallback(async (current: GameSession) => {
    const params = new URLSearchParams({ code: current.code });
    if (current.hostToken) params.set("hostToken", current.hostToken);
    const response = await fetch(`${cannabeatsPath("/api/game")}?${params}`, { cache: "no-store" });
    const payload = await response.json() as { room?: RoomView; error?: string };
    if (!response.ok) throw new Error(payload.error ?? "Unable to refresh the room.");
    if (!payload.room) throw new Error("The room response was incomplete.");
    setRoom(payload.room);
    return payload.room;
  }, []);

  useEffect(() => {
    const sharedCode = new URLSearchParams(window.location.search).get("room")?.trim().toUpperCase();
    const saved = sessionStorage.getItem(SESSION_KEY);
    const savedName = localStorage.getItem(PLAYER_NAME_KEY)?.trim();
    const timer = window.setTimeout(() => {
      if (savedName) setName((current) => current || savedName);
      if (sharedCode) {
        const launched: GameSession = {
          code: sharedCode,
          joinOrigin: `${window.location.origin}${CANNABEATS_BASE_PATH}`,
        };
        void refresh(launched).then((view) => {
          if (!view.isHost) {
            setRoom(null);
            setRoomCode(sharedCode);
            return;
          }
          sessionStorage.setItem(SESSION_KEY, JSON.stringify(launched));
          setSession(launched);
          window.history.replaceState({}, "", cannabeatsPath("/"));
        }).catch((reason: Error) => {
          setRoomCode(sharedCode);
          setError(reason.message);
        });
        return;
      }
      if (!saved) return;
      try {
        const restored = JSON.parse(saved) as GameSession;
        setSession(restored);
        void refresh(restored).catch(() => setError("The room is temporarily unavailable. Retrying…"));
      } catch {
        sessionStorage.removeItem(SESSION_KEY);
      }
    }, 0);
    return () => window.clearTimeout(timer);
  }, [refresh]);

  useEffect(() => {
    if (!session) return;
    const timer = window.setInterval(() => {
      void refresh(session)
        .then(() => setError(""))
        .catch(() => setError("The room is temporarily unavailable. Retrying…"));
    }, 1200);
    return () => window.clearInterval(timer);
  }, [refresh, session]);

  useEffect(() => {
    if (hostRules) localStorage.setItem(HOST_RULES_KEY, hostRules);
  }, [hostRules]);

  useEffect(() => {
    if (!room?.isHost || room.phase !== "lobby") return;
    let cancelled = false;
    const joinUrl = new URL(session?.joinOrigin ?? window.location.origin);
    joinUrl.pathname = cannabeatsPath(`/join/${room.code}`);
    joinUrl.search = "";
    void QRCode.toDataURL(joinUrl.toString(), {
      width: 240,
      margin: 1,
      color: { dark: "#171c2b", light: "#fff5c9" },
    }).then((url) => {
      if (!cancelled) setQrCodeUrl(url);
    }).catch(() => setError("Unable to create the room QR code."));
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
  const playbackLabel = spotify.status === "playing"
    ? "Pause"
    : spotify.status === "paused"
      ? "Resume"
      : "Play";

  async function act(body: Record<string, unknown>, playNewSong = false) {
    if (!session) return false;
    setBusy(true);
    setError("");
    try {
      const payload = await gameRequest({ ...body, code: session.code });
      if (payload.room) {
        setRoom(payload.room);
        if (playNewSong && payload.room.phase === "playing" && payload.room.currentSong?.uri) {
          await spotify.play(payload.room.currentSong.uri);
        }
      }
      return true;
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Something went wrong.");
      return false;
    } finally {
      setBusy(false);
    }
  }

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
      const code = roomCode.trim().toUpperCase();
      const chosenName = name.trim();
      const payload = await gameRequest({ action: "join", code, name: chosenName });
      const next = { code, playerId: payload.playerId! };
      localStorage.setItem(PLAYER_NAME_KEY, chosenName);
      sessionStorage.setItem(SESSION_KEY, JSON.stringify(next));
      setSession(next);
      setRoom(payload.room!);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Unable to join the room.");
    } finally {
      setBusy(false);
    }
  }

  function leaveRoom() {
    if (room?.isHost) void spotify.stop();
    sessionStorage.removeItem(SESSION_KEY);
    setSession(null);
    setRoom(null);
    setSelection(null);
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

  if (session && !room) {
    return (
      <main className="join-shell">
        <section className="join-card">
          <div className="join-note" aria-hidden="true">♪</div>
          <p className="eyebrow">Room {session.code}</p>
          <h1>Rejoining the room…</h1>
          <p className="helper">Your place is saved. We’ll reconnect automatically.</p>
          {error && <p className="error-message" role="status">{error}</p>}
          <button className="text-button" type="button" onClick={leaveRoom}>Leave room</button>
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
            <p>Start in the CannaBeats Host app. It creates the real room, prepares shared audio, and opens this full setup screen automatically.</p>
            <p className="spotify-status"><i /> Room creation is restricted to an authorized Host app</p>
          </div>
          <div className="or-rule"><span>or</span></div>
          <form className="entry-block" onSubmit={joinRoom}>
            <p className="step-label">On each player’s phone</p>
            <h2>Join a game</h2>
            <label>Room code<input value={roomCode} onChange={(event) => setRoomCode(event.target.value.toUpperCase())} maxLength={4} autoCapitalize="characters" required /></label>
            <label>Your name<input value={name} onChange={(event) => setName(event.target.value)} maxLength={24} required /></label>
            <button className="secondary-button" disabled={busy}>Join room</button>
          </form>
          {error && <p className="error-message" role="alert">{error}</p>}
        </section>
      </main>
    );
  }

  if (room.phase === "lobby") {
    return (
      <main className="game-shell lobby-shell">
        <header className="game-header">
          <div><p className="eyebrow">CannaBeats room</p><h1>{room.code}</h1></div>
          <button className="text-button" onClick={leaveRoom}>Leave</button>
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
                  <p className="helper">Phone players scan here; add shared-screen players above. Manual room code: <strong>{room.code}</strong></p>
                </div>
              </div>
              <p className="spotify-status"><i /> {spotify.isReady ? "Spotify is ready in CannaBeats" : "Reconnect Spotify before starting"}</p>
              {!spotify.isReady && <button className="spotify-button" type="button" onClick={() => void spotify.connect()}>Connect Spotify</button>}
              <button className="primary-button" disabled={!room.players.length || busy || !spotify.isReady} onClick={() => act({ action: "start", hostToken: session.hostToken })}>Set up game</button>
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
                onClick={() => void controlPlayback(() => spotify.status === "playing"
                  ? spotify.pause()
                  : spotify.status === "paused"
                    ? spotify.resume()
                    : spotify.play(room.currentSong!.uri!))}
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
                  aria-label={spotify.status === "playing" ? "Pause mystery song" : "Resume mystery song"}
                  disabled={busy || !room.currentSong?.uri}
                  onClick={() => void controlPlayback(() => spotify.status === "playing" ? spotify.pause() : spotify.resume())}
                >
                  {spotify.status === "playing" ? "Pause" : "Resume"}
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
        </header>
      )}

      {winner && room.phase === "finished" ? (
        <section className="winner-card"><p className="step-label">That’s the timeline</p><h2>{winner.name} wins!</h2><p>First to {room.rules.targetScore} songs, and officially in tune with history.</p></section>
      ) : (
        <>
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
      <button className="leave-link" onClick={leaveRoom}>{room.isHost ? "Leave room" : `Room ${room.code} · Leave`}</button>
    </main>
  );
}
