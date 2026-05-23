#!/usr/bin/env bash
# Build the AdminDm Paper plugin with plain javac + jar — no Maven/Gradle. We compile
# against the paper-api jar that Paper extracts into server/libraries (the same API
# plugins normally compile against), then package classes + plugin.yml + config.yml into
# a jar dropped straight into server/plugins/.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo="$(cd "$here/.." && pwd)"

# The paper-api jar references transitive deps (adventure, bungee-chat, annotations),
# so compile against ALL the jars Paper extracts under server/libraries, not just the
# api jar. Paper populates this dir on its first launch.
cp="$(find "$repo/server/libraries" -name '*.jar' | tr '\n' ':')"
if [[ -z "$cp" ]]; then
  echo "No jars under server/libraries — start the Paper server once so it extracts its libraries." >&2
  exit 1
fi

out="$here/build"
rm -rf "$out"
mkdir -p "$out/classes"

# Target Java 21 bytecode (major version 65), NOT the host JDK's default (26 → major 70).
# Paper's plugin remapper bundles ASM 9.8, which rejects class files newer than it knows;
# Java 21 is Paper 1.21's baseline and runs fine on the newer runtime JVM.
javac --release 21 -cp "$cp" -d "$out/classes" $(find "$here/src" -name '*.java')

jar --create --file "$out/AdminDm.jar" \
  -C "$out/classes" . \
  -C "$here/resources" plugin.yml \
  -C "$here/resources" config.yml \
  -C "$here/resources" disclosure.txt

dest="$repo/server/plugins/AdminDm.jar"
cp "$out/AdminDm.jar" "$dest"
echo "Built and installed: $dest"
