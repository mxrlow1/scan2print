import ARKit
import RealityKit
import UIKit

extension Transform4 {
    init(_ m: simd_float4x4) { self.init(m.columns.0, m.columns.1, m.columns.2, m.columns.3) }
}

/// Owns the ARKit session: LiDAR scene reconstruction, a crop target and floor detection.
final class ScanSession: NSObject, ObservableObject, ARSessionDelegate {
    enum Phase { case scanning, paused }

    @Published var phase: Phase = .scanning
    @Published private(set) var anchorCount = 0
    @Published private(set) var faceCount = 0
    @Published private(set) var tracking = "Starting…"
    @Published private(set) var hit: SIMD3<Float>?
    @Published private(set) var floorY: Float?
    @Published var radius: Float = 0.25 { didSet { updateMarker() } }

    private var hitDir = SIMD3<Float>(0, 0, -1)
    private(set) var arView: ARView?
    private var meshAnchors: [UUID: ARMeshAnchor] = [:]
    private var planes: [UUID: ARPlaneAnchor] = [:]
    private var markerAnchor: AnchorEntity?
    private var marker: ModelEntity?

    /// Centre of the crop sphere: pushed from the tapped surface point into the object.
    var cropCenter: SIMD3<Float>? { hit.map { $0 + hitDir * (radius * 0.6) } }

    static var isSupported: Bool { ARWorldTrackingConfiguration.supportsSceneReconstruction(.mesh) }

    func makeView() -> ARView {
        if let v = arView { return v }
        let v = ARView(frame: .zero, cameraMode: .ar, automaticallyConfigureSession: false)
        v.debugOptions.insert(.showSceneUnderstanding)   // live wireframe of the reconstructed mesh
        v.session.delegate = self
        arView = v
        run(reset: true)
        return v
    }

    private func configuration() -> ARWorldTrackingConfiguration {
        let c = ARWorldTrackingConfiguration()
        c.sceneReconstruction = .mesh
        c.planeDetection = [.horizontal]
        c.environmentTexturing = .none
        return c
    }

    private func run(reset: Bool) {
        let opts: ARSession.RunOptions = reset ? [.resetTracking, .removeExistingAnchors] : []
        arView?.session.run(configuration(), options: opts)
        phase = .scanning
        UIApplication.shared.isIdleTimerDisabled = true
    }

    func pause() { arView?.session.pause(); phase = .paused }
    func resume() { run(reset: false) }
    func stop() { arView?.session.pause(); phase = .paused; UIApplication.shared.isIdleTimerDisabled = false }

    func reset() {
        meshAnchors.removeAll(); planes.removeAll()
        hit = nil; floorY = nil
        updateMarker(); publishCounts()
        run(reset: true)
    }

    // MARK: target / floor

    func setTargetAtCenter() {
        guard let v = arView else { return }
        let pt = CGPoint(x: v.bounds.midX, y: v.bounds.midY)
        guard let r = v.raycast(from: pt, allowing: .estimatedPlane, alignment: .any).first else {
            tracking = "Aim the + at the object and try again"
            return
        }
        let p4 = r.worldTransform.columns.3
        let p = SIMD3<Float>(p4.x, p4.y, p4.z)
        var dir = p - v.cameraTransform.translation
        let l = length3(dir)
        dir = l > 0 ? dir / l : SIMD3(0, 0, -1)
        hitDir = dir
        hit = p
        updateFloor(); updateMarker()
    }

    func clearTarget() { hit = nil; floorY = nil; updateMarker() }

    private func updateFloor() {
        guard let c = hit else { if floorY != nil { floorY = nil }; return }
        let ys = planes.values
            .filter { $0.alignment == .horizontal }
            .map { $0.transform.columns.3.y }
            .filter { $0 < c.y - 0.005 && $0 > c.y - 2 }
        let y = ys.max()
        if y != floorY { floorY = y }
    }

