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

/* ---------- inside an archive, like a folder (read-only) ----------
 * A path that runs into an archive file - /mnt/user/x/photos.zip/2019/a.jpg - is the archive
 * /mnt/user/x/photos.zip and the path inside it, 2019/a.jpg. The archive is read once (arcindex.php)
 * into RAM; a file inside is pulled out to RAM only when it's looked at or played. Nothing in the
 * archive is ever changed: copying out is an Extract of just those items. */
define('UC_ARC_DIR', UC_STATE . '/arc');
define('UC_ARCX_DIR', UC_STATE . '/arcx');
const UC_ARC_BUCKETS = 16;
const UC_ARC_MAXFILE = 2147483648;            // a file bigger than this is copied out, not opened from RAM
function uc_arc_bucket(string $rel): int { return hexdec(substr(md5($rel), 0, 4)) % UC_ARC_BUCKETS; }
/* [archive, path inside] - or null when the path isn't inside an archive */
function uc_arc_split(string $p): ?array {
  if (is_dir($p)) return null;
  if (is_file($p)) return uc_archive_kind($p) ? [$p, ''] : null;
  $inner = [];
  for ($q = $p; $q !== '/' && $q !== '' && $q !== '.'; $q = dirname($q)) {
    if (is_dir($q)) return null;
    if (is_file($q)) return uc_archive_kind($q) && $inner ? [$q, implode('/', array_reverse($inner))] : null;
    $inner[] = basename($q);
  }
  return null;
}
function uc_arc_key(string $a): string { $s = @stat($a); return md5($a . '|' . ($s['size'] ?? 0) . '|' . ($s['mtime'] ?? 0)); }
/* the archive's reading: started when needed; waits up to $wait seconds for it to finish */
function uc_arc_index(string $a, float $wait = 0): array {
  $key = uc_arc_key($a); $dir = UC_ARC_DIR . "/$key"; $f = "$dir/state.json";
  $st = json_decode((string)@file_get_contents($f), true);
  $dead = $st && ($st['state'] ?? '') === 'running' && !empty($st['pid']) && !@posix_kill((int)$st['pid'], 0) && time() - (int)@filemtime($f) > 5;
  if (!$st || $dead) {
    uc_arc_tidy();
    @mkdir($dir, 0700, true);
    $st = ['file' => $a, 'state' => 'queued', 'entries' => 0, 'started' => time()];
    file_put_contents($f, json_encode($st, JSON_UNESCAPED_SLASHES));
    $php = PHP_BINARY && !str_contains(PHP_BINARY, 'fpm') ? PHP_BINARY : 'php';
    $io = is_executable('/usr/bin/ionice') ? '/usr/bin/ionice -c2 -n7 ' : '';
    exec('setsid nohup nice -n 5 ' . $io . escapeshellarg($php) . ' -d memory_limit=2048M ' . escapeshellarg(__DIR__ . '/arcindex.php') . ' ' . $key . ' >/dev/null 2>&1 &');
  }
  $end = microtime(true) + $wait;
  while (in_array($st['state'] ?? '', ['queued', 'running'], true) && microtime(true) < $end) {
    usleep(150000); $st = json_decode((string)@file_get_contents($f), true) ?: $st;
  }
  @touch($f);
  return $st + ['key' => $key];
}
/* a folder inside the archive: [[name, isDir, size, mtime, raw?], ...], or null if there's no such folder */
function uc_arc_rows(string $key, string $inner): ?array {
  $h = @fopen(UC_ARC_DIR . "/$key/b" . sprintf('%02x', uc_arc_bucket($inner)), 'r'); if (!$h) return null;
  $needle = '[' . json_encode($inner, JSON_UNESCAPED_SLASHES | JSON_INVALID_UTF8_SUBSTITUTE) . ',';
  while (($line = fgets($h)) !== false) if (str_starts_with($line, $needle)) { fclose($h); $j = json_decode($line, true); return is_array($j) ? $j[1] : []; }
  fclose($h); return null;
}
/* one item inside: [name, isDir, size, mtime, raw?] or null */
function uc_arc_item(string $key, string $inner): ?array {
  $i = strrpos($inner, '/'); $par = $i === false ? '' : substr($inner, 0, $i); $n = $i === false ? $inner : substr($inner, $i + 1);
  foreach (uc_arc_rows($key, $par) ?? [] as $r) if ((string)$r[0] === $n) return $r;
  return null;
}
/* every file below a folder inside (for copying out): [raw names], [empty folders inside] */
function uc_arc_walk(string $key, string $inner, array &$files, array &$dirs, int $cap = 500000): void {
  $rows = uc_arc_rows($key, $inner) ?? [];
  if (!$rows) $dirs[] = $inner;
  foreach ($rows as $r) {
    if (count($files) >= $cap) throw new UcError('That is more than ' . number_format($cap) . ' files - extract the whole archive instead');
    $p = $inner === '' ? (string)$r[0] : "$inner/{$r[0]}";
    if ($r[1]) uc_arc_walk($key, $p, $files, $dirs, $cap); else $files[] = $r[4] ?? $p;
  }
}
function uc_arc_pw(string $key): string { $f = UC_ARC_DIR . "/$key.pw"; return is_file($f) ? trim((string)file_get_contents($f)) : ''; }
function uc_arc_set_pw(string $a, string $pw): void {
  $key = uc_arc_key($a); @mkdir(UC_ARC_DIR, 0700, true);
  file_put_contents(UC_ARC_DIR . "/$key.pw", $pw); @chmod(UC_ARC_DIR . "/$key.pw", 0600);
  /* read it again with the password */
  @unlink(UC_ARC_DIR . "/$key/state.json");
}
/* a file inside the archive, pulled out into RAM so the viewer and players can read it. A path that isn't
 * inside an archive comes back as it is. */
function uc_arc_real(string $p): string {
  $sp = uc_arc_split($p); if (!$sp || $sp[1] === '') return $p;
  [$a, $inner] = $sp;
  $st = uc_arc_index($a, 20);
  if (($st['state'] ?? '') === 'password') throw new UcError('This archive needs its password');
  if (($st['state'] ?? '') !== 'ready') throw new UcError($st['error'] ?? 'The archive is still being read - try again in a moment');
  $it = uc_arc_item($st['key'], $inner);
  if (!$it) throw new UcError(basename($inner) . " isn't in the archive");
  if ($it[1]) return $p;                                           // a folder: nothing to pull out
  if ((int)$it[2] > UC_ARC_MAXFILE) throw new UcError(basename($inner) . ' is too big to open from inside the archive - copy it out first (F5)');
  $out = UC_ARCX_DIR . '/' . $st['key'] . '/' . $inner;
  if (is_file($out) && filesize($out) === (int)$it[2]) { @touch($out); return $out; }
  uc_arcx_tidy((int)$it[2]);
  $tmp = UC_ARCX_DIR . '/' . $st['key'] . '/.x' . bin2hex(random_bytes(4));
  @mkdir($tmp, 0700, true);
  $raw = $it[4] ?? $inner;
  if (uc_archive_kind($a) === 'tar') {
    exec('tar -x --no-same-owner -f ' . escapeshellarg($a) . ' -C ' . escapeshellarg($tmp) . ' -- ' . escapeshellarg($raw) . ' 2>&1', $o, $rc);
  } else {
    $pw = uc_arc_pw($st['key']);
    exec(escapeshellarg(UC_7Z) . ' x -y -spd -bso0 -bsp0 ' . escapeshellarg('-p' . ($pw !== '' ? $pw : 'UCNOPASS')) . ' ' . escapeshellarg('-o' . $tmp) . ' -- ' . escapeshellarg($a) . ' ' . escapeshellarg($raw) . ' 2>&1 </dev/null', $o, $rc);
  }
  $got = "$tmp/" . trim(preg_replace('#^(\./)+#', '', $raw), '/');
  if (!is_file($got) || filesize($got) !== (int)$it[2] || ($rc ?? 0) > 1) {
    exec('rm -rf ' . escapeshellarg($tmp));
    $msg = trim(implode(' ', $o ?? []));
    if (preg_match('/password|encrypted/i', $msg)) throw new UcError('This archive needs its password');
    throw new UcError("Could not get " . basename($inner) . " out of the archive" . ($msg !== '' ? ": " . mb_substr($msg, 0, 200) : ''));
  }
  @mkdir(dirname($out), 0700, true);
  rename($got, $out);
  exec('rm -rf ' . escapeshellarg($tmp));
  return $out;
}
/* RAM is kept small: files pulled out go after two hours, and the oldest go first past 4 GB */
function uc_arcx_tidy(int $need = 0): void {
  if (!is_dir(UC_ARCX_DIR)) return;
  $all = [];
  $it = new RecursiveIteratorIterator(new RecursiveDirectoryIterator(UC_ARCX_DIR, FilesystemIterator::SKIP_DOTS));
  foreach ($it as $f) if ($f->isFile()) $all[] = [$f->getPathname(), $f->getMTime(), $f->getSize()];
  usort($all, fn($x, $y) => $x[1] <=> $y[1]);
  $sum = array_sum(array_column($all, 2));
  foreach ($all as [$f, $m, $s]) if (time() - $m > 7200 || $sum + $need > 4294967296) { @unlink($f); $sum -= $s; }
}
/* archive readings not used for a day go */
function uc_arc_tidy(): void {
  foreach (glob(UC_ARC_DIR . '/*/state.json') ?: [] as $f) if (time() - (int)@filemtime($f) > 86400) { $d = dirname($f); exec('rm -rf ' . escapeshellarg($d)); @unlink("$d.pw"); exec('rm -rf ' . escapeshellarg(UC_ARCX_DIR . '/' . basename($d))); }
}

function uc_archive_base(string $p): string {
  return preg_replace('/(\.part0*1)?\.(tar\.gz|tar\.bz2|tar\.xz|tar\.zst|tgz|tbz2?|txz|tzst|tar|zip|rar|7z|gz|bz2|xz|zst|iso|cab|arj|lzh|z)$/i', '', basename($p)) ?: basename($p);
}

/* The starting "Your own CSS" (Settings > Look & sound): every rule labelled, so it can be tweaked */
const UC_DEFAULT_CSS = <<<'CSS'
/* Your own CSS - it's applied after unCommander's own, so it wins.
   Colours are easier in Settings > Look & sound > Colours; this box is
   for anything else. A few examples (take away the comment marks to use one):

#uc { --accent: #008cb4; }                          accent colour
#uc .uc-row .col-size.gb { font-weight: 400; }      sizes of 1 GB and more not in bold
#uc .uc-pane.active .uc-box { background: none; }   no tint on the active pane
*/
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
  $d = ['TRASH_DAYS' => '7'];
  if (is_file(UC_CFG)) $d = array_merge($d, parse_ini_file(UC_CFG) ?: []);
  return $d;
}

