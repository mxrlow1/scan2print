// MeshCore: platform-independent triangle-mesh utilities used by the scanner.
// Pure Swift + Foundation (no ARKit/simd), so it also compiles and is unit-tested on Linux/CI.
// Coordinates follow ARKit: metres, Y up.
import Foundation

@inline(__always) func dot3(_ a: SIMD3<Float>, _ b: SIMD3<Float>) -> Float { a.x * b.x + a.y * b.y + a.z * b.z }
@inline(__always) func cross3(_ a: SIMD3<Float>, _ b: SIMD3<Float>) -> SIMD3<Float> {
    SIMD3(a.y * b.z - a.z * b.y, a.z * b.x - a.x * b.z, a.x * b.y - a.y * b.x)
}
@inline(__always) func length3(_ a: SIMD3<Float>) -> Float { dot3(a, a).squareRoot() }

/// Column-major 4x4 transform (same layout as simd_float4x4 columns).
public struct Transform4 {
    public var c0, c1, c2, c3: SIMD4<Float>
    public init(_ c0: SIMD4<Float>, _ c1: SIMD4<Float>, _ c2: SIMD4<Float>, _ c3: SIMD4<Float>) {
        self.c0 = c0; self.c1 = c1; self.c2 = c2; self.c3 = c3
    }
    public static let identity = Transform4(SIMD4(1, 0, 0, 0), SIMD4(0, 1, 0, 0), SIMD4(0, 0, 1, 0), SIMD4(0, 0, 0, 1))
    @inline(__always) public func apply(_ p: SIMD3<Float>) -> SIMD3<Float> {
        let r = c0 * p.x + c1 * p.y + c2 * p.z + c3
        return SIMD3(r.x, r.y, r.z)
    }
}

public struct MeshStats: Equatable {
    public var triangles = 0
    public var vertices = 0
    public var boundaryEdges = 0
    public var nonManifoldEdges = 0
    public var pieces = 0
    /// Size in millimetres along print axes X (width), Y (depth), Z (height).
    public var sizeMM = SIMD3<Float>(0, 0, 0)
    public var watertight: Bool { triangles > 0 && boundaryEdges == 0 && nonManifoldEdges == 0 }
}

public enum ExportFormat: String, CaseIterable, Identifiable {
    case stl, obj, ply
    public var id: String { rawValue }
    public var label: String { rawValue.uppercased() }
}

public struct TriMesh {
    public var positions: [SIMD3<Float>] = []
    public var indices: [UInt32] = []
    public init() {}
    public init(positions: [SIMD3<Float>], indices: [UInt32]) { self.positions = positions; self.indices = indices }

    public var triangleCount: Int { indices.count / 3 }
    public var isEmpty: Bool { indices.isEmpty }

    /// Append a sub-mesh (e.g. one ARMeshAnchor) transformed into world space.
    public mutating func append(vertices: [SIMD3<Float>], faces: [UInt32], transform: Transform4 = .identity) {
        let base = UInt32(positions.count)
        positions.reserveCapacity(positions.count + vertices.count)
        for v in vertices { positions.append(transform.apply(v)) }
        indices.reserveCapacity(indices.count + faces.count)
        for f in faces { indices.append(f + base) }
    }

    public func bounds() -> (min: SIMD3<Float>, max: SIMD3<Float>) {
        guard var lo = positions.first else { return (.zero, .zero) }
        var hi = lo
        for p in positions { lo = pointwiseMin(lo, p); hi = pointwiseMax(hi, p) }
        return (lo, hi)
    }

    /// Remove unreferenced vertices and degenerate triangles.
    public func compacted() -> TriMesh {
        var map = [Int32](repeating: -1, count: positions.count)
        var out = TriMesh()
        out.indices.reserveCapacity(indices.count)
        var t = 0
        while t + 2 < indices.count {
            let a = indices[t], b = indices[t + 1], c = indices[t + 2]
            t += 3
            if a == b || b == c || a == c { continue }
            for v in [a, b, c] {
                if map[Int(v)] < 0 { map[Int(v)] = Int32(out.positions.count); out.positions.append(positions[Int(v)]) }
                out.indices.append(UInt32(map[Int(v)]))
            }
        }
        return out
    }

