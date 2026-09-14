#!/usr/bin/env bash
#
# Builds the APK, and finds a JDK the Android toolchain can actually use.
#
# This exists because the newest JDK is the wrong JDK. The Android Gradle
# Plugin supports 17 through 21; Gradle 8.14 does not even parse a JDK 25
# version string, and fails with the bare number as its entire error message.
# Hardcoding one machine's path into gradle.properties would fix it here and
# break it everywhere else, so the search happens at build time.
#
#   ./build-apk.sh              debug APK, installable by sideload
#   ./build-apk.sh release      same code, release build type
#
set -euo pipefail

cd "$(dirname "$0")"

usable_jdk() {
  local candidate="$1"
  [ -x "$candidate/bin/java" ] || [ -x "$candidate/bin/java.exe" ] || return 1
  local version
  version="$("$candidate/bin/java" -version 2>&1 | head -1 | sed -E 's/.*"([0-9]+).*/\1/')"
  [ "$version" -ge 17 ] 2>/dev/null && [ "$version" -le 21 ] 2>/dev/null
}

find_jdk() {
  local candidates=()
  [ -n "${JAVA_HOME:-}" ] && candidates+=("$JAVA_HOME")
  # IntelliJ and Android Studio both keep JDKs here; so does a manual unzip.
  for dir in "$HOME"/.jdks/* "$USERPROFILE"/.jdks/* \
             "/c/Program Files/Eclipse Adoptium"/* "/c/Program Files/Java"/* \
             "/c/Program Files/Android/Android Studio/jbr"; do
    [ -d "$dir" ] && candidates+=("$dir")
  done

  for candidate in "${candidates[@]}"; do
    if usable_jdk "$candidate"; then
      echo "$candidate"
      return 0
    fi
  done
  return 1
}

if ! JDK="$(find_jdk)"; then
  echo "No JDK between 17 and 21 found." >&2
  echo "The Android Gradle Plugin does not support newer ones. Install Temurin 21" >&2
  echo "and either set JAVA_HOME to it or drop it in ~/.jdks." >&2
  exit 1
fi

export JAVA_HOME="$JDK"
echo "Using JDK: $JAVA_HOME"

# The SDK location, found rather than committed. `local.properties` is a Java
# properties file, so a Windows path in it needs every backslash doubled —
# a single one silently becomes an escape sequence and the build fails with
# "invalid file name", which points at nothing.
if [ -z "${ANDROID_HOME:-}" ] && [ -z "${ANDROID_SDK_ROOT:-}" ]; then
  for sdk in "$LOCALAPPDATA/Android/Sdk" "$HOME/AppData/Local/Android/Sdk" "$HOME/Android/Sdk" "$HOME/Library/Android/sdk"; do
    if [ -d "$sdk/platform-tools" ]; then
      export ANDROID_HOME="$sdk"
      break
    fi
  done
fi
if [ -z "${ANDROID_HOME:-}" ] && [ -z "${ANDROID_SDK_ROOT:-}" ] && [ ! -f local.properties ]; then
  echo "No Android SDK found. Set ANDROID_HOME, or write sdk.dir into local.properties." >&2
  exit 1
fi

VARIANT="${1:-debug}"
case "$VARIANT" in
  debug)   TASK=assembleDebug;   OUT=app/build/outputs/apk/debug/app-debug.apk ;;
  release) TASK=assembleRelease; OUT=app/build/outputs/apk/release/app-release.apk ;;
  *) echo "Usage: $0 [debug|release]" >&2; exit 2 ;;
esac

./gradlew --no-daemon "$TASK"

cp "$OUT" "operador-$VARIANT.apk"
echo
echo "Built: android/operador-$VARIANT.apk"
echo "Install with: adb install -r android/operador-$VARIANT.apk"
