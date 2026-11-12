#!/bin/sh
# Builds moi_mac_helper from main.swift (Xcode command line tools are enough); the first argument is where to put it.
set -e
here="$(cd "$(dirname "$0")" && pwd)"
target="${1:-$here/build/moi_mac_helper}"
mkdir -p "$(dirname "$target")"
# The Info.plist inside the binary says why it asks macOS for Calendar and for Apple Events to Mail and Notes.
swiftc -O -o "$target" "$here/main.swift" -framework EventKit -framework CoreServices -Xlinker -sectcreate -Xlinker __TEXT -Xlinker __info_plist -Xlinker "$here/Info.plist"
