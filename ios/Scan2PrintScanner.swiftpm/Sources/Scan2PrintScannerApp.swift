import SwiftUI

@main
struct Scan2PrintScannerApp: App {
    @StateObject private var library = ScanLibrary()

    var body: some Scene {
        WindowGroup {
            ContentView()
                .environmentObject(library)
                .preferredColorScheme(.dark)
                .tint(.teal)
        }
    }
}

enum AppLinks {
    /// The Scan2Print web editor (cut, repair, resize, export for printing).
    static let editor = URL(string: "https://mxrlow1.github.io/scan2print/")!
}
