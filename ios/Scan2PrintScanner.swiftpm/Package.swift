// swift-tools-version: 5.9
// Swift Playgrounds app package (open Scan2PrintScanner.swiftpm on an iPad in Swift Playgrounds 4.4+ or in Xcode 15+).
// CI builds the same Sources/ through ios/project.yml (XcodeGen) so it can be signed and uploaded to TestFlight.

import PackageDescription
import AppleProductTypes

let package = Package(
    name: "Scan2Print Scanner",
    platforms: [
        .iOS("17.0")
    ],
    products: [
        .iOSApplication(
            name: "Scan2Print Scanner",
            targets: ["AppModule"],
            bundleIdentifier: "io.github.mxrlow1.scan2print.scanner",
            displayVersion: "1.0",
            bundleVersion: "1",
            appIcon: .asset("AppIcon"),
            accentColor: .presetColor(.teal),
            supportedDeviceFamilies: [
                .pad,
                .phone
            ],
            supportedInterfaceOrientations: [
                .portrait,
                .landscapeRight,
                .landscapeLeft,
                .portraitUpsideDown(.when(deviceFamilies: [.pad]))
            ],
            capabilities: [
                .camera(purposeString: "The camera and LiDAR scanner capture a 3D mesh of your object.")
            ]
        )
    ],
    targets: [
        .executableTarget(
            name: "AppModule",
            path: "Sources"
        )
    ]
)
