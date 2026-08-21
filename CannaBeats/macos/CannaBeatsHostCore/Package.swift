// swift-tools-version: 6.0

import PackageDescription

let package = Package(
    name: "CannaBeatsHostCore",
    platforms: [.macOS("14.2")],
    products: [
        .library(name: "CannaBeatsHostCore", targets: ["CannaBeatsHostCore"]),
        .executable(name: "CannaBeatsHostCoreVerifier", targets: ["CannaBeatsHostCoreVerifier"]),
    ],
    targets: [
        .target(name: "CannaBeatsHostCore"),
        .executableTarget(name: "CannaBeatsHostCoreVerifier", dependencies: ["CannaBeatsHostCore"]),
    ]
)
