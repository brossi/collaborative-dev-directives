"use client";

import { FormEvent, useEffect, useState } from "react";
import Link from "next/link";
import { PLAYER_NAME_KEY, SESSION_KEY, type GameSession } from "../../../lib/session";
import { cannabeatsPath } from "../../../lib/paths";

export default function JoinRoom({ code }: { code: string }) {
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    const savedName = localStorage.getItem(PLAYER_NAME_KEY)?.trim();
    if (!savedName) return;
    const timer = window.setTimeout(() => setName((current) => current || savedName), 0);
    return () => window.clearTimeout(timer);
  }, []);

  async function join(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      const chosenName = name.trim();
      const response = await fetch(cannabeatsPath("/api/game"), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "join", code, name: chosenName }),
      });
      const payload = await response.json() as { error?: string; playerId?: string };
      if (!response.ok || !payload.playerId) throw new Error(payload.error ?? "Unable to join this room.");

      const session: GameSession = { code, playerId: payload.playerId };
      localStorage.setItem(PLAYER_NAME_KEY, chosenName);
      sessionStorage.setItem(SESSION_KEY, JSON.stringify(session));
      window.location.replace(cannabeatsPath("/"));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Unable to join this room.");
      setBusy(false);
    }
  }

  return (
    <main className="join-shell">
      <section className="join-card">
        <div className="join-note" aria-hidden="true">♪</div>
        <p className="eyebrow">Joining room {code}</p>
        <h1>What should we call you?</h1>
        <p className="helper">Add your name, then get ready to place the music in time.</p>
        <form className="join-form" onSubmit={join}>
          <label>
            Your name
            <input
              autoComplete="name"
              autoFocus
              maxLength={24}
              onChange={(event) => setName(event.target.value)}
              placeholder="Name or nickname"
              required
              value={name}
            />
          </label>
          <button className="primary-button" disabled={busy}>
            {busy ? "Joining…" : "Join the game"}
          </button>
        </form>
        {error && <p className="error-message" role="alert">{error}</p>}
        <Link className="join-back" href={cannabeatsPath("/")}>Enter a different room code</Link>
      </section>
    </main>
  );
}
