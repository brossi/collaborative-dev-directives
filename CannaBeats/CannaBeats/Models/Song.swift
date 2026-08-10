import Foundation

struct Song: Identifiable, Codable, Equatable, Hashable {
    let title: String
    let artist: String
    /// CHART year — when the recording was a hit, not when it shipped. This is
    /// the default answer a card asks for, because it is how people actually
    /// date a song ("Blinding Lights" is a 2020 song though it was published in
    /// November 2019). Hand-verified; never trusted from Spotify album metadata
    /// (remasters and compilations lie). Load-bearing: `id` is built from it.
    let year: Int
    /// PUBLICATION year — when this recording first entered circulation.
    /// Equal to `year` or one off for most songs, and decades apart for
    /// revivals: "All I Want for Christmas Is You" was published in 1994 and
    /// did not top the chart until 2019.
    ///
    /// Backfilled from Wikidata P577 by tools/harvest_release_dates.py, and
    /// left nil wherever that source cannot distinguish OUR recording from the
    /// song itself. Wikidata items are frequently about the composition rather
    /// than a recording, so P577 on a cover dates the ORIGINAL — Luke Combs'
    /// "Fast Car" resolves to Tracy Chapman's 1988. Only rows where our artist
    /// is the sole performer on the item are filled; the rest stay nil rather
    /// than assert a year that belongs to somebody else's record.
    let releaseYear: Int?
    /// Lowercase genre tags (e.g. "pop", "hip-hop") used for round filters.
    let genres: [String]?
    /// Spotify track URI, e.g. "spotify:track:4uLU6hMCjMI75M1A2tKUQC".
    /// nil in raw research catalogs; filled by tools/resolve_uris.py.
    /// Songs without a URI are excluded from play (Catalog.playable).
    let uri: String?

    var id: String { "\(title)|\(artist)|\(year)" }

    var genreSet: Set<String> { Set(genres ?? []) }
}
