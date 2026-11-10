<?php
/* unCommander — Tools > Duplicates. Two kinds, picked in the window:
 *   paths   - the same file (same path) on more than one disk or pool. /mnt/user shows only one of
 *             them; the others take space and confuse things (an .nfo left on the cache because the
 *             same file is already on a disk, so mover can't move it).
 *   content - files with the same content under different names or folders, found in /mnt/user only
 *             (so one file seen through two paths is never counted).
 * Read-only: the window deletes what you tick, through the trash. Started detached; progress goes to
 * a JSON file, results one JSON line each. Big lists are sorted on disk (sort), not kept in memory. */
require_once __DIR__ . '/lib.php';

$id = $argv[1] ?? '';
if (!preg_match('/^[a-z0-9]{6,32}$/', $id)) exit(1);
$file = UC_STATE . "/scans/$id.json";
$st = json_decode((string)@file_get_contents($file), true);
if (!$st) exit(1);
$stop = false;
pcntl_async_signals(true);
pcntl_signal(SIGTERM, function () use (&$stop) { $stop = true; });
function save(array $st): void { global $file; file_put_contents("$file.tmp", json_encode($st, JSON_UNESCAPED_SLASHES | JSON_INVALID_UTF8_SUBSTITUTE)); rename("$file.tmp", $file); }
$st['pid'] = getmypid(); $st['state'] = 'running'; $st['seen'] = 0; $st['found'] = 0; $st['wasted'] = 0; save($st);
$out = fopen(UC_STATE . "/scans/$id.results", 'w');
$tmp = UC_STATE . "/scans/$id.list"; $sorted = "$tmp.sorted";
$shares = (array)$st['shares']; $min = max(0, (int)$st['min']);
$trash = '.uncommander-trash';
$last = 0;
$tick = function (string $phase) use (&$st, &$last) { if (microtime(true) - $last > 0.5) { $last = microtime(true); $st['phase'] = $phase; save($st); } };
/* one find, its NUL-separated records split as they come */
$walk = function (string $cmd, callable $each) use (&$stop) {
  $h = popen($cmd, 'r'); $buf = '';
  while ($h && !feof($h) && !$stop) {
    $buf .= fread($h, 1 << 16); $parts = explode("\0", $buf); $buf = array_pop($parts);
    foreach ($parts as $e) if ($e !== '') $each($e);
  }
  if ($h) pclose($h);
};
$prune = ' \( -name ' . escapeshellarg($trash) . ' -o -name ' . escapeshellarg('lost+found') . ' \) -prune -o';