    /// Merge vertices closer than `tolerance` (grid quantised). Joins the seams between ARKit mesh anchors.
    public func welded(tolerance: Float = 0.001) -> TriMesh {
        let inv = 1 / max(tolerance, 1e-9)
        var table = [SIMD3<Int32>: UInt32]()
        table.reserveCapacity(positions.count)
        var remap = [UInt32](repeating: 0, count: positions.count)
        var out = TriMesh()
        for (i, p) in positions.enumerated() {
            let q = SIMD3<Int32>(Int32((p.x * inv).rounded()), Int32((p.y * inv).rounded()), Int32((p.z * inv).rounded()))
            if let e = table[q] { remap[i] = e } else {
                let n = UInt32(out.positions.count)
                table[q] = n; remap[i] = n; out.positions.append(p)
            }
        }
        out.indices = indices.map { remap[Int($0)] }
        return out.compacted()
    }

    /// Keep triangles whose centroid passes `keep`.
    public func filtered(_ keep: (SIMD3<Float>) -> Bool) -> TriMesh {
        var out = TriMesh(positions: positions, indices: [])
        out.indices.reserveCapacity(indices.count)
        var t = 0
        while t + 2 < indices.count {
            let a = positions[Int(indices[t])], b = positions[Int(indices[t + 1])], c = positions[Int(indices[t + 2])]
            if keep((a + b + c) / 3) { out.indices.append(contentsOf: indices[t..<(t + 3)]) }
            t += 3
        }
        return out.compacted()
    }

    public func cropped(center: SIMD3<Float>, radius: Float) -> TriMesh {
        let r2 = radius * radius
        return filtered { p in let d = p - center; return dot3(d, d) <= r2 }
    }

    public func removingBelow(y: Float) -> TriMesh { filtered { $0.y > y } }

    /// Connected components (by shared vertices): label per vertex and triangle count per component.
    func components() -> (label: [Int], triCount: [Int]) {
        var parent = Array(0..<positions.count)
        func find(_ x: Int) -> Int { var x = x; while parent[x] != x { parent[x] = parent[parent[x]]; x = parent[x] }; return x }
        func union(_ a: Int, _ b: Int) { let ra = find(a), rb = find(b); if ra != rb { parent[max(ra, rb)] = min(ra, rb) } }
        var t = 0
        while t + 2 < indices.count { union(Int(indices[t]), Int(indices[t + 1])); union(Int(indices[t]), Int(indices[t + 2])); t += 3 }
        var rootLabel = [Int: Int]()
        var label = [Int](repeating: 0, count: positions.count)
        for v in 0..<positions.count {
            let r = find(v)
            if let l = rootLabel[r] { label[v] = l } else { let l = rootLabel.count; rootLabel[r] = l; label[v] = l }
        }
        var triCount = [Int](repeating: 0, count: rootLabel.count)
        t = 0
        while t + 2 < indices.count { triCount[label[Int(indices[t])]] += 1; t += 3 }
        return (label, triCount)
    }

    public func largestPiece() -> TriMesh {
        let (label, triCount) = components()
        guard let best = triCount.indices.max(by: { triCount[$0] < triCount[$1] }) else { return self }
        var out = TriMesh(positions: positions, indices: [])
        var t = 0
        while t + 2 < indices.count {
            if label[Int(indices[t])] == best { out.indices.append(contentsOf: indices[t..<(t + 3)]) }
            t += 3
        }
        return out.compacted()
    }

    /// Centre in X/Z and put the lowest point at y = 0.
    public func centeredOnFloor() -> TriMesh {
        let b = bounds()
        let shift = SIMD3<Float>(-(b.min.x + b.max.x) / 2, -b.min.y, -(b.min.z + b.max.z) / 2)
        return TriMesh(positions: positions.map { $0 + shift }, indices: indices)
    }

    public func stats() -> MeshStats {
        var s = MeshStats()
        s.triangles = triangleCount
        s.vertices = positions.count
        var edges = [UInt64: Int]()
        edges.reserveCapacity(indices.count)
        var t = 0
        while t + 2 < indices.count {
            for k in 0..<3 {
                let a = indices[t + k], b = indices[t + (k + 1) % 3]
                let key = (UInt64(min(a, b)) << 32) | UInt64(max(a, b))
                edges[key, default: 0] += 1
            }
            t += 3
        }
        for c in edges.values { if c == 1 { s.boundaryEdges += 1 } else if c > 2 { s.nonManifoldEdges += 1 } }
        s.pieces = components().triCount.count
        let b = bounds()
        let d = (b.max - b.min) * 1000
        s.sizeMM = SIMD3(d.x, d.z, d.y)
        return s
    }

    public func vertexNormals() -> [SIMD3<Float>] {
        var n = [SIMD3<Float>](repeating: .zero, count: positions.count)
        var t = 0
        while t + 2 < indices.count {
            let a = Int(indices[t]), b = Int(indices[t + 1]), c = Int(indices[t + 2])
            let fn = cross3(positions[b] - positions[a], positions[c] - positions[a])
            n[a] += fn; n[b] += fn; n[c] += fn
            t += 3
        }
        return n.map { let l = length3($0); return l > 0 ? $0 / l : SIMD3(0, 1, 0) }
    }

