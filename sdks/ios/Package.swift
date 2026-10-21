// swift-tools-version:5.9
import PackageDescription

// ConversationsKit: a thin native wrapper around the hosted chat (/chat) for in-app web views.
// The bridge and state machine are plain Swift and are unit tested on macOS (`swift test`); the UIKit and SwiftUI views compile for iOS only.
let package = Package(
    name: "ConversationsKit",
    platforms: [.iOS(.v14), .macOS(.v12)],
    products: [.library(name: "ConversationsKit", targets: ["ConversationsKit"])],
    targets: [
        .target(name: "ConversationsKit"),
        .testTarget(name: "ConversationsKitTests", dependencies: ["ConversationsKit"]),
    ]
)
