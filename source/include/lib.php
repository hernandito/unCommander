<?php
/* unCommander — shared helpers.
 * Everything that touches the filesystem goes through uc_path() first, so a
 * request can never reach outside the allowed roots (/mnt and /boot). */

define('UC_PLUGIN', 'uncommander');
define('UC_DIR', dirname(__DIR__));
define('UC_CFG', getenv('UC_CFG') ?: '/boot/config/plugins/uncommander/uncommander.cfg');
define('UC_STATE', getenv('UC_STATE') ?: '/tmp/uncommander');
define('UC_JOBS', UC_STATE . '/jobs');
define('UC_TRASH', '.uncommander-trash');
/* 7-Zip, fetched at install into unCommander's own folder - not on the
 * system PATH, only ever called by its full path. */
define('UC_7Z', UC_DIR . '/bin/7zzs');

/* Archive kinds unCommander can open. tar-based ones go through tar (7-Zip
 * would need two passes); rar/7z need 7-Zip; zip uses 7-Zip, or unzip. */
function uc_archive_kind(string $p): ?string {
  $n = strtolower(basename($p));
  if (preg_match('/\.(tar|tar\.gz|tgz|tar\.bz2|tbz2?|tar\.xz|txz|tar\.zst|tzst)$/', $n)) return 'tar';
  if (preg_match('/\.zip$/', $n)) return 'zip';
  if (preg_match('/\.(rar|7z|gz|bz2|xz|zst|iso|cab|arj|lzh|z)$/', $n)) return '7z';
  return null;
}
/* What's inside an archive: up to $limit entries [path, isDir, size] plus
 * totals. Used by Extract's summary, F3 on an archive, and the extract job
 * (for its progress). */
function uc_archive_list(string $a, int $limit = 3000): array {
  if (!is_file($a)) throw new UcError('Not a file');
  $kind = uc_archive_kind($a);
  if (!$kind) throw new UcError(basename($a) . " isn't an archive unCommander can open");
  $has7 = is_executable(UC_7Z);
  $entries = []; $files = 0; $dirs = 0; $bytes = 0; $more = false; $err = '';
  $add = function (string $path, bool $isDir, int $size) use (&$entries, &$files, &$dirs, &$bytes, &$more, $limit) {
    if ($isDir) $dirs++; else { $files++; $bytes += $size; }
    if (count($entries) < $limit) $entries[] = [$path, $isDir, $size]; else $more = true;
  };
  if ($kind === 'tar') {
    $h = popen('tar -tvf ' . escapeshellarg($a) . ' 2>&1', 'r');
    while ($h && ($line = fgets($h)) !== false) {
      /* -rw-r--r-- user/group  12345 2026-01-01 12:00 path */
      if (preg_match('/^(\S)\S*\s+\S+\s+(\d+)\s+\S+\s+\S+\s+(.*)$/', rtrim($line, "\n"), $m)) $add(rtrim($m[3], '/'), $m[1] === 'd', (int)$m[2]);
      else $err = trim($line);
    }
    if ($h && pclose($h) !== 0 && !$entries) throw new UcError('Could not read the archive' . ($err ? ": $err" : ''));
  } elseif ($has7) {
    $h = popen(escapeshellarg(UC_7Z) . ' l -slt -ba -pUCNOPASS -- ' . escapeshellarg($a) . ' 2>&1 </dev/null', 'r');
    $cur = [];
    $flush = function () use (&$cur, $add) { if (isset($cur['Path'])) $add($cur['Path'], ($cur['Folder'] ?? '') === '+' || str_contains($cur['Attributes'] ?? '', 'D'), (int)($cur['Size'] ?? 0)); $cur = []; };
    while ($h && ($line = fgets($h)) !== false) {
      $line = rtrim($line, "\r\n");
      if ($line === '') { $flush(); continue; }
      if (preg_match('/^(\w[\w ]*?) = (.*)$/', $line, $m)) $cur[$m[1]] = $m[2];
      elseif (stripos($line, 'error') !== false || stripos($line, 'password') !== false || stripos($line, 'Can not open') !== false) $err = $line;
    }
    $flush();
    if ($h) pclose($h);
    if (!$entries && $err) throw new UcError(stripos($err, 'password') !== false || stripos($err, 'encrypted') !== false ? 'This archive is password-protected - unCommander can\'t open those yet' : "Could not read the archive: $err");
  } elseif ($kind === 'zip') {
    $h = popen('unzip -Z -l ' . escapeshellarg($a) . ' 2>&1', 'r');
    while ($h && ($line = fgets($h)) !== false)
      if (preg_match('/^([d-])\S+\s+\S+\s+\S+\s+(\d+)\s+\S+\s+\S+\s+\S+\s+\S+\s+\S+\s+(.*)$/', rtrim($line, "\n"), $m)) $add(rtrim($m[3], '/'), $m[1] === 'd', (int)$m[2]);
    if ($h) pclose($h);
  } else throw new UcError("7-Zip isn't installed - reinstall unCommander while the server is online");
  return ['entries' => $entries, 'files' => $files, 'dirs' => $dirs, 'bytes' => $bytes, 'more' => $more];
}

/* All the files of a multi-part archive (name.part1.rar + name.part2.rar …,
 * name.rar + name.r00 …, name.7z.001 …) - so "delete the archive" gets them all. */
function uc_archive_parts(string $a): array {
  $dir = dirname($a); $n = basename($a); $parts = [$a];
  if (preg_match('/^(.*)\.part0*1\.rar$/i', $n, $m)) $parts = glob($dir . '/' . glob_quote($m[1]) . '.part*.rar') ?: [$a];
  elseif (preg_match('/^(.*)\.rar$/i', $n, $m)) $parts = array_merge([$a], glob($dir . '/' . glob_quote($m[1]) . '.[rs][0-9][0-9]') ?: []);
  elseif (preg_match('/^(.*\.(7z|zip))\.0*1$/i', $n, $m)) $parts = glob($dir . '/' . glob_quote($m[1]) . '.[0-9][0-9]*') ?: [$a];
  sort($parts);
  return array_values(array_unique($parts));
}
function glob_quote(string $s): string { return preg_replace('/([*?\[\]\\])/', '\\$1', $s); }

function uc_archive_base(string $p): string {
  return preg_replace('/(\.part0*1)?\.(tar\.gz|tar\.bz2|tar\.xz|tar\.zst|tgz|tbz2?|txz|tzst|tar|zip|rar|7z|gz|bz2|xz|zst|iso|cab|arj|lzh|z)$/i', '', basename($p)) ?: basename($p);
}

/* The starting "Your own CSS" (Settings > Look & sound): every rule labelled, so it can be tweaked */
const UC_DEFAULT_CSS = <<<'CSS'
/* ===== Shares view ===== */

/* Accent colour - active pane outline, highlights, buttons, links, tabs */
#uc { --accent: #008cb4; }

/* Active pane header bar ("LEFT · ACTIVE") - background, and the thin
   line under it. Last two digits = transparency (17 pale, 4a stronger) */
#uc .uc-pane.active .uc-pane-head {
  background: #008cb417;
  border-bottom: 1px solid #008cb44a;
}

/* ===== Whole OS view (only while the switch is on Whole OS) ===== */

/* Whole OS - accent colour */
#uc.uc-sys { --accent: #6b7a1f; }

