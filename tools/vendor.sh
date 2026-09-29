#!/usr/bin/env bash
# Re-vendors three.js (pinned) into ./vendor. Requires npm. Run from repo root.
set -euo pipefail
VER=0.186.1
TMP=$(mktemp -d)
( cd "$TMP" && npm pack three@$VER >/dev/null && tar xzf three-$VER.tgz )
SRC="$TMP/package"
DST=vendor/three
rm -rf "$DST"; mkdir -p "$DST/build" "$DST/addons"
cp "$SRC/build/three.module.js" "$SRC/build/three.core.js" "$DST/build/"
cp "$SRC/LICENSE" "$DST/LICENSE"
for f in controls/OrbitControls.js loaders/OBJLoader.js loaders/GLTFLoader.js loaders/PLYLoader.js \
         loaders/STLLoader.js loaders/DRACOLoader.js utils/BufferGeometryUtils.js utils/SkeletonUtils.js \
         libs/fflate.module.js libs/meshopt_simplifier.module.js libs/meshopt_decoder.module.js; do
  mkdir -p "$DST/addons/$(dirname $f)"
  depth=$(echo "$f" | awk -F/ '{print NF-1}')
  rel=$(printf '../%.0s' $(seq 1 $((depth+1))))
  sed "s#from 'three';#from '${rel}build/three.module.js';#" "$SRC/examples/jsm/$f" > "$DST/addons/$f"
done
mkdir -p "$DST/addons/libs/draco/gltf"
cp "$SRC/examples/jsm/libs/draco/gltf/"* "$DST/addons/libs/draco/gltf/"
echo "$VER" > "$DST/VERSION"
rm -rf "$TMP"
echo "vendored three@$VER"
