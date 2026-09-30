import SwiftUI
import ARKit

struct ContentView: View {
    @EnvironmentObject private var library: ScanLibrary
    @State private var scanning = false
    private let lidar = ARWorldTrackingConfiguration.supportsSceneReconstruction(.mesh)

    var body: some View {
        NavigationStack {
            List {
                Section {
                    VStack(alignment: .leading, spacing: 10) {
                        Label(lidar ? "LiDAR scanner ready" : "No LiDAR on this device", systemImage: lidar ? "cube.transparent" : "exclamationmark.triangle")
                            .font(.headline)
                            .foregroundStyle(lidar ? Color.teal : Color.orange)
                        Text(lidar
                             ? "Walk slowly around the object. Tap “Set target” on it to crop away the room, then Finish and save an STL/OBJ/PLY."
                             : "LiDAR mesh scanning needs an iPad Pro (2020 or later) or an iPhone Pro. On this device, use a photo-scanning app (Scaniverse, Polycam, KIRI Engine) and open the export in the Scan2Print editor.")
                            .font(.subheadline).foregroundStyle(.secondary)
                        Button {
                            scanning = true
                        } label: {
                            Label("New LiDAR scan", systemImage: "viewfinder")
                                .frame(maxWidth: .infinity, minHeight: 50)
                        }
                        .buttonStyle(.borderedProminent)
                        .disabled(!lidar)
                    }
                    .padding(.vertical, 6)
                }

                Section("Saved scans") {
                    if library.files.isEmpty {
                        Text("No scans yet").foregroundStyle(.secondary)
                    }
                    ForEach(library.files) { file in
                        HStack {
                            VStack(alignment: .leading) {
                                Text(file.name).font(.body.monospaced())
                                Text("\(ByteCountFormatter.string(fromByteCount: Int64(file.size), countStyle: .file)) · \(file.date.formatted(date: .abbreviated, time: .shortened))")
                                    .font(.caption).foregroundStyle(.secondary)
                            }
                            Spacer()
                            ShareLink(item: file.url) { Image(systemName: "square.and.arrow.up") }
                                .buttonStyle(.borderless)
                        }
                        .swipeActions { Button("Delete", role: .destructive) { library.delete(file) } }
                    }
                }

                Section("Edit & print") {
                    Link(destination: AppLinks.editor) {
                        Label("Open the Scan2Print editor", systemImage: "wand.and.stars")
                    }
                    Text("Share a saved scan → Save to Files, then in the editor tap Open 3D file. There you can cut, fill holes, smooth, resize in mm and export a watertight STL/3MF for your slicer.")
                        .font(.footnote).foregroundStyle(.secondary)
                }

                Section("Tips") {
                    Text("• LiDAR works best for objects bigger than a fist (≈10 cm+). Very small or shiny things come out blobby — use photo mode apps for those.")
                    Text("• Keep 30–100 cm away, move slowly, and cover the top and sides. Good light helps tracking.")
                    Text("• Put the object on a clear floor or table; the scanner can remove that surface for you.")
                }
                .font(.footnote)
            }
            .navigationTitle("Scan2Print Scanner")
            .onAppear { library.refresh() }
        }
        .fullScreenCover(isPresented: $scanning) {
            ScanFlowView { scanning = false }
                .environmentObject(library)
        }
    }
}
