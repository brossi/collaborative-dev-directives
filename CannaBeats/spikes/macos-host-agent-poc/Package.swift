// swift-tools-version: 6.0

import PackageDescription

let package = Package(
    name: "CannaBeatsHostPoC",
    platforms: [.macOS(.v14)],
    products: [
        .executable(name: "CannaBeatsHostPoC", targets: ["CannaBeatsHostPoC"]),
    ],
    targets: [
        .executableTarget(name: "CannaBeatsHostPoC"),
    ]
)

