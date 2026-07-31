"use client";

import { FormEvent, useCallback, useEffect, useMemo, useState } from "react";
import type { Player, RoomView, Song } from "../lib/game";

type Session = {
  code: string;
  hostToken?: string;
  playerId?: string;
};

const SESSION_KEY = "cannabeats-session";

async function gameRequest(body: Record<string, unknown>) {
  const response = await fetch("/api/game", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const payload = await response.json() as { room?: RoomView; error?: string; hostToken?: string; playerId?: string };
  if (!response.ok) throw new Error(payload.error ?? "Something went wrong.");
  return payload;
}

function spotifyHref(song: Song | null) {
  return song?.uri ?? "#";
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
  const [session, setSession] = useState<Session | null>(null);
  const [name, setName] = useState("");
  const [roomCode, setRoomCode] = useState("");
  const [selection, setSelection] = useState<{ round: number; index: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const refresh = useCallback(async (current: Session) => {
    const params = new URLSearchParams({ code: current.code });
    if (current.hostToken) params.set("hostToken", current.hostToken);
    const response = await fetch(`/api/game?${params}`, { cache: "no-store" });
    const payload = await response.json() as { room?: RoomView; error?: string };
    if (!response.ok) throw new Error(payload.error ?? "Unable to refresh the room.");
    setRoom(payload.room ?? null);
  }, []);

  useEffect(() => {
    const saved = sessionStorage.getItem(SESSION_KEY);
    if (!saved) return;
    try {
      const restored = JSON.parse(saved) as Session;
      const timer = window.setTimeout(() => {
        setSession(restored);
        void refresh(restored).catch(() => sessionStorage.removeItem(SESSION_KEY));
      }, 0);
      return () => window.clearTimeout(timer);
    } catch {
      sessionStorage.removeItem(SESSION_KEY);
    }
  }, [refresh]);

  useEffect(() => {
    if (!session) return;
    const timer = window.setInterval(() => {
      void refresh(session).catch((reason: Error) => setError(reason.message));
    }, 1200);
    return () => window.clearInterval(timer);
  }, [refresh, session]);

  const currentPlayer = useMemo(
    () => room?.players.find((player) => player.id === session?.playerId) ?? null,
    [room, session?.playerId],
  );
  const activePlayer = room?.players.find((player) => player.id === room.activePlayerId) ?? null;
  const winner = room?.players.find((player) => player.id === room.winnerId) ?? null;
  const isMyTurn = Boolean(currentPlayer && room?.activePlayerId === currentPlayer.id);
  const selected = selection && selection.round === room?.round ? selection.index : null;

  async function act(body: Record<string, unknown>) {
    if (!session) return;
    setBusy(true);
    setError("");
    try {
      const payload = await gameRequest({ ...body, code: session.code });
      if (payload.room) setRoom(payload.room);
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
      const next = { code: payload.room!.code, hostToken: payload.hostToken! };
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
      const payload = await gameRequest({ action: "join", code, name });
      const next = { code, playerId: payload.playerId! };
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

  if (!room || !session) {
    return (
      <main className="welcome-shell">
        <section className="welcome-copy">
          <p className="eyebrow">A family music timeline game</p>
          <div className="logo-frame">
            {/* This local, already-sized brand image does not need runtime optimization. */}
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src="/cannabeats-logo.jpg" width="1200" height="1200" alt="CannaBeats — Premium Quality" />
          </div>
          <p className="welcome-lede">Listen closely. Place the song in time. Trust your ears.</p>
        </section>
        <section className="entry-card">
          <div className="entry-block">
            <p className="step-label">On the shared screen</p>
            <h2>Host a game</h2>
            <p>Create a room, control the music, and reveal each answer.</p>
            <button className="primary-button" onClick={createRoom} disabled={busy}>Create room</button>
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
              <p className="helper">Players join at this address using room code <strong>{room.code}</strong>.</p>
              <button className="primary-button" disabled={!room.players.length || busy} onClick={() => act({ action: "start", hostToken: session.hostToken })}>Start game</button>
            </>
          ) : <p className="waiting-note"><i /> Waiting for the host to start</p>}
        </section>
        {error && <p className="error-message" role="alert">{error}</p>}
      </main>
    );
  }

  return (
    <main className="game-shell">
      <header className="game-header compact">
        <div><p className="eyebrow">Room {room.code}</p><h1>CannaBeats</h1></div>
        <div className="round-marker"><small>Round</small><strong>{room.round}</strong></div>
      </header>

      {winner && room.phase === "finished" ? (
        <section className="winner-card"><p className="step-label">That’s the timeline</p><h2>{winner.name} wins!</h2><p>First to ten songs, and officially in tune with history.</p></section>
      ) : (
        <>
          <section className="turn-banner">
            <p>{isMyTurn ? "Your turn" : `${activePlayer?.name ?? "Player"}’s turn`}</p>
            <span>{room.phase === "placed" ? "Placement locked" : room.phase === "revealed" ? "Answer revealed" : "Listen and place the song"}</span>
          </section>

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
                  <a className="spotify-button" href={spotifyHref(room.currentSong)}>Open in Spotify</a>
                  <button className="text-button" disabled={busy} onClick={() => act({ action: "skip", hostToken: session.hostToken })}>Skip unavailable song</button>
                </div>
              )}
              {room.phase === "placed" && <button className="primary-button" disabled={busy} onClick={() => act({ action: "reveal", hostToken: session.hostToken })}>Reveal answer</button>}
              {room.phase === "revealed" && <button className="primary-button" disabled={busy} onClick={() => act({ action: "advance", hostToken: session.hostToken })}>{room.winnerId ? "Finish game" : "Next player"}</button>}
            </section>
          )}

          {!room.isHost && currentPlayer && (
            <section className="player-board">
              <div className="board-heading"><div><p className="step-label">Your timeline</p><h2>{currentPlayer.name}</h2></div><span>{currentPlayer.timeline.length} / 10</span></div>
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
              {!isMyTurn && room.phase !== "revealed" && <p className="waiting-note"><i /> Listen closely — you’re up later</p>}
              {room.phase === "placed" && <p className="waiting-note"><i /> Placement locked. Waiting for the reveal</p>}
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
      <button className="leave-link" onClick={leaveRoom}>Leave room</button>
    </main>
  );
}
