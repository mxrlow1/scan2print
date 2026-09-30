import SwiftUI
import RealityKit

/// Full-screen flow: scan → result (clean up, save, share).
struct ScanFlowView: View {
    var onClose: () -> Void
    @StateObject private var session = ScanSession()
    @State private var raw: TriMesh?
    @State private var building = false

    init(onClose: @escaping () -> Void) { self.onClose = onClose }

    var body: some View {
        Group {
            if let raw {
                ResultView(raw: raw, cropCenter: session.cropCenter, radius: session.radius, floorY: session.floorY,
                           onRescan: { self.raw = nil; session.resume() },
                           onClose: close)
            } else {
                ScanView(session: session, building: building, onFinish: finish, onClose: close)
            }
        }
    }

    private func finish() {
        building = true
        session.pause()
        session.buildRawMesh { mesh in
            building = false
            raw = mesh
        }
    }

    private func close() { session.stop(); onClose() }
}

struct ARViewContainer: UIViewRepresentable {
    let session: ScanSession
    func makeUIView(context: Context) -> ARView { session.makeView() }
    func updateUIView(_ uiView: ARView, context: Context) {}
}

struct ScanView: View {
    @ObservedObject var session: ScanSession
    var building: Bool
    var onFinish: () -> Void
    var onClose: () -> Void

    var body: some View {
        ZStack {
            ARViewContainer(session: session).ignoresSafeArea()
            Image(systemName: "plus")
                .font(.system(size: 34, weight: .ultraLight))
                .foregroundStyle(.white.opacity(0.9))
                .shadow(radius: 2)
                .allowsHitTesting(false)
            VStack {
                HStack(alignment: .top) {
                    Button(action: onClose) {
                        Image(systemName: "xmark").font(.title3.bold()).frame(width: 48, height: 48)
                            .background(.ultraThinMaterial, in: Circle())
                    }
                    .accessibilityLabel("Close")
                    Spacer()
                    VStack(alignment: .trailing, spacing: 2) {
                        Text(session.tracking).font(.subheadline.bold())
                        Text("\(session.faceCount.formatted()) triangles · \(session.anchorCount) chunks").font(.caption).monospacedDigit()
                        if let y = session.floorY, let h = session.hit {
                            Text(String(format: "Floor found %.0f cm below target", (h.y - y) * 100)).font(.caption)
                        }
                    }
                    .padding(10)
                    .background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: 12))
                }
                .padding()
                Spacer()
                VStack(spacing: 12) {
                    if session.hit != nil {
                        HStack {
                            Text("Crop")
                            Slider(value: $session.radius, in: 0.05...1.5)
                            Text("\(Int((session.radius * 100).rounded())) cm").monospacedDigit().frame(width: 64, alignment: .trailing)
                        }
                    } else {
                        Text("Point the + at your object and tap Set target to crop away the room.")
                            .font(.footnote).multilineTextAlignment(.center)
                    }
                    HStack(spacing: 10) {
                        Button { session.setTargetAtCenter() } label: {
                            Label(session.hit == nil ? "Set target" : "Move target", systemImage: "scope").frame(maxWidth: .infinity, minHeight: 50)
                        }
                        .buttonStyle(.bordered)
                        Button { session.phase == .scanning ? session.pause() : session.resume() } label: {
                            Label(session.phase == .scanning ? "Pause" : "Resume", systemImage: session.phase == .scanning ? "pause.fill" : "play.fill")
                                .frame(maxWidth: .infinity, minHeight: 50)
                        }
                        .buttonStyle(.bordered)
                        Button(action: onFinish) {
                            Label("Finish", systemImage: "checkmark").frame(maxWidth: .infinity, minHeight: 50)
                        }
                        .buttonStyle(.borderedProminent)
                        .disabled(session.faceCount == 0 || building)
                    }
                    Button("Reset scan", role: .destructive) { session.reset() }.font(.footnote)
                }
                .padding()
                .background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: 20))
                .padding()
            }
            if building {
                ProgressView("Building mesh…").padding(20).background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: 14))
            }
        }
    }
}

struct ResultView: View {
    let raw: TriMesh
    let cropCenter: SIMD3<Float>?
    @State var radius: Float
    let floorY: Float?
    var onRescan: () -> Void
    var onClose: () -> Void

    @EnvironmentObject private var library: ScanLibrary
    @State private var useCrop = true
    @State private var removeFloor = true
    @State private var largestOnly = true
    @State private var mesh = TriMesh()
    @State private var stats = MeshStats()
    @State private var processing = true
    @State private var format: ExportFormat = .stl
    @State private var name = ResultView.defaultName()
    @State private var savedURL: URL?
    @State private var errorText: String?

