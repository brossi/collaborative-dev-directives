import SwiftUI

@main
struct RossiHitFamApp: App {
    @StateObject private var session = GameSession()
    @StateObject private var player = PlayerModel()
    @Environment(\.scenePhase) private var scenePhase

    var body: some Scene {
        WindowGroup {
            GameView()
                .environmentObject(session)
                .environmentObject(player)
                .onOpenURL { url in
                    // Return leg of the one-time Spotify auth handshake.
                    player.handleAuthCallback(url: url)
                }
                .onChange(of: scenePhase) { phase in
                    // Coming back from the Spotify bounce (or any background
                    // stint) — re-establish the App Remote connection.
                    if phase == .active { player.appDidBecomeActive() }
                }
        }
    }
}
