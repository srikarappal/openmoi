#!/bin/sh
# Builds openMoi.app and its DMG in shell/release: the shell, the Mac helper, a Python of the app's own (a pinned
# python-build-standalone, checked against its published SHA256) with the brain's locked dependencies, then
# electron-builder. Signing and notarizing happen only when your Apple Developer identity is in the environment.
set -e
repo="$(cd "$(dirname "$0")/.." && pwd)"
python_tag="20261026"
python_file="cpython-3.12.16+${python_tag}-aarch64-apple-darwin-install_only_stripped.tar.gz"
python_sha256="353d5f1b4fd2715e7053f12f068435d5bbad16b91e057006b5d01e0925709a7e"
electron_builder="electron-builder@26.0.12"
build="$repo/shell/build"
mkdir -p "$build/downloads"

cd "$repo/shell"
npm ci
node build.mjs
"$repo/helper/build.sh"

archive="$build/downloads/$python_file"
if [ ! -f "$archive" ]; then
  curl -fL -o "$archive" "https://github.com/astral-sh/python-build-standalone/releases/download/${python_tag}/${python_file}"
fi
echo "$python_sha256  $archive" | shasum -a 256 -c -
rm -rf "$build/python"
tar -xzf "$archive" -C "$build"
# The brain's dependencies exactly as uv.lock pins them, installed into the app's Python, none of the dev tools.
uv export --project "$repo/brain" --frozen --no-dev --no-emit-project --format requirements-txt > "$build/requirements.txt"
uv pip install --python "$build/python/bin/python3" --require-hashes -r "$build/requirements.txt"

npx --yes "$electron_builder" --mac --config electron-builder.yml "$@"