/* User settings (shortcuts, custom CSS, sounds) merged over defaults. */
/* Settings > General > Music player: the folders playlists are kept in */
function uc_pldirs_clean($a): array {
  $out = [];
  foreach (is_array($a) ? $a : preg_split('/\r?\n/', (string)$a) as $d) {
    $d = rtrim(trim((string)$d), '/');
    if ($d === '' || $d[0] !== '/' || str_contains($d, "\0") || preg_match('#(^|/)\.\.(/|$)#', $d)) continue;
    if (!in_array($d, $out, true)) $out[] = $d;
  }
  return array_slice($out, 0, 10);
}
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
    'trash_days' => (int)(uc_cfg()['TRASH_DAYS'] ?? 7),
    'tap_mode'   => in_array($s['tap_mode'] ?? 'auto', ['always', 'never'], true) ? $s['tap_mode'] : 'auto',
    'menu_name'  => uc_clean_menu_name($s['menu_name'] ?? ''),
    'practice'   => !empty($s['practice']),
    'sysmode'    => !empty($s['sysmode']),
    'collect'    => !empty($s['collect']),       // Copy/Cut add to a list from several folders (Settings > Safety)
    'tree'       => !empty($s['tree']),          // a caret opens folders in place (Settings > General)
    'palette'    => array_key_exists('palette', $s) ? uc_palette_clean($s['palette']) : (is_file($f) ? uc_palette_clean(null) : UC_PAL_DEFAULT),   // Settings > Colours (new installs: unRAID orange; upgrades from before colours keep the blue they had)
    'mythemes'   => array_values(array_filter(array_map(fn($t) => is_array($t) && trim((string)($t['name'] ?? '')) !== '' ? ['name' => mb_substr(trim((string)$t['name']), 0, 40)] + uc_palette_clean($t) : null, is_array($s['mythemes'] ?? null) ? array_slice($s['mythemes'], 0, 30) : []))),
    'menu_show'  => !array_key_exists('menu_show', $s) || !empty($s['menu_show']),   // the entry in unRAID's top menu bar
    'vplay'      => !array_key_exists('vplay', $s) || !empty($s['vplay']),       // Play any video (ffmpeg, fetched the first time a video needs it)
    'vsmooth'    => !array_key_exists('vsmooth', $s) || !empty($s['vsmooth']),   // videos always through ffmpeg (smoother from the array)
    'vconv'      => in_array($s['vconv'] ?? 'auto', ['auto', 'off', 'cpu', 'nvidia', 'vaapi'], true) ? ($s['vconv'] ?? 'auto') : 'auto',   // convert the picture: automatic = the graphics when they work
    'toolbtns'   => ['movies' => ($s['toolbtns']['movies'] ?? true) !== false, 'tv' => ($s['toolbtns']['tv'] ?? true) !== false, 'tools' => ($s['toolbtns']['tools'] ?? true) !== false],
    'highlight'  => !array_key_exists('highlight', $s) || !empty($s['highlight']),   // on unless switched off
    'radarr'     => uc_radarr_public($s['radarr'] ?? []),
    'sonarr'     => uc_sonarr_public($s['sonarr'] ?? []),
    'lidarr'     => uc_lidarr_public($s['lidarr'] ?? []),
    'autorefresh' => ['on' => !empty($s['autorefresh']['on']), 'secs' => in_array((int)($s['autorefresh']['secs'] ?? 10), [5, 10, 30, 60], true) ? (int)($s['autorefresh']['secs'] ?? 10) : 10],   // off unless switched on
    'trash'      => !array_key_exists('trash', $s) || !empty($s['trash']),   // on unless switched off
    'notify_unraid' => !array_key_exists('notify_unraid', $s) || !empty($s['notify_unraid']),
    'player'     => !array_key_exists('player', $s) || !empty($s['player']),
    'uscripts'   => uc_us_clean($s['uscripts'] ?? null),      // the User Scripts button: which scripts, in which order (null = all)
    'us'         => is_dir(UC_US_DIR),
    'first'      => !is_file($f),                            // a new install: the setup window asks where unCommander's folder goes
    'array'      => uc_array_up(),
    'data_dir'   => uc_hist_dir(),
    'hist_dir'   => (string)($s['hist_dir'] ?? ''),           // Settings > Trash & History: where History is kept (empty = appdata)   // the music player at the bottom (Settings > General)
    'pldirs'     => uc_pldirs_clean($s['pldirs'] ?? []),
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
function uc_apply_menu_name(string $name, bool $show = true): bool {
  $page = UC_DIR . '/UnCommander.page';
  if (!is_file($page)) return false;
  $s = file_get_contents($page);
  $n = preg_replace('/^Name=".*"$/m', 'Name="' . uc_clean_menu_name($name) . '"', $s, 1);
  /* off: the page stays (Settings > User Utilities and the own-tab still open it), only the top-menu entry goes */
  $n = preg_replace('/^Menu=".*"$/m', 'Menu="' . ($show ? 'Tasks:95' : 'UnCommanderHidden') . '"', $n, 1);
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
  if (str_starts_with($norm, UC_ARCX_DIR . '/')) return $norm;      // a file pulled out of an archive to be looked at
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
 * for good. Returns [count, bins, items] - items says, per path, which trash
 * folder it went to or why it's gone for good (for History). Used by Delete
 * and by "delete the originals" after compressing or extracting. */
function uc_delete_paths(array $paths, bool $forever = false, ?array &$items = null): array {
  $n = 0; $bins = []; $items = [];
  $trashOn = uc_settings()['trash'];
  $useTrash = $trashOn && !$forever;
  $stamp = date('Ymd-His');
  $gone = function ($p, $why) use (&$n, &$items) {
    exec('rm -rf -- ' . escapeshellarg($p), $o, $rc);
    if ($rc) throw new UcError('Could not delete ' . basename($p));
    $items[] = ['t' => 'gone', 'p' => $p, 'gone' => $why];
    $n++;
  };
  foreach ($paths as $p) {
    if (!$useTrash || str_contains($p, '/' . UC_TRASH . '/') || basename($p) === UC_TRASH) {
      $gone($p, $forever ? 'deleted for good (it skipped the trash)' : (!$trashOn ? 'deleted for good - the trash was switched off' : 'deleted from the trash, so it is gone for good'));
      continue;
    }
    try { $root = uc_trash_root($p); }
    catch (UcError $e) {     /* system folders (/etc, /var, /tmp...) have no trash: removed for good */
      $gone($p, 'outside /mnt and /boot there is no trash, so it is gone for good');
      continue;
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
    $items[] = ['t' => 'trash', 'p' => $p, 'bin' => $bin];
    $n++;
  }
  return [$n, $bins, $items];
}

/* ---------- ffmpeg (optional): plays any video by converting it on the fly ----------
 * Jellyfin's ffmpeg build (8.1.3, "portable", one program that also knows how
 * to use NVIDIA and Intel/AMD graphics), downloaded only when switched on in
 * Settings, checked by sha256 and kept on the flash drive. It's unpacked into
 * the plugin folder (RAM) the first time a video needs it after a reboot. */
define('UC_FF_URL', 'https://github.com/jellyfin/jellyfin-ffmpeg/releases/download/v8.1.3-1/jellyfin-ffmpeg_8.1.3-1_portable_linux64-gpl.tar.xz');
define('UC_FF_SHA', 'b86dc023c64a5a9a410e6e3a938a970460214fae78f31c1553c9f88f1c289b6a');
define('UC_FF_SIZE', 60368340);
define('UC_FF_NAME', 'jellyfin-ffmpeg_8.1.3-1_portable_linux64-gpl.tar.xz');
/* ffmpeg's download lives in unCommander's folder (appdata), not on the flash drive - one moved over from
 * the flash drive by an earlier version. null while that folder isn't there (array stopped). */
function uc_ff_gz(): ?string {
  $d = uc_data_dir(); if (!$d) return null;
  @mkdir("$d/ffmpeg", 0777, true);
  $gz = "$d/ffmpeg/" . UC_FF_NAME; $old = dirname(UC_CFG) . '/' . UC_FF_NAME;
  if (is_file($old)) {
    if (!is_file($gz) && filesize($old) === UC_FF_SIZE && @copy($old, "$gz.tmp") && hash_file('sha256', "$gz.tmp") === UC_FF_SHA) @rename("$gz.tmp", $gz);
    @unlink("$gz.tmp"); if (is_file($gz)) @unlink($old);
  }
  return $gz;
}
define('UC_FF_BIN', UC_DIR . '/bin/ffmpeg');
function uc_ffmpeg(): ?string {
  if (is_file(UC_FF_BIN) && is_executable(UC_FF_BIN)) return UC_FF_BIN;
  $gzf = uc_ff_gz();
  if (!$gzf || !is_file($gzf) || filesize($gzf) !== UC_FF_SIZE) return null;
  @mkdir(UC_STATE, 0700, true);
  $l = fopen(UC_STATE . '/ffmpeg.lock', 'c'); flock($l, LOCK_EX);
  if (!is_file(UC_FF_BIN)) {
    if (hash_file('sha256', $gzf) !== UC_FF_SHA) { flock($l, LOCK_UN); return null; }
    @mkdir(dirname(UC_FF_BIN), 0755, true);
    $t = escapeshellarg(UC_FF_BIN . '.tmp');
    exec('tar -xJf ' . escapeshellarg($gzf) . " -O ffmpeg > $t && chmod 755 $t && mv $t " . escapeshellarg(UC_FF_BIN), $o, $rc);
    if ($rc) @unlink(UC_FF_BIN . '.tmp');
  }
  flock($l, LOCK_UN);
  return is_executable(UC_FF_BIN) ? UC_FF_BIN : null;
}
/* A /mnt/user file that lives on one disk: read it straight from that disk.
 * Skipping the share layer (shfs) is what makes array videos play smoothly. */
function uc_direct(string $p): string {
  if (!preg_match('#^/mnt/user/(.+)$#', $p, $m)) return $p;
  $d = uc_locate([$p])[0] ?? [];
  return count($d) === 1 && is_file("/mnt/{$d[0]}/{$m[1]}") ? "/mnt/{$d[0]}/{$m[1]}" : $p;
}
/* ffmpeg: ready, being downloaded, failed, or not there yet */
function uc_ff_state(): string {
  if (is_file(UC_FF_BIN)) return 'ready';
  $gzf = uc_ff_gz(); if (!$gzf) return 'noarray';
  $part = $gzf . '.part';
  return is_file($gzf) && filesize($gzf) === UC_FF_SIZE ? 'ready'
    : (is_file($part) && filemtime($part) > time() - 60 ? 'downloading' : (is_file(UC_STATE . '/ffmpeg.err') ? 'error' : 'none'));
}
/* Fetch ffmpeg in the background (once): checked against its checksum, kept in unCommander's folder */
function uc_ff_start(): void {
  if (in_array(uc_ff_state(), ['ready', 'downloading', 'noarray'], true)) return;
  $gzf = uc_ff_gz();
  @mkdir(UC_STATE, 0700, true);
  @unlink(UC_STATE . '/ffmpeg.err');
  foreach (glob(dirname(UC_CFG) . '/ffmpeg-*-linux-x64.gz') ?: [] as $old) @unlink($old);     // the first, smaller build (beta 14)
  @unlink(UC_FF_BIN);
  $gz = escapeshellarg($gzf); $part = escapeshellarg($gzf . '.part'); $err = escapeshellarg(UC_STATE . '/ffmpeg.err');
  $sh = "curl -fsSL --max-time 900 -o $part " . escapeshellarg(UC_FF_URL) . " && echo " . escapeshellarg(UC_FF_SHA . '  ' . $gzf . '.part') . " | sha256sum -c --status && mv $part $gz || { rm -f $part; echo 'The download failed or did not match its checksum - is the server online?' > $err; }";
  exec('setsid nohup bash -c ' . escapeshellarg($sh) . ' >/dev/null 2>&1 &');
  touch($gzf . '.part');           // counts as downloading from now on
}
/* A 2-second test picture made with the CPU, NVIDIA or Intel/AMD graphics: does it work here? */
function uc_gpu_try(string $mode): array {
  $ff = uc_ffmpeg(); if (!$ff) return ['ok' => false, 'error' => 'no ffmpeg', 'secs' => 0];
  $src = '-f lavfi -i testsrc2=size=1280x720:rate=25 -t 2';
  $cmd = ['cpu' => "$src -vf format=yuv420p -c:v libx264 -preset veryfast",
          'nvidia' => "-init_hw_device cuda=gpu -filter_hw_device gpu $src -vf format=yuv420p,hwupload -c:v h264_nvenc",
          'vaapi' => '-vaapi_device ' . escapeshellarg(array_column(uc_gpus(), 'dev', 'id')['vaapi'] ?? '/dev/dri/renderD128') . " $src -vf format=nv12,hwupload -c:v h264_vaapi"][$mode] ?? null;
  if (!$cmd) return ['ok' => false, 'error' => 'Unknown choice', 'secs' => 0];
  $t = microtime(true);
  exec('timeout 30 ' . escapeshellarg($ff) . " -hide_banner -loglevel error -nostdin $cmd -f null - 2>&1", $out, $rc);
  return ['ok' => $rc === 0, 'secs' => round(microtime(true) - $t, 1), 'error' => $rc ? trim(implode(' ', array_slice($out, -3))) ?: "ffmpeg stopped (code $rc)" : ''];
}
/* How to convert a picture on this server: the graphics when they work, else the CPU. Found out once
 * per boot (a short test each), kept in RAM. */
function uc_vconv(bool $fresh = false): string {
  $set = uc_settings()['vconv'];
  if (in_array($set, ['cpu', 'nvidia', 'vaapi'], true)) return $set;          // picked in Settings
  $f = UC_STATE . '/vconv';
  if ($fresh) @unlink($f);
  $m = trim((string)@file_get_contents($f));
  if (in_array($m, ['cpu', 'nvidia', 'vaapi'], true)) return $m;
  $m = 'cpu';
  foreach (uc_gpus() as $g) if (uc_gpu_try($g['id'])['ok']) { $m = $g['id']; break; }
  @mkdir(UC_STATE, 0700, true); @file_put_contents($f, $m);
  return $m;
}
/* Graphics this server could convert video with */
function uc_gpus(): array {
  $g = [];
  if (file_exists('/dev/nvidia0') && (is_executable('/usr/bin/nvidia-smi') || is_file('/usr/lib64/libnvidia-encode.so.1') || is_file('/usr/lib/libnvidia-encode.so.1'))) $g[] = ['id' => 'nvidia', 'label' => 'NVIDIA graphics'];
  foreach (glob('/dev/dri/renderD*') ?: [] as $dev) {
    $v = trim((string)@file_get_contents('/sys/class/drm/' . basename($dev) . '/device/vendor'));
    if ($v === '0x8086' || $v === '0x1002') { $g[] = ['id' => 'vaapi', 'dev' => $dev, 'label' => ($v === '0x8086' ? 'Intel' : 'AMD') . ' graphics']; break; }
  }
  return $g;
}
/* What's inside a video: length, the video codec, sound tracks, subtitles
 * (inside it, and .srt/.ass/.vtt files next to it). */
function uc_media_info(string $p): array {
  $ff = uc_ffmpeg();
  $ext = [];
  $stem = pathinfo($p, PATHINFO_FILENAME);
  foreach (glob(dirname($p) . '/*') ?: [] as $f) {
    $b = basename($f);
    if (!preg_match('/\.(srt|ass|ssa|vtt)$/i', $b) || !str_starts_with($b, $stem)) continue;
    $tag = trim(substr(pathinfo($b, PATHINFO_FILENAME), strlen($stem)), " ._-");
    $ext[] = ['path' => $f, 'name' => $b, 'label' => $tag !== '' ? $tag : 'external'];
  }
  if (!$ff) return ['ff' => false, 'ext' => $ext, 'need' => uc_ff_state()];
  exec('timeout 20 ' . escapeshellarg($ff) . ' -hide_banner -i ' . escapeshellarg(uc_direct($p)) . ' 2>&1', $out);
  $dur = 0; $kbps = 0; $video = null; $audio = []; $subs = []; $last = null; $tags = []; $cover = false; $inStream = false;
  foreach ($out as $line) {
    /* the file's own tags (title, artist, album, date) - listed before the first stream */
    if (!$inStream && preg_match('/^\s{4}(title|artist|album_artist|album|date|genre|track|disc|composer)\s*:\s*(.+)$/i', $line, $m)) { $k = strtolower($m[1]); if ($k === 'album_artist') { $tags['albumartist'] = $tags['albumartist'] ?? trim($m[2]); $k = 'artist'; } $tags[$k] = $tags[$k] ?? trim($m[2]); }
    if (!$inStream && preg_match('/Duration: .*bitrate: (\d+) kb\/s/', $line, $m)) $kbps = (int)$m[1];
    if (preg_match('/^\s*Stream #/', $line)) $inStream = true;
    if (preg_match('/Video: .*attached pic|\(attached pic\)/', $line)) $cover = true;
    if (preg_match('/Duration: (\d+):(\d+):([\d.]+)/', $line, $m)) $dur = $m[1] * 3600 + $m[2] * 60 + (float)$m[3];
    if (preg_match('/^\s*Stream #0:(\d+)(?:\[[^\]]*\])?(?:\((\w+)\))?: (Video|Audio|Subtitle): (\w+)(.*)$/', $line, $m)) {
      $last = null;
      if ($m[3] === 'Video' && !$video && !str_contains($m[5], 'attached pic'))
        $video = ['i' => (int)$m[1], 'codec' => $m[4], 'w' => preg_match('/ (\d{2,5})x(\d{2,5})/', $m[5], $s) ? (int)$s[1] : 0, 'h' => $s[2] ?? 0, 'hdr' => (bool)preg_match('/smpte2084|arib-std-b67|bt2020/', $m[5])];
      elseif ($m[3] === 'Audio') { $audio[] = ['i' => (int)$m[1], 'lang' => $m[2] ?? '', 'codec' => $m[4], 'ch' => preg_match('/Hz, ([^,]+)/', $m[5], $c) ? trim($c[1]) : '', 'default' => str_contains($m[5], '(default)'), 'title' => '', 'hz' => preg_match('/(\d+) Hz/', $m[5], $h) ? (int)$h[1] : 0, 'bits' => preg_match('/\((\d+) bit\)|\b[su](16|24|32)p?\b/', $m[5], $b) ? (int)($b[1] ?: $b[2]) : 0]; $last = ['a', count($audio) - 1]; }
      elseif ($m[3] === 'Subtitle') { $subs[] = ['i' => (int)$m[1], 'lang' => $m[2] ?? '', 'codec' => $m[4], 'text' => in_array($m[4], ['subrip', 'ass', 'ssa', 'webvtt', 'mov_text', 'text'], true), 'forced' => str_contains($m[5], '(forced)'), 'default' => str_contains($m[5], '(default)'), 'title' => '']; $last = ['s', count($subs) - 1]; }
    } elseif ($last && preg_match('/^\s+title\s*:\s*(.+)$/', $line, $m)) { if ($last[0] === 'a') $audio[$last[1]]['title'] = trim($m[1]); else $subs[$last[1]]['title'] = trim($m[1]); }
  }
  if (!$cover) foreach (['cover.jpg', 'folder.jpg', 'Cover.jpg', 'Folder.jpg', 'front.jpg', 'cover.png', 'folder.png'] as $n) if (is_file(dirname($p) . "/$n")) { $cover = true; break; }
  return ['ff' => true, 'duration' => $dur, 'video' => $video, 'audio' => $audio, 'subs' => $subs, 'ext' => $ext, 'tags' => $tags, 'cover' => $cover, 'kbps' => $kbps, 'size' => @filesize($p) ?: 0];
}

/* ---------- colours (Settings > Look > Colours) ----------
 * A theme is two sets of colours (light and dark unRAID themes) for a few CSS
 * variables; they're written before the user's own CSS, which still wins. */
const UC_PAL_KEYS = ['accent', 'accent-soft', 'accent-ink', 'cursor', 'cursor-off', 'sel-count', 'ok', 'warn', 'danger',
  /* a theme can also set the backgrounds, text and lines (Norton does) */
  'ground', 'surface', 'surface-2', 'surface-3', 'line', 'line-soft', 'ink', 'ink-2', 'muted', 'pane-active-bg', 'cursor-ink', 'sel-ink',
  /* the F-key buttons at the bottom (when not set: like the other buttons) */
  'fk-bg', 'fk-ink', 'fk-key', 'fk-line', 'fk-danger',
  /* text boxes and path bars, path-bar hover, logo, headings, column titles, the right-click menu */
  'input-bg', 'crumb-hover', 'crumb-hover-ink', 'logo-ink', 'head-ink', 'cols-bg', 'menu-bg', 'menu-line',
  /* inside an archive: the strip under the pane header and the archive in the path bar */
  'arc-bg', 'arc-line'];
/* the colours a new install starts with: the "unRAID orange" theme (same values as THEMES.unraid in the page) */
const UC_PAL_DEFAULT = ['base' => 'unraid',
  'light' => ['accent' => '#c4510a', 'accent-soft' => '#fdeee3', 'accent-ink' => '#ffffff', 'cursor' => '#fff4e8', 'cursor-off' => '#efedeb', 'sel-count' => '#c4510a', 'ok' => '#2e7a3e', 'warn' => '#8a6a00', 'danger' => '#c62828'],
  'dark' => ['accent' => '#ff8c2f', 'accent-soft' => '#3a2414', 'accent-ink' => '#1a0c00', 'cursor' => '#3d2c1c', 'cursor-off' => '#2d2a27', 'sel-count' => '#ff8c2f', 'ok' => '#6cc27e', 'warn' => '#e8c35a', 'danger' => '#ff6b5e']];
function uc_palette_clean($p): array {
  $out = ['base' => is_array($p) && preg_match('/^(my:.{1,40}|[a-z]{1,20})$/u', (string)($p['base'] ?? '')) ? (string)$p['base'] : 'uncommander', 'light' => [], 'dark' => []];
  if (is_array($p) && ($p['always'] ?? '') === 'dark') $out['always'] = 'dark';   // a theme that is always dark (Norton), whatever unRAID's theme
  foreach (['light', 'dark'] as $m) foreach (UC_PAL_KEYS as $k) {
    $v = is_array($p) ? ($p[$m][$k] ?? null) : null;
    if (is_string($v) && preg_match('/^#[0-9a-fA-F]{6}$/', $v)) $out[$m][$k] = strtolower($v);
  }
  return $out;
}
function uc_palette_css(array $p): string {
  $css = '';
  foreach (['light' => '#uc', 'dark' => '#uc.uc-dark'] as $m => $sel) {
    if (empty($p[$m]) || !is_array($p[$m])) continue;
    $css .= $sel . ' { ' . implode(' ', array_map(fn($k, $v) => "--$k: $v;", array_keys($p[$m]), $p[$m])) . " }\n";
    /* text colours for the cursor row and ticked rows, when the theme sets them (Norton: dark on the cyan bar, yellow when ticked) */
    if (!empty($p[$m]['cursor-ink'])) $css .= "$sel .uc-pane.active .uc-list .uc-row.cursor:not(.sel), $sel .uc-pane.active .uc-list .uc-row.cursor:not(.sel) * { color: {$p[$m]['cursor-ink']} !important; }\n";
    if (!empty($p[$m]['sel-ink'])) $css .= "$sel .uc-list .uc-row.sel, $sel .uc-list .uc-row.sel * { color: {$p[$m]['sel-ink']} !important; }\n";
    if (!empty($p[$m]['input-bg'])) $css .= "$sel input:not([type=checkbox]):not([type=radio]):not([type=range]):not([type=color]), $sel select, $sel textarea, $sel .uc-path, $sel .uc-goto, $sel .uc-tabname { background-color: {$p[$m]['input-bg']} !important; }\n";
  }
  return $css;
}

/* A JPG's "which way is up" note (EXIF Orientation, 1-8) without the exif extension. */
function uc_jpeg_orientation(string $p): int {
  $d = @file_get_contents($p, false, null, 0, 131072);
  if ($d === false || strlen($d) < 4 || substr($d, 0, 2) !== "\xFF\xD8") return 1;
  $o = 2;
  while ($o + 4 < strlen($d)) {
    $m = unpack('n', substr($d, $o, 2))[1]; $len = unpack('n', substr($d, $o + 2, 2))[1];
    if ($m === 0xFFE1 && substr($d, $o + 4, 6) === "Exif\0\0") {
      $t = $o + 10; $le = substr($d, $t, 2) === 'II';
      $u16 = fn($at) => unpack($le ? 'v' : 'n', substr($d, $at, 2))[1];
      $u32 = fn($at) => unpack($le ? 'V' : 'N', substr($d, $at, 4))[1];
      $ifd = $t + $u32($t + 4); $n = $u16($ifd);
      for ($i = 0; $i < $n; $i++) { $e = $ifd + 2 + $i * 12; if ($e + 10 > strlen($d)) break; if ($u16($e) === 0x0112) { $v = $u16($e + 8); return $v >= 1 && $v <= 8 ? $v : 1; } }
      return 1;
    }
    if ($m === 0xFFDA || ($m & 0xFF00) !== 0xFF00) break;
    $o += 2 + $len;
  }
  return 1;
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
/* ---------- Lidarr (Tools > Music library check: Missing tracks, No songs) ---------- */
function uc_lidarr_cfg(): array {
  $f = dirname(UC_CFG) . '/settings.json';
  $s = is_file($f) ? (json_decode(file_get_contents($f), true) ?: []) : [];
  return array_merge(['host' => '', 'port' => 8686, 'base' => '', 'key' => '', 'profile' => 0, 'profile_name' => '', 'meta' => 0, 'meta_name' => '', 'map' => []], (array)($s['lidarr'] ?? []));
}
function uc_lidarr_public(array $r): array {
  $r = array_merge(['host' => '', 'port' => 8686, 'base' => '', 'key' => '', 'profile' => 0, 'profile_name' => '', 'meta' => 0, 'meta_name' => '', 'map' => []], $r);
  $r['has_key'] = $r['key'] !== '';
  $r['ok'] = $r['host'] !== '' && $r['has_key'] && $r['profile'] > 0 && $r['meta'] > 0;
  unset($r['key']);
  return $r;
}
function uc_lidarr_clean(array $in, array $old): array {
  $host = trim((string)($in['host'] ?? ''));
  if ($host !== '' && !preg_match('#^(https?://)?[A-Za-z0-9.\-\[\]:]+/?$#', $host)) throw new UcError('Lidarr address should look like 192.168.1.10 or http://tower.local');
  $map = [];
  foreach (array_slice((array)($in['map'] ?? []), 0, 20) as $m) {
    $rp = trim((string)($m['lidarr'] ?? '')); $hp = trim((string)($m['host'] ?? ''));
    if ($rp === '' || $hp === '') continue;
    $map[] = ['lidarr' => rtrim($rp, '/') ?: '/', 'host' => rtrim(uc_path($hp), '/')];
  }
  $key = trim((string)($in['key'] ?? ''));
  return [
    'host' => rtrim($host, '/'), 'port' => max(1, min(65535, (int)($in['port'] ?? 8686))),
    'base' => trim(preg_replace('#[^A-Za-z0-9._\-/]#', '', (string)($in['base'] ?? '')), '/'),
    'key' => $key !== '' ? preg_replace('/[^A-Za-z0-9]/', '', $key) : ($old['key'] ?? ''),
    'profile' => (int)($in['profile'] ?? 0), 'profile_name' => mb_substr((string)($in['profile_name'] ?? ''), 0, 80),
    'meta' => (int)($in['meta'] ?? 0), 'meta_name' => mb_substr((string)($in['meta_name'] ?? ''), 0, 80),
    'map' => $map,
  ];
}
function uc_lidarr_req(array $c, string $method, string $path, $body = null, int $timeout = 40) {
  if ($c['host'] === '' || $c['key'] === '') throw new UcError('Set up Lidarr first (Settings > Tools)');
  $host = preg_match('#^https?://#', $c['host']) ? $c['host'] : 'http://' . $c['host'];
  $url = $host . (preg_match('#:\d+$#', $host) ? '' : ':' . $c['port']) . ($c['base'] !== '' ? '/' . $c['base'] : '') . '/api/v1/' . ltrim($path, '/');
  $ch = curl_init($url);
  curl_setopt_array($ch, [CURLOPT_RETURNTRANSFER => true, CURLOPT_CUSTOMREQUEST => $method, CURLOPT_CONNECTTIMEOUT => 6, CURLOPT_TIMEOUT => $timeout,
    CURLOPT_HTTPHEADER => ['X-Api-Key: ' . $c['key'], 'Accept: application/json', 'Content-Type: application/json'],
    CURLOPT_SSL_VERIFYPEER => false, CURLOPT_SSL_VERIFYHOST => 0]);
  if ($body !== null) curl_setopt($ch, CURLOPT_POSTFIELDS, json_encode($body, JSON_UNESCAPED_SLASHES));
  $raw = curl_exec($ch); $code = (int)curl_getinfo($ch, CURLINFO_HTTP_CODE); $err = curl_error($ch);
  curl_close($ch);
  if ($raw === false) throw new UcError("Can't reach Lidarr at $url ($err)");
  if ($code === 401) throw new UcError('Lidarr refused the API key (401) - copy it again from Lidarr > Settings > General');
  $j = json_decode((string)$raw, true);
  if ($code >= 400) {
    $msg = is_array($j) ? implode('; ', array_filter(array_map(fn($e) => is_array($e) ? ($e['errorMessage'] ?? $e['message'] ?? '') : (string)$e, isset($j['message']) ? [$j] : $j))) : '';
    throw new UcError('Lidarr said: ' . ($msg !== '' ? $msg : "HTTP $code"));
  }
  if ($j === null && trim((string)$raw) !== '') throw new UcError("That address answered, but it doesn't look like Lidarr's API (check the port and URL base)");
  return $j;
}
function uc_lidarr_mounts(): array {
  $pairs = [];
  if (is_executable('/usr/bin/docker')) {
    foreach (explode("\n", (string)shell_exec("/usr/bin/docker ps -a --format '{{.Names}}|{{.Image}}' 2>/dev/null")) as $l) {
      [$name, $img] = array_pad(explode('|', $l, 2), 2, '');
      if ($name === '' || stripos($name . $img, 'lidarr') === false) continue;
      foreach (explode("\n", (string)shell_exec('/usr/bin/docker inspect -f ' . escapeshellarg('{{range .Mounts}}{{.Destination}}|{{.Source}}{{"\n"}}{{end}}') . ' ' . escapeshellarg($name) . ' 2>/dev/null')) as $m) {
        [$dst, $src] = array_pad(explode('|', trim($m), 2), 2, '');
        if ($dst !== '' && $src !== '') $pairs[rtrim($dst, '/') ?: '/'] = rtrim($src, '/');
      }
      if ($pairs) return $pairs;
    }
  }
  foreach (glob('/boot/config/plugins/dockerMan/templates-user/*.xml') ?: [] as $t) {
    if (stripos(basename($t), 'lidarr') === false) continue;
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
/* a folder on this server, as Lidarr sees it (through the folder pairs in Settings) */
function uc_lidarr_path(array $c, string $hp): ?string {
  $best = null; $len = -1;
  foreach ($c['map'] as $m) if (($hp === $m['host'] || str_starts_with($hp, $m['host'] . '/')) && strlen($m['host']) > $len) { $best = $m['lidarr'] . substr($hp, strlen($m['host'])); $len = strlen($m['host']); }
  return $best;
}
/* what was asked of Lidarr, per album folder - kept next to History (on the array) */
function uc_lidarr_jobs_file(): string { return uc_data_file('lidarr-jobs.json'); }
function uc_lidarr_jobs(): array { $f = uc_lidarr_jobs_file(); return is_file($f) ? (json_decode((string)file_get_contents($f), true) ?: []) : []; }
function uc_lidarr_job_set(string $p, array $v): array {
  $f = uc_lidarr_jobs_file(); if (!is_dir(dirname($f))) @mkdir(dirname($f), 0777, true);
  $h = fopen("$f.lock", 'c'); if ($h) flock($h, LOCK_EX);
  $all = uc_lidarr_jobs();
  $all[$p] = array_merge($all[$p] ?? [], $v, ['at' => time()]);
  /* finished ones are forgotten after two weeks */
  foreach ($all as $k => $x) if (in_array($x['state'] ?? '', ['sent', 'failed', 'nothing'], true) && time() - ($x['at'] ?? 0) > 14 * 86400) unset($all[$k]);
  @file_put_contents("$f.tmp", json_encode($all, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE)); @rename("$f.tmp", $f);
  if ($h) { flock($h, LOCK_UN); fclose($h); }
  return $all[$p];
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
  $f = uc_data_file('radarr-sent.json');
  if ($set !== null) { file_put_contents("$f.tmp", json_encode($set, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE)); rename("$f.tmp", $f); return $set; }
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

/* Sonarr/Radarr must use the folder we're looking at - the one that already
 * holds part of the show or movie. If the item points somewhere else:
 *   - that other folder is missing or has no videos -> point the item here
 *     (nothing is moved);
 *   - it has videos too -> stop and say so, so nothing gets split further. */
function uc_has_video(string $dir): bool {
  if (!is_dir($dir)) return false;
  $it = new RecursiveIteratorIterator(new RecursiveDirectoryIterator($dir, FilesystemIterator::SKIP_DOTS));
  $n = 0;
  foreach ($it as $f) { if (++$n > 20000) return true; if ($f->isFile() && preg_match('/\.(mkv|mp4|m4v|avi|ts|m2ts|wmv|mov|mpe?g|iso)$/i', $f->getFilename())) return true; }
  return false;
}
function uc_arr_same_folder(string $app, array $item, string $want, callable $toHost, callable $get, callable $put): array {
  $have = rtrim((string)($item['path'] ?? ''), '/');
  if ($have === '' || $have === rtrim($want, '/')) return $item;
  $other = $toHost($have);
  if ($other !== null && uc_has_video($other))
    throw new UcError("$app already has this in another folder: " . $other . " - and there are videos there too. Merge the two folders (or change the path in $app) first, so the files don't end up split across both.");
  $full = $get();
  $full['path'] = rtrim($want, '/');
  return (array)$put($full) ?: $full;
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
  $verb = ['copy' => 'Copy', 'move' => 'Move', 'perms' => 'Permissions change', 'back' => 'Undo'][$job['type']] ?? 'Job';
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
      CURLOPT_CONNECTTIMEOUT => 8, CURLOPT_TIMEOUT => 30, CURLOPT_USERAGENT => 'unCommander (unRAID plugin)',
      CURLOPT_HTTPHEADER => ['Accept: application/json']]);
    $raw = curl_exec($ch); $code = (int)curl_getinfo($ch, CURLINFO_HTTP_CODE); $err = curl_error($ch);
    curl_close($ch);
    if ($raw === false) throw new UcError("Can't reach TVmaze ($err)");
    if ($code === 429) { sleep($wait); $wait *= 2; continue; }
    /* a hiccup on TVmaze's side (502, 503, 504, Cloudflare's 52x): try again shortly */
    if ($code >= 500 && $try < 2) { sleep(1 + $try); continue; }
    if ($code === 404) return null;
    if ($code >= 400) throw new UcError("TVmaze answered with error $code");
    $j = json_decode((string)$raw, true);
    if ($j === null && trim((string)$raw) !== 'null') throw new UcError("TVmaze sent an answer that isn't readable (HTTP $code)");
    return $j;
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
  /* one call normally; if TVmaze chokes on the combined answer (it happens with
   * some shows), ask for the show and its episodes separately */
  try { $j = uc_tvmaze_get("shows/$id?embed=episodes"); }
  catch (UcError $e) {
    $j = uc_tvmaze_get("shows/$id");
    if ($j) $j['_embedded']['episodes'] = (array)uc_tvmaze_get("shows/$id/episodes");
  }
  if (!$j) return null;
  if (!isset($j['_embedded']['episodes'])) $j['_embedded']['episodes'] = (array)uc_tvmaze_get("shows/$id/episodes");
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
    CURLOPT_CONNECTTIMEOUT => 8, CURLOPT_TIMEOUT => 30, CURLOPT_USERAGENT => 'unCommander (unRAID plugin)', CURLOPT_HTTPHEADER => ['Accept: application/json']]);
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
  $f = uc_data_file('tv-' . $what . '.json');
  if ($set !== null) { file_put_contents("$f.tmp", json_encode($set, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE)); rename("$f.tmp", $f); return $set; }
  return is_file($f) ? (json_decode((string)file_get_contents($f), true) ?: []) : [];
}

require_once __DIR__ . '/history.php';

/* ---------- music tags ----------
 * One set of fields for every kind of file; ffmpeg writes each the way that
 * kind keeps it (ID3v2.3 in MP3, Vorbis comments in FLAC/OGG, iTunes tags in
 * M4A). Only the tags change: the sound is copied as it is, and checked. */
const UC_TAG_FIELDS = ['title', 'artist', 'album', 'album_artist', 'date', 'track', 'disc', 'genre', 'composer', 'comment'];
function uc_tag_kind(string $p): string {
  $e = strtolower(pathinfo($p, PATHINFO_EXTENSION));
  return ['mp3' => 'mp3', 'flac' => 'vorbis', 'ogg' => 'ogg', 'oga' => 'ogg', 'opus' => 'ogg', 'm4a' => 'mp4', 'm4b' => 'mp4'][$e] ?? '';
}
function uc_tags_read(string $p, string $ff): array {
  $o = [];
  exec('timeout 15 ' . escapeshellarg($ff) . ' -hide_banner -loglevel error -nostdin -i ' . escapeshellarg(uc_direct($p)) . ' -f ffmetadata - 2>/dev/null', $o);
  $raw = [];
  for ($i = 1, $n = count($o); $i < $n; $i++) {
    $l = $o[$i];
    if ($l === '' || $l[0] === ';' || $l[0] === '#') continue;
    if ($l[0] === '[') break;                                  // stream and chapter sections: not the song's tags
    while (preg_match('/(?<!\\\\)(\\\\\\\\)*\\\\$/', $l) && $i + 1 < $n) $l = substr($l, 0, -1) . "\n" . $o[++$i];   // a value over several lines
    $eq = -1;
    for ($k = 0, $len = strlen($l); $k < $len; $k++) { if ($l[$k] === '\\') { $k++; continue; } if ($l[$k] === '=') { $eq = $k; break; } }
    if ($eq < 1) continue;
    $un = fn($s) => preg_replace('/\\\\(.)/s', '$1', $s);
    $raw[strtolower($un(substr($l, 0, $eq)))] = $un(substr($l, $eq + 1));
  }
  $alias = ['albumartist' => 'album_artist', 'album artist' => 'album_artist', 'tracknumber' => 'track', 'discnumber' => 'disc', 'year' => 'date', 'tdrc' => 'date', 'tyer' => 'date'];
  $tags = [];
  foreach ($raw as $k => $v) { $k = $alias[$k] ?? $k; if (in_array($k, UC_TAG_FIELDS, true) && !isset($tags[$k])) $tags[$k] = $v; }
  $o = [];
  exec('timeout 15 ' . escapeshellarg($ff) . ' -hide_banner -nostdin -i ' . escapeshellarg(uc_direct($p)) . ' 2>&1', $o);
  $codec = ''; $cover = false;
  foreach ($o as $l) {
    if (!$codec && preg_match('/Stream #0:\d+.*?: Audio: (\w+)/', $l, $m)) $codec = $m[1];
    if (str_contains($l, 'attached pic')) $cover = true;
  }
  $kind = uc_tag_kind($p);
  $ro = '';
  if (!$kind) $ro = "Tags can't be changed in ." . strtolower(pathinfo($p, PATHINFO_EXTENSION)) . ' files';
  elseif (!$codec) $ro = "This doesn't look like a sound file ffmpeg can read";
  elseif ($kind === 'ogg' && $cover) $ro = 'This OGG file has a picture inside; its tags are left alone so the picture isn\'t lost';
  return ['tags' => (object)$tags, 'cover' => $cover, 'codec' => $codec, 'kind' => $kind, 'ro' => $ro];
}
/* MusicBrainz: free, no key; asks for at most one request a second and a name in User-Agent */
function uc_mb_base(): string { return rtrim(getenv('UC_MB') ?: 'https://musicbrainz.org/ws/2', '/'); }
function uc_caa_base(): string { return rtrim(getenv('UC_CAA') ?: 'https://coverartarchive.org', '/'); }
function uc_mb_get(string $path) {
  static $last = 0.0;
  for ($try = 0; $try < 3; $try++) {
    $gap = 1.05 - (microtime(true) - $last);
    if ($gap > 0) usleep((int)($gap * 1e6));
    $last = microtime(true);
    $ch = curl_init(uc_mb_base() . '/' . ltrim($path, '/'));
    curl_setopt_array($ch, [CURLOPT_RETURNTRANSFER => true, CURLOPT_FOLLOWLOCATION => true, CURLOPT_MAXREDIRS => 3,
      CURLOPT_CONNECTTIMEOUT => 8, CURLOPT_TIMEOUT => 30, CURLOPT_USERAGENT => 'unCommander/1 ( https://github.com/hernandito/unCommander )',
      CURLOPT_HTTPHEADER => ['Accept: application/json']]);
    $raw = curl_exec($ch); $code = (int)curl_getinfo($ch, CURLINFO_HTTP_CODE); $err = curl_error($ch);
    curl_close($ch);
    if ($raw === false) throw new UcError("Can't reach MusicBrainz ($err)");
    if ($code === 503 || $code === 429) { sleep(2 + 2 * $try); continue; }
    if ($code === 404) return null;
    if ($code >= 400) throw new UcError("MusicBrainz answered with error $code");
    $j = json_decode((string)$raw, true);
    if (!is_array($j)) throw new UcError("MusicBrainz sent an answer that isn't readable");
    return $j;
  }
  throw new UcError('MusicBrainz is busy - try again in a minute');
}
function uc_mb_credit($ac): string {
  $s = '';
  foreach ((array)$ac as $c) $s .= ($c['name'] ?? ($c['artist']['name'] ?? '')) . ($c['joinphrase'] ?? '');
  return trim($s);
}

/* ---------- playlists ----------
 * Preferences (where each app's playlists go, how its paths look, the Plex
 * address and token) in playlists.json next to the settings; the token never
 * goes back to the browser. */
function uc_pl_prefs(): array {
  $f = uc_data_file('playlists.json');
  $p = is_file($f) ? (json_decode((string)file_get_contents($f), true) ?: []) : [];
  return array_merge(['targets' => [], 'last' => 'navidrome', 'plex_url' => '', 'plex_token' => '', 'jf_url' => '', 'jf_key' => '', 'jf_user' => '', 'jf_uname' => ''], $p);
}
function uc_pl_prefs_save(array $p): void {
  $f = uc_data_file('playlists.json');
  file_put_contents("$f.tmp", json_encode($p, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE));
  rename("$f.tmp", $f);
}
/* Docker folder mappings of the containers whose name or image matches: [{app, container, host}] */
function uc_docker_maps(string $re): array {
  $out = [];
  if (is_executable('/usr/bin/docker')) {
    foreach (explode("\n", (string)shell_exec("/usr/bin/docker ps -a --format '{{.Names}}|{{.Image}}' 2>/dev/null")) as $l) {
      [$name, $img] = array_pad(explode('|', trim($l), 2), 2, '');
      if ($name === '' || !preg_match($re, "$name $img")) continue;
      foreach (explode("\n", (string)shell_exec('/usr/bin/docker inspect -f ' . escapeshellarg('{{range .Mounts}}{{.Destination}}|{{.Source}}{{"\n"}}{{end}}') . ' ' . escapeshellarg($name) . ' 2>/dev/null')) as $m) {
        [$dst, $src] = array_pad(explode('|', trim($m), 2), 2, '');
        if ($dst !== '' && $src !== '') $out[] = ['app' => $name, 'image' => $img, 'container' => rtrim($dst, '/') ?: '/', 'host' => rtrim($src, '/')];
      }
    }
  }
  if (!$out) foreach (glob('/boot/config/plugins/dockerMan/templates-user/*.xml') ?: [] as $t) {
    $x = @simplexml_load_file($t); if (!$x) continue;
    $name = (string)$x->Name;
    if (!preg_match($re, $name . ' ' . (string)$x->Repository)) continue;
    foreach ($x->Config as $cfg) {
      if ((string)$cfg['Type'] !== 'Path') continue;
      $dst = rtrim((string)$cfg['Target'], '/'); $src = rtrim(trim((string)$cfg) ?: (string)$cfg['Default'], '/');
      if ($dst !== '' && $src !== '') $out[] = ['app' => $name, 'image' => (string)$x->Repository, 'container' => $dst, 'host' => $src];
    }
  }
  return $out;
}
/* "a/../b" and "./" out of a path */
function uc_norm_path(string $p): string {
  $abs = str_starts_with($p, '/'); $out = [];
  foreach (explode('/', $p) as $s) {
    if ($s === '' || $s === '.') continue;
    if ($s === '..') { if ($out && end($out) !== '..') array_pop($out); elseif (!$abs) $out[] = '..'; continue; }
    $out[] = $s;
  }
  return ($abs ? '/' : '') . implode('/', $out);
}

/* Unassigned Devices' network shares (Main › Unassigned Devices › Remote shares): each one, where it
 * mounts (/mnt/remotes/...), and whether it's mounted now. Mounting goes through UD's own script, so
 * UD shows the same state and its credentials are used. */
const UC_UD_RC = '/usr/local/sbin/rc.unassigned';
function uc_ud_mounts(): array {
  $m = [];
  foreach (@file(getenv('UC_MOUNTS') ?: '/proc/mounts', FILE_IGNORE_NEW_LINES) ?: [] as $l) {
    $f = explode(' ', $l); if (count($f) < 3) continue;
    $dec = fn($x) => preg_replace_callback('/\\\\([0-7]{3})/', fn($o) => chr(octdec($o[1])), $x);
    $m[] = ['src' => $dec($f[0]), 'at' => $dec($f[1]), 'type' => $f[2]];
  }
  return $m;
}
function uc_ud_remotes(): array {
  $f = is_file('/tmp/unassigned.devices/config/samba_mount.cfg') ? '/tmp/unassigned.devices/config/samba_mount.cfg' : '/boot/config/plugins/unassigned.devices/samba_mount.cfg';
  $ini = is_file($f) ? (@parse_ini_file($f, true, INI_SCANNER_RAW) ?: []) : [];
  $mounts = uc_ud_mounts(); $out = [];
  foreach ($ini as $src => $o) {
    if (!is_array($o)) continue;
    $src = (string)$src; $nfs = !str_starts_with($src, '//');
    /* UD's name for the mount: the one set in UD, else SERVER_share */
    $mp = trim((string)($o['mountpoint'] ?? ''), '"');
    if ($mp === '') $mp = $nfs ? preg_replace('#[:/]+#', '_', trim(preg_replace('#^([^:]+):/*(.*)$#', '$1_$2', $src), '/')) : preg_replace('#/+#', '_', ltrim($src, '/'));
    $path = '/mnt/remotes/' . $mp; $mounted = false;
    $share = strtolower(preg_replace('#^//[^/]+#', '', preg_replace('#^[^:]+:#', '', $src)));
    foreach ($mounts as $m) {
      if (!str_starts_with($m['at'], '/mnt/remotes/')) continue;
      $ms = strtolower(preg_replace('#^//[^/]+#', '', preg_replace('#^[^:]+:#', '', $m['src'])));
      if ($m['at'] === $path || (strcasecmp($m['src'], $src) === 0) || ($share !== '' && $ms === $share && strtolower(basename($m['at'])) === strtolower($mp))) { $path = $m['at']; $mounted = true; break; }
    }
    $out[] = ['src' => $src, 'name' => basename($path), 'nfs' => $nfs, 'path' => $path, 'mounted' => $mounted];
  }
  return $out;
}
/* inside a Kodi share: the folder Kodi keeps music playlists in */
function uc_kodi_pldir(string $p): ?string {
  foreach (['userdata/playlists/music', 'playlists/music', '.kodi/userdata/playlists/music', 'storage/.kodi/userdata/playlists/music', 'Kodi/userdata/playlists/music'] as $d)
    if (is_dir("$p/$d")) return "$p/$d";
  return null;
}
/* Disks in the server that aren't in the array or a pool (Unassigned Devices mounts them under /mnt/disks):
 * each partition with a file system, mounted or not */
function uc_ud_disks(): array {
  $j = getenv('UC_LSBLK') ? (string)@file_get_contents(getenv('UC_LSBLK'))
    : (string)shell_exec('timeout 10 lsblk -J -l -b -o NAME,PATH,TYPE,FSTYPE,LABEL,SIZE,MOUNTPOINT,SERIAL,MODEL,PKNAME 2>/dev/null');
  $all = (json_decode($j, true) ?: [])['blockdevices'] ?? [];
  /* the array's and pools' disks and the flash drive are left out */
  $taken = [];
  foreach ((@parse_ini_file(getenv('UC_DISKS_INI') ?: '/var/local/emhttp/disks.ini', true) ?: []) as $d) if (!empty($d['device'])) $taken[$d['device']] = 1;
  $byName = []; foreach ($all as $b) $byName[$b['name']] = $b;
  $cfgF = '/boot/config/plugins/unassigned.devices/unassigned.devices.cfg';
  $cfg = is_file($cfgF) ? (@parse_ini_file($cfgF, true, INI_SCANNER_RAW) ?: []) : [];
  $mounts = []; foreach (uc_ud_mounts() as $m) $mounts[$m['src']] = $m['at'];
  $out = [];
  foreach ($all as $b) {
    if (($b['type'] ?? '') !== 'part' && ($b['type'] ?? '') !== 'disk') continue;
    $fs = (string)($b['fstype'] ?? '');
    if (!in_array($fs, ['xfs', 'btrfs', 'ext4', 'ext3', 'ext2', 'ntfs', 'exfat', 'vfat', 'hfsplus', 'apfs'], true)) continue;
    $parent = (string)($b['pkname'] ?? '') ?: $b['name'];
    if (isset($taken[$parent]) || isset($taken[$b['name']]) || preg_match('/^(md|nmd|zram|loop|sr)\d/', $b['name'])) continue;
    $mp = (string)($b['mountpoint'] ?? '') ?: ($mounts[$b['path']] ?? '');
    if ($mp !== '' && !str_starts_with($mp, '/mnt/disks/')) continue;          // mounted somewhere else: not ours to touch
    $disk = $byName[$parent] ?? $b; $serial = (string)($disk['serial'] ?? '');
    $name = '';
    foreach ($cfg as $sec => $o) if ($serial !== '' && stripos((string)$sec, $serial) !== false) foreach ((array)$o as $k => $v) if (str_starts_with((string)$k, 'mountpoint')) { $name = basename(trim((string)$v, '"')); break 2; }
    if ($name === '') $name = (string)($b['label'] ?? '') ?: trim(preg_replace('/\s+/', '_', (string)($disk['model'] ?? '')) . ($serial !== '' ? '_' . substr($serial, -6) : ''), '_') ?: $b['name'];
    $out[] = ['src' => $b['path'], 'name' => $mp !== '' ? basename($mp) : $name, 'path' => $mp !== '' ? $mp : "/mnt/disks/$name", 'mounted' => $mp !== '',
      'about' => trim(implode(' · ', array_filter([$b['name'], strtoupper($fs), $b['size'] ? round($b['size'] / 1e9) . ' GB' : '', $disk['model'] ?? '']))), 'disk' => true];
  }
  return $out;
}
/* For a pane at /mnt/remotes or /mnt/disks (or inside one of them): what Unassigned Devices could mount there */
function uc_ud_here(string $dir): ?array {
  if (!preg_match('#^/mnt/(remotes|disks)(?:/([^/]+))?#', $dir, $m)) return null;
  $list = $m[1] === 'remotes' ? uc_ud_remotes() : uc_ud_disks();
  if (!$list) return null;
  $off = null;
  if (!empty($m[2])) foreach ($list as $e) if (!$e['mounted'] && basename($e['path']) === $m[2]) $off = $e;
  return ['kind' => $m[1], 'all' => $list, 'off' => $off, 'rc' => is_executable(UC_UD_RC)];
}
function uc_ud_find(string $src): ?array {
  foreach (str_starts_with($src, '/dev/') ? uc_ud_disks() : uc_ud_remotes() as $e) if ($e['src'] === $src) return $e;
  return null;
}

/* ---------- User Scripts (the plugin by Squid) ----------
 * Its scripts live in /boot/config/plugins/user.scripts/scripts/<name>/script. They're run the way
 * User Scripts runs them - copied to /tmp/user.scripts/tmpScripts/<name>/ first, the background ones
 * logging to log.txt there and marked in /tmp/user.scripts/running - so its own page shows the same. */
define('UC_US_DIR', getenv('UC_US_DIR') ?: '/boot/config/plugins/user.scripts/scripts');
define('UC_US_TMP', '/tmp/user.scripts');
function uc_us_vars(string $file): array {
  $v = [];
  foreach (array_slice(@file($file, FILE_IGNORE_NEW_LINES) ?: [], 0, 60) as $i => $l) {
    $l = trim(str_replace("\r", '', $l));
    if ($i === 0 && str_starts_with($l, '#!')) continue;
    if ($l === '' ) continue;
    if (preg_match('/^<\?(php)?$/i', $l)) continue;
    if ($l[0] !== '#') break;
    if (preg_match('/^#\s*(\w+)\s*=\s*(.*)$/', $l, $m)) $v[$m[1]] = trim($m[2], " \t\"'");
  }
  foreach (['foregroundOnly', 'backgroundOnly', 'arrayStarted', 'clearLog', 'noParity'] as $b) if (isset($v[$b])) $v[$b] = filter_var($v[$b], FILTER_VALIDATE_BOOLEAN);
  return $v;
}
function uc_us_running(string $id): bool {
  $pf = UC_US_TMP . "/running/$id";
  if (!is_file($pf)) return false;
  $pid = (int)trim((string)@file_get_contents($pf));
  return $pid > 0 && file_exists("/proc/$pid");
}
function uc_us_list(): array {
  $out = [];
  foreach (glob(UC_US_DIR . '/*/script') ?: [] as $f) {
    $id = basename(dirname($f)); $v = uc_us_vars($f);
    $desc = is_file(dirname($f) . '/description') ? trim((string)@file_get_contents(dirname($f) . '/description')) : (string)($v['description'] ?? '');
    $out[] = ['id' => $id, 'name' => (string)($v['name'] ?? '') ?: $id, 'desc' => mb_substr(strip_tags($desc), 0, 300),
      'arg' => isset($v['argumentDescription']) ? ['about' => (string)$v['argumentDescription'], 'def' => (string)($v['argumentDefault'] ?? '')] : null,
      'fg' => empty($v['backgroundOnly']), 'bg' => empty($v['foregroundOnly']), 'running' => uc_us_running($id),
      'log' => is_file(UC_US_TMP . "/tmpScripts/$id/log.txt")];
  }
  usort($out, fn($a, $b) => strnatcasecmp($a['name'], $b['name']));
  return $out;
}
function uc_us_clean($l): ?array {
  if (!is_array($l)) return null;
  return array_values(array_unique(array_filter(array_map(fn($x) => is_string($x) && $x !== '' && !str_contains($x, '/') ? mb_substr($x, 0, 120) : null, array_slice($l, 0, 200)))));
}

/* ---------- Clean up (Settings › Trash & History) ----------
 * What unCommander keeps that can go, how big each is, and clearing the ones picked. */
function uc_du(array $paths, int $secs = 60): int {
  $paths = array_values(array_filter($paths, 'file_exists')); if (!$paths) return 0;
  $o = (string)shell_exec("timeout $secs du -scb " . implode(' ', array_map('escapeshellarg', $paths)) . ' 2>/dev/null | tail -1');
  return (int)$o;
}
function uc_trash_dirs(): array {
  $d = [];
  foreach (array_merge(glob('/mnt/user/*/' . UC_TRASH, GLOB_ONLYDIR) ?: [], glob('/mnt/*/' . UC_TRASH, GLOB_ONLYDIR) ?: [], glob('/mnt/{disks,remotes}/*/' . UC_TRASH, GLOB_ONLYDIR | GLOB_BRACE) ?: [], glob('/boot/' . UC_TRASH, GLOB_ONLYDIR) ?: []) as $t)
    if (!preg_match('#^/mnt/user0?/' . preg_quote(UC_TRASH, '#') . '$#', $t)) $d[] = $t;
  return array_values(array_unique($d));
}
function uc_clean_parts(): array {
  $S = UC_STATE; $hist = uc_hist_path(); $cfg = dirname(UC_CFG);
  $live = []; foreach (glob("$S/hls-*") ?: [] as $h) if (filemtime($h) < time() - 120) $live[] = $h;     // video pieces no player is using
  return [
    'trash'  => ['Trash', 'Everything in the trash, on every share and disk. History can no longer undo deletes after this.', uc_trash_dirs()],
    'hist'   => ['History', 'The list of changes (copies, moves, renames…) and their Undo. Nothing on the disks changes.', [$hist]],
    'cache'  => ['Thumbnails and scan results', 'Picture previews, folder sizes, tool scans and covers kept in memory - made again when needed.', array_merge(array_map(fn($x) => "$S/$x", ['thumbs', 'scans', 'sizes', 'mbcover', 'tvmaze', 'subs', 'music-check.json'])) ],
    'left'   => ['Leftovers', 'Pieces of uploads and picture edits that never finished, old download links, video pieces from closed players, and script output from the User Scripts window.', array_merge(glob("$S/put/*") ?: [], glob("$S/dl-*.json") ?: [], $live, glob("$S/us-*") ?: [], glob("$S/ffmpeg.err") ?: [])],
    'lists'  => ['Finished lists', 'Albums sent to Lidarr that are done, music-check "Accept"s, and the list of movies sent to Radarr. Only the lists - nothing on Lidarr or Radarr changes.', array_values(array_filter([uc_data_file('lidarr-jobs.json'), uc_data_file('music-accept.json'), uc_data_file('radarr-sent.json')], 'is_file'))],
    'ffmpeg' => ['ffmpeg', 'The video tool unCommander fetched the first time a video, a song length or music tags needed it (Jellyfin\'s build of ffmpeg, from GitHub), kept in unCommander\'s folder. It plays MKV films with any sound, adds subtitles and converts pictures browsers can\'t show. Removing it frees the space and memory; it\'s fetched again the next time something needs it.', array_values(array_filter(array_merge([(string)uc_ff_gz(), UC_FF_BIN, "$cfg/" . UC_FF_NAME], glob("$cfg/ffmpeg-*-linux-x64.gz") ?: []), fn($f) => $f !== '' && file_exists($f)))],
  ];
}
/* folders picked in the tools' tree, relative to the shares (Media, Media/Movies…): checked, no ../ or hidden ones */
function uc_rel_dirs($in): array {
  $l = is_string($in) ? (json_decode($in, true) ?: []) : (array)$in; $out = [];
  foreach (array_slice($l, 0, 500) as $d) {
    $d = trim((string)$d, '/');
    if ($d === '' || preg_match('#(^|/)\.#', $d) || str_contains($d, "\0")) continue;
    $out[] = $d;
  }
  /* a folder inside another picked one is already covered */
  sort($out); $keep = [];
  foreach ($out as $d) { $in2 = false; foreach ($keep as $k) if (str_starts_with($d, "$k/")) $in2 = true; if (!$in2) $keep[] = $d; }
  return $keep;
}
/* tools' scans (in memory): the newest of each tool is kept until a new one replaces it; older ones go after a day */
/* What's using space: a scan's folders are spread over this many files, by name */
const UC_SPACE_BUCKETS = 64;
function uc_space_bucket(string $rel): int { return hexdec(substr(md5($rel), 0, 4)) % UC_SPACE_BUCKETS; }
const UC_SPACE_KINDS = ['vid', 'aud', 'img', 'arc', 'oth'];
function uc_space_kind(string $name): int {
  return preg_match('/\.(mkv|mp4|m4v|avi|mov|wmv|ts|m2ts|webm|mpe?g|iso|vob)$/i', $name) ? 0 : (preg_match('/\.(mp3|flac|m4a|aac|ogg|opus|wav|wma|aiff?|ape|dsf)$/i', $name) ? 1
    : (preg_match('/\.(jpe?g|png|gif|webp|heic|tiff?|bmp|raw|cr2|nef|arw|dng)$/i', $name) ? 2 : (preg_match('/\.(zip|rar|7z|tar|gz|xz|bz2|zst|img|qcow2|vdisk)$/i', $name) ? 3 : 4)));
}
/* one walk of a folder: folder rel => [bytes, files, sub-folder names, biggest files [name => bytes], smaller files [bytes, count], bytes by kind].
 * $tick(seen, bytes) is called every half second; returning true stops the walk. */
function uc_space_walk(string $root, ?callable $tick = null): array {
  $D = ['' => [0, 0, [], [], [0, 0], [0, 0, 0, 0, 0]]];
  $seen = 0; $bytes = 0; $last = 0; $stop = false;
  $h = popen('find -H ' . escapeshellarg($root) . ' -mindepth 1 -printf ' . escapeshellarg('%y\t%s\t%P\0') . ' 2>/dev/null', 'r');
  $buf = '';
  while ($h && !feof($h) && !$stop) {
    $buf .= fread($h, 1 << 16); $parts = explode("\0", $buf); $buf = array_pop($parts);
    foreach ($parts as $e) {
      $a = explode("\t", $e, 3); if (count($a) < 3) continue;
      [$t, $size, $rel] = $a; $size = (int)$size;
      $i = strrpos($rel, '/'); $par = $i === false ? '' : substr($rel, 0, $i); $name = $i === false ? $rel : substr($rel, $i + 1);
      if ($t === 'd') {
        $D[$rel] ??= [0, 0, [], [], [0, 0], [0, 0, 0, 0, 0]];
        $D[$par] ??= [0, 0, [], [], [0, 0], [0, 0, 0, 0, 0]];
        $D[$par][2][] = $name;
        continue;
      }
      $D[$par] ??= [0, 0, [], [], [0, 0], [0, 0, 0, 0, 0]];
      $kind = uc_space_kind($name);
      $f = &$D[$par][3]; $f[$name] = $size;
      if (count($f) > 120) { arsort($f); $rest = array_slice($f, 60, null, true); $f = array_slice($f, 0, 60, true); $D[$par][4][0] += array_sum($rest); $D[$par][4][1] += count($rest); }
      unset($f);
      /* up the tree: this folder and every one above it */
      $p = $par;
      while (true) { $D[$p][0] += $size; $D[$p][1]++; $D[$p][5][$kind] += $size; if ($p === '') break; $j = strrpos($p, '/'); $p = $j === false ? '' : substr($p, 0, $j); $D[$p] ??= [0, 0, [], [], [0, 0], [0, 0, 0, 0, 0]]; }
      $seen++; $bytes += $size;
    }
    if ($tick && microtime(true) - $last > 0.5) { $last = microtime(true); $stop = (bool)$tick($seen, $bytes); }
  }
  if ($h) pclose($h);
  if ($tick) $tick($seen, $bytes);
  return $D;
}
/* what the map shows for one folder of a walk: its total, and its sub-folders and biggest files */
function uc_space_entry(array &$D, string $rel): array {
  [$bytes, $n, $kids, $files, $rest] = $D[$rel];
  if (count($files) > 60) { arsort($files); $more = array_slice($files, 60, null, true); $files = array_slice($files, 0, 60, true); $rest[0] += array_sum($more); $rest[1] += count($more); }
  $items = [];
  foreach (array_unique($kids) as $k) {
    $k = (string)$k; $x = $D[$rel === '' ? $k : "$rel/$k"] ?? [0, 0]; $kd = $x[5] ?? [0, 0, 0, 0, 0];
    $items[] = ['n' => $k, 'd' => 1, 's' => $x[0], 'c' => $x[1], 'k' => UC_SPACE_KINDS[array_search(max($kd), $kd)]];
  }
  foreach ($files as $k => $v) $items[] = ['n' => (string)$k, 'd' => 0, 's' => $v];
  if ($rest[1]) $items[] = ['n' => '', 'd' => 0, 's' => $rest[0], 'c' => $rest[1], 'rest' => 1];
  usort($items, fn($a, $b) => $b['s'] <=> $a['s']);
  return ['s' => $bytes, 'c' => $n, 'items' => $items];
}
/* After changes made in the panes: look again at just the folders that were open there (and where jobs
 * copied or moved to), and fix the scan to match - new folders are walked, gone ones dropped, the files
 * right inside re-read, and the totals of every folder above adjusted. Only the small files those
 * folders live in are rewritten. Returns how many folders changed. */
function uc_space_refresh(string $id, array $dirs): int {
  $jf = UC_STATE . "/scans/$id.json";
  $st = json_decode((string)@file_get_contents($jf), true);
  if (!$st || ($st['tool'] ?? '') !== 'space' || ($st['state'] ?? '') !== 'done') throw new UcError('That scan is no longer available - scan again');
  $root = rtrim($st['root'], '/') ?: '/';
  $lk = fopen("$jf.lock", 'c'); flock($lk, LOCK_EX);
  $tf = fn(string $rel) => UC_STATE . "/scans/$id.tree." . sprintf('%02x', uc_space_bucket($rel));
  $L = []; $dirty = [];
  $get = function (string $rel) use (&$L, $tf) {
    if (array_key_exists($rel, $L)) return $L[$rel];
    $L[$rel] = null; $f = $tf($rel);
    if (!is_file($f)) return null;
    $needle = '[' . json_encode($rel, JSON_UNESCAPED_SLASHES | JSON_INVALID_UTF8_SUBSTITUTE) . ',';
    $h = fopen($f, 'r');
    while ($h && ($line = fgets($h)) !== false) if (str_starts_with($line, $needle)) { $j = json_decode($line, true); $L[$rel] = is_array($j) ? $j[1] : null; break; }
    if ($h) fclose($h);
    return $L[$rel];
  };
  $set = function (string $rel, array $v) use (&$L, &$dirty) { $L[$rel] = $v; $dirty[$rel] = true; };
  $rels = [];
  foreach ($dirs as $d) {
    $d = rtrim((string)$d, '/') ?: '/';
    if ($d === $root) $rels[''] = 0;
    elseif (str_starts_with($d, $root === '/' ? '/' : "$root/")) { $r = substr($d, strlen($root === '/' ? '/' : "$root/")); $rels[$r] = substr_count($r, '/') + 1; }
  }
  arsort($rels);                                         // deepest first, so a folder's change is in its parent before the parent is looked at
  $changed = 0;
  foreach (array_keys($rels) as $rel) {
    $rel = (string)$rel; $abs = $rel === '' ? $root : ($root === '/' ? "/$rel" : "$root/$rel");
    $old = $get($rel); if (!$old || !is_dir($abs) || is_link($abs)) continue;
    $now = @scandir($abs); if ($now === false) continue;
    $oldDirs = []; $oldFB = 0; $oldFC = 0;
    foreach ($old['items'] as $it) { if (!empty($it['d'])) $oldDirs[$it['n']] = $it; elseif (!empty($it['rest'])) { $oldFB += $it['s']; $oldFC += $it['c']; } else { $oldFB += $it['s']; $oldFC++; } }
    $ds = 0; $dc = 0; $dirItems = []; $files = []; $seenDirs = [];
    foreach ($now as $n) {
      if ($n === '.' || $n === '..') continue;
      $p = "$abs/$n"; $isDir = is_dir($p) && !is_link($p);
      if (!$isDir) { $sz = @lstat($p); $files[$n] = $sz ? (int)$sz['size'] : 0; continue; }
      $seenDirs[$n] = true;
      if (isset($oldDirs[$n])) { $dirItems[] = $oldDirs[$n]; continue; }
      /* a folder that wasn't there: walk it */
      $W = uc_space_walk($p); $sub = $rel === '' ? $n : "$rel/$n";
      foreach (array_keys($W) as $wr) { $wr = (string)$wr; $set($wr === '' ? $sub : "$sub/$wr", uc_space_entry($W, $wr)); }
      $kd = $W[''][5];
      $dirItems[] = ['n' => (string)$n, 'd' => 1, 's' => $W[''][0], 'c' => $W[''][1], 'k' => UC_SPACE_KINDS[array_search(max($kd), $kd)]];
      $ds += $W[''][0]; $dc += $W[''][1];
    }
    foreach ($oldDirs as $n => $it) if (!isset($seenDirs[$n])) { $ds -= $it['s']; $dc -= $it['c'] ?? 0; }
    $ds += array_sum($files) - $oldFB; $dc += count($files) - $oldFC;
    arsort($files); $top = array_slice($files, 0, 60, true); $more = array_slice($files, 60, null, true);
    $items = $dirItems;
    foreach ($top as $k => $v) $items[] = ['n' => (string)$k, 'd' => 0, 's' => $v];
    if ($more) $items[] = ['n' => '', 'd' => 0, 's' => array_sum($more), 'c' => count($more), 'rest' => 1];
    usort($items, fn($a, $b) => $b['s'] <=> $a['s']);
    $sameItems = json_encode($items) === json_encode($old['items']);
    if ($sameItems && !$ds && !$dc) continue;
    $changed++;
    $set($rel, ['s' => $old['s'] + $ds, 'c' => $old['c'] + $dc, 'items' => $items]);
    if (!$ds && !$dc) continue;
    /* every folder above: its total, and this branch's line in it */
    $child = $rel;
    while ($child !== '') {
      $j = strrpos($child, '/'); $par = $j === false ? '' : substr($child, 0, $j); $nm = $j === false ? $child : substr($child, $j + 1);
      $pv = $get($par); if (!$pv) break;
      $pv['s'] += $ds; $pv['c'] += $dc;
      foreach ($pv['items'] as &$it) if (!empty($it['d']) && $it['n'] === $nm) { $it['s'] += $ds; $it['c'] = ($it['c'] ?? 0) + $dc; }
      unset($it);
      usort($pv['items'], fn($a, $b) => $b['s'] <=> $a['s']);
      $set($par, $pv); $child = $par;
    }
  }
  /* write back: only the small files holding a changed folder */
  $by = [];
  foreach (array_keys($dirty) as $r) $by[uc_space_bucket((string)$r)][(string)$r] = true;
  foreach ($by as $b => $want) {
    $f = UC_STATE . "/scans/$id.tree." . sprintf('%02x', $b);
    $in = @fopen($f, 'r'); $out = fopen("$f.tmp", 'w');
    while ($in && ($line = fgets($in)) !== false) {
      $key = preg_match('/^\[("(?:[^"\\\\]|\\\\.)*")/', $line, $m) ? json_decode($m[1]) : null;
      if (is_string($key) && isset($want[$key])) continue;            // replaced below
      fwrite($out, $line);
    }
    if ($in) fclose($in);
    foreach (array_keys($want) as $r) fwrite($out, json_encode([(string)$r, $L[$r]], JSON_UNESCAPED_SLASHES | JSON_INVALID_UTF8_SUBSTITUTE) . "\n");
    fclose($out); rename("$f.tmp", $f);
  }
  flock($lk, LOCK_UN); fclose($lk); @unlink("$jf.lock");
  return $changed;
}
function uc_scans_tidy(): void {
  $newest = [];
  $all = glob(UC_STATE . '/scans/*.json') ?: [];
  foreach ($all as $f) { $j = json_decode((string)@file_get_contents($f), true) ?: []; $t = ($j['tool'] ?? '?') . '/' . ($j['mode'] ?? ''); if (!isset($newest[$t]) || filemtime($f) > filemtime($newest[$t])) $newest[$t] = $f; }
  foreach ($all as $f) if (!in_array($f, $newest, true) && time() - filemtime($f) > 86400) { $b = substr($f, 0, -5); foreach (['.json', '.results', '.tree', '.list', '.list.sorted'] as $x) @unlink($b . $x); foreach (glob($b . '.tree.*') ?: [] as $x) @unlink($x); }
}
