import Foundation

/// One catalog module file: a themed or per-year pack of songs.
/// Any number of module JSONs can be dropped into Resources/Catalog —
/// the loader discovers them all, so packs are added/removed without
/// code changes.
struct CatalogModule: Codable {
    let module: String
    let name: String?
    let source: String?
    let songs: [Song]
}

/// Per-round constraints — the hook for future round setup UI
/// (e.g. year range to level the field for younger players, or a
/// genre pack). `.all` reproduces the plain full-deck game.
struct CatalogFilter: Equatable {
    var years: ClosedRange<Int>?
    var genres: Set<String>?

    static let all = CatalogFilter()

    func allows(_ song: Song) -> Bool {
        if let years, !years.contains(song.year) { return false }
        if let genres, genres.isDisjoint(with: song.genreSet) { return false }
        return true
    }
}

enum Catalog {
    /// All songs from every module JSON in the app bundle, deduplicated.
    /// A JSON that doesn't decode as a CatalogModule (e.g. asset metadata)
    /// is silently skipped.
    static func loadBundled() -> [Song] {
        guard let root = Bundle.main.resourceURL else { return [] }
        let decoder = JSONDecoder()
        var seen = Set<String>()
        var songs: [Song] = []
        let files = FileManager.default
            .enumerator(at: root, includingPropertiesForKeys: nil)?
            .compactMap { $0 as? URL }
            .filter { $0.pathExtension == "json" } ?? []
        for file in files.sorted(by: { $0.path < $1.path }) {
            guard let data = try? Data(contentsOf: file),
                  let module = try? decoder.decode(CatalogModule.self, from: data)
            else { continue }
            for song in module.songs {
                let key = song.id.lowercased()
                if seen.insert(key).inserted {
                    songs.append(song)
                }
            }
        }
        return songs
    }

    /// Bundled songs that can actually be played (URI resolved),
    /// narrowed by an optional round filter.
    static func playable(filter: CatalogFilter = .all) -> [Song] {
        loadBundled().filter { $0.uri != nil && filter.allows($0) }
    }
}
