// Unit tests for MeshCore.swift. Runs anywhere Swift runs (Linux, macOS CI):
//   swiftc -O ios/Scan2PrintScanner.swiftpm/Sources/MeshCore.swift ios/Tests/MeshCoreTests/main.swift -o /tmp/meshcore-tests && /tmp/meshcore-tests
import Foundation

var failures = 0
func check(_ name: String, _ ok: Bool, _ detail: String = "") {
    print((ok ? "PASS " : "FAIL ") + name + (detail.isEmpty ? "" : "  [\(detail)]"))
    if !ok { failures += 1 }
}

/// UV sphere split into `tiles` separate sub-meshes (like ARKit mesh anchors) with duplicated seam vertices.
func tiledSphere(radius r: Float, center c: SIMD3<Float>, lat: Int = 24, lon: Int = 32, tiles: Int = 4) -> TriMesh {
    var m = TriMesh()
    let perTile = lon / tiles
    for tile in 0..<tiles {
        var verts = [SIMD3<Float>](), faces = [UInt32]()
        func vid(_ i: Int, _ j: Int) -> UInt32 {
            let th = Float.pi * Float(i) / Float(lat), ph = 2 * Float.pi * Float(j % lon) / Float(lon)
            verts.append(SIMD3(r * sin(th) * cos(ph), r * cos(th), r * sin(th) * sin(ph)))
            return UInt32(verts.count - 1)
        }
        for i in 0..<lat {
            for j in (tile * perTile)..<((tile + 1) * perTile) {
                let a = vid(i, j), b = vid(i, j + 1), cc = vid(i + 1, j), d = vid(i + 1, j + 1)
                faces += [a, b, cc, b, d, cc]
            }
        }
        // anchor transform: translation to the sphere centre
        m.append(vertices: verts, faces: faces, transform: Transform4(SIMD4(1, 0, 0, 0), SIMD4(0, 1, 0, 0), SIMD4(0, 0, 1, 0), SIMD4(c.x, c.y, c.z, 1)))
    }
    return m
}

// 1) welding joins anchor seams and poles -> closed mesh
let center = SIMD3<Float>(0.5, 0.2, -1.0)
let raw = tiledSphere(radius: 0.05, center: center)
let welded = raw.welded(tolerance: 0.0005)
let ws = welded.stats()
check("weld closes tiled sphere", ws.watertight && ws.pieces == 1, "tris=\(ws.triangles) boundary=\(ws.boundaryEdges) nm=\(ws.nonManifoldEdges)")
check("size in mm ~100", abs(ws.sizeMM.z - 100) < 0.5 && abs(ws.sizeMM.x - 100) < 1, "\(ws.sizeMM)")

// 2) scene = object sphere + floor slab + a far away blob
var scene = raw
var floor = TriMesh()
floor.append(vertices: [SIMD3(-1, 0.145, -2), SIMD3(2, 0.145, -2), SIMD3(2, 0.145, 1), SIMD3(-1, 0.145, 1)], faces: [0, 2, 1, 0, 3, 2])
scene.append(vertices: floor.positions, faces: floor.indices)
scene.append(vertices: tiledSphere(radius: 0.01, center: SIMD3(0.63, 0.2, -1.0), tiles: 1).positions,
             faces: tiledSphere(radius: 0.01, center: SIMD3(0.63, 0.2, -1.0), tiles: 1).indices)
check("scene has 3 pieces after weld", scene.welded(tolerance: 0.0005).stats().pieces == 3)

var o = ProcessOptions()
o.weldTolerance = 0.0005
o.cropCenter = center; o.cropRadius = 0.2
o.floorY = 0.145
o.keepLargestPiece = true
let out = ScanProcessor.process(scene, o)
let os = out.stats()
check("process: crop + floor + largest piece -> object only", os.pieces == 1 && os.triangles == ws.triangles, "tris=\(os.triangles) vs \(ws.triangles)")
let b = out.bounds()
check("process: centred and on the floor", abs(b.min.y) < 1e-5 && abs(b.min.x + b.max.x) < 1e-4 && abs(b.min.z + b.max.z) < 1e-4)
check("removingBelow cuts lower half", welded.removingBelow(y: center.y).triangleCount < welded.triangleCount * 6 / 10)

// 3) exporters
let stl = out.stlData()
check("STL size = 84 + 50n", stl.count == 84 + 50 * out.triangleCount)
let count = stl.subdata(in: 80..<84).withUnsafeBytes { $0.loadUnaligned(as: UInt32.self) }
check("STL triangle count", Int(UInt32(littleEndian: count)) == out.triangleCount)
// read back vertex Z of all triangles: Z-up means min z == 0 (object on floor) and height ~100 mm
var zmin = Float.greatestFiniteMagnitude, zmax = -Float.greatestFiniteMagnitude
stl.withUnsafeBytes { p in
    for t in 0..<out.triangleCount {
        for v in 0..<3 {
            let z = Float(bitPattern: UInt32(littleEndian: p.loadUnaligned(fromByteOffset: 84 + t * 50 + 12 + v * 12 + 8, as: UInt32.self)))
            zmin = min(zmin, z); zmax = max(zmax, z)
        }
    }
}
check("STL is Z-up in mm", abs(zmin) < 1e-3 && abs(zmax - 100) < 0.5, "z=\(zmin)...\(zmax)")
let obj = String(decoding: out.objData(), as: UTF8.self)
check("OBJ counts", obj.components(separatedBy: "\nv ").count - 1 == out.positions.count && obj.components(separatedBy: "\nf ").count - 1 == out.triangleCount)
let ply = out.plyData()
let headerEnd = ply.range(of: Data("end_header\n".utf8))!.upperBound
check("PLY binary size", ply.count - headerEnd == out.positions.count * 12 + out.triangleCount * 13)

// 4) normals point outward on the sphere
let n = welded.vertexNormals()
var outward = 0
for (i, p) in welded.positions.enumerated() where dot3(n[i], p - center) > 0 { outward += 1 }
check("vertex normals outward", outward == welded.positions.count, "\(outward)/\(welded.positions.count)")

// 5) performance smoke test: ~200k triangles
let big = tiledSphere(radius: 0.1, center: .zero, lat: 300, lon: 340, tiles: 10)
let t0 = Date()
var bo = ProcessOptions(); bo.weldTolerance = 0.00005
let bigOut = ScanProcessor.process(big, bo)
let dt = Date().timeIntervalSince(t0)
let bs = bigOut.stats()
check("process 200k-triangle scan", bs.watertight && bs.triangles > 190_000, String(format: "%d -> %d tris in %.2fs, boundary %d nm %d", big.triangleCount, bs.triangles, dt, bs.boundaryEdges, bs.nonManifoldEdges))

print(failures == 0 ? "ALL MESHCORE TESTS PASSED" : "\(failures) FAILURE(S)")
exit(failures == 0 ? 0 : 1)
