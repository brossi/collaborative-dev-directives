import SwiftUI

struct GameView: View {
    @EnvironmentObject private var session: GameSession
    @EnvironmentObject private var player: PlayerModel

    var body: some View {
        VStack(spacing: 24) {
            header
            Spacer()
            if session.currentSong != nil {
                // Round in progress: keep the game pane mounted even if the
                // connection drops — a compact banner handles reconnecting
                // instead of swapping the whole screen for the connect pane.
                if player.status != .connected {
                    connectionBanner
                }
                playPane
            } else if player.status == .connected {
                if session.deck.isEmpty {
                    Text("Deck is empty — no playable songs in the bundled catalog")
                        .font(.title3)
                        .foregroundStyle(.secondary)
                        .multilineTextAlignment(.center)
                } else {
                    bigButton("Next Song", systemImage: "shuffle") { drawAndPlay() }
                }
            } else {
                connectPane
            }
            Spacer()
            footer
        }
        .padding()
    }

    private var header: some View {
        VStack(spacing: 4) {
            Text("CannaBeats")
                .font(.headline)
            if player.usingStub {
                Text("STUB PLAYER — add SpotifyiOS.xcframework for real audio")
                    .font(.caption2)
                    .foregroundStyle(.orange)
            }
        }
    }

    private var connectPane: some View {
        VStack(spacing: 16) {
            if let summary = session.deckSummary {
                Text(summary)
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            Button {
                player.connect()
            } label: {
                Label(player.status == .connecting ? "Connecting…" : "Connect Spotify",
                      systemImage: "music.note")
                    .font(.title2.bold())
                    .frame(maxWidth: .infinity, minHeight: 60)
            }
            .buttonStyle(.borderedProminent)
            .disabled(player.status == .connecting)

            Text("Bounces to Spotify to link up (first play each launch) and plays a warm-up track — no deck songs are revealed.")
                .font(.footnote)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
        }
    }

    private var connectionBanner: some View {
        HStack(spacing: 8) {
            if player.status == .connecting {
                ProgressView()
                    .controlSize(.small)
                Text("Reconnecting Spotify…")
            } else {
                Text("Spotify disconnected — tap Connect")
                Button("Connect") { player.connect() }
                    .buttonStyle(.bordered)
                    .controlSize(.small)
            }
        }
        .font(.footnote)
        .foregroundStyle(.secondary)
        .padding(8)
        .frame(maxWidth: .infinity)
        .background(
            RoundedRectangle(cornerRadius: 10)
                .fill(Color(.secondarySystemBackground))
        )
    }

    @ViewBuilder
    private var playPane: some View {
        if session.revealed, let song = session.currentSong {
            RevealCard(song: song)
            if session.deckExhausted {
                VStack(spacing: 8) {
                    Text("Deck exhausted!")
                        .font(.title3.bold())
                    Button("Reshuffle & play again") { session.reshuffle() }
                        .buttonStyle(.bordered)
                }
            } else {
                bigButton("Next Song", systemImage: "shuffle") { drawAndPlay() }
            }
        } else {
            VStack(spacing: 20) {
                Image(systemName: "questionmark.square.dashed")
                    .font(.system(size: 80))
                    .foregroundStyle(.secondary)
                Text("Song hidden — listen and guess")
                    .foregroundStyle(.secondary)
                bigButton(player.isPaused ? "Play" : "Pause",
                          systemImage: player.isPaused ? "play.fill" : "pause.fill") {
                    player.togglePlayPause()
                }
                Button("Reveal (game master only)") {
                    session.revealed = true
                }
                .buttonStyle(.bordered)
                if !session.deckExhausted {
                    Button("Skip song") { skipAndPlay() }
                        .buttonStyle(.bordered)
                }
            }
        }
    }

    private var footer: some View {
        VStack(spacing: 4) {
            Text("\(session.songsRemaining) songs left in the deck")
                .font(.caption)
                .foregroundStyle(.secondary)
            if let error = player.lastError {
                Text(error)
                    .font(.caption2)
                    .foregroundStyle(.red)
            }
        }
    }

    private func drawAndPlay() {
        guard let uri = session.drawNext()?.uri else { return }
        player.play(uri: uri)
    }

    private func skipAndPlay() {
        // Same path as drawAndPlay, but the skipped song is never revealed.
        guard let uri = session.skipCurrent()?.uri else { return }
        player.play(uri: uri)
    }

    private func bigButton(_ title: String,
                           systemImage: String,
                           action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Label(title, systemImage: systemImage)
                .font(.title.bold())
                .frame(maxWidth: .infinity, minHeight: 72)
        }
        .buttonStyle(.borderedProminent)
    }
}
