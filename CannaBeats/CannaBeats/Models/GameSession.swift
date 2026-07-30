import Foundation

/// The deck: shuffled once per session, advanced one song at a time,
/// no repeats until exhausted. All state is in-memory — killing the
/// app resets the game, which is fine.
@MainActor
final class GameSession: ObservableObject {
    @Published private(set) var deck: [Song]
    @Published private(set) var index: Int = -1
    @Published var revealed = false

    /// The round constraints this session was built with. Future round
    /// setup UI re-creates the session with a different filter.
    let filter: CatalogFilter

    init(filter: CatalogFilter = .all, songs: [Song]? = nil) {
        self.filter = filter
        deck = (songs ?? Catalog.playable(filter: filter)).shuffled()
    }

    var currentSong: Song? {
        deck.indices.contains(index) ? deck[index] : nil
    }

    var songsRemaining: Int { max(0, deck.count - (index + 1)) }
    var deckExhausted: Bool { index >= deck.count - 1 }

    /// "Deck: N songs, YYYY–YYYY" for the connect pane; nil for an empty deck.
    var deckSummary: String? {
        guard let first = deck.map(\.year).min(),
              let last = deck.map(\.year).max() else { return nil }
        return "Deck: \(deck.count) songs, \(first)–\(last)"
    }

    /// Advances to the next hidden song. Returns nil when the deck is done.
    func drawNext() -> Song? {
        guard !deckExhausted else { return nil }
        revealed = false
        index += 1
        return currentSong
    }

    /// Skip the current hidden song: advance exactly like drawNext, never
    /// revealing it. A skipped card simply goes back in the box — the song
    /// is consumed for this session, not re-queued.
    func skipCurrent() -> Song? {
        drawNext()
    }

    func reshuffle() {
        deck.shuffle()
        index = -1
        revealed = false
    }
}
