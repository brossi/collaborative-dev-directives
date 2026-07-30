import SwiftUI

struct GameView: View {
    @EnvironmentObject private var session: GameSession
    @EnvironmentObject private var player: PlayerModel

    var body: some View {
        VStack(spacing: 24) {
            header
            Spacer()
            switch player.status {
            case .disconnected, .connecting:
                connectPane
            case .connected:
                if session.currentSong == nil {
                    bigButton("Next Song", systemImage: "shuffle") { drawAndPlay() }
                } else {
                    playPane
                }
            }
            Spacer()
            footer
        }
        .padding()
    }

    private var header: some View {
        VStack(spacing: 4) {
            Text("RossiHitFam")
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

            Text("Bounces to Spotify once and plays a warm-up track — no deck songs are revealed.")
                .font(.footnote)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
        }
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
