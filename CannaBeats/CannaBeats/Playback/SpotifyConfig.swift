import Foundation

enum SpotifyConfig {
    /// Client ID of your app at https://developer.spotify.com/dashboard
    static let clientID = "YOUR_SPOTIFY_CLIENT_ID"

    /// Must match a Redirect URI registered in the dashboard AND the
    /// URL scheme declared in Config/Info.plist.
    static let redirectURL = URL(string: "cannabeats://spotify-callback")!

    /// Played (briefly visible in the Spotify app) during the one-time
    /// connect handshake. Never a deck song — the Spotify screen shows
    /// whatever it is asked to play. Default: Europe — "The Final Countdown".
    static let warmupTrackURI = "spotify:track:3MrRksHupTVEQ7YbA0FsZK"
}
