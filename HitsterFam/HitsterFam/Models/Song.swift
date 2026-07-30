import Foundation

struct Song: Identifiable, Codable, Equatable, Hashable {
    let title: String
    let artist: String
    /// Original release / chart year — hand-verified, never trusted from
    /// Spotify album metadata (remasters/compilations lie).
    let year: Int
    /// Lowercase genre tags (e.g. "pop", "hip-hop") used for round filters.
    let genres: [String]?
    /// Spotify track URI, e.g. "spotify:track:4uLU6hMCjMI75M1A2tKUQC".
    /// nil in raw research catalogs; filled by tools/resolve_uris.py.
    /// Songs without a URI are excluded from play (Catalog.playable).
    let uri: String?

    var id: String { "\(title)|\(artist)|\(year)" }

    var genreSet: Set<String> { Set(genres ?? []) }
}
