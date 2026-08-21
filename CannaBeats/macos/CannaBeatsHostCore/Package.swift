// swift-tools-version: 6.0

import PackageDescription

let package = Package(
    name: "CannaBeatsHostCore",
    platforms: [.macOS("14.2")],
    products: [
        .library(name: "CannaBeatsHostCore", targets: ["CannaBeatsHostCore"]),
        .executable(name: "CannaBeatsHost", targets: ["CannaBeatsHost"]),
        .executable(name: "CannaBeatsHostCoreVerifier", targets: ["CannaBeatsHostCoreVerifier"]),
        .executable(
            name: "CannaBeatsHostPlaybackVerifier",
            targets: ["CannaBeatsHostPlaybackVerifier"]
        ),
        .executable(
            name: "CannaBeatsHostAudioVerifier",
            targets: ["CannaBeatsHostAudioVerifier"]
        ),
    ],
    targets: [
        .target(
            name: "AudioTapBridge",
            publicHeadersPath: "include",
            linkerSettings: [
                .linkedFramework("AppKit"),
                .linkedFramework("AudioToolbox"),
                .linkedFramework("CoreAudio"),
            ]
        ),
        .target(name: "CannaBeatsHostCore", dependencies: ["AudioTapBridge"]),
        .executableTarget(name: "CannaBeatsHost", dependencies: ["CannaBeatsHostCore"]),
        .executableTarget(name: "CannaBeatsHostCoreVerifier", dependencies: ["CannaBeatsHostCore"]),
        .executableTarget(
            name: "CannaBeatsHostPlaybackVerifier",
            dependencies: ["CannaBeatsHostCore"]
        ),
        .executableTarget(
            name: "CannaBeatsHostAudioVerifier",
            dependencies: ["AudioTapBridge", "CannaBeatsHostCore"]
        ),
    ]
)