/* Whole OS - active pane header bar: background and the line under it */
#uc.uc-sys .uc-pane.active .uc-pane-head {
  background: #6b7a1f17;
  border-bottom: 1px solid #6b7a1f4a;
}

/* Whole OS - highlighted row (cursor) in the active pane
   (#fbf3dc = the same cream as Shares view) */
#uc.uc-sys .uc-pane.active .uc-list .uc-row.cursor {
  background: #fbf3dc;
}
CSS;

function uc_roots(): array {
  $env = getenv('UC_ROOTS');
  if ($env) return array_map(fn($r) => rtrim($r, '/'), explode(':', $env));
  /* Settings > Safety > "Whole system": the whole file system, like MC on the console */
  return uc_sys_allowed() ? [''] : ['/mnt', '/boot'];
}
function uc_sys_allowed(): bool {
  static $on = null;
  if ($on === null) { $f = dirname(UC_CFG) . '/settings.json'; $s = is_file($f) ? (json_decode((string)file_get_contents($f), true) ?: []) : []; $on = !empty($s['sysmode']); }
  return $on;
}

function uc_cfg(): array {
  $d = ['TRASH_DAYS' => '30'];
  if (is_file(UC_CFG)) $d = array_merge($d, parse_ini_file(UC_CFG) ?: []);
  return $d;
}

/* User settings (shortcuts, custom CSS, sounds) merged over defaults. */
function uc_settings(): array {
  $f = dirname(UC_CFG) . '/settings.json';
  $s = is_file($f) ? (json_decode(file_get_contents($f), true) ?: []) : [];
  $snd = array_merge(['enabled' => true, 'volume' => 40, 'buttons' => true, 'nav' => true, 'taps' => true, 'errors' => true],
                     (array)($s['sounds'] ?? []));
  return [
    'bookmarks'  => array_values((array)($s['bookmarks'] ?? [])),
    'css'        => array_key_exists('css', $s) ? (string)$s['css'] : UC_DEFAULT_CSS,   // never saved yet: the starting look
    'css_default' => UC_DEFAULT_CSS,
    'sounds'     => $snd,
    'trash_days' => (int)(uc_cfg()['TRASH_DAYS'] ?? 30),
    'tap_mode'   => in_array($s['tap_mode'] ?? 'auto', ['always', 'never'], true) ? $s['tap_mode'] : 'auto',
    'menu_name'  => uc_clean_menu_name($s['menu_name'] ?? ''),
    'practice'   => !empty($s['practice']),
    'sysmode'    => !empty($s['sysmode']),
    'theme'      => ($s['theme'] ?? '') === 'mc' ? 'mc' : 'standard',
    'toolbtns'   => ['movies' => ($s['toolbtns']['movies'] ?? true) !== false, 'tv' => ($s['toolbtns']['tv'] ?? true) !== false],
    'highlight'  => !array_key_exists('highlight', $s) || !empty($s['highlight']),   // on unless switched off
    'radarr'     => uc_radarr_public($s['radarr'] ?? []),
    'sonarr'     => uc_sonarr_public($s['sonarr'] ?? []),
    'autorefresh' => ['on' => !empty($s['autorefresh']['on']), 'secs' => in_array((int)($s['autorefresh']['secs'] ?? 10), [5, 10, 30, 60], true) ? (int)$s['autorefresh']['secs'] : 10],   // off unless switched on
    'trash'      => !array_key_exists('trash', $s) || !empty($s['trash']),   // on unless switched off
    'notify_unraid' => !array_key_exists('notify_unraid', $s) || !empty($s['notify_unraid']),
  ];
}

/* Practice mode (Settings -> Safety): nothing can be deleted, moved,
 * renamed, overwritten or have its permissions changed. Checked here on the
 * server too, so it holds even if the page is out of date. */
function uc_practice_block(string $what): void {
  if (uc_settings()['practice'])
    throw new UcError("Practice mode is on, so $what is turned off. You can switch it off in Settings > Safety.");
}

/* The label in the unRAID top menu comes from the Name= line of
 * UnCommander.page. It's rewritten on save and again at every install/boot
 * (scripts/apply-menu-name), so a custom name survives reboots. */
function uc_clean_menu_name($n): string {
  $n = trim(preg_replace('/["\\\\\r\n\t]+/', '', (string)$n));     // drop quotes, backslashes and line breaks
  return $n === '' ? 'unCommander' : mb_substr($n, 0, 30);
}
function uc_apply_menu_name(string $name): bool {
  $page = UC_DIR . '/UnCommander.page';
  if (!is_file($page)) return false;
  $s = file_get_contents($page);
  $n = preg_replace('/^Name=".*"$/m', 'Name="' . uc_clean_menu_name($name) . '"', $s, 1);
  return $n === $s || file_put_contents($page, $n) !== false;
}

class UcError extends Exception {}

/* Normalise a path lexically (no symlink resolution — /mnt/user is FUSE and
 * realpath on every request is a needless round trip) and check it sits
 * under an allowed root. */
function uc_path(string $p): string {
  if ($p === '' || $p[0] !== '/' || str_contains($p, "\0")) throw new UcError('Invalid path');
  $out = [];
  foreach (explode('/', $p) as $seg) {
    if ($seg === '' || $seg === '.') continue;
    if ($seg === '..') { array_pop($out); continue; }
    $out[] = $seg;
  }
  $norm = '/' . implode('/', $out);
  foreach (uc_roots() as $r) {
    if ($r === '' || $norm === $r || str_starts_with($norm, $r . '/')) return $norm;   // '' = the whole system
  }
  throw new UcError("Outside allowed locations: $norm");
}

function uc_name(string $n): string {
  if ($n === '' || $n === '.' || $n === '..' || str_contains($n, '/') || str_contains($n, "\0"))
    throw new UcError('Invalid name');
  return $n;
}

function uc_join(string $dir, string $name): string { return rtrim($dir, '/') . '/' . $name; }

/* unRAID's classic data-loss trap: /mnt/user/X and /mnt/diskN/X can be the
 * same file, so copying between the two views can truncate the source.
 * Classify each path as the user-share view or the disk view and refuse to
 * mix them in one operation. */
function uc_view(string $p): string {
  if (preg_match('#^/mnt/(user0?)(/|$)#', $p)) return 'user';
  if (preg_match('#^/mnt/(remotes|addons|disks|rootshare)(/|$)#', $p)) return 'other';
  if (preg_match('#^/mnt/[^/]+(/|$)#', $p)) return 'disk';
  return 'other';
}

/* The same file can be reached as /mnt/user/Share/x, /mnt/diskN/Share/x or
 * /mnt/<pool>/Share/x. Map a disk or pool path to its user-share form so we
 * can tell when two different-looking paths are really one file. Paths that
 * aren't inside a share (files at the top of a pool, /boot, unassigned
 * devices) have no user-share form. */
function uc_share_equiv(string $p, ?bool $isDir = null): ?string {
  $v = uc_view($p);
  if ($v === 'user') return preg_match('#^/mnt/user0?(/.+)$#', $p, $m) ? '/mnt/user' . $m[1] : null;
  if ($v !== 'disk' || !preg_match('#^/mnt/[^/]+/(.+)$#', $p, $m)) return null;
  /* a top-level entry on a disk or pool is a share only if it's a folder */
  if (!str_contains($m[1], '/') && !($isDir ?? is_dir($p))) return null;
  return '/mnt/user/' . $m[1];
}

