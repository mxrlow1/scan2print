import SwiftUI
import SceneKit

/// Orbitable SceneKit preview of a TriMesh (metres).
struct MeshPreview: UIViewRepresentable {
    let mesh: TriMesh

    final class Coordinator { var shownCount = -1; var firstPoint: SIMD3<Float>? }
    func makeCoordinator() -> Coordinator { Coordinator() }

    func makeUIView(context: Context) -> SCNView {
        let v = SCNView()
        v.scene = SCNScene()
        v.allowsCameraControl = true
        v.autoenablesDefaultLighting = true
        v.antialiasingMode = .multisampling4X
        v.backgroundColor = UIColor(red: 0.06, green: 0.07, blue: 0.08, alpha: 1)
        return v
    }

    func updateUIView(_ v: SCNView, context: Context) {
        let c = context.coordinator
        if c.shownCount == mesh.indices.count && c.firstPoint == mesh.positions.first { return }
        c.shownCount = mesh.indices.count; c.firstPoint = mesh.positions.first
        let scene = SCNScene()
        if !mesh.isEmpty {
            let verts = mesh.positions.map { SCNVector3($0.x, $0.y, $0.z) }
            let normals = mesh.vertexNormals().map { SCNVector3($0.x, $0.y, $0.z) }
            let geo = SCNGeometry(sources: [SCNGeometrySource(vertices: verts), SCNGeometrySource(normals: normals)],
                                  elements: [SCNGeometryElement(indices: mesh.indices, primitiveType: .triangles)])
            let mat = SCNMaterial()
            mat.diffuse.contents = UIColor(white: 0.82, alpha: 1)
            mat.lightingModel = .blinn
            mat.isDoubleSided = true
            geo.materials = [mat]
            scene.rootNode.addChildNode(SCNNode(geometry: geo))

            let b = mesh.bounds()
            let center = (b.min + b.max) / 2
            let r = max(length3(b.max - b.min) / 2, 0.01)
            let cam = SCNNode()
            cam.camera = SCNCamera()
            cam.camera?.zNear = Double(r / 100)
            cam.camera?.zFar = Double(r * 100)
            cam.position = SCNVector3(center.x + r * 1.5, center.y + r * 1.2, center.z + r * 1.9)
            cam.look(at: SCNVector3(center.x, center.y, center.z))
            scene.rootNode.addChildNode(cam)
            v.scene = scene
            v.pointOfView = cam
        } else {
            v.scene = scene
        }
    }
}
