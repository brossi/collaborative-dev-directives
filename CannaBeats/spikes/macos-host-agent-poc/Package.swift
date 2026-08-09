// swift-tools-version: 6.0

import PackageDescription

let package = Package(
    name: "CannaBeatsHostPoC",
    platforms: [.macOS("14.2")],
    products: [
        .executable(name: "CannaBeatsHostPoC", targets: ["CannaBeatsHostPoC"]),
    ],
    targets: [
        .target(
            name: "AudioTapBridge",
            path: "Sources/AudioTapBridge",
            publicHeadersPath: "include",
            linkerSettings: [
                .linkedFramework("AppKit"),
                .linkedFramework("AudioToolbox"),
                .linkedFramework("CoreAudio"),
                .linkedFramework("Foundation"),
            ]
        ),
        .executableTarget(
            name: "CannaBeatsHostPoC",
            dependencies: ["AudioTapBridge"],
            linkerSettings: [
                .linkedFramework("AVFoundation"),
                .linkedFramework("Network"),
            ]
        ),
    ]
)