/* Mixing /mnt/user with disk or pool paths is fine - except when the copy
 * would land on the very file (or folder) it's reading from, seen through the
 * other view. That's refused, because rsync would truncate it. */
function uc_guard_views(array $sources, string $dest): void {
  foreach ($sources as $s) {
    if ($s === $dest || str_starts_with($dest . '/', rtrim($s, '/') . '/'))
      throw new UcError("Can't copy or move a folder into itself: " . basename($s));
    if (uc_view($s) === uc_view($dest)) continue;
    $sDir = is_dir($s);
    $se = uc_share_equiv($s, $sDir);
    $target = uc_join($dest, basename($s));
    $te = uc_share_equiv($target, $sDir);
    $de = uc_share_equiv($dest, true);
    if ($se === null) continue;
    if ($te !== null && $te === $se)
      throw new UcError(basename($s) . " would be copied onto itself: $s and $target are the same " . ($sDir ? 'folder' : 'file') . " seen two ways (through the share, and through the disk or pool that holds it). Doing that can destroy it.");
    if ($de !== null && ($de === $se || str_starts_with($de . '/', $se . '/')))
      throw new UcError("Can't copy " . basename($s) . " into itself: $dest is inside it, seen through the share instead of the disk or pool (or the other way round).");
  }
}

/* Disks and pools that make up user shares: disk1, disk2 ... then pools
 * (cache, etc.). Anything else under /mnt isn't part of a share. */
function uc_array_mounts(): array {
  static $m = null;
  if ($m !== null) return $m;
  $m = [];
  foreach (scandir('/mnt') ?: [] as $d) {
    if ($d[0] === '.' || in_array($d, ['user', 'user0', 'disks', 'remotes', 'addons', 'rootshare'], true) || !is_dir("/mnt/$d")) continue;
    $m[] = $d;
  }
  usort($m, function ($a, $b) {
    $da = preg_match('/^disk\d+$/', $a); $db = preg_match('/^disk\d+$/', $b);
    return $da !== $db ? $db - $da : strnatcmp($a, $b);
  });
  return $m;
}

/* Which disk(s) or pool a /mnt/user path really lives on. unRAID's share
 * filesystem answers that directly (the system.LOCATIONS attribute); if
 * that's not available, look for the same path on each disk and pool. */
function uc_locate(array $paths): array {
  $found = [];
  if ($paths && is_executable('/usr/bin/getfattr')) {
    $cmd = '/usr/bin/getfattr --absolute-names -n system.LOCATIONS -- ' . implode(' ', array_map('escapeshellarg', array_values($paths))) . ' 2>/dev/null';
    $file = null;
    foreach (explode("\n", (string)shell_exec($cmd)) as $line) {
      if (str_starts_with($line, '# file: ')) { $file = stripcslashes(substr($line, 8)); continue; }
      if ($file !== null && preg_match('/^system\.LOCATIONS="(.*)"$/', $line, $m)) { $found[$file] = $m[1]; $file = null; }
    }
  }
  $out = [];
  foreach ($paths as $n => $p) {
    if (isset($found[$p])) { $out[$n] = array_values(array_filter(explode(',', $found[$p]))); continue; }
    $rest = preg_replace('#^/mnt/user0?#', '', $p);
    $locs = [];
    foreach (uc_array_mounts() as $d) if (file_exists("/mnt/$d$rest") || is_link("/mnt/$d$rest")) $locs[] = $d;
    $out[$n] = $locs;
  }
  return $out;
}

function uc_mode_str(int $mode): string { return sprintf('%03o', $mode & 0777); }

$UC_USERS = null; $UC_GROUPS = null;
function uc_owner(int $uid): string {
  global $UC_USERS;
  if (!isset($UC_USERS[$uid])) {
    $pw = function_exists('posix_getpwuid') ? @posix_getpwuid($uid) : false;
    $UC_USERS[$uid] = $pw ? $pw['name'] : (string)$uid;
  }
  return $UC_USERS[$uid];
}
function uc_group(int $gid): string {
  global $UC_GROUPS;
  if (!isset($UC_GROUPS[$gid])) {
    $gr = function_exists('posix_getgrgid') ? @posix_getgrgid($gid) : false;
    $UC_GROUPS[$gid] = $gr ? $gr['name'] : (string)$gid;
  }
  return $UC_GROUPS[$gid];
}

/* Where deleted items go: a trash folder at the top of the same share or
 * disk, so "delete" is a rename on one filesystem — instant. */
function uc_trash_root(string $p): string {
  if (preg_match('#^(/mnt/user0?/[^/]+)/#', $p, $m)) return $m[1] . '/' . UC_TRASH;
  if (preg_match('#^(/mnt/[^/]+)/#', $p, $m)) return $m[1] . '/' . UC_TRASH;
  if (preg_match('#^(/boot)/#', $p, $m)) return $m[1] . '/' . UC_TRASH;
  foreach (uc_roots() as $r) if ($r !== '' && str_starts_with($p, $r . '/')) {   // test roots
    $rest = explode('/', substr($p, strlen($r) + 1));
    return $r . '/' . $rest[0] . '/' . UC_TRASH;
  }
  throw new UcError('No trash location for ' . $p);
}

/* Delete = move into the trash at the top of the same share/disk (one dated
 * folder per item, named after it), unless the trash is switched off, the
 * item is already in the trash, or it IS the trash folder - then it's removed
 * for good. Returns [count, bins]. Used by Delete and by "delete the
 * originals" after compressing. */
function uc_delete_paths(array $paths, bool $forever = false): array {
  $n = 0; $bins = [];
  $useTrash = uc_settings()['trash'] && !$forever;
  $stamp = date('Ymd-His');
  foreach ($paths as $p) {
    if (!$useTrash || str_contains($p, '/' . UC_TRASH . '/') || basename($p) === UC_TRASH) {
      exec('rm -rf -- ' . escapeshellarg($p), $o, $rc);
      if ($rc) throw new UcError('Could not delete ' . basename($p));
      $n++; continue;
    }
    try { $root = uc_trash_root($p); }
    catch (UcError $e) {     /* system folders (/etc, /var, /tmp...) have no trash: removed for good */
      exec('rm -rf -- ' . escapeshellarg($p), $o, $rc);
      if ($rc) throw new UcError('Could not delete ' . basename($p));
      $n++; continue;
    }
    $label = trim(mb_substr(preg_replace('/[\x00-\x1f\/]+/', ' ', basename($p)), 0, 80));
    $bin = "$root/$stamp " . ($label !== '' ? $label : 'item');
    for ($k = 2; file_exists($bin); $k++) $bin = "$root/$stamp " . $label . " ($k)";
    mkdir($bin, 0700, true);
    file_put_contents("$bin/.uncommander-origin", $p);
    if (!@rename($p, "$bin/" . basename($p))) {
      @unlink("$bin/.uncommander-origin"); @rmdir($bin);
      throw new UcError('Could not move to trash: ' . basename($p));
    }
    $bins[] = $bin;
    $n++;
  }
  return [$n, $bins];
}

/* ---------- Radarr (Tools > Movie folders without a video) ----------
 * Settings live in settings.json; the API key never goes to the browser. */
