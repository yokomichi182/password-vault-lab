#!/usr/bin/env bash
# Android(kotpass) ⇔ PC(kdbxweb) の相互確認。android/ で gradlew を動かせる環境(JAVA_HOME など)で実行する。
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
export PWV_XCHECK_DIR="${PWV_XCHECK_DIR:-$HOME/pwvault-build/app/xcheck}"
mkdir -p "$PWV_XCHECK_DIR"; rm -f "$PWV_XCHECK_DIR"/*.kdbx
export JAVA_HOME="${JAVA_HOME:-C:/Program Files/Android/Android Studio/jbr}"
export ANDROID_HOME="${ANDROID_HOME:-$LOCALAPPDATA/Android/Sdk}"
(cd "$here/../../android" && ./gradlew cleanTestDebugUnitTest testDebugUnitTest --console=plain --tests '*KdbxXcheckTest.writeAndroidMade')
(cd "$here" && node check.mjs)
(cd "$here/../../android" && ./gradlew cleanTestDebugUnitTest testDebugUnitTest --console=plain --tests '*KdbxXcheckTest.readNodeMade')
