#!/bin/sh
# Builds openMoi.app and its DMG in shell/release: the shell, the Mac helper, a Python of the app's own (a pinned
# python-build-standalone, checked against its published SHA256) with the brain's locked dependencies, then
# electron-builder. Signing uses the Developer ID in your keychain if there is one; notarizing needs your Apple ID.
#
# A release ships the kill switch: policy/pack_key.pub (from `uv run --project brain python -m moi_brain.packs keygen
# <private key file>`, the private key kept off this repo) and policy/pack_channel.json ({"url": "https://..."}).
# Without them the build stops, unless MOI_NO_KILL_SWITCH=1 says to build one that cannot be switched off remotely.
set -e
repo="$(cd "$(dirname "$0")/.." && pwd)"
python_tag="20261026"
python_file="cpython-3.12.16+${python_tag}-aarch64-apple-darwin-install_only_stripped.tar.gz"
python_sha256="353d5f1b4fd2715e7053f12f068435d5bbad16b91e057006b5d01e0925709a7e"
electron_builder="electron-builder@26.0.12"
build="$repo/shell/build"
mkdir -p "$build/downloads"

if [ ! -f "$repo/policy/pack_key.pub" ] || [ ! -f "$repo/policy/pack_channel.json" ]; then
  if [ "$MOI_NO_KILL_SWITCH" != "1" ]; then
    echo "policy/pack_key.pub and policy/pack_channel.json are missing, so the kill switch could not reach this build." >&2
    echo "Add them (see the top of this script), or build anyway with MOI_NO_KILL_SWITCH=1." >&2
    exit 1
  fi
  echo "Building without the kill switch (MOI_NO_KILL_SWITCH=1)." >&2
fi

cd "$repo/shell"
npm ci
# The shell's types, the brain's generated ones current, and the two fitting each other.
uv run --project "$repo/brain" python -m moi_brain.schema_ts | diff -q - src/shared/brain_schema.ts
npx tsc --noEmit -p .
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
# Bytecode made now, before signing, so the running app never writes into its signed bundle.
"$build/python/bin/python3" -m compileall -q -j 0 "$build/python/lib"

npx --yes "$electron_builder" --mac --config electron-builder.yml "$@"
