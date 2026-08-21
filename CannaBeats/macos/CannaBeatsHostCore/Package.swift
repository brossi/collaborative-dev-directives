// swift-tools-version: 6.0

import PackageDescription

let package = Package(
    name: "CannaBeatsHostCore",
    platforms: [.macOS("14.2")],
    products: [
        .library(name: "CannaBeatsHostCore", targets: ["CannaBeatsHostCore"]),
        .executable(name: "CannaBeatsHostCoreVerifier", targets: ["CannaBeatsHostCoreVerifier"]),
        .executable(
            name: "CannaBeatsHostPlaybackVerifier",
            targets: ["CannaBeatsHostPlaybackVerifier"]
        ),
    ],
    targets: [
        .target(name: "CannaBeatsHostCore"),
        .executableTarget(name: "CannaBeatsHostCoreVerifier", dependencies: ["CannaBeatsHostCore"]),
        .executableTarget(
            name: "CannaBeatsHostPlaybackVerifier",
            dependencies: ["CannaBeatsHostCore"]
        ),
    ]
)
