"use client";

import { FormEvent, useEffect, useState } from "react";
import Link from "next/link";
import { PLAYER_NAME_KEY, SESSION_KEY, type GameSession } from "../../../lib/session";
import { cannabeatsPath } from "../../../lib/paths";
import { actionUuid } from "../../../lib/game-request";
import {
  clearAdmissionIntent,durableAdmissionIntent,releaseExpiredAdmissionIntent,
} from "../../../lib/admission-intent";
import { GAME_CLIENT_CONTRACT_HEADER, GAME_CLIENT_CONTRACT_VERSION } from "../../../lib/game-client-contract.ts";

export default function JoinRoom({ code }: { code: string }) {
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [invitation, setInvitation] = useState<string | null>(null);
  const [lockedName,setLockedName] = useState<string | null>(null);

  useEffect(() => {
    const fragment = new URLSearchParams(window.location.hash.slice(1));
    const savedName = localStorage.getItem(PLAYER_NAME_KEY)?.trim();
    const timer = window.setTimeout(() => {
      setInvitation(fragment.get("invite") ?? "");
      if (savedName) setName((current) => current || savedName);
    }, 0);
    return () => window.clearTimeout(timer);
  }, []);

  async function join(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      const chosenName = name.trim();
      const intent = durableAdmissionIntent({
        code,name: chosenName,storage: sessionStorage,createActionId: actionUuid,
      });
      setLockedName(intent.name);
      const response = await fetch(cannabeatsPath("/api/game"), {
        method: "POST",
        headers: {
          "content-type": "application/json",
          [GAME_CLIENT_CONTRACT_HEADER]: GAME_CLIENT_CONTRACT_VERSION,
        },
        body: JSON.stringify({
          action: invitation ? "joinGuest" : "join",
          actionId: intent.actionId,
          code,
          name: intent.name,
          ...(invitation ? { invite: invitation } : {}),
        }),
      });
      const payload = await response.json() as { code?: string; error?: string; playerId?: string };
      if (!response.ok || !payload.playerId) {
        if (releaseExpiredAdmissionIntent({
          status: response.status,responseCode: payload.code,code,storage: sessionStorage,
        })) {
          setLockedName(null);
        }
        throw new Error(payload.error ?? "Unable to join this lobby.");
      }

      const session: GameSession = { code, playerId: payload.playerId };
      localStorage.setItem(PLAYER_NAME_KEY, intent.name);
      clearAdmissionIntent(code,sessionStorage);
      sessionStorage.setItem(SESSION_KEY, JSON.stringify(session));
      window.location.replace(cannabeatsPath("/"));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Unable to join this lobby.");
      setBusy(false);
    }
  }

  return (
    <main className="join-shell">
      <section className="join-card">
        <div className="join-note" aria-hidden="true">♪</div>
        <p className="eyebrow">Joining lobby {code}</p>
        <h1>What should we call you?</h1>
        <p className="helper">Add your name, then get ready to place the music in time.</p>
        <form className="join-form" onSubmit={join}>
          <label>
            Your name
            <input
              autoComplete="name"
              autoFocus
              disabled={lockedName !== null}
              maxLength={24}
              onChange={(event) => setName(event.target.value)}
              placeholder="Name or nickname"
              required
              value={name}
            />
          </label>
          <button className="primary-button" disabled={busy || invitation === null}>
            {busy ? "Joining…" : "Join the game"}
          </button>
        </form>
        {error && <p className="error-message" role="alert">{error}</p>}
        {lockedName && error && (
          <p className="helper">This retry keeps the original name and request identity.</p>
        )}
        <Link className="join-back" href={cannabeatsPath("/")}>Enter a different lobby code</Link>
      </section>
    </main>
  );
}
