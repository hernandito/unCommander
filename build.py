#!/usr/bin/env python3
"""Build uncommander.plg — a single-file unRAID plugin with every source file
inlined, so it installs from a local path with no download server."""
import pathlib, datetime, os

ROOT = pathlib.Path(__file__).parent
SRC = ROOT / 'src'
VERSION = os.environ.get('UC_VERSION') or datetime.date.today().strftime('%Y.%m.%d')
PLUGDIR = '/usr/local/emhttp/plugins/uncommander'
PLUGIN_URL = os.environ.get('UC_PLUGIN_URL', '')     # set it for a build that unRAID can check for updates
_ch = ROOT / 'CHANGES.txt'
CHANGES = (_ch.read_text().strip() if _ch.is_file() else 'Two-pane file manager for unRAID.').replace('&', '&amp;').replace('<', '&lt;').replace('>', '&gt;')

files = sorted(p for p in SRC.rglob('*') if p.is_file() and p.suffix not in ('.png', '.ico') and not any(d in str(p) for d in ('/plugins/uncommander/lib/', '/plugins/uncommander/bin/')))   # lib/ and bin/ are downloaded
blocks = []
for p in files:
    text = p.read_text()
    if p.name == 'README.md' and 'uC-Beta' not in PLUGIN_URL: text = text.replace(' (Beta)', '')   # the Plugins page title: stable builds drop (Beta)
    assert ']]>' not in text, f'{p} contains a CDATA terminator'
    target = '/' + str(p.relative_to(SRC))
    blocks.append(f'<FILE Name="{target}" Mode="0{"755" if "scripts/" in target else "644"}">\n<INLINE><![CDATA[{text}]]></INLINE>\n</FILE>')

