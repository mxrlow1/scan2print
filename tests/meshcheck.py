"""Independent validators for exported files (STL / OBJ / 3MF)."""
import struct, zipfile, re
import numpy as np
from collections import Counter

def topo(V, F, weld=True):
    # STL: weld bit-identical vertices (what slicers do); OBJ/3MF are already indexed.
    if weld:
        uniq, inv = np.unique(V, axis=0, return_inverse=True)
        F = inv.reshape(-1)[F].reshape(-1, 3)
    else:
        uniq = V
    degenerate = int(((F[:, 0] == F[:, 1]) | (F[:, 1] == F[:, 2]) | (F[:, 0] == F[:, 2])).sum())
    F = F[(F[:, 0] != F[:, 1]) & (F[:, 1] != F[:, 2]) & (F[:, 0] != F[:, 2])]
    e = np.concatenate([F[:, [0, 1]], F[:, [1, 2]], F[:, [2, 0]]])
    und = np.sort(e, axis=1)
    _, counts = np.unique(und, axis=0, return_counts=True)
    _, dcounts = np.unique(e, axis=0, return_counts=True)
    tri = uniq[F]
    vol = np.einsum('ij,ij->i', tri[:, 0], np.cross(tri[:, 1], tri[:, 2])).sum() / 6
    return dict(tris=int(len(F)), degenerate=degenerate, verts=int(len(uniq)), boundary=int((counts == 1).sum()), nonmanifold=int((counts > 2).sum()),
                misoriented=int((dcounts > 1).sum()), volume=float(vol),
                watertight=bool((counts == 2).all()), bbox=(uniq.max(0) - uniq.min(0)).round(2).tolist(), zmin=float(uniq[:, 2].min()))

def read_stl(path):
    data = open(path, 'rb').read()
    n = struct.unpack('<I', data[80:84])[0]
    assert len(data) == 84 + 50 * n, 'binary STL size mismatch'
    rec = np.frombuffer(data[84:], dtype=[('n', '<f4', 3), ('v', '<f4', (3, 3)), ('a', '<u2')], count=n)
    V = rec['v'].reshape(-1, 3).astype(np.float64)
    return V, np.arange(len(V)).reshape(-1, 3)

def read_obj(path):
    V, F = [], []
    for line in open(path):
        if line.startswith('v '): V.append([float(x) for x in line.split()[1:4]])
        elif line.startswith('f '): F.append([int(x.split('/')[0]) - 1 for x in line.split()[1:4]])
    return np.array(V), np.array(F)

def read_3mf(path):
    z = zipfile.ZipFile(path)
    names = z.namelist()
    assert '[Content_Types].xml' in names and '_rels/.rels' in names and '3D/3dmodel.model' in names, names
    xml = z.read('3D/3dmodel.model').decode()
    assert 'unit="millimeter"' in xml
    V = np.array([[float(a), float(b), float(c)] for a, b, c in re.findall(r'<vertex x="([^"]+)" y="([^"]+)" z="([^"]+)"', xml)])
    F = np.array([[int(a), int(b), int(c)] for a, b, c in re.findall(r'<triangle v1="(\d+)" v2="(\d+)" v3="(\d+)"', xml)])
    return V, F

if __name__ == '__main__':
    import sys
    p = sys.argv[1]
    r = read_stl(p) if p.endswith('.stl') else read_obj(p) if p.endswith('.obj') else read_3mf(p)
    print(topo(*r))