    // MARK: - Export (millimetres)

    /// Binary STL, millimetres, Z-up (x, -z, y) — the slicer / Scan2Print convention.
    public func stlData(scale: Float = 1000) -> Data {
        var bytes = [UInt8]()
        bytes.reserveCapacity(84 + triangleCount * 50)
        var header = Array("Scan2Print Scanner binary STL (mm)".utf8)
        header += [UInt8](repeating: 0x20, count: 80 - header.count)
        bytes += header
        appendLE(&bytes, UInt32(triangleCount))
        let zUp = { (p: SIMD3<Float>) -> SIMD3<Float> in SIMD3(p.x * scale, -p.z * scale, p.y * scale) }
        var t = 0
        while t + 2 < indices.count {
            let a = zUp(positions[Int(indices[t])]), b = zUp(positions[Int(indices[t + 1])]), c = zUp(positions[Int(indices[t + 2])])
            var n = cross3(b - a, c - a); let l = length3(n); if l > 0 { n /= l }
            for v in [n, a, b, c] { appendLE(&bytes, v.x); appendLE(&bytes, v.y); appendLE(&bytes, v.z) }
            bytes += [0, 0]
            t += 3
        }
        return Data(bytes)
    }

    /// Wavefront OBJ, millimetres, Y-up.
    public func objData(scale: Float = 1000) -> Data {
        var s = "# Scan2Print Scanner (units: mm, Y-up)\no scan\n"
        s.reserveCapacity(positions.count * 32 + indices.count * 8)
        for p in positions { s += "v \(fmt(p.x * scale)) \(fmt(p.y * scale)) \(fmt(p.z * scale))\n" }
        var t = 0
        while t + 2 < indices.count { s += "f \(indices[t] + 1) \(indices[t + 1] + 1) \(indices[t + 2] + 1)\n"; t += 3 }
        return Data(s.utf8)
    }

    /// Binary little-endian PLY, millimetres, Y-up.
    public func plyData(scale: Float = 1000) -> Data {
        let header = "ply\nformat binary_little_endian 1.0\ncomment Scan2Print Scanner (mm, Y-up)\nelement vertex \(positions.count)\nproperty float x\nproperty float y\nproperty float z\nelement face \(triangleCount)\nproperty list uchar uint vertex_indices\nend_header\n"
        var bytes = Array(header.utf8)
        bytes.reserveCapacity(bytes.count + positions.count * 12 + triangleCount * 13)
        for p in positions { appendLE(&bytes, p.x * scale); appendLE(&bytes, p.y * scale); appendLE(&bytes, p.z * scale) }
        var t = 0
        while t + 2 < indices.count { bytes.append(3); appendLE(&bytes, indices[t]); appendLE(&bytes, indices[t + 1]); appendLE(&bytes, indices[t + 2]); t += 3 }
        return Data(bytes)
    }

    public func data(for format: ExportFormat) -> Data {
        switch format { case .stl: return stlData(); case .obj: return objData(); case .ply: return plyData() }
    }
}

@inline(__always) private func appendLE(_ bytes: inout [UInt8], _ v: UInt32) {
    let x = v.littleEndian
    bytes += [UInt8(x & 0xff), UInt8((x >> 8) & 0xff), UInt8((x >> 16) & 0xff), UInt8((x >> 24) & 0xff)]
}
@inline(__always) private func appendLE(_ bytes: inout [UInt8], _ v: Float) { appendLE(&bytes, v.bitPattern) }
private func fmt(_ v: Float) -> String { String(format: "%.4f", Double(v)) }

/// Options applied after a scan, in order: weld → crop → floor → largest piece → centre.
public struct ProcessOptions: Equatable {
    public var weldTolerance: Float = 0.001
    public var cropCenter: SIMD3<Float>? = nil
    public var cropRadius: Float = 0.3
    public var floorY: Float? = nil
    public var floorMargin: Float = 0.003
    public var keepLargestPiece = true
    public init() {}
}

public enum ScanProcessor {
    public static func process(_ raw: TriMesh, _ o: ProcessOptions) -> TriMesh {
        var m = raw.welded(tolerance: o.weldTolerance)
        if let c = o.cropCenter { m = m.cropped(center: c, radius: o.cropRadius) }
        if let y = o.floorY { m = m.removingBelow(y: y + o.floorMargin) }
        if o.keepLargestPiece, !m.isEmpty { m = m.largestPiece() }
        return m.isEmpty ? m : m.centeredOnFloor()
    }
}