plg = f"""<?xml version='1.0' standalone='yes'?>
<!DOCTYPE PLUGIN [
<!ENTITY name    "uncommander">
<!ENTITY version "{VERSION}">
<!ENTITY plugdir "{PLUGDIR}">
<!ENTITY cfgdir  "/boot/config/plugins/uncommander">
]>
<PLUGIN name="&name;" author="hernandito" version="&version;"{(' pluginURL="' + PLUGIN_URL + '"') if PLUGIN_URL else ''} min="6.12.0" icon="uncommander.png" launch="UnCommander" support="https://forums.unraid.net/topic/200949-plugin-uncommander-%E2%AD%90-a-powerful-two-pane-file-manager/">

<CHANGES>
###&version;
{CHANGES}
</CHANGES>

<!-- clean out an older build before laying down this one -->
<FILE Run="/bin/bash">
<INLINE>
rm -rf &plugdir;
mkdir -p &plugdir; &cfgdir;
</INLINE>
</FILE>

{chr(10).join(blocks)}

<!-- 7-Zip (for .rar/.7z, and zips): the official static Linux build, checksum-pinned,
     cached on the flash drive and unpacked into unCommander's own folder only -->
<FILE Run="/bin/bash">
<INLINE><![CDATA[
Z=/boot/config/plugins/uncommander/7z2603-linux-x64.tar.xz
SHA=dc99eff5008f1ab79bd7084c68513701547a808a89502bf4133683535ab3c695
URL=https://github.com/ip7z/7zip/releases/download/26.03/7z2603-linux-x64.tar.xz
BIN=/usr/local/emhttp/plugins/uncommander/bin
mkdir -p /boot/config/plugins/uncommander "$BIN"
if ! echo "$SHA  $Z" | sha256sum -c --status 2>/dev/null; then
  rm -f "$Z"
  echo "Downloading 7-Zip (about 1.6 MB)..."
  if curl -fsSL --max-time 120 -o "$Z.part" "$URL" && echo "$SHA  $Z.part" | sha256sum -c --status; then
    mv "$Z.part" "$Z"
  else
    rm -f "$Z.part"
    echo "Note: could not download 7-Zip. Extracting .rar and .7z will be unavailable until unCommander is reinstalled while the server is online."
  fi
fi
if [ -f "$Z" ]; then
  rm -f "$BIN/7zzs"
  # unpack just the 7zzs program; try plain xz first, then tar's own -J
  xz -dc "$Z" 2>/dev/null | tar -xf - -C "$BIN" 7zzs 2>/dev/null || tar -xJf "$Z" -C "$BIN" 7zzs
  chmod 755 "$BIN/7zzs" 2>/dev/null
  if [ -x "$BIN/7zzs" ] && "$BIN/7zzs" >/dev/null 2>&1; then
    echo "7-Zip ready: $BIN/7zzs"
  else
    echo "Note: 7-Zip was downloaded but could not be unpacked into $BIN - .rar and .7z extraction is unavailable."
    ls -la "$BIN" "$Z" 2>&1
  fi
  find /boot/config/plugins/uncommander -maxdepth 1 -name '7z*-linux-x64.tar.xz' ! -name "$(basename "$Z")" -delete
fi

# HEIC pictures (iPhone photos) for browsers that can't show them: heic2any, one
# JavaScript file run by the browser - nothing is installed on the server.
# Pinned version from the npm registry, checked by its sha256, kept on the flash.
Z=/boot/config/plugins/uncommander/heic2any-0.0.4.tgz
SHA=510dbabc44f5940689b1779fff552584a1c4df434c0cc83c3be3258b2ace1995
URL=https://registry.npmjs.org/heic2any/-/heic2any-0.0.4.tgz
LIB=/usr/local/emhttp/plugins/uncommander/lib
mkdir -p "$LIB"
if ! echo "$SHA  $Z" | sha256sum -c --status 2>/dev/null; then
  rm -f "$Z"
  echo "Downloading HEIC picture support (about 1 MB)..."
  if curl -fsSL --max-time 120 -o "$Z.part" "$URL" && echo "$SHA  $Z.part" | sha256sum -c --status; then
    mv "$Z.part" "$Z"
  else
    rm -f "$Z.part"
    echo "Note: could not download HEIC support. HEIC photos will only open in Safari until unCommander is reinstalled while the server is online."
  fi
fi
if [ -f "$Z" ]; then
  tar -xzf "$Z" -O package/dist/heic2any.min.js > "$LIB/heic2any.min.js" 2>/dev/null && echo "HEIC support ready" || rm -f "$LIB/heic2any.min.js"
fi
]]></INLINE>
</FILE>

<FILE Run="/bin/bash">
<INLINE>
# icons arrive as text (base64): turn them back into pictures
for f in &plugdir;/images/*.b64; do [ -f "$f" ] || continue; base64 -d "$f" &gt; "${{f%.b64}}"; done
# the Settings > User Utilities icon, wherever this unRAID version looks for it
mkdir -p &plugdir;/icons; cp -f &plugdir;/images/uncommander.png &plugdir;/uncommander.png; cp -f &plugdir;/images/uncommander.png &plugdir;/icons/uncommander.png
# default settings, kept across upgrades
[ -f &cfgdir;/uncommander.cfg ] || echo 'TRASH_DAYS="7"' > &cfgdir;/uncommander.cfg
chmod 755 &plugdir;/scripts/purge-trash &plugdir;/scripts/apply-menu-name &plugdir;/scripts/daily
# custom menu name from Settings, if one was saved
php &plugdir;/scripts/apply-menu-name
# daily at 04:17: old trash emptied, and the tools' lists copied to the flash drive if they changed.
# The cron file is only written when it's different, so a boot doesn't write the flash drive.
CRON='17 4 * * * &plugdir;/scripts/daily &amp;>/dev/null'
[ "$(cat &cfgdir;/uncommander.cron 2>/dev/null)" = "$CRON" ] || echo "$CRON" > &cfgdir;/uncommander.cron
update_cron
echo ""
echo "unCommander &version; installed - open it from the unRAID top menu."
echo ""
</INLINE>
</FILE>

<FILE Run="/bin/bash" Method="remove">
<INLINE>
rm -f &cfgdir;/uncommander.cron
update_cron
pkill -f "&plugdir;/include/worker.php" 2>/dev/null
rm -rf &plugdir; /tmp/uncommander
echo "unCommander removed. Settings in &cfgdir; and any .uncommander-trash folders on your shares were left in place."
</INLINE>
</FILE>

</PLUGIN>
"""
(ROOT / 'uncommander.plg').write_text(plg)
print(f'wrote uncommander.plg ({len(plg):,} bytes, {len(files)} files, version {VERSION})')
