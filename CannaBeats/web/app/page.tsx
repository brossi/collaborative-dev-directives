"use client";

import { FormEvent, useCallback, useEffect, useMemo, useState } from "react";
import QRCode from "qrcode";
import type { Player, RoomView } from "../lib/game";
import { PLAYER_NAME_KEY, SESSION_KEY, type GameSession } from "../lib/session";
import { useSpotifyPlayer } from "../lib/use-spotify-player";

async function gameRequest(body: Record<string, unknown>) {
  const response = await fetch("/api/game", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const payload = await response.json() as { room?: RoomView; error?: string; hostToken?: string; playerId?: string; joinOrigin?: string };
  if (!response.ok) throw new Error(payload.error ?? "Something went wrong.");
  return payload;
}

function Timeline({ player, interactive, selected, onSelect }: {
  player: Player;
  interactive: boolean;
  selected: number | null;
  onSelect: (index: number) => void;
}) {
  return (
    <div className="timeline" aria-label={`${player.name}’s timeline`}>
      {player.timeline.map((song, index) => (
        <div className="timeline-section" key={`${song.year}-${song.title}-${index}`}>
          {interactive && (
            <button
              className={`timeline-gap ${selected === index ? "selected" : ""}`}
              onClick={() => onSelect(index)}
              type="button"
            >
              <span>{selected === index ? "Mystery song goes here" : "Place here"}</span>
            </button>
          )}
          <article className="song-card">
            <span className="song-year">{song.year}</span>
            <span className="song-details">
              <strong>{song.title}</strong>
              <small>{song.artist}</small>
            </span>
          </article>
        </div>
      ))}
      {interactive && (
        <button
          className={`timeline-gap ${selected === player.timeline.length ? "selected" : ""}`}
          onClick={() => onSelect(player.timeline.length)}
          type="button"
        >
          <span>{selected === player.timeline.length ? "Mystery song goes here" : "Place here"}</span>
        </button>
      )}
    </div>
  );
}

export default function Home() {
  const [room, setRoom] = useState<RoomView | null>(null);
  const [session, setSession] = useState<GameSession | null>(null);
  const [name, setName] = useState("");
  const [roomCode, setRoomCode] = useState("");
  const [selection, setSelection] = useState<{ round: number; index: number } | null>(null);
  const [qrCodeUrl, setQrCodeUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const spotify = useSpotifyPlayer();

  const refresh = useCallback(async (current: GameSession) => {
    const params = new URLSearchParams({ code: current.code });
    if (current.hostToken) params.set("hostToken", current.hostToken);
    const response = await fetch(`/api/game?${params}`, { cache: "no-store" });
    const payload = await response.json() as { room?: RoomView; error?: string };
    if (!response.ok) throw new Error(payload.error ?? "Unable to refresh the room.");
    setRoom(payload.room ?? null);
  }, []);

  useEffect(() => {
    const sharedCode = new URLSearchParams(window.location.search).get("room")?.trim().toUpperCase();
    const saved = sessionStorage.getItem(SESSION_KEY);
    const savedName = localStorage.getItem(PLAYER_NAME_KEY)?.trim();
    const timer = window.setTimeout(() => {
      if (sharedCode) setRoomCode(sharedCode);
      if (savedName) setName((current) => current || savedName);
      if (!saved) return;
      try {
        const restored = JSON.parse(saved) as GameSession;
        setSession(restored);
        void refresh(restored).catch(() => sessionStorage.removeItem(SESSION_KEY));
      } catch {
        sessionStorage.removeItem(SESSION_KEY);
      }
    }, 0);
    return () => window.clearTimeout(timer);
  }, [refresh]);

  useEffect(() => {
    if (!session) return;
    const timer = window.setInterval(() => {
      void refresh(session).catch((reason: Error) => setError(reason.message));
    }, 1200);
    return () => window.clearInterval(timer);
  }, [refresh, session]);

  useEffect(() => {
    if (!room?.isHost || room.phase !== "lobby") return;
    let cancelled = false;
    const joinUrl = new URL(session?.joinOrigin ?? window.location.origin);
    joinUrl.pathname = `/join/${room.code}`;
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

  const currentPlayer = useMemo(
    () => room?.players.find((player) => player.id === session?.playerId) ?? null,
    [room, session?.playerId],
  );
  const activePlayer = room?.players.find((player) => player.id === room.activePlayerId) ?? null;
  const winner = room?.players.find((player) => player.id === room.winnerId) ?? null;
  const isMyTurn = Boolean(currentPlayer && room?.activePlayerId === currentPlayer.id);
  const selected = selection && selection.round === room?.round ? selection.index : null;

  async function act(body: Record<string, unknown>, playNewSong = false) {
    if (!session) return;
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
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Something went wrong.");
    } finally {
      setBusy(false);
    }
  }

  async function createRoom() {
    setBusy(true);
    setError("");
    try {
      const payload = await gameRequest({ action: "create" });
      const next = { code: payload.room!.code, hostToken: payload.hostToken!, joinOrigin: payload.joinOrigin };
      sessionStorage.setItem(SESSION_KEY, JSON.stringify(next));
      setSession(next);
      setRoom(payload.room!);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Unable to create a room.");
    } finally {
      setBusy(false);
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

  if (!room || !session) {
    return (
      <main className="welcome-shell">
        <section className="welcome-copy">
          <p className="eyebrow">A family music timeline game</p>
          <div className="logo-frame">
            {/* This local, already-sized brand image does not need runtime optimization. */}
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src="/cannabeats-logo-640.jpg" width="640" height="640" alt="CannaBeats — Premium Quality" />
          </div>
          <p className="welcome-lede">Listen closely. Place the song in time. Trust your ears.</p>
        </section>
        <section className="entry-card">
          <div className="entry-block">
            <p className="step-label">On the shared screen</p>
            <h2>Host a game</h2>
            <p>Create a room, play every mystery song here, and reveal each answer.</p>
            {!spotify.supportedOrigin ? (
              <a className="spotify-button" href="http://127.0.0.1:3000/">Open the private host screen</a>
            ) : spotify.isReady ? (
              <p className="spotify-status"><i /> Spotify is ready in CannaBeats</p>
            ) : (
              <button className="spotify-button" type="button" onClick={() => void spotify.connect()} disabled={spotify.status === "connecting"}>
                {spotify.status === "connecting" ? "Connecting Spotify…" : "Connect Spotify"}
              </button>
            )}
            <button className="primary-button" onClick={createRoom} disabled={busy || !spotify.supportedOrigin || !spotify.isReady}>Create room</button>
            {(spotify.error || !spotify.isConfigured) && <p className="error-message" role="alert">{spotify.error || "Spotify is not configured for this build."}</p>}
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
          <h2>{room.players.length ? "The band is assembling" : "Waiting for players"}</h2>
          <div className="player-list">
            {room.players.map((player, index) => <div className="player-pill" key={player.id}><span>{index + 1}</span>{player.name}</div>)}
          </div>
          {room.isHost ? (
            <>
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
                  <p className="helper">Open the camera on each player’s phone. Manual room code: <strong>{room.code}</strong></p>
                </div>
              </div>
              <p className="spotify-status"><i /> {spotify.isReady ? "Spotify is ready in CannaBeats" : "Reconnect Spotify before starting"}</p>
              {!spotify.isReady && <button className="spotify-button" type="button" onClick={() => void spotify.connect()}>Connect Spotify</button>}
              <button className="primary-button" disabled={!room.players.length || busy || !spotify.isReady} onClick={() => act({ action: "start", hostToken: session.hostToken }, true)}>Start game</button>
            </>
          ) : <p className="waiting-note"><i /> Waiting for the host to start</p>}
        </section>
        {error && <p className="error-message" role="alert">{error}</p>}
      </main>
    );
  }

  return (
    <main className={`game-shell ${room.isHost ? "" : "player-shell"}`}>
      {room.isHost ? (
        <header className="game-header compact">
          <div><p className="eyebrow">Room {room.code}</p><h1>CannaBeats</h1></div>
          <div className="round-marker"><small>Round</small><strong>{room.round}</strong></div>
        </header>
      ) : currentPlayer && (
        <header className="player-header">
          <strong>{currentPlayer.name}</strong>
          <span>{currentPlayer.timeline.length} / 10</span>
        </header>
      )}

      {winner && room.phase === "finished" ? (
        <section className="winner-card"><p className="step-label">That’s the timeline</p><h2>{winner.name} wins!</h2><p>First to ten songs, and officially in tune with history.</p></section>
      ) : (
        <>
          {room.isHost ? (
            <section className="turn-banner">
              <p>{isMyTurn ? "Your turn" : `${activePlayer?.name ?? "Player"}’s turn`}</p>
              <span>{room.phase === "placed" ? "Placement locked" : room.phase === "revealed" ? "Answer revealed" : "Listen and place the song"}</span>
            </section>
          ) : room.phase !== "revealed" && (
            <p className={`player-status ${isMyTurn && room.phase === "playing" ? "active" : ""}`}>
              {isMyTurn && room.phase === "playing"
                ? "Place the mystery song"
                : room.phase === "placed"
                  ? "Locked in — waiting for the reveal"
                  : `${activePlayer?.name ?? "Another player"} is choosing`}
            </p>
          )}

          {room.isHost && (
            <section className="host-panel">
              <div className={`mystery-disc ${room.phase === "playing" ? "spinning" : ""}`}><i /></div>
              {room.phase === "revealed" && room.currentSong ? (
                <div className="reveal-copy">
                  <p className={room.result?.correct ? "correct" : "incorrect"}>{room.result?.correct ? "Correct placement" : "Not quite"}</p>
                  <h2>{room.currentSong.title}</h2>
                  <p>{room.currentSong.artist}</p>
                  <strong>{room.currentSong.year}</strong>
                </div>
              ) : (
                <div className="host-actions">
                  <p className="step-label">Mystery song</p>
                  <h2>{room.phase === "placed" ? `${activePlayer?.name} has locked in` : `Play for ${activePlayer?.name}`}</h2>
                  <button
                    className="spotify-button"
                    type="button"
                    disabled={busy || !room.currentSong?.uri}
                    onClick={() => void controlPlayback(() => spotify.status === "playing"
                      ? spotify.pause()
                      : spotify.status === "paused"
                        ? spotify.resume()
                        : spotify.play(room.currentSong!.uri!))}
                  >
                    {spotify.status === "playing" ? "Pause mystery song" : spotify.status === "paused" ? "Resume mystery song" : "Play mystery song"}
                  </button>
                  <button className="text-button" disabled={busy} onClick={() => act({ action: "skip", hostToken: session.hostToken }, true)}>Skip unavailable song</button>
                </div>
              )}
              {room.phase === "placed" && <button className="primary-button" disabled={busy} onClick={() => act({ action: "reveal", hostToken: session.hostToken })}>Reveal answer</button>}
              {room.phase === "revealed" && <button className="primary-button" disabled={busy} onClick={() => act({ action: "advance", hostToken: session.hostToken }, !room.winnerId)}>{room.winnerId ? "Finish game" : "Next player"}</button>}
            </section>
          )}

          {!room.isHost && currentPlayer && (
            <section className="player-board">
              {room.phase === "revealed" && room.currentSong && (
                <div className={`mobile-result ${room.result?.correct ? "correct" : "incorrect"}`}>
                  <strong>{room.result?.correct ? "Correct!" : "Not quite"}</strong>
                  <span>{room.currentSong.title} · {room.currentSong.artist} · {room.currentSong.year}</span>
                </div>
              )}
              <Timeline player={currentPlayer} interactive={isMyTurn && room.phase === "playing"} selected={selected} onSelect={(index) => setSelection({ round: room.round, index })} />
              {isMyTurn && room.phase === "playing" && (
                <button className="primary-button sticky-action" disabled={selected === null || busy} onClick={() => act({ action: "place", playerId: session.playerId, index: selected })}>Lock placement</button>
              )}
            </section>
          )}

          {room.isHost && (
            <section className="scoreboard">
              {room.players.map((player) => <div key={player.id} className={player.id === room.activePlayerId ? "active" : ""}><span>{player.name}</span><strong>{player.timeline.length} / 10</strong></div>)}
            </section>
          )}
        </>
      )}
      {error && <p className="error-message" role="alert">{error}</p>}
      <button className="leave-link" onClick={leaveRoom}>{room.isHost ? "Leave room" : `Room ${room.code} · Leave`}</button>
    </main>
  );
}
