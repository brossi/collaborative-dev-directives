import SwiftUI

/// The game master's peek: the "flipped card" showing the answer so the
/// guess can be confirmed and the right hand-written card handed over.
struct RevealCard: View {
    let song: Song

    var body: some View {
        VStack(spacing: 12) {
            Text(String(song.year))
                .font(.system(size: 88, weight: .black, design: .rounded))
            Text(song.title)
                .font(.title2.bold())
                .multilineTextAlignment(.center)
            Text(song.artist)
                .font(.title3)
                .foregroundStyle(.secondary)
        }
        .padding(28)
        .frame(maxWidth: .infinity)
        .background(
            RoundedRectangle(cornerRadius: 24)
                .fill(Color(.secondarySystemBackground))
        )
    }
}
