"""Generate test meshes in every supported import format (tests/fixtures/)."""
import struct, json, math, os, zipfile, random
import numpy as np
OUT = os.path.join(os.path.dirname(__file__), 'fixtures'); os.makedirs(OUT, exist_ok=True)

def uv_sphere(r, nlat, nlon, noise=0.0, seed=1):
    rng = np.random.default_rng(seed)
    verts = [(0, r, 0)]
    for i in range(1, nlat):
        th = math.pi * i / nlat
        for j in range(nlon):
            ph = 2 * math.pi * j / nlon
            rr = r * (1 + (rng.random() - 0.5) * noise)
            verts.append((rr * math.sin(th) * math.cos(ph), rr * math.cos(th), rr * math.sin(th) * math.sin(ph)))
    verts.append((0, -r, 0))
    V = np.array(verts, dtype=np.float32)
    F = []
    for j in range(nlon): F.append((0, 1 + (j + 1) % nlon, 1 + j))
    for i in range(nlat - 2):
        for j in range(nlon):
            a = 1 + i * nlon + j; b = 1 + i * nlon + (j + 1) % nlon; c = a + nlon; d = b + nlon
            F.append((a, b, c)); F.append((b, d, c))
    last = len(verts) - 1; base = 1 + (nlat - 2) * nlon
    for j in range(nlon): F.append((last, base + j, base + (j + 1) % nlon))
    return V, np.array(F, dtype=np.uint32)

def write_stl(path, V, F):
    tri = V[F]  # (n,3,3)
    n = np.cross(tri[:, 1] - tri[:, 0], tri[:, 2] - tri[:, 0]); n /= np.linalg.norm(n, axis=1, keepdims=True) + 1e-20
    rec = np.zeros(len(F), dtype=[('n', '<f4', 3), ('v', '<f4', (3, 3)), ('a', '<u2')])
    rec['n'] = n; rec['v'] = tri
    with open(path, 'wb') as f:
        f.write(b'fixture'.ljust(80, b' ')); f.write(struct.pack('<I', len(F))); f.write(rec.tobytes())

def write_obj(path, V, F):
    with open(path, 'w') as f:
        f.write('# fixture\nmtllib fixture.mtl\n')
        for v in V: f.write('v %.6f %.6f %.6f\n' % tuple(v))
        for t in F: f.write('f %d %d %d\n' % (t[0] + 1, t[1] + 1, t[2] + 1))

def write_ply(path, V, F):
    with open(path, 'wb') as f:
        f.write(('ply\nformat binary_little_endian 1.0\nelement vertex %d\nproperty float x\nproperty float y\nproperty float z\n'
                 'element face %d\nproperty list uchar int vertex_indices\nend_header\n' % (len(V), len(F))).encode())
        f.write(V.astype('<f4').tobytes())
        rec = np.zeros(len(F), dtype=[('c', 'u1'), ('i', '<i4', 3)]); rec['c'] = 3; rec['i'] = F
        f.write(rec.tobytes())

def write_glb(path, V, F):
    pos = V.astype('<f4').tobytes(); idx = F.astype('<u4').tobytes()
    binary = pos + idx
    gltf = {"asset": {"version": "2.0"}, "scene": 0, "scenes": [{"nodes": [0]}], "nodes": [{"mesh": 0, "scale": [1, 1, 1]}],
            "meshes": [{"primitives": [{"attributes": {"POSITION": 0}, "indices": 1, "material": 0}]}],
            "materials": [{"pbrMetallicRoughness": {"baseColorFactor": [1, 1, 1, 1]}}],
            "buffers": [{"byteLength": len(binary)}],
            "bufferViews": [{"buffer": 0, "byteOffset": 0, "byteLength": len(pos), "target": 34962},
                            {"buffer": 0, "byteOffset": len(pos), "byteLength": len(idx), "target": 34963}],
            "accessors": [{"bufferView": 0, "componentType": 5126, "count": len(V), "type": "VEC3", "min": V.min(0).tolist(), "max": V.max(0).tolist()},
                          {"bufferView": 1, "componentType": 5125, "count": F.size, "type": "SCALAR"}]}
    js = json.dumps(gltf).encode(); js += b' ' * ((4 - len(js) % 4) % 4)
    binary += b'\0' * ((4 - len(binary) % 4) % 4)
    total = 12 + 8 + len(js) + 8 + len(binary)
    with open(path, 'wb') as f:
        f.write(struct.pack('<III', 0x46546C67, 2, total)); f.write(struct.pack('<II', len(js), 0x4E4F534A)); f.write(js)
        f.write(struct.pack('<II', len(binary), 0x004E4942)); f.write(binary)

if __name__ == '__main__':
    V, F = uv_sphere(0.04, 40, 64, noise=0.02)       # 4 cm radius, metres (like scan apps)
    write_obj(f'{OUT}/sphere_m.obj', V, F)
    write_glb(f'{OUT}/sphere_m.glb', V, F)
    write_ply(f'{OUT}/sphere_m.ply', V, F)
    write_stl(f'{OUT}/sphere_mm.stl', V * 1000, F)     # STL in mm
    with zipfile.ZipFile(f'{OUT}/polycam_export.zip', 'w') as z:
        z.write(f'{OUT}/sphere_m.obj', 'mesh/sphere_m.obj'); z.writestr('mesh/fixture.mtl', 'newmtl a\n'); z.writestr('__MACOSX/._x', 'junk')
    # ~500k-triangle noisy scan-like sphere with a cut-off bottom hole, in mm
    V, F = uv_sphere(60, 540, 520, noise=0.01, seed=7)
    keep = ~(V[F][:, :, 1].min(axis=1) < -55)          # open bottom
    write_stl(f'{OUT}/big_scan_500k.stl', V, F[keep])
    print('fixtures:', sorted(os.listdir(OUT)), 'big tris', int(keep.sum()))
