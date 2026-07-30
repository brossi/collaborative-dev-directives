import Foundation

enum SpotifyConfig {
    /// Client ID of your app at https://developer.spotify.com/dashboard
    ///
    /// Two ways to provide it:
    /// 1. Paste it here, replacing the placeholder, or
    /// 2. (keeps it out of git) create the gitignored file
    ///    Resources/SpotifyClientID.txt containing just the ID —
    ///    it's bundled into the app and overrides the constant below.
    ///
    /// The client SECRET is scripts-only (tools + .env) and must never
    /// appear anywhere in this app.
    static let clientID: String = {
        if let url = Bundle.main.url(forResource: "SpotifyClientID", withExtension: "txt"),
           let contents = try? String(contentsOf: url, encoding: .utf8) {
            let trimmed = contents.trimmingCharacters(in: .whitespacesAndNewlines)
            if !trimmed.isEmpty { return trimmed }
        }
        return "YOUR_SPOTIFY_CLIENT_ID"
    }()

    /// Must match a Redirect URI registered in the dashboard AND the
    /// URL scheme declared in Config/Info.plist.
    static let redirectURL = URL(string: "cannabeats://spotify-callback")!

    /// Played (briefly visible in the Spotify app) during the one-time
    /// connect handshake. Never a deck song — the Spotify screen shows
    /// whatever it is asked to play. Default: Europe — "The Final Countdown".
    static let warmupTrackURI = "spotify:track:3MrRksHupTVEQ7YbA0FsZK"
}