function uc_radarr_cfg(): array {
  $f = dirname(UC_CFG) . '/settings.json';
  $s = is_file($f) ? (json_decode(file_get_contents($f), true) ?: []) : [];
  return array_merge(['host' => '', 'port' => 7878, 'base' => '', 'key' => '', 'profile' => 0, 'profile_name' => '',
                      'availability' => 'released', 'search' => true, 'map' => []], (array)($s['radarr'] ?? []));
}
function uc_radarr_public(array $r): array {
  $r = array_merge(['host' => '', 'port' => 7878, 'base' => '', 'key' => '', 'profile' => 0, 'profile_name' => '', 'availability' => 'released', 'search' => true, 'map' => []], $r);
  $r['has_key'] = $r['key'] !== '';
  $r['ok'] = $r['host'] !== '' && $r['has_key'] && $r['profile'] > 0;
  unset($r['key']);
  return $r;
}
/* clean what the Settings window sent; an empty key keeps the saved one */
function uc_radarr_clean(array $in, array $old): array {
  $host = trim((string)($in['host'] ?? ''));
  if ($host !== '' && !preg_match('#^(https?://)?[A-Za-z0-9.\-\[\]:]+/?$#', $host)) throw new UcError('Radarr address should look like 192.168.1.10 or http://tower.local');
  $map = [];
  foreach (array_slice((array)($in['map'] ?? []), 0, 20) as $m) {
    $rp = trim((string)($m['radarr'] ?? '')); $hp = trim((string)($m['host'] ?? ''));
    if ($rp === '' || $hp === '') continue;
    $map[] = ['radarr' => rtrim($rp, '/') ?: '/', 'host' => rtrim(uc_path($hp), '/')];
  }
  $key = trim((string)($in['key'] ?? ''));
  return [
    'host' => rtrim($host, '/'), 'port' => max(1, min(65535, (int)($in['port'] ?? 7878))),
    'base' => trim(preg_replace('#[^A-Za-z0-9._\-/]#', '', (string)($in['base'] ?? '')), '/'),
    'key' => $key !== '' ? preg_replace('/[^A-Za-z0-9]/', '', $key) : ($old['key'] ?? ''),
    'profile' => (int)($in['profile'] ?? 0), 'profile_name' => mb_substr((string)($in['profile_name'] ?? ''), 0, 80),
    'availability' => in_array($in['availability'] ?? '', ['announced', 'inCinemas', 'released'], true) ? $in['availability'] : 'released',
    'search' => !array_key_exists('search', $in) || !empty($in['search']),
    'map' => $map,
  ];
}
function uc_radarr_req(array $c, string $method, string $path, $body = null) {
  if ($c['host'] === '' || $c['key'] === '') throw new UcError('Set up Radarr first (Settings > Tools)');
  $host = preg_match('#^https?://#', $c['host']) ? $c['host'] : 'http://' . $c['host'];
  $url = $host . (preg_match('#:\d+$#', $host) ? '' : ':' . $c['port']) . ($c['base'] !== '' ? '/' . $c['base'] : '') . '/api/v3/' . ltrim($path, '/');
  $ch = curl_init($url);
  curl_setopt_array($ch, [CURLOPT_RETURNTRANSFER => true, CURLOPT_CUSTOMREQUEST => $method, CURLOPT_CONNECTTIMEOUT => 6, CURLOPT_TIMEOUT => 25,
    CURLOPT_HTTPHEADER => ['X-Api-Key: ' . $c['key'], 'Accept: application/json', 'Content-Type: application/json'],
    CURLOPT_SSL_VERIFYPEER => false, CURLOPT_SSL_VERIFYHOST => 0]);
  if ($body !== null) curl_setopt($ch, CURLOPT_POSTFIELDS, json_encode($body, JSON_UNESCAPED_SLASHES));
  $raw = curl_exec($ch); $code = (int)curl_getinfo($ch, CURLINFO_HTTP_CODE); $err = curl_error($ch);
  curl_close($ch);
  if ($raw === false) throw new UcError("Can't reach Radarr at $url ($err)");
  if ($code === 401) throw new UcError('Radarr refused the API key (401) - copy it again from Radarr > Settings > General');
  $j = json_decode((string)$raw, true);
  if ($code >= 400) {
    $msg = is_array($j) ? implode('; ', array_filter(array_map(fn($e) => is_array($e) ? ($e['errorMessage'] ?? $e['message'] ?? '') : (string)$e, isset($j['message']) ? [$j] : $j))) : '';
    throw new UcError('Radarr said: ' . ($msg !== '' ? $msg : "HTTP $code"));
  }
  if ($j === null && trim((string)$raw) !== '') throw new UcError("That address answered, but it doesn't look like Radarr's API (check the port and URL base)");
  return $j;
}
/* Radarr's Docker volume mappings (container path => server path): from Docker
 * itself, or from unRAID's saved template if Docker can't be asked */
function uc_radarr_mounts(): array {
  $pairs = [];
  if (is_executable('/usr/bin/docker')) {
    foreach (explode("\n", (string)shell_exec("/usr/bin/docker ps -a --format '{{.Names}}|{{.Image}}' 2>/dev/null")) as $l) {
      [$name, $img] = array_pad(explode('|', $l, 2), 2, '');
      if ($name === '' || stripos($name . $img, 'radarr') === false) continue;
      foreach (explode("\n", (string)shell_exec('/usr/bin/docker inspect -f ' . escapeshellarg('{{range .Mounts}}{{.Destination}}|{{.Source}}{{"\n"}}{{end}}') . ' ' . escapeshellarg($name) . ' 2>/dev/null')) as $m) {
        [$dst, $src] = array_pad(explode('|', trim($m), 2), 2, '');
        if ($dst !== '' && $src !== '') $pairs[rtrim($dst, '/') ?: '/'] = rtrim($src, '/');
      }
      if ($pairs) return $pairs;
    }
  }
  foreach (glob('/boot/config/plugins/dockerMan/templates-user/*.xml') ?: [] as $t) {
    if (stripos(basename($t), 'radarr') === false) continue;
    $x = @simplexml_load_file($t); if (!$x) continue;
    foreach ($x->Config as $cfg) {
      if ((string)$cfg['Type'] !== 'Path') continue;
      $dst = rtrim((string)$cfg['Target'], '/'); $src = rtrim(trim((string)$cfg) ?: (string)$cfg['Default'], '/');
      if ($dst !== '' && $src !== '') $pairs[$dst] = $src;
    }
    if ($pairs) return $pairs;
  }
  return $pairs;
}
/* ---------- Sonarr (Tools > TV shows with missing episodes) ----------
 * The same as Radarr above, for Sonarr. Settings in settings.json; the key stays on the server. */
