import Foundation

struct Song: Identifiable, Codable, Equatable {
    let title: String
    let artist: String
    /// Original release year — hand-verified, never trusted from Spotify
    /// album metadata (remasters/compilations lie).
    let year: Int
    /// Spotify track URI, e.g. "spotify:track:4uLU6hMCjMI75M1A2tKUQC".
    let uri: String

    var id: String { uri }

    static func loadBundled() -> [Song] {
        guard let url = Bundle.main.url(forResource: "songs", withExtension: "json"),
              let data = try? Data(contentsOf: url),
              let songs = try? JSONDecoder().decode([Song].self, from: data)
        else {
            assertionFailure("songs.json missing or malformed")
            return []
        }
        return songs
    }
}
