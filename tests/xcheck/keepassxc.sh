#!/usr/bin/env bash
# KeePassXC(keepassxc-cli)との相互確認。先に `bash run.sh` で Android 製の android-made.kdbx を作っておく。
# 1) 開いて ItemType / Environment / 期限が読め、キーが保護属性(値は伏せる)であることを確かめる
# 2) KeePassXC でタイトルを変え、そのファイルを Android(kotpass)で読み直す(KdbxXcheckTest.readKeepassxcEdited)
# 値は出力・記録しない(show は既定で保護属性を伏せる。-s は使わない)。KDBX は PWV_XCHECK_DIR の中にだけ置く。
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
export PWV_XCHECK_DIR="${PWV_XCHECK_DIR:-$HOME/pwvault-build/app/xcheck}"
CLI="${KEEPASSXC_CLI:-/c/Program Files/KeePassXC/keepassxc-cli.exe}"
MASTER='master-CANARY-7f3e9a1c-dummy'   # テスト用の架空のマスターパスワード
src="$PWV_XCHECK_DIR/android-made.kdbx"; out="$PWV_XCHECK_DIR/keepassxc-edited.kdbx"
cli() { printf '%s\n' "$MASTER" | "$CLI" "$@" 2>/dev/null; }
fail() { echo "NG - $*"; exit 1; }

cli ls "$src" | grep -q 'apikey-svc' || fail "KeePassXC が android-made.kdbx を開けない / apikey-svc が無い"
echo "ok - KeePassXC が Android 製の KDBX を開ける"
shown="$(cli show "$src" apikey-svc)"
[ "$(cli show -a ItemType "$src" apikey-svc | tr -d '\r\n')" = "apikey" ] || fail "ItemType が読めない"
[ "$(cli show -a Environment "$src" apikey-svc | tr -d '\r\n')" = "本番" ] || fail "Environment が読めない"
echo "ok - ItemType=apikey / Environment=本番 が読める"
# 期限: keepassxc-cli 2.8 の show は期限を出さないので、XML の書き出し(標準出力のみ。ファイルに残さない)から
# 対象項目の Expires / ExpiryTime と、Password の保護属性だけを取り出す。値は読まない。
info="$(cli export -f xml "$src" | python -I -c "
import sys,base64,datetime,xml.etree.ElementTree as ET
d=sys.stdin.buffer.read().decode('utf-8'); r=ET.fromstring(d[d.index('<KeePassFile'):].encode())
for e in r.iter('Entry'):
    t={s.find('Key').text:s.find('Value') for s in e.findall('String')}
    if t['Title'].text=='apikey-svc':
        tm=e.find('Times'); sec=int.from_bytes(base64.b64decode(tm.find('ExpiryTime').text),'little')
        ms=int((datetime.datetime(1,1,1,tzinfo=datetime.timezone.utc)+datetime.timedelta(seconds=sec)-datetime.datetime(1970,1,1,tzinfo=datetime.timezone.utc)).total_seconds()*1000)
        print('expires=%s expiryMs=%d pwProtected=%s itemTypeProtected=%s' % (tm.find('Expires').text, ms, t['Password'].get('ProtectInMemory'), t['ItemType'].get('ProtectInMemory')))
")"
echo "    $info"
[ "$info" = "expires=True expiryMs=1900000000000 pwProtected=True itemTypeProtected=None" ] || fail "期限または保護属性が想定と違う"
echo "ok - 期限(2030-03-17 17:46:40 UTC)が読める / Password は保護属性 / ItemType は保護しない"
echo "$shown" | grep -q '^Password: PROTECTED' || fail "Password が保護属性でない"
echo "$shown" | grep -q 'CANARY' && fail "show の出力に値が出ている"
echo "ok - Password は保護属性(出力は PROTECTED で、値は出ない)"

cp "$src" "$out"
cli edit -t apikey-svc-edited "$out" apikey-svc >/dev/null || fail "KeePassXC での編集に失敗"
cli ls "$out" | grep -q 'apikey-svc-edited' || fail "タイトル変更が反映されていない"
echo "ok - KeePassXC でタイトルを変更して保存"
(cd "$here/../../android" && ./gradlew cleanTestDebugUnitTest testDebugUnitTest --console=plain --tests '*KdbxXcheckTest.readKeepassxcEdited')
echo "ok - Android(kotpass)で読み直しても ItemType / Environment / 期限 / 値が残る"