function uc_sonarr_cfg(): array {
  $f = dirname(UC_CFG) . '/settings.json';
  $s = is_file($f) ? (json_decode(file_get_contents($f), true) ?: []) : [];
  return array_merge(['host' => '', 'port' => 8989, 'base' => '', 'key' => '', 'profile' => 0, 'profile_name' => '',
                      'search' => true, 'map' => []], (array)($s['sonarr'] ?? []));
}
function uc_sonarr_public(array $r): array {
  $r = array_merge(['host' => '', 'port' => 8989, 'base' => '', 'key' => '', 'profile' => 0, 'profile_name' => '', 'search' => true, 'map' => []], $r);
  $r['has_key'] = $r['key'] !== '';
  $r['ok'] = $r['host'] !== '' && $r['has_key'] && $r['profile'] > 0;
  unset($r['key']);
  return $r;
}
function uc_sonarr_clean(array $in, array $old): array {
  $host = trim((string)($in['host'] ?? ''));
  if ($host !== '' && !preg_match('#^(https?://)?[A-Za-z0-9.\-\[\]:]+/?$#', $host)) throw new UcError('Sonarr address should look like 192.168.1.10 or http://tower.local');
  $map = [];
  foreach (array_slice((array)($in['map'] ?? []), 0, 20) as $m) {
    $rp = trim((string)($m['sonarr'] ?? $m['radarr'] ?? '')); $hp = trim((string)($m['host'] ?? ''));
    if ($rp === '' || $hp === '') continue;
    $map[] = ['sonarr' => rtrim($rp, '/') ?: '/', 'host' => rtrim(uc_path($hp), '/')];
  }
  $key = trim((string)($in['key'] ?? ''));
  return [
    'host' => rtrim($host, '/'), 'port' => max(1, min(65535, (int)($in['port'] ?? 8989))),
    'base' => trim(preg_replace('#[^A-Za-z0-9._\-/]#', '', (string)($in['base'] ?? '')), '/'),
    'key' => $key !== '' ? preg_replace('/[^A-Za-z0-9]/', '', $key) : ($old['key'] ?? ''),
    'profile' => (int)($in['profile'] ?? 0), 'profile_name' => mb_substr((string)($in['profile_name'] ?? ''), 0, 80),
    'search' => !array_key_exists('search', $in) || !empty($in['search']),
    'map' => $map,
  ];
}
function uc_sonarr_req(array $c, string $method, string $path, $body = null) {
  if ($c['host'] === '' || $c['key'] === '') throw new UcError('Set up Sonarr first (Settings > Tools)');
  $host = preg_match('#^https?://#', $c['host']) ? $c['host'] : 'http://' . $c['host'];
  $url = $host . (preg_match('#:\d+$#', $host) ? '' : ':' . $c['port']) . ($c['base'] !== '' ? '/' . $c['base'] : '') . '/api/v3/' . ltrim($path, '/');
  $ch = curl_init($url);
  curl_setopt_array($ch, [CURLOPT_RETURNTRANSFER => true, CURLOPT_CUSTOMREQUEST => $method, CURLOPT_CONNECTTIMEOUT => 6, CURLOPT_TIMEOUT => 25,
    CURLOPT_HTTPHEADER => ['X-Api-Key: ' . $c['key'], 'Accept: application/json', 'Content-Type: application/json'],
    CURLOPT_SSL_VERIFYPEER => false, CURLOPT_SSL_VERIFYHOST => 0]);
  if ($body !== null) curl_setopt($ch, CURLOPT_POSTFIELDS, json_encode($body, JSON_UNESCAPED_SLASHES));
  $raw = curl_exec($ch); $code = (int)curl_getinfo($ch, CURLINFO_HTTP_CODE); $err = curl_error($ch);
  curl_close($ch);
  if ($raw === false) throw new UcError("Can't reach Sonarr at $url ($err)");
  if ($code === 401) throw new UcError('Sonarr refused the API key (401) - copy it again from Sonarr > Settings > General');
  $j = json_decode((string)$raw, true);
  if ($code >= 400) {
    $msg = is_array($j) ? implode('; ', array_filter(array_map(fn($e) => is_array($e) ? ($e['errorMessage'] ?? $e['message'] ?? '') : (string)$e, isset($j['message']) ? [$j] : $j))) : '';
    throw new UcError('Sonarr said: ' . ($msg !== '' ? $msg : "HTTP $code"));
  }
  if ($j === null && trim((string)$raw) !== '') throw new UcError("That address answered, but it doesn't look like Sonarr's API (check the port and URL base)");
  return $j;
}
function uc_sonarr_mounts(): array {
  $pairs = [];
  if (is_executable('/usr/bin/docker')) {
    foreach (explode("\n", (string)shell_exec("/usr/bin/docker ps -a --format '{{.Names}}|{{.Image}}' 2>/dev/null")) as $l) {
      [$name, $img] = array_pad(explode('|', $l, 2), 2, '');
      if ($name === '' || stripos($name . $img, 'sonarr') === false) continue;
      foreach (explode("\n", (string)shell_exec('/usr/bin/docker inspect -f ' . escapeshellarg('{{range .Mounts}}{{.Destination}}|{{.Source}}{{"\n"}}{{end}}') . ' ' . escapeshellarg($name) . ' 2>/dev/null')) as $m) {
        [$dst, $src] = array_pad(explode('|', trim($m), 2), 2, '');
        if ($dst !== '' && $src !== '') $pairs[rtrim($dst, '/') ?: '/'] = rtrim($src, '/');
      }
      if ($pairs) return $pairs;
    }
  }
  foreach (glob('/boot/config/plugins/dockerMan/templates-user/*.xml') ?: [] as $t) {
    if (stripos(basename($t), 'sonarr') === false) continue;
    $x = @simplexml_load_file($t); if (!$x) continue;
    foreach ($x->Config as $cfg) {
      if ((string)$cfg['Type'] !== 'Path') continue;
      $dst = rtrim((string)$cfg['Target'], '/'); $src = rtrim(trim((string)$cfg) ?: (string)$cfg['Default'], '/');
      if ($dst !== '' && $src !== '') $pairs[$dst] = $src;
    }
    if ($pairs) return $pairs;
  }
  return $pairs;
}
function uc_sonarr_hostpath(array $c, string $rp): ?string {
  $best = null;
  foreach ($c['map'] as $m) if ($rp === $m['sonarr'] || str_starts_with($rp, rtrim($m['sonarr'], '/') . '/')) {
    if (!$best || strlen($m['sonarr']) > strlen($best['sonarr'])) $best = $m;
  }
  return $best ? $best['host'] . substr($rp, strlen(rtrim($best['sonarr'], '/'))) : null;
}
function uc_sonarr_path(array $c, string $host): ?string {
  $best = null;
  foreach ($c['map'] as $m) if ($host === $m['host'] || str_starts_with($host, $m['host'] . '/')) {
    if (!$best || strlen($m['host']) > strlen($best['host'])) $best = $m;
  }
  return $best ? rtrim($best['sonarr'], '/') . substr($host, strlen($best['host'])) : null;
}
/* What was sent to Sonarr, per show folder (flash drive) */
function uc_sonarr_hist(?array $set = null): array { return uc_tv_store('sonarr', $set); }
function uc_sonarr_note(string $path, array $o): array {
  $h = uc_sonarr_hist();
  $h[$path] = array_merge($h[$path] ?? [], $o, ['at' => time()]);
  uc_sonarr_hist($h);
  return $h[$path];
}

/* A title reduced to plain letters and digits for comparing ("Amélie!" = "amelie").
 * Built in on purpose: unRAID's PHP has no iconv or intl. */
