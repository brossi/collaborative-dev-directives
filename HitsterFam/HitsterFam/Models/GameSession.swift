import Foundation

/// The deck: shuffled once per session, advanced one song at a time,
/// no repeats until exhausted. All state is in-memory — killing the
/// app resets the game, which is fine.
@MainActor
final class GameSession: ObservableObject {
    @Published private(set) var deck: [Song]
    @Published private(set) var index: Int = -1
    @Published var revealed = false

    init(songs: [Song] = Song.loadBundled()) {
        deck = songs.shuffled()
    }

    var currentSong: Song? {
        deck.indices.contains(index) ? deck[index] : nil
    }

    var songsRemaining: Int { max(0, deck.count - (index + 1)) }
    var deckExhausted: Bool { index >= deck.count - 1 }

    /// Advances to the next hidden song. Returns nil when the deck is done.
    func drawNext() -> Song? {
        guard !deckExhausted else { return nil }
        revealed = false
        index += 1
        return currentSong
    }

    func reshuffle() {
        deck.shuffle()
        index = -1
        revealed = false
    }
}
