#!/bin/sh
# Build dist/local-reader-tts-<version>.zip from extension/, ready for AMO
# signing or a GitHub release. Version is read from the manifest.
set -eu
cd "$(dirname "$0")/.."

VERSION=$(python3 -c "import json; print(json.load(open('extension/manifest.json'))['version'])")
OUT="dist/local-reader-tts-$VERSION.zip"

mkdir -p dist
rm -f "$OUT"
(cd extension && zip -r "../$OUT" . -x "*/.*" -x ".DS_Store")
echo "built $OUT"