function uc_fold(string $t): string {
  static $map = null;
  if ($map === null) {
    $map = [];
    foreach (['a' => 'àáâãäåāăą', 'c' => 'çćĉċč', 'd' => 'ďđ', 'e' => 'èéêëēĕėęě', 'g' => 'ĝğġģ', 'h' => 'ĥħ', 'i' => 'ìíîïĩīĭįı',
              'j' => 'ĵ', 'k' => 'ķ', 'l' => 'ĺļľŀł', 'n' => 'ñńņňŉ', 'o' => 'òóôõöøōŏő', 'r' => 'ŕŗř', 's' => 'śŝşšș', 't' => 'ţťŧț',
              'u' => 'ùúûüũūŭůűų', 'w' => 'ŵ', 'y' => 'ýÿŷ', 'z' => 'źżž', 'ae' => 'æ', 'oe' => 'œ', 'ss' => 'ß', 'th' => 'þ'] as $to => $chars)
      foreach (preg_split('//u', $chars, -1, PREG_SPLIT_NO_EMPTY) as $ch) { $map[$ch] = $to; $map[mb_strtoupper($ch)] = $to; }
    $map['&'] = 'and';
  }
  return preg_replace('/[^a-z0-9]+/', '', strtolower(strtr($t, $map)));
}

/* What was sent to Radarr, per movie folder - kept on the flash drive so it
 * survives new scans and reboots. */
function uc_radarr_hist(?array $set = null): array {
  $f = dirname(UC_CFG) . '/radarr-sent.json';
  if ($set !== null) { @mkdir(dirname($f), 0777, true); file_put_contents("$f.tmp", json_encode($set, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE)); rename("$f.tmp", $f); return $set; }
  return is_file($f) ? (json_decode(file_get_contents($f), true) ?: []) : [];
}
function uc_radarr_note(string $path, array $o): array {
  $h = uc_radarr_hist();
  $h[$path] = array_merge($h[$path] ?? [], $o, ['at' => time()]);
  uc_radarr_hist($h);
  return $h[$path];
}
/* the path Radarr sees -> the same folder on this server (the pairs, the other way) */
function uc_radarr_hostpath(array $c, string $rp): ?string {
  $best = null;
  foreach ($c['map'] as $m) if ($rp === $m['radarr'] || str_starts_with($rp, rtrim($m['radarr'], '/') . '/')) {
    if (!$best || strlen($m['radarr']) > strlen($best['radarr'])) $best = $m;
  }
  return $best ? $best['host'] . substr($rp, strlen(rtrim($best['radarr'], '/'))) : null;
}

/* server folder -> the path Radarr sees, using the saved pairs */
function uc_radarr_path(array $c, string $host): ?string {
  $best = null;
  foreach ($c['map'] as $m) if ($host === $m['host'] || str_starts_with($host, $m['host'] . '/')) {
    if (!$best || strlen($m['host']) > strlen($best['host'])) $best = $m;
  }
  return $best ? rtrim($best['radarr'], '/') . substr($host, strlen($best['host'])) : null;
}

/* ---------- undo for copies ----------
 * A copy, move or Compare copy that may replace files runs rsync with
 * --backup-dir pointing into the trash, so every file it replaces is kept.
 * The worker also records what it wrote. Undo then moves the new copies to
 * the trash and puts the replaced files back. */
define('UC_UNDO', UC_STATE . '/undo');
function uc_undo_meta(string $id): ?array {
  if (!preg_match('/^[a-z0-9]{6,32}$/', $id)) return null;
  $f = UC_UNDO . "/$id.json";
  return is_file($f) ? json_decode(file_get_contents($f), true) : null;
}
/* A trash entry that holds files to merge back into a folder (not one item). */
function uc_trash_merge_bin(string $dest, string $label): string {
  $root = uc_trash_root(rtrim($dest, '/') . '/x');
  $bin = "$root/" . date('Ymd-His') . " $label";
  for ($k = 2; file_exists($bin); $k++) $bin = "$root/" . date('Ymd-His') . " $label ($k)";
  return $bin;
}
function uc_trash_merge_mark(string $bin, string $dest): void {
  file_put_contents("$bin/.uncommander-origin", $dest);
  touch("$bin/.uncommander-merge");
}
/* Move everything under $from into $to, replacing files that are there.
 * Returns how many files moved; empty folders left in $from are removed. */
function uc_merge_back(string $from, string $to): int {
  $n = 0;
  if (!is_dir($from)) return 0;
  $it = new RecursiveIteratorIterator(new RecursiveDirectoryIterator($from, FilesystemIterator::SKIP_DOTS), RecursiveIteratorIterator::SELF_FIRST);
  $files = [];
  foreach ($it as $p => $info) {
    $rel = substr($p, strlen($from) + 1);
    if ($info->isDir() && !$info->isLink()) { if (!is_dir("$to/$rel")) @mkdir("$to/$rel", 0777, true); continue; }
    $files[] = $rel;
  }
  foreach ($files as $rel) {
    $t = "$to/$rel";
    if (is_dir($t) && !is_link($t)) continue;            // a folder took its place - leave it in the trash
    if (!is_dir(dirname($t))) @mkdir(dirname($t), 0777, true);
    if (@rename("$from/$rel", $t)) $n++;
  }
  exec('find ' . escapeshellarg($from) . ' -depth -type d -empty -delete 2>/dev/null');
  return $n;
}

function uc_json($data, int $code = 200): never {
  http_response_code($code);
  header('Content-Type: application/json');
  echo json_encode($data, JSON_UNESCAPED_SLASHES | JSON_INVALID_UTF8_SUBSTITUTE);
  exit;
}

function uc_job_file(string $id): string {
  if (!preg_match('/^[a-z0-9]{6,32}$/', $id)) throw new UcError('Bad job id');
  return UC_JOBS . "/$id.json";
}
function uc_job_read(string $id): ?array {
  $f = uc_job_file($id);
  return is_file($f) ? json_decode(file_get_contents($f), true) : null;
}
/* While unCommander's progress window shows a job, the page "touches" a
 * small .watch file every few seconds. When the job ends, a fresh .watch means
 * someone saw it finish - nothing more to say. A stale one means they pressed
 * "Continue in background", closed the tab or went to another page: then the
 * job gets an alert row on unCommander's page (until dismissed, on every
 * device) and, if enabled, a normal unRAID notification. */
function uc_job_watch_file(string $id): string { return substr(uc_job_file($id), 0, -5) . '.watch'; }
function uc_job_touch(string $id): void { @touch(uc_job_watch_file($id)); }
function uc_job_watched(string $id): bool {
  $f = uc_job_watch_file($id);
  clearstatcache(true, $f);
  return is_file($f) && time() - filemtime($f) <= 15;
}
function uc_job_announce(array &$job): void {
  if (uc_job_watched($job['id'])) { $job['seen'] = true; return; }   // watched to the end: not logged
  $job['alert'] = true;
  if (!uc_settings()['notify_unraid']) return;
  $took = max(0, ($job['finished'] ?? time()) - ($job['started'] ?? $job['created'] ?? time()));
  $failed = $job['state'] === 'failed';
  $verb = ['copy' => 'Copy', 'move' => 'Move', 'perms' => 'Permissions change'][$job['type']] ?? 'Job';
  $what = ['done' => 'finished', 'failed' => 'FAILED', 'cancelled' => 'cancelled'][$job['state']] ?? $job['state'];
  $bits = [$job['label'] ?? $verb];
  if (!empty($job['files'])) $bits[] = number_format($job['files']) . ' files';
  if (!empty($job['bytes'])) $bits[] = uc_human_bytes((int)$job['bytes']);
  $bits[] = 'took ' . uc_human_time($took);
  $desc = implode(' - ', $bits) . ($job['error'] ? '. ' . $job['error'] : '');
  $desc = str_replace('→', 'to', $desc);
  $notify = '/usr/local/emhttp/webGui/scripts/notify';
  if (is_executable($notify))
    exec(implode(' ', array_map('escapeshellarg', [$notify, '-e', 'unCommander', '-s', "unCommander: $verb $what", '-d', $desc,
      '-i', $failed ? 'alert' : ($job['state'] === 'cancelled' ? 'warning' : 'normal'), '-l', '/UnCommander'])) . ' >/dev/null 2>&1');
}
function uc_human_bytes(int $n): string {
  $u = ['B', 'KB', 'MB', 'GB', 'TB', 'PB']; $i = 0; $v = $n;
  while ($v >= 1000 && $i < count($u) - 1) { $v /= 1000; $i++; }
  return ($i ? number_format($v, $v < 10 ? 1 : 0) : $v) . ' ' . $u[$i];
}
function uc_human_time(int $s): string {
  if ($s < 60) return "$s s";
  if ($s < 3600) return intdiv($s, 60) . ' min' . ($s % 60 && $s < 600 ? ' ' . ($s % 60) . ' s' : '');
  return intdiv($s, 3600) . ' h ' . intdiv($s % 3600, 60) . ' min';
}