if ($st['mode'] === 'paths') {
  /* every file on every disk and pool, as "rel TAB device TAB size TAB mtime" - then sorted, so the
   * same rel from two devices end up next to each other */
  $mounts = uc_array_mounts();
  $w = fopen($tmp, 'w');
  foreach ($mounts as $dev) {
    if ($stop) break;
    foreach ($shares as $sh) {
      $start = "/mnt/$dev/$sh"; if (!is_dir($start)) continue;
      $walk('find -H ' . escapeshellarg($start) . $prune . ' -type f -size +' . max(0, $min - 1) . 'c -printf ' . escapeshellarg('%P\t%s\t%T@\0') . ' 2>/dev/null', function ($e) use ($w, $dev, $sh, &$st, $tick) {
        [$rel, $size, $mt] = array_pad(explode("\t", $e), 3, '0');
        if (str_contains($rel, "\n")) return;
        fwrite($w, "$sh/$rel\t$dev\t$size\t" . (int)$mt . "\n"); $st['seen']++; $tick('reading');
      });
    }
  }
  fclose($w);
  if (!$stop) {
    $st['phase'] = 'sorting'; save($st);
    exec('LC_ALL=C sort -t "$(printf \'\t\')" -k1,1 -S 200M -T ' . escapeshellarg(UC_STATE . '/scans') . ' -o ' . escapeshellarg($sorted) . ' ' . escapeshellarg($tmp));
    $r = fopen($sorted, 'r'); $grp = []; $cur = null;
    $flush = function () use (&$grp, &$cur, $out, &$st) {
      if (count($grp) > 1) {
        /* which copy /mnt/user shows: the one whose size and date match what the share reports */
        $u = @stat("/mnt/user/$cur"); $served = null;
        if ($u) foreach ($grp as $i => $g) if ((int)$g[1] === $u['size'] && (int)$g[2] === $u['mtime']) { $served = $i; break; }
        $same = count(array_unique(array_map(fn($g) => $g[1] . '/' . $g[2], $grp))) === 1;
        $waste = array_sum(array_column($grp, 1)) - max(array_column($grp, 1));
        fwrite($out, json_encode(['k' => 'path', 'rel' => $cur, 'copies' => array_map(fn($g, $i) => ['dev' => $g[0], 'size' => (int)$g[1], 'm' => (int)$g[2], 'served' => $i === $served], $grp, array_keys($grp)), 'same' => $same, 'waste' => $waste], JSON_UNESCAPED_SLASHES | JSON_INVALID_UTF8_SUBSTITUTE) . "\n");
        $st['found']++; $st['wasted'] += $waste;
      }
      $grp = [];
    };
    while ($r && ($l = fgets($r)) !== false && !$stop) {
      $f = explode("\t", rtrim($l, "\n")); if (count($f) < 4) continue;
      if ($f[0] !== $cur) { $flush(); $cur = $f[0]; }
      $grp[] = [$f[1], (int)$f[2], (int)$f[3]];
      $tick('comparing');
    }
    $flush();
    if ($r) fclose($r);
  }
} else {
  /* content: sizes first (nothing read), then the start and end of each file, then the whole file */
  $w = fopen($tmp, 'w');
  foreach ($shares as $sh) {
    if ($stop) break;
    $start = "/mnt/user/$sh"; if (!is_dir($start)) continue;
    $walk('find -H ' . escapeshellarg($start) . $prune . ' -type f -size +' . max(0, $min - 1) . 'c -printf ' . escapeshellarg('%s\t%i\t%p\0') . ' 2>/dev/null', function ($e) use ($w, &$st, $tick) {
      if (str_contains($e, "\n")) return;
      fwrite($w, "$e\n"); $st['seen']++; $tick('reading');
    });
  }
  fclose($w);
  if (!$stop) {
    $st['phase'] = 'sorting'; save($st);
    exec('LC_ALL=C sort -t "$(printf \'\t\')" -k1,1n -S 200M -T ' . escapeshellarg(UC_STATE . '/scans') . ' -o ' . escapeshellarg($sorted) . ' ' . escapeshellarg($tmp));
    $part = function (string $p, int $size) { $fh = @fopen(uc_direct($p), 'rb'); if (!$fh) return null; $a = fread($fh, $size <= 131072 ? 131072 : 65536); if ($size > 131072) { fseek($fh, -65536, SEEK_END); $a .= fread($fh, 65536); } fclose($fh); return md5((string)$a); };
    $full = function (string $p) { return @hash_file('md5', uc_direct($p)) ?: null; };
    $r = fopen($sorted, 'r'); $grp = []; $cur = null; $st['checked'] = 0;
    $flush = function () use (&$grp, &$cur, $out, &$st, $part, $full, &$stop, $tick) {
      /* hard links (the same inode) are one file - they take no extra space */
      $byIno = []; foreach ($grp as $g) $byIno[$g[0]] ??= $g[1];
      $paths = array_values($byIno);
      if (count($paths) > 1 && $cur > 0) {
        $by = [];
        foreach ($paths as $p) { if ($stop) return; $k = $part($p, $cur); if ($k !== null) $by[$k][] = $p; $st['checked']++; $tick('checking'); }
        foreach ($by as $cands) {
          if (count($cands) < 2) continue;
          $fin = [];
          if ($cur <= 131072) $fin['x'] = $cands;                     // small: the start and end were the whole file
          else foreach ($cands as $p) { if ($stop) return; $h = $full($p); if ($h) $fin[$h][] = $p; $tick('checking'); }
          foreach ($fin as $same) if (count($same) > 1) {
            $files = array_map(fn($p) => ['p' => $p, 'm' => (int)@filemtime($p)], $same);
            usort($files, fn($a, $b) => $a['m'] <=> $b['m']);
            fwrite($out, json_encode(['k' => 'content', 'size' => $cur, 'files' => $files, 'waste' => $cur * (count($same) - 1)], JSON_UNESCAPED_SLASHES | JSON_INVALID_UTF8_SUBSTITUTE) . "\n");
            $st['found']++; $st['wasted'] += $cur * (count($same) - 1);
          }
        }
      }
      $grp = [];
    };
    while ($r && ($l = fgets($r)) !== false && !$stop) {
      $f = explode("\t", rtrim($l, "\n"), 3); if (count($f) < 3) continue;
      $size = (int)$f[0];
      if ($size !== $cur) { $flush(); $cur = $size; }
      $grp[] = [$f[1], $f[2]];
    }
    $flush();
    if ($r) fclose($r);
  }
}
fclose($out); @unlink($tmp); @unlink($sorted);
$st['state'] = $stop ? 'stopped' : 'done'; $st['finished'] = time(); $st['phase'] = '';
save($st);
