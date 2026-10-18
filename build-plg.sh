#!/bin/bash
#
# build-plg.sh - get uncommander.plg ready for a release
#
# Run this in the repo folder AFTER you finish editing, BEFORE you commit and
# push. It does three jobs:
#
#   1. Bumps <!ENTITY version> to today's date with a letter suffix
#      (2026.10.14 -> 2026.10.14a -> 2026.10.14b ...), so Unraid's Plugins page
#      offers the update. Unraid compares versions as plain text, so the new
#      value must sort after the old one - this script checks that.
#
#   2. Rewrites the file list between <!-- FILES:BEGIN --> and <!-- FILES:END -->
#      with one <FILE> per file in source/ (plus the icon and description.txt).
#      Add, rename or delete files in source/ and the list follows - nothing to
#      type by hand.
#
#   3. Puts an <MD5> on every file, so Unraid can tell when a file changed and
#      always downloads the right copy.
#
# Usage:
#     cd /path/to/your/repo/uncommander
#     bash build-plg.sh              # bump the version and refresh the list
#     bash build-plg.sh --no-bump    # refresh the list and MD5s only
#     ...then commit and push.
#
# Re-running is always safe. If you change a file after running it, run it
# again - otherwise Unraid will stop the install with "bad file MD5".
#

set -euo pipefail
cd "$(dirname "$0")"

PLG="uncommander.plg"
[[ -f "$PLG" ]] || { echo "ERROR: $PLG not found."; exit 1; }
[[ -d source ]] || { echo "ERROR: source/ folder not found."; exit 1; }

BUMP=1
[[ "${1:-}" == "--no-bump" ]] && BUMP=0

# ---- 1. the next version ----------------------------------------------------
CURRENT=$(grep -oP '<!ENTITY version\s+"\K[^"]+' "$PLG")
NEXT="$CURRENT"
if [[ $BUMP == 1 ]]; then
  TODAY=$(date +%Y.%m.%d)
  if [[ "$CURRENT" == "$TODAY"* ]]; then
    SUFFIX="${CURRENT#$TODAY}"
    if [[ -z "$SUFFIX" ]]; then NEXT="${TODAY}a"
    elif [[ "$SUFFIX" == *z ]]; then NEXT="${CURRENT}a"          # ...z -> ...za
    else NEXT="${TODAY}${SUFFIX%?}$(echo "${SUFFIX: -1}" | tr 'a-y' 'b-z')"
    fi
  else
    NEXT="$TODAY"
  fi
  if [[ ! "$NEXT" > "$CURRENT" ]]; then
    echo "ERROR: new version '$NEXT' does not sort after '$CURRENT' - Unraid would see a downgrade."
    exit 1
  fi
fi

# ---- 2 + 3. file list and MD5s ----------------------------------------------
python3 - "$PLG" "$NEXT" <<'PYEOF'
import hashlib, os, re, sys

plg, version = sys.argv[1], sys.argv[2]
text = open(plg, encoding='utf-8').read()
text = re.sub(r'(<!ENTITY version\s+")[^"]+(">)', r'\g<1>' + version + r'\g<2>', text, count=1)

def md5(path):
    raw = open(path, 'rb').read()
    # Hash what GitHub will serve: .gitattributes stores text files with LF
    # line endings, so fix any CRLF here too (on disk and in the hash).
    if b'\x00' not in raw and b'\r\n' in raw:
        raw = raw.replace(b'\r\n', b'\n')
        open(path, 'wb').write(raw)
        print('  converted CRLF -> LF: ' + path)
    return hashlib.md5(raw).hexdigest()

# (repo path, installed path)
files = []
for root, dirs, names in os.walk('source'):
    dirs[:] = sorted(d for d in dirs if not d.startswith('.'))
    for n in sorted(names):
        if n.startswith('.'):
            continue
        rel = os.path.join(root, n).replace(os.sep, '/')
        files.append((rel, '&plugdir;/' + rel[len('source/'):]))
files.append(('icon.png', '&plugdir;/&name;.png'))            # icon on the Plugins page
files.append(('description.txt', '&plugdir;/README.md'))      # text on the Plugins page

blocks = []
for repo_path, target in files:
    if not os.path.isfile(repo_path):
        sys.exit('ERROR: missing ' + repo_path)
    url = '&raw;/' + '/'.join(p.replace(' ', '%20') for p in repo_path.split('/'))
    blocks.append('<FILE Name="%s">\n  <URL>%s</URL>\n  <MD5>%s</MD5>\n</FILE>' % (target, url, md5(repo_path)))

begin = '<!-- FILES:BEGIN - this list is written by build-plg.sh, don\'t edit by hand -->'
end = '<!-- FILES:END -->'
if begin not in text or end not in text:
    sys.exit('ERROR: the FILES:BEGIN / FILES:END markers are missing from the .plg')
a, b = text.index(begin) + len(begin), text.index(end)
text = text[:a] + '\n' + '\n\n'.join(blocks) + '\n' + text[b:]
open(plg, 'w', encoding='utf-8', newline='\n').write(text)

print('  version: ' + version)
print('  files:   %d' % len(files))
for repo_path, _ in files:
    print('    ' + repo_path)
PYEOF

# ---- sanity check: is the .plg still valid XML? ------------------------------
if command -v php >/dev/null 2>&1; then
  php -r '$x = @simplexml_load_file($argv[1]); if ($x === false) { fwrite(STDERR, "ERROR: the .plg is not valid XML\n"); exit(1); }' "$PLG"
fi

echo
echo "Done. Now commit and push, then use Plugins > Check for Updates on your server."
