<?php
/* unCommander — reading an archive so it can be browsed like a folder (read-only).
 * One pass over the archive's own listing (7-Zip, or tar for .tar.*), written as one line per folder
 * ([folder, [[name, isDir, size, mtime, rawName], ...]]) spread over a few small files, so opening any
 * folder inside reads one small file. Started detached by uc_arc_index(); progress in state.json. */
require_once __DIR__ . '/lib.php';

$key = $argv[1] ?? '';
if (!preg_match('/^[a-f0-9]{32}$/', $key)) exit(1);
$dir = UC_ARC_DIR . "/$key";
$stf = "$dir/state.json";
$st = json_decode((string)@file_get_contents($stf), true);
if (!$st || empty($st['file'])) exit(1);
$save = function () use (&$st, $stf) { file_put_contents("$stf.tmp", json_encode($st, JSON_UNESCAPED_SLASHES | JSON_INVALID_UTF8_SUBSTITUTE)); rename("$stf.tmp", $stf); };
$st['state'] = 'running'; $st['pid'] = getmypid(); $st['entries'] = 0; $save();

$a = $st['file'];
$pw = is_file("$dir.pw") ? trim((string)file_get_contents("$dir.pw")) : '';
$kind = uc_archive_kind($a);
/* folder => [name => [isDir, size, mtime, raw]] */
$D = ['' => []];
$err = ''; $enc = false;
$add = function (string $raw, bool $isDir, int $size, int $mtime) use (&$D, &$st, $save) {
  $p = trim(preg_replace('#^(\./)+#', '', str_replace('\\', '/', $raw)), '/');
  if ($p === '' || $p === '.') return;
  $parts = explode('/', $p);
  if (in_array('..', $parts, true)) return;                       // never shown (and never extracted from here)
  /* every folder on the way, even when the archive doesn't list it */
  $cur = '';
  for ($i = 0; $i < count($parts) - 1; $i++) {
    $D[$cur] ??= [];
    if (!isset($D[$cur][$parts[$i]])) $D[$cur][$parts[$i]] = [true, 0, 0, ''];
    $cur = $cur === '' ? $parts[$i] : "$cur/{$parts[$i]}";
  }
  $D[$cur] ??= [];
  $name = end($parts);
  if ($isDir) { $D[$p] ??= []; $D[$cur][$name] = [true, 0, $mtime, rtrim($raw, '/')]; }
  else $D[$cur][$name] = [false, $size, $mtime, $raw];
  if (++$st['entries'] % 2000 === 0) $save();
};
$tm = function (string $s): int { $t = strtotime(preg_replace('/\.\d+$/', '', trim($s))); return $t ?: 0; };

if ($kind === 'tar') {
  $h = popen('tar -tv --quoting-style=literal --full-time -f ' . escapeshellarg($a) . ' 2>&1', 'r');
  while ($h && ($line = fgets($h)) !== false) {
    /* drwxr-xr-x user/group 0 2026-01-01 12:00:00 path   (links: "name -> target") */
    if (preg_match('/^(\S)\S*\s+\S+\s+(\d+)\s+(\S+ \S+)\s(.*)$/', rtrim($line, "\n"), $m)) {
      $name = $m[4];
      if ($m[1] === 'l' || $m[1] === 'h') $name = preg_replace('/ (->|link to) .*$/', '', $name);
      $add($name, $m[1] === 'd', (int)$m[2], $tm($m[3]));
    } elseif (trim($line) !== '') $err = trim($line);
  }
  $rc = $h ? pclose($h) : 1;
  if ($rc !== 0 && $st['entries'] === 0) { $st['state'] = 'failed'; $st['error'] = 'Could not read the archive' . ($err ? ": $err" : ''); $save(); exit; }
} elseif (is_executable(UC_7Z)) {
  $h = popen(escapeshellarg(UC_7Z) . ' l -slt -ba ' . escapeshellarg('-p' . ($pw !== '' ? $pw : 'UCNOPASS')) . ' -- ' . escapeshellarg($a) . ' 2>&1 </dev/null', 'r');
  $cur = [];
  $flush = function () use (&$cur, $add, $tm, &$enc) {
    if (isset($cur['Path'])) {
      if (($cur['Encrypted'] ?? '') === '+') $enc = true;
      $add($cur['Path'], ($cur['Folder'] ?? '') === '+' || preg_match('/(^|\s)D/', $cur['Attributes'] ?? ''), (int)($cur['Size'] ?? 0), $tm($cur['Modified'] ?? ''));
    }
    $cur = [];
  };
  while ($h && ($line = fgets($h)) !== false) {
    $line = rtrim($line, "\r\n");
    if ($line === '') { $flush(); continue; }
    if (preg_match('/^(\w[\w ]*?) = (.*)$/', $line, $m)) $cur[$m[1]] = $m[2];
    elseif (preg_match('/error|password|encrypted|can ?not open/i', $line)) $err = trim($line);
  }
  $flush();
  if ($h) pclose($h);
  if ($st['entries'] === 0 && $err !== '') {
    $st['state'] = preg_match('/password|encrypted/i', $err) ? 'password' : 'failed';
    $st['error'] = $st['state'] === 'password' ? ($pw !== '' ? 'That password is not right' : 'This archive needs its password') : "Could not read the archive: $err";
    $save(); exit;
  }
} else { $st['state'] = 'failed'; $st['error'] = "7-Zip isn't installed - reinstall unCommander while the server is online"; $save(); exit; }

/* write the folders out: one line each, in a few small files by name */
$hs = [];
for ($i = 0; $i < UC_ARC_BUCKETS; $i++) $hs[$i] = fopen("$dir/b" . sprintf('%02x', $i), 'w');
foreach ($D as $p => $kids) {
  $p = (string)$p; $rows = [];
  foreach ($kids as $n => [$isDir, $size, $mtime, $raw]) { $n = (string)$n; $r = [$n, $isDir ? 1 : 0, $size, $mtime]; if ($raw !== '' && $raw !== ($p === '' ? $n : "$p/$n")) $r[] = $raw; $rows[] = $r; }
  fwrite($hs[uc_arc_bucket($p)], json_encode([$p, $rows], JSON_UNESCAPED_SLASHES | JSON_INVALID_UTF8_SUBSTITUTE) . "\n");
}
foreach ($hs as $x) fclose($x);
$st['state'] = 'ready'; $st['folders'] = count($D); $st['encrypted'] = $enc; unset($st['pid']);
$save();