    private func updateMarker() {
        guard let v = arView, let c = cropCenter else {
            if let a = markerAnchor { arView?.scene.removeAnchor(a) }
            markerAnchor = nil; marker = nil
            return
        }
        if marker == nil {
            var mat = UnlitMaterial(color: .systemTeal)
            mat.blending = .transparent(opacity: 0.22)
            let e = ModelEntity(mesh: .generateSphere(radius: 1), materials: [mat])
            let a = AnchorEntity(world: c)
            a.addChild(e)
            v.scene.addAnchor(a)
            marker = e; markerAnchor = a
        }
        markerAnchor?.position = c
        marker?.scale = SIMD3(repeating: radius)
    }

    // MARK: ARSessionDelegate (called on the main queue)

    func session(_ session: ARSession, didAdd anchors: [ARAnchor]) { ingest(anchors) }
    func session(_ session: ARSession, didUpdate anchors: [ARAnchor]) { ingest(anchors) }
    func session(_ session: ARSession, didRemove anchors: [ARAnchor]) {
        for a in anchors { meshAnchors[a.identifier] = nil; planes[a.identifier] = nil }
        publishCounts()
    }
    func session(_ session: ARSession, cameraDidChangeTrackingState camera: ARCamera) {
        switch camera.trackingState {
        case .normal: tracking = "Tracking OK"
        case .notAvailable: tracking = "Tracking not available"
        case .limited(let reason):
            switch reason {
            case .excessiveMotion: tracking = "Slow down"
            case .insufficientFeatures: tracking = "Need more detail / light"
            case .initializing: tracking = "Move the device slowly…"
            case .relocalizing: tracking = "Relocalizing…"
            @unknown default: tracking = "Tracking limited"
            }
        }
    }
    func session(_ session: ARSession, didFailWithError error: Error) { tracking = "AR error: \(error.localizedDescription)" }

    private func ingest(_ anchors: [ARAnchor]) {
        var planesChanged = false
        for a in anchors {
            if let m = a as? ARMeshAnchor { meshAnchors[m.identifier] = m }
            else if let p = a as? ARPlaneAnchor { planes[p.identifier] = p; planesChanged = true }
        }
        publishCounts()
        if planesChanged { updateFloor() }
    }

    private func publishCounts() {
        let n = meshAnchors.count
        let f = meshAnchors.values.reduce(0) { $0 + $1.geometry.faces.count }
        if n != anchorCount { anchorCount = n }
        if f != faceCount { faceCount = f }
    }

    // MARK: mesh extraction

    /// Copies all mesh anchors into one world-space TriMesh (metres, Y up) off the main thread.
    func buildRawMesh(completion: @escaping (TriMesh) -> Void) {
        let anchors = Array(meshAnchors.values)
        DispatchQueue.global(qos: .userInitiated).async {
            var m = TriMesh()
            for a in anchors {
                let (v, f) = ScanSession.extract(a.geometry)
                m.append(vertices: v, faces: f, transform: Transform4(a.transform))
            }
            DispatchQueue.main.async { completion(m) }
        }
    }

    static func extract(_ g: ARMeshGeometry) -> ([SIMD3<Float>], [UInt32]) {
        let vs = g.vertices
        var verts = [SIMD3<Float>]()
        verts.reserveCapacity(vs.count)
        let vbase = vs.buffer.contents().advanced(by: vs.offset)
        for i in 0..<vs.count {
            let p = vbase.advanced(by: i * vs.stride).assumingMemoryBound(to: Float.self)
            verts.append(SIMD3(p[0], p[1], p[2]))
        }
        let fs = g.faces
        let n = fs.count * fs.indexCountPerPrimitive
        var faces = [UInt32]()
        faces.reserveCapacity(n)
        let fbase = fs.buffer.contents()
        if fs.bytesPerIndex == 2 {
            let p = fbase.assumingMemoryBound(to: UInt16.self)
            for i in 0..<n { faces.append(UInt32(p[i])) }
        } else {
            let p = fbase.assumingMemoryBound(to: UInt32.self)
            for i in 0..<n { faces.append(p[i]) }
        }
        return (verts, faces)
    }
}