    init(raw: TriMesh, cropCenter: SIMD3<Float>?, radius: Float, floorY: Float?, onRescan: @escaping () -> Void, onClose: @escaping () -> Void) {
        self.raw = raw; self.cropCenter = cropCenter; self._radius = State(initialValue: radius)
        self.floorY = floorY; self.onRescan = onRescan; self.onClose = onClose
    }

    static func defaultName() -> String {
        let f = DateFormatter()
        f.locale = Locale(identifier: "en_US_POSIX")
        f.dateFormat = "yyyyMMdd-HHmm"
        return "scan-" + f.string(from: Date())
    }

    private var options: ProcessOptions {
        var o = ProcessOptions()
        if useCrop, let c = cropCenter { o.cropCenter = c; o.cropRadius = radius }
        if removeFloor, let y = floorY { o.floorY = y }
        o.keepLargestPiece = largestOnly
        return o
    }

    var body: some View {
        NavigationStack {
            VStack(spacing: 0) {
                ZStack {
                    MeshPreview(mesh: mesh)
                    if processing { ProgressView().controlSize(.large) }
                    if !processing && mesh.isEmpty { Text("Nothing left — widen the crop or turn options off").padding() }
                }
                .frame(minHeight: 240, maxHeight: .infinity)
                Form {
                    Section("Result") {
                        LabeledContent("Size", value: String(format: "%.0f × %.0f × %.0f mm", stats.sizeMM.x, stats.sizeMM.y, stats.sizeMM.z))
                        LabeledContent("Triangles", value: stats.triangles.formatted())
                        LabeledContent("Pieces", value: "\(stats.pieces)")
                        LabeledContent("Closed mesh", value: stats.watertight ? "Yes ✓" : "No – \(stats.boundaryEdges) open edges")
                    }
                    Section {
                        if cropCenter != nil {
                            Toggle("Crop to target", isOn: $useCrop)
                            if useCrop {
                                HStack {
                                    Slider(value: $radius, in: 0.05...1.5)
                                    Text("\(Int((radius * 100).rounded())) cm").monospacedDigit().frame(width: 64, alignment: .trailing)
                                }
                            }
                        }
                        if floorY != nil { Toggle("Remove floor / table", isOn: $removeFloor) }
                        Toggle("Keep largest piece only", isOn: $largestOnly)
                    } header: { Text("Clean up") } footer: {
                        Text("Holes, the open bottom, smoothing and exact sizing are handled in the Scan2Print editor, which exports a watertight STL/3MF.")
                    }
                    Section("Save") {
                        TextField("File name", text: $name).textInputAutocapitalization(.never).autocorrectionDisabled()
                        Picker("Format", selection: $format) {
                            ForEach(ExportFormat.allCases) { Text($0.label).tag($0) }
                        }
                        .pickerStyle(.segmented)
                        Button { save() } label: { Label("Save \(format.label)", systemImage: "square.and.arrow.down") }
                            .disabled(mesh.isEmpty || processing)
                        if let savedURL {
                            ShareLink(item: savedURL) { Label("Share / Save to Files", systemImage: "square.and.arrow.up") }
                            Link(destination: AppLinks.editor) { Label("Open Scan2Print editor", systemImage: "wand.and.stars") }
                        }
                        if let errorText { Text(errorText).foregroundStyle(.red) }
                    }
                }
                .frame(maxHeight: .infinity)
            }
            .navigationTitle("Scan result")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Close", action: onClose) }
                ToolbarItem(placement: .primaryAction) { Button("Keep scanning", action: onRescan) }
            }
            .task(id: options) { await reprocess() }
            .onChange(of: format) { _ in savedURL = nil }
        }
    }

    private func reprocess() async {
        processing = true
        try? await Task.sleep(nanoseconds: 200_000_000) // debounce slider drags
        if Task.isCancelled { return }
        let o = options, r = raw
        let result = await Task.detached(priority: .userInitiated) { () -> (TriMesh, MeshStats) in
            let m = ScanProcessor.process(r, o)
            return (m, m.stats())
        }.value
        if Task.isCancelled { return }
        mesh = result.0; stats = result.1; processing = false; savedURL = nil
    }

    private func save() {
        do {
            savedURL = try library.save(mesh.data(for: format), name: name, format: format)
            errorText = nil
        } catch {
            errorText = "Could not save: \(error.localizedDescription)"
        }
    }
}