function uc_job_forget(string $id): void {
  $b = substr(uc_job_file($id), 0, -5);
  foreach (['.json', '.log', '.watch'] as $x) @unlink($b . $x);
}

function uc_job_write(array $job): void {
  @mkdir(UC_JOBS, 0700, true);
  $f = uc_job_file($job['id']);
  file_put_contents("$f.tmp", json_encode($job, JSON_UNESCAPED_SLASHES));
  rename("$f.tmp", $f);
}

/* Auto-refresh: a fingerprint of each folder's last-changed time. One
 * find -maxdepth 0 stats the folders themselves - nothing is listed. A share
 * folder (/mnt/user/...) is checked on every disk/pool that holds it, as a
 * file added on disk2 doesn't change the time the share shows. */
function uc_watch_sigs(array $paths): array {
  $out = []; $who = [];
  foreach ($paths as $want) {
    $out[$want] = '';
    try { $dir = $want === '/' || $want === '' ? '/mnt' : uc_path($want); } catch (Throwable $e) { continue; }
    $list = [$dir];
    if (preg_match('#^/mnt/(user0?)(/.*)?$#', $dir, $m))
      foreach (uc_array_mounts() as $d) if ($m[1] === 'user' || str_starts_with($d, 'disk')) $list[] = "/mnt/$d" . ($m[2] ?? '');
    foreach ($list as $x) $who[$x][] = $want;
  }
  if ($who) {
    $raw = (string)shell_exec('find -H ' . implode(' ', array_map('escapeshellarg', array_keys($who))) . ' -maxdepth 0 -printf ' . escapeshellarg('%p\t%T@\0') . ' 2>/dev/null');
    foreach (explode("\0", $raw) as $rec) {
      $t = strrpos($rec, "\t"); if ($t === false) continue;
      $p = substr($rec, 0, $t);
      foreach ($who[$p] ?? [] as $want) $out[$want] .= "$p=" . substr($rec, $t + 1) . ';';
    }
  }
  foreach ($out as $k => $v) $out[$k] = $v === '' ? 'gone' : md5($v);
  return $out;
}

/* ---------- TV shows: TVmaze (no key needed) ----------
 * TVmaze allows about 20 requests per 10 seconds, so every call is spaced at
 * least 0.6 s apart, and a "slow down" (429) waits and tries again - 10 s,
 * then 20 s, then 40 s - instead of giving up on the show. */
function uc_tvmaze_base(): string { return rtrim(getenv('UC_TVMAZE') ?: 'https://api.tvmaze.com', '/'); }
/* GET a TVmaze path. Returns the decoded JSON, null for "not found", and throws
 * a UcError if TVmaze can't be reached. */
function uc_tvmaze_get(string $path) {
  static $last = 0.0;
  $wait = 10;
  for ($try = 0; $try < 4; $try++) {
    $gap = 0.6 - (microtime(true) - $last);
    if ($gap > 0) usleep((int)($gap * 1e6));
    $last = microtime(true);
    $ch = curl_init(uc_tvmaze_base() . '/' . ltrim($path, '/'));
    curl_setopt_array($ch, [CURLOPT_RETURNTRANSFER => true, CURLOPT_FOLLOWLOCATION => true, CURLOPT_MAXREDIRS => 3,
      CURLOPT_CONNECTTIMEOUT => 8, CURLOPT_TIMEOUT => 30, CURLOPT_USERAGENT => 'unCommander (Unraid plugin)',
      CURLOPT_HTTPHEADER => ['Accept: application/json']]);
    $raw = curl_exec($ch); $code = (int)curl_getinfo($ch, CURLINFO_HTTP_CODE); $err = curl_error($ch);
    curl_close($ch);
    if ($raw === false) throw new UcError("Can't reach TVmaze ($err)");
    if ($code === 429) { sleep($wait); $wait *= 2; continue; }
    if ($code === 404) return null;
    if ($code >= 400) throw new UcError("TVmaze answered with error $code");
    return json_decode((string)$raw, true);
  }
  throw new UcError('TVmaze is busy (too many requests) - try again in a few minutes');
}
/* A show and its regular episodes (no specials), cached in memory (/tmp):
 * ended shows for 30 days, running ones for 12 hours. */
function uc_tv_show(int $id, bool $cachedOnly = false): ?array {
  $dir = UC_STATE . '/tvmaze'; @mkdir($dir, 0700, true);
  $f = "$dir/$id.json";
  $c = is_file($f) ? json_decode((string)@file_get_contents($f), true) : null;
  if ($c && time() - ($c['fetched'] ?? 0) < (($c['show']['status'] ?? '') === 'Ended' ? 30 * 86400 : 12 * 3600)) return $c;
  if ($cachedOnly) return $c;
  $j = uc_tvmaze_get("shows/$id?embed=episodes");
  if (!$j) return null;
  $eps = [];
  foreach ((array)($j['_embedded']['episodes'] ?? []) as $e) {
    if (($e['type'] ?? 'regular') !== 'regular' || !isset($e['season'], $e['number']) || (int)$e['season'] < 1) continue;
    $eps[] = [(int)$e['season'], (int)$e['number'], (string)($e['airdate'] ?? ''), mb_substr((string)($e['name'] ?? ''), 0, 120)];
  }
  $c = ['fetched' => time(), 'show' => uc_tv_brief($j), 'eps' => $eps];
  file_put_contents("$f.tmp", json_encode($c, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE | JSON_INVALID_UTF8_SUBSTITUTE)); rename("$f.tmp", $f);
  return $c;
}
/* Sonarr's numbering (TheTVDB order) for a show, from Sonarr's own listings
 * service - no key needed. Only asked for when your files don't line up with
 * TVmaze (a season released in two halves, "parts", DVD order...), because
 * Sonarr is the one that will name and fetch the files. Cached like TVmaze's.
 * Returns [[season, episode, airdate, title], ...] or null. Never throws. */
function uc_skyhook_base(): string { return rtrim(getenv('UC_SKYHOOK') ?: 'https://skyhook.sonarr.tv/v1/tvdb/shows/en', '/'); }
function uc_tv_sonarr_eps(int $tvdb, bool $ended = false): ?array {
  static $down = false;   // unreachable once: don't wait on it again for every show
  if ($tvdb < 1) return null;
  $dir = UC_STATE . '/tvmaze'; @mkdir($dir, 0700, true);
  $f = "$dir/sonarr-$tvdb.json";
  $c = is_file($f) ? json_decode((string)@file_get_contents($f), true) : null;
  if ($c && time() - ($c['fetched'] ?? 0) < ($ended ? 30 * 86400 : 12 * 3600)) return $c['eps'] ?: null;
  if ($down) return $c['eps'] ?? null;
  $ch = curl_init(uc_skyhook_base() . "/$tvdb");
  curl_setopt_array($ch, [CURLOPT_RETURNTRANSFER => true, CURLOPT_FOLLOWLOCATION => true, CURLOPT_MAXREDIRS => 3,
    CURLOPT_CONNECTTIMEOUT => 8, CURLOPT_TIMEOUT => 30, CURLOPT_USERAGENT => 'unCommander (Unraid plugin)', CURLOPT_HTTPHEADER => ['Accept: application/json']]);
  $raw = curl_exec($ch); $code = (int)curl_getinfo($ch, CURLINFO_HTTP_CODE); curl_close($ch);
  if ($raw === false || ($code >= 400 && $code !== 404)) { $down = true; return $c['eps'] ?? null; }   // can't ask now: last known answer, if any
  $j = $code === 404 ? [] : (json_decode((string)$raw, true) ?: []);
  $eps = [];
  foreach ((array)($j['episodes'] ?? []) as $e) {
    if (!isset($e['seasonNumber'], $e['episodeNumber']) || (int)$e['seasonNumber'] < 1) continue;
    $eps[] = [(int)$e['seasonNumber'], (int)$e['episodeNumber'], substr((string)($e['airDate'] ?? $e['airDateUtc'] ?? ''), 0, 10), mb_substr((string)($e['title'] ?? ''), 0, 120)];
  }
  usort($eps, fn($a, $b) => [$a[0], $a[1]] <=> [$b[0], $b[1]]);
  file_put_contents("$f.tmp", json_encode(['fetched' => time(), 'eps' => $eps], JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE | JSON_INVALID_UTF8_SUBSTITUTE)); rename("$f.tmp", $f);
  return $eps ?: null;
}
/* How badly a folder's episode numbers fit an episode list: files the list doesn't
 * have, and aired episodes (3+ days ago) the folder doesn't have. */
function uc_tv_misfit(array $have, array $eps): array {
  $cut = date('Y-m-d', time() - 3 * 86400); $known = []; $miss = 0;
  foreach ($eps as $ep) { $known["{$ep[0]}.{$ep[1]}"] = true; if ($ep[2] !== '' && $ep[2] <= $cut && !isset($have["{$ep[0]}.{$ep[1]}"])) $miss++; }
  $unk = 0; foreach ($have as $k => $_) if (!isset($known[$k])) $unk++;
  return [$unk, $miss];
}
/* A scanned show whose files don't line up with TVmaze: check them against
 * Sonarr's numbering, and use that list when it fits better. */
function uc_tv_try_sonarr_order(array &$row): bool {
  if (empty($row['show']) || empty($row['eps']) || !empty($row['order']) || empty($row['show']['tvdb'])) return false;
  $have = array_fill_keys(array_map('strval', (array)($row['have'] ?? [])), true);
  [$u, $m] = uc_tv_misfit($have, $row['eps']);
  if ($u < 2 || $m < 1 || min($u, $m) / max($u, $m) < 0.5) return false;   // same test as "Needs a look" in the browser
  $alt = uc_tv_sonarr_eps((int)$row['show']['tvdb'], ($row['show']['status'] ?? '') === 'Ended');
  if (!$alt) return false;
  [$u2, $m2] = uc_tv_misfit($have, $alt);
  /* only when it really explains the files: (almost) every file is on Sonarr's list,
   * and far fewer episodes are left over than with TVmaze's */
  if ($u2 > max(1, (int)floor(count($have) * 0.05)) || ($u2 + $m2) * 2 > $u + $m) return false;
  $row['eps'] = $alt; $row['order'] = 'sonarr';
  $row['tvmaze_fit'] = [$u, $m];
  return true;
}
/* the few show fields unCommander uses */
function uc_tv_brief(array $j): array {
  return ['id' => (int)($j['id'] ?? 0), 'name' => (string)($j['name'] ?? ''), 'year' => substr((string)($j['premiered'] ?? ''), 0, 4) ?: null,
          'status' => (string)($j['status'] ?? ''), 'type' => (string)($j['type'] ?? ''), 'network' => (string)($j['network']['name'] ?? $j['webChannel']['name'] ?? ''),
          'poster' => $j['image']['medium'] ?? null, 'url' => (string)($j['url'] ?? ''), 'tvdb' => $j['externals']['thetvdb'] ?? null, 'imdb' => $j['externals']['imdb'] ?? null,
          'rating' => isset($j['rating']['average']) ? (float)$j['rating']['average'] : null, 'genres' => array_slice((array)($j['genres'] ?? []), 0, 4),
          'ended' => (string)($j['ended'] ?? ''),
          'summary' => mb_substr(trim(html_entity_decode(strip_tags((string)($j['summary'] ?? '')), ENT_QUOTES, 'UTF-8')), 0, 400)];
}
/* TVmaze show search -> short candidate list */
function uc_tv_search(string $q): array {
  $out = [];
  /* folder names can't hold ":" so it's often a "-" ("Star Trek- Picard"); a dash
   * can also upset the search - search on the words only */
  $q = trim(preg_replace('/\s+/', ' ', preg_replace('/\s*[-–—:|\/]+\s*/u', ' ', $q)));
  foreach ((array)uc_tvmaze_get('search/shows?q=' . rawurlencode($q)) as $hit) if (!empty($hit['show']['id'])) $out[] = uc_tv_brief($hit['show']) + ['score' => $hit['score'] ?? 0];
  return $out;
}
/* "The Office (US)" / "The.Office" / "Office, The" -> "office us" - for comparing titles */
function uc_tv_norm(string $t): string {
  $t = preg_replace('/,\s*(the|a|an)\s*$/i', '', trim($t));
  $t = str_replace('&', ' and ', mb_strtolower($t));
  $t = implode(' ', array_map('uc_fold', preg_split('/[^\p{L}\p{N}]+/u', $t, -1, PREG_SPLIT_NO_EMPTY)));
  $t = preg_replace('/,\s*the$/', '', $t);
  $t = preg_replace('/[^a-z0-9]+/', ' ', $t);
  $t = preg_replace('/^(the|a|an) /', '', trim($t));
  return trim($t);
}
/* Which show each folder is (found automatically or picked by you), and your
 * choices per show (ignore it, ignore seasons, mark complete). Small files on
 * the flash drive, written only when something changes. */
function uc_tv_store(string $what, ?array $set = null): array {
  $f = dirname(UC_CFG) . '/tv-' . $what . '.json';
  if ($set !== null) { @mkdir(dirname($f), 0777, true); file_put_contents("$f.tmp", json_encode($set, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE)); rename("$f.tmp", $f); return $set; }
  return is_file($f) ? (json_decode((string)file_get_contents($f), true) ?: []) : [];
}
