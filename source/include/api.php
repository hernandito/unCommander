<?php
/* unCommander — JSON API. Every call is a POST (unRAID's webGUI rejects
 * POSTs without the page's csrf_token, so that check comes for free). */
require_once __DIR__ . '/lib.php';
/* Never hold the PHP session lock: a slow request (a Find, or a folder on a
 * disk that's spinning up) would otherwise make every other request wait. */
if (session_status() === PHP_SESSION_ACTIVE) session_write_close();

/* Raw file for the image/PDF viewer: a GET (read-only), limited to image
 * and PDF types so nothing that could run as a web page is ever served. */
if (($_GET['action'] ?? '') === 'raw') {
  $types = ['png' => 'image/png', 'jpg' => 'image/jpeg', 'jpeg' => 'image/jpeg', 'gif' => 'image/gif',
            'webp' => 'image/webp', 'bmp' => 'image/bmp', 'ico' => 'image/x-icon', 'avif' => 'image/avif',
            'heic' => 'image/heic', 'heif' => 'image/heif', 'tif' => 'image/tiff', 'tiff' => 'image/tiff',
            'svg' => 'image/svg+xml', 'pdf' => 'application/pdf'];
  try { $p = uc_path((string)($_GET['path'] ?? '')); } catch (Throwable $e) { http_response_code(403); exit; }
  $ext = strtolower(pathinfo($p, PATHINFO_EXTENSION));
  if (!isset($types[$ext]) || !is_file($p) || !is_readable($p)) { http_response_code(404); exit; }
  header('Content-Type: ' . $types[$ext]);
  header('Content-Length: ' . filesize($p));
  header('Content-Disposition: inline; filename="' . str_replace(['"', "\r", "\n"], '', basename($p)) . '"');
  header('X-Content-Type-Options: nosniff');
  header('Cache-Control: private, max-age=300');
  if ($ext === 'svg') header("Content-Security-Policy: default-src 'none'; style-src 'unsafe-inline'; img-src data:; sandbox");
  while (ob_get_level()) ob_end_clean();
  readfile($p);
  exit;
}

set_error_handler(function ($no, $str) {
  if (!(error_reporting() & $no)) return false;   // silenced with @
  throw new UcError(preg_replace('/^\w+\(\):\s*/', '', $str));
});

$req = $_POST;
if (empty($req) && ($raw = file_get_contents('php://input'))) $req = json_decode($raw, true) ?: [];
$action = $req['action'] ?? '';

function arg(string $k, $default = null) {
  global $req;
  if (!array_key_exists($k, $req)) {
    if ($default === null) throw new UcError("Missing $k");
    return $default;
  }
  return $req[$k];
}
function arg_list(string $k): array {
  $v = arg($k);
  if (is_string($v)) $v = json_decode($v, true);
  if (!is_array($v)) throw new UcError("Bad $k");
  return array_values($v);
}

try {
  switch ($action) {

    /* Names and types only — find's %y comes from readdir's d_type, so no
     * stat per entry. 3,445 entries in ~90 ms instead of ~7 s. */
    case 'list': {
      $t0 = microtime(true);
      /* /mnt is the top: it already holds user (all shares), every disk and
       * pool, and disks/ + remotes/ (Unassigned Devices). "/" opens it too. */
      $want = (string)arg('path');
      $dir = $want === '/' || $want === '' ? (uc_sys_allowed() && arg('sys', '0') === '1' ? '/' : '/mnt') : uc_path($want);
      if (!is_dir($dir)) throw new UcError("Not a folder: $dir");
      $cmd = 'find -H ' . escapeshellarg($dir) . ' -mindepth 1 -maxdepth 1 -printf ' . escapeshellarg('%y\t%f\0') . ' 2>/dev/null';
      $raw = shell_exec($cmd) ?? '';
      $items = [];
      foreach (explode("\0", $raw) as $rec) {
        if ($rec === '') continue;
        [$t, $n] = explode("\t", $rec, 2);
        $items[] = [$n, $t === 'd' ? 'd' : ($t === 'l' ? 'l' : 'f')];
      }
      $free = @disk_free_space($dir);
      /* inside a trash folder: say what each dated bin holds and where it came from */
      $origins = null;
      if (str_ends_with($dir, '/' . UC_TRASH)) {
        $origins = [];
        foreach ($items as [$n, $t]) if ($t === 'd' && is_file("$dir/$n/.uncommander-origin"))
          $origins[$n] = trim((string)@file_get_contents("$dir/$n/.uncommander-origin"));
      }
      uc_json(['path' => $dir, 'items' => $items, 'free' => $free === false ? null : $free,
               'writable' => is_writable($dir), 'trash' => str_ends_with($dir, '/' . UC_TRASH),
               'ms' => (int)round((microtime(true) - $t0) * 1000), 'origins' => $origins,
               'sig' => arg('watch', '0') === '1' ? (uc_watch_sigs([$dir])[$dir] ?? null) : null]);
    }

    /* Auto-refresh (opt-in, Settings > General): has an open folder changed?
     * One find -maxdepth 0 - it stats the folder itself, never lists it. A
     * share folder (/mnt/user/...) is checked on every disk that holds it,
     * since a file added on disk2 doesn't change the mtime the share shows. */
    case 'watch': {
      uc_json(['sig' => uc_watch_sigs(array_slice(array_values(array_filter(arg_list('paths'), 'is_string')), 0, 2))]);
    }

    /* Sizes, dates, perms — only for the rows on screen. */
    case 'stat': {
      $dir = uc_path(arg('path'));
      $out = [];
      foreach (arg_list('names') as $n) {
        $p = str_starts_with($n, '/') ? uc_path($n) : uc_join($dir, uc_name($n));
        $s = @lstat($p);
        if (!$s) { $out[$n] = null; continue; }
        $isLink = ($s['mode'] & 0170000) === 0120000;
        $isDir = $isLink ? is_dir($p) : ($s['mode'] & 0170000) === 0040000;
        $out[$n] = [
          's' => $isDir ? null : $s['size'],
          'm' => $s['mtime'],
          'p' => uc_mode_str($s['mode']),
          'o' => uc_owner($s['uid']),
          'g' => uc_group($s['gid']),
          'd' => $isDir,
          'l' => $isLink ? @readlink($p) : null,
        ];
      }
      uc_json(['stats' => $out]);
    }

    /* Disk column: where /mnt/user items physically live. */
    case 'locate': {
      $dir = uc_path(arg('path'));
      $paths = [];
      foreach (arg_list('names') as $n) {
        $p = str_starts_with($n, '/') ? uc_path($n) : uc_join($dir, uc_name($n));
        if (uc_view($p) === 'user') $paths[$n] = $p;
      }
      uc_json(['locs' => uc_locate($paths)]);
    }

    /* Tap a Disk cell: what's on each disk or pool for this /mnt/user item. */
    case 'where': {
      $p = uc_path(arg('path'));
      if (uc_view($p) !== 'user') throw new UcError('Only for /mnt/user paths');
      $rest = preg_replace('#^/mnt/user0?#', '', $p);
      $out = [];
      foreach (uc_array_mounts() as $d) {
        $q = "/mnt/$d$rest";
        if (!file_exists($q) && !is_link($q)) continue;
        $row = ['disk' => $d, 'path' => $q, 'dir' => is_dir($q), 'files' => 0, 'dirs' => 0, 'bytes' => 0, 'more' => false];
        if ($row['dir']) {
          $h = popen('find -H ' . escapeshellarg($q) . ' -mindepth 1 -printf ' . escapeshellarg("%y %s\n") . ' 2>/dev/null', 'r');
          $n = 0;
          while ($h && ($line = fgets($h)) !== false) {
            if (++$n > 50000) { $row['more'] = true; break; }
            if ($line[0] === 'd') $row['dirs']++; else { $row['files']++; $row['bytes'] += (int)substr($line, 2); }
          }
          if ($h) pclose($h);
        } else { $row['files'] = 1; $row['bytes'] = (int)@filesize($q); $row['mtime'] = @filemtime($q); }
        $out[] = $row;
      }
      uc_json(['where' => $out]);
    }

    /* What's inside an archive (Extract dialog summary, F3 on an archive). */
    case 'archive_list': {
      $a = uc_path(arg('path'));
      $r = uc_archive_list($a, 3000);
      uc_json($r + ['base' => uc_archive_base($a), 'kind' => uc_archive_kind($a), 'has7z' => is_executable(UC_7Z), 'parts' => array_map('basename', uc_archive_parts($a))]);
    }

    /* Compare (More row): the two panes' folders, top level only. For each
     * name: only on one side, newer/older (dates more than 2 s apart),
     * different (same date, different size), the same, or a folder on both. */
    case 'compare': {
      $L = uc_path(arg('left')); $R = uc_path(arg('right'));
      if (!is_dir($L) || !is_dir($R)) throw new UcError('Both panes need to show a folder');
      if ($L === $R) throw new UcError('Both panes show the same folder');
      $scan = function (string $d) {
        $o = [];
        foreach (scandir($d) ?: [] as $n) {
          if ($n === '.' || $n === '..') continue;
          $st = @lstat("$d/$n"); if (!$st) continue;
          $o[$n] = [is_dir("$d/$n"), $st['size'], $st['mtime']];
        }
        return $o;
      };
      $a = $scan($L); $b = $scan($R); $l = []; $r = [];
      foreach ($a as $n => [$ad, $as, $am]) {
        if (!isset($b[$n])) { $l[$n] = 'only'; continue; }
        [$bd, $bs, $bm] = $b[$n];
        if ($ad && $bd) { $l[$n] = $r[$n] = 'both'; continue; }
        if ($ad !== $bd) { $l[$n] = $r[$n] = 'differ'; continue; }
        if (abs($am - $bm) > 2) { $l[$n] = $am > $bm ? 'newer' : 'older'; $r[$n] = $am > $bm ? 'older' : 'newer'; continue; }
        $l[$n] = $r[$n] = $as !== $bs ? 'differ' : 'same';
      }
      foreach ($b as $n => $_) if (!isset($a[$n])) $r[$n] = 'only';
      uc_json(['left' => $l, 'right' => $r]);
    }

    /* Detailed compare (Compare window): walks both folders all the way down.
     * One row per difference. A folder that exists on one side only is a
     * single row (copying it copies everything inside). Folders on both sides
     * get no row of their own - their contents are compared instead. */
    case 'compare_tree': {
      $L = uc_path(arg('left')); $R = uc_path(arg('right'));
      if (!is_dir($L) || !is_dir($R)) throw new UcError('Both panes need to show a folder');
      if ($L === $R) throw new UcError('Both panes show the same folder');
      if (str_starts_with($R . '/', $L . '/') || str_starts_with($L . '/', $R . '/'))
        throw new UcError("One folder is inside the other - pick two separate folders");
      $el = uc_share_equiv($L, true); $er = uc_share_equiv($R, true);
      if ($el !== null && $el === $er) throw new UcError("These are the same folder seen two ways (through the share and through a disk) - there's nothing to compare");
      $LIMIT = 200000; $t0 = microtime(true); $cut = false;
      $walk = function (string $root) use ($LIMIT, $t0, &$cut) {
        $o = [];
        $cmd = 'find -H ' . escapeshellarg($root) . ' -mindepth 1 -name ' . escapeshellarg(UC_TRASH) . ' -prune -o -printf ' . escapeshellarg('%P\0%y\0%s\0%T@\0');
        $h = popen($cmd . ' 2>/dev/null', 'r');
        $buf = '';
        while ($h && !feof($h)) {
          $buf .= fread($h, 65536);
          $parts = explode("\0", $buf);
          $n = intdiv(count($parts) - 1, 4) * 4;
          for ($i = 0; $i < $n; $i += 4) $o[$parts[$i]] = [$parts[$i + 1] === 'd', (int)$parts[$i + 2], (int)$parts[$i + 3]];
          $buf = implode("\0", array_slice($parts, $n));
          if (count($o) > $LIMIT || microtime(true) - $t0 > 60) { $cut = true; break; }
        }
        if ($h) pclose($h);
        return $o;
      };
      $a = $walk($L); $b = $walk($R);
      $sides = [$a, $b];
      /* folders found on one side only: their contents fold into them */
      $lone = [];
      foreach ([0, 1] as $k) foreach ($sides[$k] as $p => [$d]) if ($d && !isset($sides[1 - $k][$p])) $lone[$p] = $k;
      $top = function (string $p) use ($lone) {
        $best = null;
        for ($q = $p; ($i = strrpos($q, '/')) !== false; ) { $q = substr($q, 0, $i); if (isset($lone[$q])) $best = $q; }
        return $best;
      };
      $rows = []; $agg = []; $same = 0; $sameRows = 0; $counts = [];
      $keys = array_keys($a + $b);
      foreach ($keys as $p) {
        $p = (string)$p;
        if (($t = $top($p)) !== null) {      // inside a one-sided folder
          $k = $lone[$t]; [$d, $sz] = $sides[$k][$p];
          if (!$d) { $agg[$t][0] = ($agg[$t][0] ?? 0) + 1; $agg[$t][1] = ($agg[$t][1] ?? 0) + $sz; }
          continue;
        }
        $x = $a[$p] ?? null; $y = $b[$p] ?? null;
        if ($x && $y && $x[0] && $y[0]) continue;   // folder on both sides
        if ($x && !$y) $st = 'only-l';
        elseif ($y && !$x) $st = 'only-r';
        elseif ($x[0] !== $y[0]) $st = 'differ';
        elseif (abs($x[2] - $y[2]) > 2) $st = $x[2] > $y[2] ? 'newer-l' : 'newer-r';
        else $st = $x[1] !== $y[1] ? 'differ' : 'same';
        $counts[$st] = ($counts[$st] ?? 0) + 1;
        if ($st === 'same' && ++$sameRows > 5000) continue;   // counted, not listed
        $rows[] = [$p, $st, $x ? [$x[0] ? 1 : 0, $x[1], $x[2]] : null, $y ? [$y[0] ? 1 : 0, $y[1], $y[2]] : null];
      }
      foreach ($rows as &$row) if (isset($lone[$row[0]])) {   // one-sided folder: total of what's inside
        $side = $row[2] ? 2 : 3; $row[$side][1] = $agg[$row[0]][1] ?? 0; $row[$side][3] = $agg[$row[0]][0] ?? 0;
      }
      unset($row);
      usort($rows, fn($m, $n) => strnatcasecmp($m[0], $n[0]));
      uc_json(['rows' => $rows, 'counts' => $counts, 'cut' => $cut, 'secs' => round(microtime(true) - $t0, 1),
               'scanned' => [count($a), count($b)], 'sameListed' => min($sameRows, 5000)]);
    }

    case 'mkdir': {
      $p = uc_join(uc_path(arg('path')), uc_name(trim(arg('name'))));
      if (file_exists($p)) throw new UcError('Already exists');
      mkdir($p, 0777);
      @chown($p, 'nobody'); @chgrp($p, 'users');
      uc_json(['ok' => true, 'name' => basename($p)]);
    }

    /* Undo of New Folder: only ever removes a folder that's still empty. */
    case 'rmdir_empty': {
      $p = uc_path(arg('path'));
      if (!is_dir($p) || is_link($p)) throw new UcError('That folder is gone already');
      if (count(scandir($p)) > 2) throw new UcError(basename($p) . ' has something in it now, so it was left alone');
      rmdir($p);
      uc_json(['ok' => true]);
    }

    case 'rename': {
      uc_practice_block('renaming');
      $dir = uc_path(arg('path'));
      $from = uc_join($dir, uc_name(arg('from')));
      $to = uc_join($dir, uc_name(trim(arg('to'))));
      if (file_exists($to)) throw new UcError('A file with that name already exists');
      rename($from, $to);
      uc_json(['ok' => true, 'name' => basename($to)]);
    }

    /* Batch rename: every pair in one go, all or nothing. Each item first gets
     * a temporary name, then its new one - so swaps (a <-> b) and case-only
     * changes work. If anything fails, everything goes back to how it was. */
    case 'batch_rename': {
      uc_practice_block('renaming');
      $dir = uc_path(arg('path'));
      $pairs = [];
      foreach (arg_list('pairs') as $pr) {
        if (!is_array($pr) || count($pr) !== 2) throw new UcError('Bad rename list');
        [$f, $t] = [uc_name((string)$pr[0]), uc_name((string)$pr[1])];
        if ($f !== $t) $pairs[] = [$f, $t];
      }
      if (!$pairs) throw new UcError('Nothing to rename');
      if (count($pairs) > 20000) throw new UcError('Too many at once (20,000 max)');
      $there = fn($n) => file_exists("$dir/$n") || is_link("$dir/$n");
      $from = array_column($pairs, 0); $to = array_column($pairs, 1);
      if (count(array_unique($from)) !== count($from)) throw new UcError('The same item is in the list twice');
      if (count(array_unique($to)) !== count($to)) throw new UcError('Two items would get the same name');
      $fromSet = array_flip($from); $probs = [];
      foreach ($pairs as [$f, $t]) {
        if (!$there($f)) $probs[] = "$f is gone";
        elseif ($there($t) && !isset($fromSet[$t]) && strcasecmp($f, $t) !== 0) $probs[] = "$t already exists";
        elseif (strlen($t) > 255) $probs[] = "$t is too long";
      }
      if ($probs) throw new UcError('Nothing was renamed: ' . implode('; ', array_slice($probs, 0, 5)) . (count($probs) > 5 ? ' (and ' . (count($probs) - 5) . ' more)' : ''));
      $tag = '.uc-rename-' . bin2hex(random_bytes(4)) . '-';
      $step1 = []; $step2 = []; $fail = null;
      foreach ($pairs as $i => [$f, $t]) {                 // 1: everything to a temporary name
        if (!@rename("$dir/$f", "$dir/$tag$i")) { $fail = $f; break; }
        $step1[] = $i;
      }
      if ($fail === null) foreach ($pairs as $i => [$f, $t]) {   // 2: temporary name to the new name
        if ($there($t) || !@rename("$dir/$tag$i", "$dir/$t")) { $fail = $f; break; }
        $step2[] = $i;
      }
      if ($fail !== null) {                                 // put it all back
        foreach (array_reverse($step2) as $i) @rename("$dir/{$pairs[$i][1]}", "$dir/$tag$i");
        $stuck = [];
        foreach (array_reverse($step1) as $i) if (!@rename("$dir/$tag$i", "$dir/{$pairs[$i][0]}")) $stuck[] = "$tag$i";
        throw new UcError("Couldn't rename $fail, so nothing was renamed" . ($stuck ? '. Some items still have a temporary name starting with .uc-rename: ' . implode(', ', $stuck) : ''));
      }
      uc_json(['ok' => true, 'count' => count($pairs), 'pairs' => $pairs]);
    }

    /* Delete = move into .uncommander-trash on the same share/disk. */
    case 'trash': {
      uc_practice_block('deleting');
      [$n, $bins] = uc_delete_paths(array_map('uc_path', arg_list('paths')), arg('forever', '0') === '1');
      uc_json(['ok' => true, 'count' => $n, 'bins' => $bins]);
    }

    /* Put trash bins back where they came from. Paths are bin folders. */
    case 'restore': {
      uc_practice_block('restoring from the trash');
      $done = [];
      foreach (arg_list('paths') as $raw) {
        $bin = uc_path($raw);
        if (!is_file("$bin/.uncommander-origin")) throw new UcError(basename($bin) . ' is not a trash entry');
        $orig = uc_path(trim(file_get_contents("$bin/.uncommander-origin")));
        if (is_file("$bin/.uncommander-merge")) {
          /* files set aside by a copy (replaced, or undone): put them back into that folder */
          if (!is_dir($orig)) @mkdir($orig, 0777, true);
          uc_merge_back("$bin/" . basename($orig), $orig);
          @unlink("$bin/.uncommander-origin"); @unlink("$bin/.uncommander-merge");
          exec('find ' . escapeshellarg($bin) . ' -depth -type d -empty -delete 2>/dev/null');
          @rmdir(dirname($bin));
          $done[] = $orig;
          continue;
        }
        if (file_exists($orig)) throw new UcError("Something already exists at $orig");
        if (!is_dir(dirname($orig))) mkdir(dirname($orig), 0777, true);
        rename("$bin/" . basename($orig), $orig);
        unlink("$bin/.uncommander-origin");
        @rmdir($bin);
        @rmdir(dirname($bin));            // the trash folder itself, if that was the last thing in it
        $done[] = $orig;
      }
      uc_json(['ok' => true, 'restored' => $done]);
    }

    /* Undo a finished copy, move or Compare copy: new copies go to the trash,
     * replaced files come back. mode=backups only puts replaced files back
     * (a move's undo moves the items themselves first). */
    case 'undo_job': {
      uc_practice_block('undoing a copy');
      $mode = arg('mode', 'full') === 'backups' ? 'backups' : 'full';
      $removed = 0; $restored = 0; $missing = 0;
      foreach (arg_list('ids') as $id) {
        $id = (string)$id;
        $j = uc_job_read($id);
        if ($j && in_array($j['state'], ['running', 'queued'], true)) throw new UcError('Wait for the copy to finish, then undo it');
        $m = uc_undo_meta($id);
        if (!$m) { $missing++; continue; }
        if (!empty($m['blocked']) && $mode === 'full') throw new UcError("That copy replaced files while the trash was switched off, so the old versions are gone and it can't be undone");
        $dest = $m['dest']; $bk = $m['bin'] ? $m['bin'] . '/' . basename($dest) : null;
        if ($mode === 'full') {
          $names = array_filter(explode("\0", (string)@file_get_contents(UC_UNDO . "/$id.written")), 'strlen');
          $dirs = []; $ubin = null; $trash = uc_settings()['trash'];
          foreach ($names as $n) {
            if ($n[0] === '/' || in_array('..', explode('/', $n), true)) continue;
            if (str_ends_with($n, '/')) { $dirs[] = rtrim($n, '/'); continue; }
            $p = "$dest/$n";
            if ($bk && (file_exists("$bk/$n") || is_link("$bk/$n"))) continue;   // replaced: its old version comes back below
            if (!is_link($p) && (!is_file($p))) continue;
            if (!$trash) { if (@unlink($p)) $removed++; continue; }
            if (!$ubin) { $ubin = uc_trash_merge_bin($dest, 'Undone copy'); @mkdir($ubin, 0700, true); uc_trash_merge_mark($ubin, $dest); }
            $t = "$ubin/" . basename($dest) . "/$n";
            if (!is_dir(dirname($t))) @mkdir(dirname($t), 0777, true);
            if (@rename($p, $t)) $removed++;
          }
        }
        if ($bk && is_dir($bk)) {
          $restored += uc_merge_back($bk, $dest);
          @unlink($m['bin'] . '/.uncommander-origin'); @unlink($m['bin'] . '/.uncommander-merge');
          exec('find ' . escapeshellarg($m['bin']) . ' -depth -type d -empty -delete 2>/dev/null');
        }
        if ($mode === 'full') {
          /* folders the copy made, deepest first, if they're empty now */
          usort($dirs, fn($a, $b) => substr_count($b, '/') <=> substr_count($a, '/'));
          foreach ($dirs as $d) if ($d !== '' && $d !== '.') @rmdir("$dest/$d");
        }
        @unlink(UC_UNDO . "/$id.json"); @unlink(UC_UNDO . "/$id.written");
      }
      if ($missing && !$removed && !$restored) throw new UcError("There's no record of that copy any more (the server may have restarted), so it can't be undone");
      uc_json(['ok' => true, 'removed' => $removed, 'restored' => $restored]);
    }

    /* Before copying with "Replace": which files would actually be replaced?
     * (rsync leaves a file alone when its size and date already match.) */
    case 'conflicts': {
      $mode = arg('mode', 'overwrite') === 'newer' ? 'newer' : 'overwrite';
      $dest = uc_path(arg('dest'));
      $pairs = [];
      foreach (arg_list('sources') as $src) { $src = uc_path($src); $pairs[] = [$src, uc_join($dest, basename($src))]; }
      $t0 = microtime(true); $count = 0; $bytes = 0; $sample = []; $cut = false; $seen = 0;
      $check = function (string $a, string $b) use ($mode, &$count, &$bytes, &$sample) {
        $x = @lstat($a); $y = @lstat($b);
        if (!$x || !$y || is_dir($b)) return;
        $differ = $x['size'] !== $y['size'] || $x['mtime'] !== $y['mtime'];
        $hit = $mode === 'overwrite' ? $differ : ($x['mtime'] > $y['mtime'] || ($x['mtime'] === $y['mtime'] && $x['size'] !== $y['size']));
        if (!$hit) return;
        $count++; $bytes += $y['size'];
        if (count($sample) < 8) $sample[] = $b;
      };
      foreach ($pairs as [$a, $b]) {
        if (!file_exists($b)) continue;
        if (!is_dir($a) || is_link($a)) { $check($a, $b); continue; }
        $it = new RecursiveIteratorIterator(new RecursiveDirectoryIterator($a, FilesystemIterator::SKIP_DOTS));
        foreach ($it as $p => $info) {
          if (++$seen > 100000 || microtime(true) - $t0 > 15) { $cut = true; break 2; }
          if ($info->isDir()) continue;
          $check($p, $b . substr($p, strlen($a)));
        }
      }
      uc_json(['count' => $count, 'bytes' => $bytes, 'sample' => $sample, 'cut' => $cut]);
    }

    case 'trash_info': {
      $bin = uc_path(arg('path'));
      $f = "$bin/.uncommander-origin";
      uc_json(['origin' => is_file($f) ? trim(file_get_contents($f)) : null]);
    }

    /* Find File, modelled on mc's dialog: start dir, ignore dirs, file name
     * (shell pattern or regex), content (plain/regex, case, whole words). */
    case 'find': {
      $on = fn($k, $d) => filter_var(arg($k, $d ? '1' : '0'), FILTER_VALIDATE_BOOLEAN);
      $start = uc_path(arg('path'));
      if (!is_dir($start)) throw new UcError("Start folder doesn't exist: $start");
      $name = trim((string)arg('name', ''));
      $text = (string)arg('text', '');
      $shell = $on('shell', true);    $nameCase = $on('name_case', false);
      $recursive = $on('recursive', true); $follow = $on('follow', false); $skipHidden = $on('skip_hidden', false);
      $regex = $on('regex', false);   $textCase = $on('text_case', false); $whole = $on('whole', false);
      $limit = 2000;

      $nameRe = null;
      if (!$shell && $name !== '') {
        $nameRe = '~' . str_replace('~', '\~', $name) . '~u' . ($nameCase ? '' : 'i');
        if (@preg_match($nameRe, '') === false) throw new UcError('File name is not a valid regular expression');
      }

      /* Ignore dirs: separated by ":" (as in mc) or ";".
       *   /mnt/user/appdata  → exactly that folder
       *   Media/Old          → relative to the start folder
       *   .git  or  cache*   → any folder with that name, anywhere */
      $prune = ['-name', UC_TRASH];
      if ($start === '/') array_push($prune, '-o', '-path', '/proc', '-o', '-path', '/sys', '-o', '-path', '/dev');   // kernel's live views: endless
      if ($skipHidden) array_push($prune, '-o', '(', '-name', '.*', '!', '-path', $start, ')');
      foreach (preg_split('/[:;]/', (string)arg('ignore', '')) as $ig) {
        $ig = trim($ig);
        if ($ig === '' || $ig === '.') continue;
        if ($ig[0] === '/') $test = ['-path', rtrim($ig, '/')];
        elseif (str_contains(rtrim($ig, '/'), '/')) $test = ['-path', rtrim($start, '/') . '/' . trim(preg_replace('#^\./#', '', $ig), '/')];
        else $test = ['-name', $ig];
        array_push($prune, '-o', ...$test);
      }

      $argv = ['timeout', '120', 'find'];
      $argv[] = $follow ? '-L' : '-H';      // -H: a share that is a link (an exclusive share, like appdata on the cache) is searched too
      $argv[] = $start;
      if (!$recursive) array_push($argv, '-mindepth', '1', '-maxdepth', '1');
      array_push($argv, '(', ...$prune);
      array_push($argv, ')', '-prune', '-o');
      if ($text !== '') array_push($argv, '-type', 'f');
      if ($shell && $name !== '' && $name !== '*') array_push($argv, $nameCase ? '-name' : '-iname', $name);
      $argv[] = '-print0';

      $cmd = implode(' ', array_map('escapeshellarg', $argv)) . ' 2>/dev/null';
      $fh = popen($cmd, 'r');
      $cands = []; $scanned = 0; $buf = '';
      $cap = $text === '' ? $limit + 1 : 500000;
      while (!feof($fh) && count($cands) < $cap) {
        $buf .= fread($fh, 65536);
        while (($z = strpos($buf, "\0")) !== false) {
          $p = substr($buf, 0, $z); $buf = substr($buf, $z + 1);
          if ($p === $start) continue;
          $scanned++;
          if ($nameRe && !preg_match($nameRe, basename($p))) continue;
          $cands[] = $p;
          if (count($cands) >= $cap) break;
        }
      }
      pclose($fh);

      $sortKey = fn($a, $b) => strnatcasecmp(dirname($a[0]), dirname($b[0])) ?: strnatcasecmp(basename($a[0]), basename($b[0])) ?: (($a[2] ?? 0) <=> ($b[2] ?? 0));
      if ($text !== '') {
        /* One entry per matching line, like mc: grep -n gives "file\0line:text". */
        $tmp = tempnam(sys_get_temp_dir(), 'ucf');
        file_put_contents($tmp, implode("\0", $cands));
        $g = ['grep', '-n', '-H', '-Z', '-I', '-s', '-m', '200'];
        if (!$textCase) $g[] = '-i';
        if ($whole) $g[] = '-w';
        $g[] = $regex ? '-E' : '-F';
        array_push($g, '-e', $text);
        $cmd = 'timeout 120 xargs -0 -r -a ' . escapeshellarg($tmp) . ' ' . implode(' ', array_map('escapeshellarg', $g))
             . ' 2>/dev/null | head -n ' . ($limit + 1);
        $items = [];
        foreach ($cands ? explode("\n", shell_exec($cmd) ?? '') : [] as $ln) {
          $z = strpos($ln, "\0");
          if ($z === false || !preg_match('/^(\d+):(.*)$/s', substr($ln, $z + 1), $m)) continue;
          $snip = trim(mb_convert_encoding(substr($m[2], 0, 600), 'UTF-8', 'UTF-8'));
          if (mb_strlen($snip) > 200) $snip = mb_substr($snip, 0, 200) . '…';
          $items[] = [substr($ln, 0, $z), 'f', (int)$m[1], $snip];
        }
        unlink($tmp);
        $more = count($items) > $limit;
        $items = array_slice($items, 0, $limit);
        usort($items, $sortKey);
        uc_json(['start' => $start, 'items' => $items, 'truncated' => $more, 'scanned' => $scanned, 'lines' => true]);
      }
      $more = count($cands) > $limit;
      $items = [];
      foreach (array_slice($cands, 0, $limit) as $h) $items[] = [$h, is_dir($h) ? 'd' : 'f'];
      usort($items, $sortKey);
      uc_json(['start' => $start, 'items' => $items, 'truncated' => $more, 'scanned' => $scanned]);
    }

    /* Viewer. Small files come back whole; big ones as a window of lines
     * around the requested line, so a hit deep in a log still opens fast. */
    case 'peek': {
      $p = uc_path(arg('path'));
      if (!is_file($p)) throw new UcError('Not a file');
      $size = filesize($p);
      $fh = fopen($p, 'rb');
      $head = fread($fh, 8192);
      if (str_contains($head, "\0")) { fclose($fh); uc_json(['binary' => true, 'size' => $size]); }
      $want = max(1, (int)arg('line', '1'));
      rewind($fh);
      if ($size <= 524288) {
        $text = stream_get_contents($fh); $first = 1; $more = false;
      } else {
        $from = max(1, $want - 300); $to = $from + 1999;
        $n = 0; $buf = []; $bytes = 0; $more = false;
        while (($l = fgets($fh)) !== false) {
          $n++;
          if ($n < $from) continue;
          if ($n > $to || $bytes > 2097152) { $more = true; break; }
          $buf[] = $l; $bytes += strlen($l);
        }
        $text = implode('', $buf); $first = $from;
      }
      fclose($fh);
      uc_json(['binary' => false, 'text' => mb_convert_encoding($text, 'UTF-8', 'UTF-8'), 'first' => $first,
               'size' => $size, 'partial' => $size > 524288, 'more' => $more, 'mtime' => filemtime($p)]);
    }

    /* Editor: text files up to 5 MB, saved in place so owner and
     * permissions stay as they were. */
    case 'open_edit': {
      $p = uc_path(arg('path'));
      if (!is_file($p)) throw new UcError('Not a file');
      $size = filesize($p);
      if ($size > 5242880) throw new UcError('Too large to edit here (limit 5 MB)');
      $s = file_get_contents($p);
      if (str_contains($s, "\0")) throw new UcError("Not a text file — it can't be edited here");
      if (!mb_check_encoding($s, 'UTF-8')) throw new UcError("This file isn't plain UTF-8 text, so editing it here could damage it");
      uc_json(['text' => str_replace("\r\n", "\n", $s), 'crlf' => str_contains($s, "\r\n"), 'mtime' => filemtime($p),
               'size' => $size, 'writable' => is_writable($p)]);
    }

    case 'save_edit': {
      uc_practice_block('saving edits');
      $p = uc_path(arg('path'));
      if (!is_file($p)) throw new UcError('The file no longer exists');
      clearstatcache(true, $p);
      if (arg('force', '0') !== '1' && (string)filemtime($p) !== (string)arg('mtime'))
        uc_json(['error' => 'changed', 'message' => 'The file changed on disk since you opened it'], 409);
      $s = (string)arg('text');
      if (arg('crlf', '0') === '1') $s = str_replace("\n", "\r\n", $s);
      if (file_put_contents($p, $s, LOCK_EX) === false) throw new UcError('Could not write the file');
      clearstatcache(true, $p);
      uc_json(['ok' => true, 'mtime' => filemtime($p), 'size' => filesize($p)]);
    }

    /* Settings live on the flash drive, so they're the same on every device:
     * shortcut buttons, custom CSS, sounds, and trash retention. */
    case 'get_settings': {
      uc_json(['settings' => uc_settings()]);
    }

    case 'save_settings': {
      $in = arg('settings');
      if (is_string($in)) $in = json_decode($in, true);
      if (!is_array($in)) throw new UcError('Bad settings');
      $bms = [];
      foreach (array_slice((array)($in['bookmarks'] ?? []), 0, 40) as $b) {
        $label = trim(mb_substr((string)($b['label'] ?? ''), 0, 40));
        $path = trim((string)($b['path'] ?? ''));
        if ($path === '') continue;
        $path = uc_path($path);
        $bms[] = ['label' => $label !== '' ? $label : (basename($path) ?: $path), 'path' => $path];
      }
      $css = (string)($in['css'] ?? '');
      if (strlen($css) > 65536) throw new UcError('Custom CSS is too long (64 KB max)');
      $snd = (array)($in['sounds'] ?? []);
      $out = [
        'bookmarks' => $bms,
        'css' => $css,
        'tap_mode' => in_array($in['tap_mode'] ?? 'auto', ['always', 'never'], true) ? $in['tap_mode'] : 'auto',
        'menu_name' => uc_clean_menu_name($in['menu_name'] ?? ''),
        'practice' => !empty($in['practice']),
        'sysmode' => !empty($in['sysmode']),
        'theme' => ($in['theme'] ?? '') === 'mc' ? 'mc' : 'standard',
        'toolbtns' => ['movies' => !empty($in['toolbtns']['movies']), 'tv' => !empty($in['toolbtns']['tv'])],
        'highlight' => !array_key_exists('highlight', $in) || !empty($in['highlight']),
        'autorefresh' => ['on' => !empty($in['autorefresh']['on']), 'secs' => in_array((int)($in['autorefresh']['secs'] ?? 10), [5, 10, 30, 60], true) ? (int)$in['autorefresh']['secs'] : 10],
        'radarr' => isset($in['radarr']) && is_array($in['radarr']) ? uc_radarr_clean($in['radarr'], uc_radarr_cfg()) : uc_radarr_cfg(),
        'sonarr' => isset($in['sonarr']) && is_array($in['sonarr']) ? uc_sonarr_clean($in['sonarr'], uc_sonarr_cfg()) : uc_sonarr_cfg(),
        'trash' => !array_key_exists('trash', $in) || !empty($in['trash']),
        'notify_unraid' => !array_key_exists('notify_unraid', $in) || !empty($in['notify_unraid']),
        'sounds' => [
          'enabled' => !empty($snd['enabled']),
          'volume'  => max(0, min(100, (int)($snd['volume'] ?? 40))),
          'buttons' => !empty($snd['buttons']), 'nav' => !empty($snd['nav']),
          'taps' => !empty($snd['taps']), 'errors' => !empty($snd['errors']),
        ],
      ];
      @mkdir(dirname(UC_CFG), 0777, true);
      $f = dirname(UC_CFG) . '/settings.json';
      file_put_contents("$f.tmp", json_encode($out, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE));
      rename("$f.tmp", $f);
      if (isset($in['trash_days'])) {
        $days = max(0, min(3650, (int)$in['trash_days']));
        $cfg = is_file(UC_CFG) ? file_get_contents(UC_CFG) : '';
        $cfg = preg_match('/^TRASH_DAYS=.*$/m', $cfg) ? preg_replace('/^TRASH_DAYS=.*$/m', "TRASH_DAYS=\"$days\"", $cfg) : rtrim($cfg) . ($cfg ? "\n" : '') . "TRASH_DAYS=\"$days\"\n";
        file_put_contents(UC_CFG, $cfg);
      }
      uc_apply_menu_name($out['menu_name']);
      uc_json(['ok' => true, 'settings' => uc_settings()]);
    }

    case 'job_start': {
      $type = arg('type');
      if (!in_array($type, ['copy', 'move', 'perms', 'compress', 'extract', 'sync'], true)) throw new UcError('Bad job type');
      if ($type === 'sync') {
        /* from the Compare window: copy an exact list of paths (relative to
         * one compared folder) to the same places under the other one */
        $root = uc_path(arg('root')); $dest = uc_path(arg('dest'));
        if (!is_dir($root) || !is_dir($dest)) throw new UcError('Both compared folders need to exist');
        if (str_starts_with($dest . '/', $root . '/') || str_starts_with($root . '/', $dest . '/')) throw new UcError('One folder is inside the other');
        $rel = [];
        foreach (arg_list('rel') as $r) {
          $r = (string)$r;
          if ($r === '' || $r[0] === '/' || str_contains($r, "\0") || in_array('..', explode('/', $r), true) || in_array('.', explode('/', $r), true))
            throw new UcError('Bad path in the list: ' . $r);
          if (!file_exists("$root/$r") && !is_link("$root/$r")) throw new UcError("$r is no longer in $root - compare again");
          $rel[] = $r;
        }
        if (!$rel) throw new UcError('Nothing to copy');
        $over = arg('overwrite', '0') === '1';
        if ($over) uc_practice_block('replacing existing files');
        $job = ['id' => bin2hex(random_bytes(6)), 'type' => 'sync', 'sources' => [$root], 'root' => $root, 'dest' => $dest, 'rel' => $rel,
                'exists' => $over ? 'overwrite' : 'skip', 'state' => 'queued', 'created' => time(), 'pct' => 0, 'bytes' => 0,
                'speed' => '', 'eta' => '', 'file' => '', 'error' => null,
                'label' => 'Copy ' . count($rel) . ' item' . (count($rel) === 1 ? '' : 's') . " from compare → $dest"];
        uc_job_write($job);
        uc_job_touch($job['id']);
        $php = PHP_BINARY && !str_contains(PHP_BINARY, 'fpm') ? PHP_BINARY : 'php';
        exec('setsid nohup ' . escapeshellarg($php) . ' -d memory_limit=1024M ' . escapeshellarg(__DIR__ . '/worker.php') . ' ' . escapeshellarg($job['id']) . ' >/dev/null 2>&1 &');
        uc_json(['ok' => true, 'job' => $job['id']]);
      }
      if ($type === 'move') uc_practice_block('moving');
      if ($type === 'perms') uc_practice_block('changing permissions');
      $sources = array_map('uc_path', arg_list('sources'));
      if (!$sources) throw new UcError('Nothing selected');
      $job = ['id' => bin2hex(random_bytes(6)), 'type' => $type, 'sources' => $sources,
              'state' => 'queued', 'created' => time(), 'pct' => 0, 'bytes' => 0,
              'speed' => '', 'eta' => '', 'file' => '', 'error' => null];

      if ($type === 'compress') {
        $dest = uc_path(arg('dest'));
        if (!is_dir($dest)) throw new UcError("Save-to folder isn't a folder");
        $fmt = arg('format', 'zip') === 'tgz' ? 'tgz' : 'zip';
        $name = uc_name(trim((string)arg('name')));
        $ext = $fmt === 'zip' ? '.zip' : '.tar.gz';
        if (!str_ends_with(strtolower($name), $ext)) $name .= $ext;
        $out = uc_join($dest, $name);
        if (file_exists($out)) throw new UcError("$name already exists there - pick another name");
        $srcdir = dirname($sources[0]);
        foreach ($sources as $s) {
          if (dirname($s) !== $srcdir) throw new UcError('Everything to compress must be in the same folder');
          if ($dest === $s || str_starts_with($dest . '/', $s . '/')) throw new UcError("Can't save the archive inside " . basename($s) . ' - it would end up inside itself');
        }
        $remove = arg('remove', '0') === '1';
        if ($remove) uc_practice_block('deleting the originals');
        $job += ['dest' => $dest, 'out' => $out, 'srcdir' => $srcdir, 'format' => $fmt, 'store' => arg('store', '0') === '1', 'remove' => $remove];
        $job['label'] = 'Compress ' . (count($sources) === 1 ? basename($sources[0]) : count($sources) . ' items') . " → $name in $dest";
      } elseif ($type === 'extract') {
        $a = $sources[0];
        if (!is_file($a)) throw new UcError('Pick an archive file');
        $kind = uc_archive_kind($a);
        if (!$kind) throw new UcError(basename($a) . " isn't an archive unCommander can open");
        if ($kind === '7z' && !is_executable(UC_7Z)) throw new UcError('7-Zip is needed for ' . basename($a) . " but isn't installed - reinstall unCommander while the server is online");
        $dest = uc_path(arg('dest'));
        if (!is_dir($dest)) throw new UcError("Destination isn't a folder");
        $sub = trim((string)arg('sub', ''));
        $target = $sub !== '' ? uc_join($dest, uc_name($sub)) : $dest;
        $ex = arg('exists', 'skip') === 'overwrite' ? 'overwrite' : 'skip';
        if ($ex !== 'skip') uc_practice_block('replacing existing files');
        $remove = arg('remove', '0') === '1';
        if ($remove) uc_practice_block('deleting the archive');
        $job += ['dest' => $dest, 'target' => $target, 'made' => $sub !== '' && !file_exists($target), 'kind' => $kind, 'exists' => $ex, 'remove' => $remove];
        $job['label'] = 'Extract ' . basename($a) . " → $target";
      } elseif ($type === 'perms') {
        $o = arg('options', []);
        if (is_string($o)) $o = json_decode($o, true) ?: [];
        $job['options'] = [
          'preset'    => !empty($o['preset']),
          'owner'     => preg_match('/^[a-z_][a-z0-9_-]*$/i', $o['owner'] ?? '') ? $o['owner'] : '',
          'group'     => preg_match('/^[a-z_][a-z0-9_-]*$/i', $o['group'] ?? '') ? $o['group'] : '',
          'mode'      => preg_match('/^[0-7]{3,4}$/', $o['mode'] ?? '') ? $o['mode'] : '',
          'recursive' => !empty($o['recursive']),
        ];
        $job['label'] = 'Permissions · ' . count($sources) . ' item' . (count($sources) > 1 ? 's' : '');
      } else {
        $dest = uc_path(arg('dest'));
        if (!is_dir($dest)) throw new UcError("Destination isn't a folder");
        uc_guard_views($sources, $dest);
        foreach ($sources as $s) if (dirname($s) === $dest) throw new UcError('Source and destination are the same folder');
        $ex = arg('exists', 'skip');
        $job['dest'] = $dest;
        $job['exists'] = in_array($ex, ['skip', 'overwrite', 'newer'], true) ? $ex : 'skip';
        if ($job['exists'] !== 'skip') uc_practice_block('replacing existing files');

        if ($type === 'move') {
          /* Same filesystem → rename(), instant. Only the leftovers need rsync. */
          $left = []; $moved = [];
          foreach ($sources as $s) {
            $t = uc_join($dest, basename($s));
            $ss = @stat($s); $ds = @stat($dest);
            if (!file_exists($t) && $ss && $ds && $ss['dev'] === $ds['dev'] && @rename($s, $t)) { $moved[] = [$s, $t]; continue; }
            $left[] = $s;
          }
          if (!$left) uc_json(['ok' => true, 'instant' => true, 'moved' => $moved]);
          $job['moved'] = $moved;
          $job['sources'] = $sources = $left;
        }
        $job['label'] = ($type === 'copy' ? 'Copy ' : 'Move ') . count($sources) . ' item' . (count($sources) > 1 ? 's' : '') . ' → ' . $dest;
      }

      uc_job_write($job);
      uc_job_touch($job['id']);        // the page opens its progress window for it straight away
      $php = PHP_BINARY && !str_contains(PHP_BINARY, 'fpm') ? PHP_BINARY : 'php';
      exec('setsid nohup ' . escapeshellarg($php) . ' -d memory_limit=1024M ' . escapeshellarg(__DIR__ . '/worker.php')
           . ' ' . escapeshellarg($job['id']) . ' >/dev/null 2>&1 &');
      uc_json(['ok' => true, 'job' => $job['id'], 'moved' => $job['moved'] ?? []]);
    }

    /* ---------- Tools: background scans (read-only) ---------- */
    case 'mounts': {
      $shares = [];
      foreach (scandir('/mnt/user') ?: [] as $n) if ($n[0] !== '.' && is_dir("/mnt/user/$n")) $shares[] = $n;
      uc_json(['mounts' => uc_array_mounts(), 'shares' => $shares]);
    }
    /* ---------- Radarr ---------- */
    /* Try the address and key typed in Settings (or the saved ones): version,
     * quality profiles, root folders, and how those map to server folders. */
    case 'radarr_test': {
      $in = arg('radarr', []); if (is_string($in)) $in = json_decode($in, true) ?: [];
      $c = uc_radarr_clean((array)$in, uc_radarr_cfg());
      $status = uc_radarr_req($c, 'GET', 'system/status');
      if (!is_array($status) || empty($status['version'])) throw new UcError("That address answered, but it doesn't look like Radarr");
      $profiles = array_map(fn($p) => ['id' => $p['id'], 'name' => $p['name']], (array)uc_radarr_req($c, 'GET', 'qualityprofile'));
      $mounts = uc_radarr_mounts();
      $roots = [];
      foreach ((array)uc_radarr_req($c, 'GET', 'rootfolder') as $r) {
        $rp = rtrim($r['path'] ?? '', '/') ?: '/';
        /* the Docker mapping that holds this root folder (longest match) */
        $host = null; $len = -1;
        foreach ($mounts as $dst => $src) if (($rp === $dst || str_starts_with($rp . '/', $dst . '/')) && strlen($dst) > $len) { $host = $src . substr($rp, strlen($dst)); $len = strlen($dst); }
        $saved = null; foreach ($c['map'] as $m) if ($m['radarr'] === $rp) $saved = $m['host'];
        $roots[] = ['radarr' => $rp, 'host' => $saved ?? $host, 'detected' => $host, 'free' => $r['freeSpace'] ?? null];
      }
      uc_json(['ok' => true, 'version' => $status['version'], 'name' => $status['instanceName'] ?? 'Radarr', 'profiles' => $profiles, 'roots' => $roots, 'docker' => (bool)$mounts]);
    }
    case 'sonarr_test': {
      $in = arg('sonarr', []); if (is_string($in)) $in = json_decode($in, true) ?: [];
      $c = uc_sonarr_clean((array)$in, uc_sonarr_cfg());
      $status = uc_sonarr_req($c, 'GET', 'system/status');
      if (!is_array($status) || empty($status['version'])) throw new UcError("That address answered, but it doesn't look like Sonarr");
      $profiles = array_map(fn($p) => ['id' => $p['id'], 'name' => $p['name']], (array)uc_sonarr_req($c, 'GET', 'qualityprofile'));
      $mounts = uc_sonarr_mounts();
      $roots = [];
      foreach ((array)uc_sonarr_req($c, 'GET', 'rootfolder') as $r) {
        $rp = rtrim($r['path'] ?? '', '/') ?: '/';
        /* the Docker mapping that holds this root folder (longest match) */
        $host = null; $len = -1;
        foreach ($mounts as $dst => $src) if (($rp === $dst || str_starts_with($rp . '/', $dst . '/')) && strlen($dst) > $len) { $host = $src . substr($rp, strlen($dst)); $len = strlen($dst); }
        $saved = null; foreach ($c['map'] as $m) if ($m['sonarr'] === $rp) $saved = $m['host'];
        $roots[] = ['sonarr' => $rp, 'host' => $saved ?? $host, 'detected' => $host, 'free' => $r['freeSpace'] ?? null];
      }
      $langs = [];
      try { $langs = array_map(fn($p) => ['id' => $p['id'], 'name' => $p['name']], (array)uc_sonarr_req($c, 'GET', 'languageprofile')); } catch (UcError $e) {}   // Sonarr v3 only
      uc_json(['langs' => $langs, 'ok' => true, 'version' => $status['version'], 'name' => $status['instanceName'] ?? 'Sonarr', 'profiles' => $profiles, 'roots' => $roots, 'docker' => (bool)$mounts]);
    }
    /* Send a show's missing episodes to Sonarr. If Sonarr doesn't have the show,
     * it's added with its existing folder and nothing wanted; then only the
     * missing episodes are marked wanted and searched. Files already in the
     * folder are never touched. Right after adding, Sonarr needs a few seconds
     * to load the episode list - then this answers "waiting" and the page asks
     * again. */
    case 'sonarr_send': {
      $c = uc_sonarr_cfg();
      if (!$c['profile']) throw new UcError('Pick a quality profile for Sonarr first (Settings > Tools)');
      $folder = uc_path(arg('path'));
      if (!is_dir($folder)) throw new UcError('That folder is gone');
      $tvdb = (int)arg('tvdb', '0');
      if ($tvdb < 1) throw new UcError("TVmaze has no TheTVDB id for this show, and Sonarr needs one - add it in Sonarr by hand");
      $want = array_values(array_filter((array)json_decode((string)arg('eps', '[]'), true), 'is_array'));
      if (!$want) throw new UcError('No missing episodes to send');
      $rpath = uc_sonarr_path($c, $folder);
      if ($rpath === null) throw new UcError("Sonarr can't see this folder: none of its root folders points at " . dirname($folder) . ' (check the folder pairs in Settings > Tools)');
      $hist = uc_sonarr_hist()[$folder] ?? [];
      /* 1. the series in Sonarr - or add it */
      $series = null;
      foreach ((array)uc_sonarr_req($c, 'GET', 'series?tvdbId=' . $tvdb) as $x) if ((int)($x['tvdbId'] ?? 0) === $tvdb) $series = $x;
      $added = !empty($hist['added']);
      if (!$series) {
        $look = (array)uc_sonarr_req($c, 'GET', 'series/lookup?term=' . rawurlencode('tvdb:' . $tvdb));
        $info = $look[0] ?? null;
        if (!$info) throw new UcError("Sonarr couldn't find this show by its TheTVDB id ($tvdb)");
        $type = in_array(arg('type', ''), ['Talk Show', 'News'], true) ? 'daily' : 'standard';
        $body = array_merge($info, [
          'qualityProfileId' => (int)$c['profile'], 'path' => $rpath, 'monitored' => true, 'seasonFolder' => true, 'seriesType' => $type,
          'seasons' => array_map(fn($ss) => ['seasonNumber' => $ss['seasonNumber'], 'monitored' => false], (array)($info['seasons'] ?? [])),
          'addOptions' => ['monitor' => 'none', 'searchForMissingEpisodes' => false, 'searchForCutoffUnmetEpisodes' => false, 'ignoreEpisodesWithFiles' => true, 'ignoreEpisodesWithoutFiles' => true],
        ]);
        unset($body['id'], $body['rootFolderPath']);
        $lang = (int)arg('lang', '0');
        if (!$lang) { try { $lp = (array)uc_sonarr_req($c, 'GET', 'languageprofile'); $lang = (int)($lp[0]['id'] ?? 0); } catch (UcError $e) {} }
        if ($lang) $body['languageProfileId'] = $lang;
        $series = uc_sonarr_req($c, 'POST', 'series', $body);
        $added = true;
        uc_sonarr_note($folder, ['state' => 'adding', 'seriesId' => $series['id'] ?? 0, 'added' => true, 'title' => $series['title'] ?? '', 'dismissed' => false]);
      } elseif (empty($series['monitored'])) {
        $full = uc_sonarr_req($c, 'GET', 'series/' . (int)$series['id']); $full['monitored'] = true;
        uc_sonarr_req($c, 'PUT', 'series/' . (int)$series['id'], $full);
      }
      $sid = (int)($series['id'] ?? 0);
      /* 2. its episodes (empty for a few seconds after adding) */
      $eps = (array)uc_sonarr_req($c, 'GET', 'episode?seriesId=' . $sid);
      if (!$eps) uc_json(['status' => 'waiting', 'seriesId' => $sid, 'added' => $added]);
      $byNum = []; $byDate = [];
      foreach ($eps as $e) { $byNum[(int)$e['seasonNumber'] . '.' . (int)$e['episodeNumber']] = $e; if (!empty($e['airDate'])) $byDate[$e['airDate']][] = $e; }
      $ids = []; $sent = []; $nf = [];
      foreach ($want as $w) {
        [$sn, $en, $ad] = array_pad($w, 3, '');
        $e = $byNum["$sn.$en"] ?? (($ad !== '' && count($byDate[$ad] ?? []) === 1) ? $byDate[$ad][0] : null);
        if (!$e) { $nf[] = [(int)$sn, (int)$en]; continue; }
        if (!empty($e['hasFile'])) continue;            // Sonarr already has it
        $ids[] = (int)$e['id']; $sent[] = "$sn.$en";
      }
      if (!$ids && !$nf) uc_json(['status' => 'have', 'seriesId' => $sid, 'added' => $added]);
      if (!$ids) throw new UcError("Sonarr's episode numbers don't match these episodes (it may use a different order) - " . count($nf) . ' not found');
      /* 3. wanted + search */
      uc_sonarr_req($c, 'PUT', 'episode/monitor', ['episodeIds' => $ids, 'monitored' => true]);
      /* the seasons these episodes are in are monitored too - shows unCommander adds start
       * with every season off - so Sonarr's Wanted list and later RSS grabs include them */
      $wantSeasons = [];
      foreach ($eps as $e) if (in_array((int)$e['id'], $ids, true)) $wantSeasons[(int)$e['seasonNumber']] = true;
      try {
        $full = uc_sonarr_req($c, 'GET', "series/$sid"); $chg = false;
        foreach ((array)($full['seasons'] ?? []) as $k => $se) if (isset($wantSeasons[(int)($se['seasonNumber'] ?? -1)]) && empty($se['monitored'])) { $full['seasons'][$k]['monitored'] = true; $chg = true; }
        if (empty($full['monitored'])) { $full['monitored'] = true; $chg = true; }
        if ($chg) uc_sonarr_req($c, 'PUT', "series/$sid", $full);
      } catch (UcError $x) {}
      /* a season with every aired episode missing is searched as a season: releases of a
       * whole season usually come as one pack, which an episode-by-episode search skips */
      $today = gmdate('Y-m-d'); $packs = []; $rest = $ids;
      foreach (array_keys($wantSeasons) as $sn) {
        if ($sn < 1) continue;
        /* every aired episode of the season - not just the ones Sonarr has no file for -
         * must be among the ones asked for; otherwise it's a few episodes, searched singly */
        $aired = []; $anyFile = false;
        foreach ($eps as $e) {
          if ((int)$e['seasonNumber'] !== $sn) continue;
          if (!empty($e['hasFile'])) $anyFile = true;
          if (!empty($e['airDate']) && $e['airDate'] <= $today) $aired[] = (int)$e['id'];
        }
        if (!$anyFile && count($aired) >= 2 && !array_diff($aired, $ids)) { $packs[] = $sn; $rest = array_values(array_diff($rest, $aired)); }
      }
      $search = !empty($c['search']);
      if ($search) {
        /* whole missing seasons: the season pack first, then every episode on its own too -
         * often there's no pack. Episodes a grabbed pack covers are already in Sonarr's queue
         * by then, so the episode search skips them (no doubles). */
        foreach ($packs as $sn) uc_sonarr_req($c, 'POST', 'command', ['name' => 'SeasonSearch', 'seriesId' => $sid, 'seasonNumber' => $sn]);
        uc_sonarr_req($c, 'POST', 'command', ['name' => 'EpisodeSearch', 'episodeIds' => $ids]);
      }
      $note = uc_sonarr_note($folder, ['state' => 'sent', 'seriesId' => $sid, 'added' => $added, 'title' => $series['title'] ?? '', 'eps' => array_values(array_unique(array_merge((array)($hist['eps'] ?? []), $sent))), 'notfound' => $nf, 'searching' => $search, 'packs' => $packs, 'dismissed' => false]);
      uc_json(['status' => 'sent', 'count' => count($ids), 'notfound' => $nf, 'added' => $added, 'searching' => $search, 'packs' => $packs, 'sn' => $note]);
    }
    /* look in one show folder again (after downloads arrived) */
    case 'tv_recheck': {
      require_once __DIR__ . '/tvparse.php';
      $path = uc_path(arg('path'));
      if (!is_dir($path)) throw new UcError('That folder is gone');
      $eps = json_decode((string)arg('eps', '[]'), true) ?: [];
      $have = uc_tv_folder_have($path, $eps, $odd, $info);
      uc_json(['have' => $have, 'odd' => (object)$odd] + $info);
    }
    /* take the show out of Sonarr (files stay), or just drop it from the list */
    /* Downloads Sonarr finished but won't import on its own ("matched to series by ID",
     * "manual import required" ...) for the shows unCommander sent to it. */
    case 'sonarr_stuck': {
      $c = uc_sonarr_cfg();
      if ($c['host'] === '' || $c['key'] === '') uc_json(['stuck' => (object)[]]);
      $out = []; $n = 0;
      foreach (uc_sonarr_hist() as $path => $e) {
        $sid = (int)($e['seriesId'] ?? 0);
        if (!$sid || ($e['state'] ?? '') !== 'sent' || !empty($e['dismissed']) || ++$n > 25) continue;
        try { $q = (array)uc_sonarr_req($c, 'GET', "queue/details?seriesId=$sid&includeEpisode=true"); }
        catch (UcError $x) { if (str_starts_with($x->getMessage(), "Can't reach")) uc_json(['stuck' => (object)[], 'note' => $x->getMessage()]); continue; }
        $by = [];
        foreach ($q as $it) {
          if (!is_array($it) || (int)($it['seriesId'] ?? $sid) !== $sid) continue;
          $state = (string)($it['trackedDownloadState'] ?? ''); $status = (string)($it['trackedDownloadStatus'] ?? '');
          $blocked = in_array($state, ['importBlocked', 'importPending', 'importFailed', 'failedPending'], true) || ($status === 'warning' && in_array(strtolower((string)($it['status'] ?? '')), ['completed', 'warning'], true));
          if (!$blocked || $state === 'importing' || $state === 'downloading') continue;
          $dl = (string)($it['downloadId'] ?? ''); if ($dl === '') continue;
          $msgs = [];
          foreach ((array)($it['statusMessages'] ?? []) as $m) foreach ((array)($m['messages'] ?? []) as $t) $msgs[] = (string)$t;
          $b = $by[$dl] ?? ['downloadId' => $dl, 'title' => (string)($it['title'] ?? ''), 'msgs' => [], 'eps' => []];
          $b['msgs'] = array_values(array_unique(array_merge($b['msgs'], $msgs)));
          if (isset($it['episode']['seasonNumber'], $it['episode']['episodeNumber'])) $b['eps'][] = sprintf('S%02dE%02d', $it['episode']['seasonNumber'], $it['episode']['episodeNumber']);
          $by[$dl] = $b;
        }
        if ($by) $out[$path] = array_values($by);
      }
      uc_json(['stuck' => (object)$out]);
    }
    /* Import one such download - what Sonarr's own Manual Import does. Only files Sonarr
     * itself has matched to episodes, with nothing permanently wrong, are imported. */
    case 'sonarr_import': {
      uc_practice_block('import into Sonarr');
      $p = uc_path(arg('path')); $dl = (string)arg('downloadId');
      if ($dl === '' || !preg_match('/^[\w.:-]{1,200}$/', $dl)) throw new UcError('Bad download id');
      $e = uc_sonarr_hist()[$p] ?? []; $sid = (int)($e['seriesId'] ?? 0);
      if (!$sid) throw new UcError('unCommander has no record of this show in Sonarr');
      $c = uc_sonarr_cfg();
      /* which episodes Sonarr grabbed this download for (from its queue) - used when it
       * can't tell from the file name, which is exactly the "matched by ID" case */
      $qeps = []; $qseason = null; $out = ''; $title = '';
      try {
        foreach ((array)uc_sonarr_req($c, 'GET', "queue/details?seriesId=$sid&includeEpisode=true") as $it) {
          if (!is_array($it) || (string)($it['downloadId'] ?? '') !== $dl) continue;
          if (!empty($it['outputPath'])) $out = (string)$it['outputPath'];
          if (!empty($it['title'])) $title = (string)$it['title'];
          if (!empty($it['episodeId'])) $qeps[] = (int)$it['episodeId'];
          if (isset($it['episode']['seasonNumber'])) $qseason = (int)$it['episode']['seasonNumber']; elseif (isset($it['seasonNumber'])) $qseason = (int)$it['seasonNumber'];
        }
      } catch (UcError $x) {}
      $qeps = array_values(array_unique($qeps));
      /* ask the way Sonarr's own Activity screen does (the download's folder + its id), then
       * fall back to simpler questions - different Sonarr versions answer different ones */
      $asks = [];
      if ($out !== '') {
        $asks[] = 'folder=' . rawurlencode($out) . '&downloadId=' . rawurlencode($dl) . "&seriesId=$sid&filterExistingFiles=false";
        $asks[] = 'folder=' . rawurlencode($out) . "&seriesId=$sid&filterExistingFiles=false";
      }
      $asks[] = 'downloadId=' . rawurlencode($dl) . "&seriesId=$sid&filterExistingFiles=false";
      $asks[] = 'downloadId=' . rawurlencode($dl) . '&filterExistingFiles=false';
      $cands = []; $tried = [];
      foreach ($asks as $qs) {
        try { $cands = (array)uc_sonarr_req($c, 'GET', "manualimport?$qs"); } catch (UcError $x) { $tried[] = $x->getMessage(); continue; }
        /* the download's folder may hold other downloads too: only this download's files */
        if ($title !== '' && str_starts_with($qs, 'folder=')) {
          $key = uc_fold(preg_replace('/\.(mkv|mp4|avi|m4v|ts)$/i', '', $title));
          $cands = array_values(array_filter($cands, fn($f) => is_array($f) && ((string)($f['downloadId'] ?? '') === $dl
            || ($key !== '' && (str_contains(uc_fold((string)($f['folderName'] ?? '')), $key) || str_contains(uc_fold((string)($f['path'] ?? '')), $key))))));
        }
        if ($cands) break;
      }
      $isSample = function ($f) { foreach ((array)($f['rejections'] ?? []) as $r) if (stripos((string)($r['reason'] ?? ''), 'sample') !== false) return true; return (bool)preg_match('/(^|[\W_])sample([\W_]|$)/i', basename((string)($f['path'] ?? ''))); };
      $videos = array_values(array_filter($cands, fn($f) => is_array($f) && !empty($f['path']) && !$isSample($f)));
      /* rejections that only say "Sonarr couldn't tie the name to the show" - the very
       * thing this button is for - don't count against a file */
      $nameOnly = '/unknown series|unable to (parse|identify)|matched to series by id|series title|grab history|could not find series|invalid season or episode|unable to determine/i';
      $files = []; $skipped = [];
      foreach ($cands as $f) {
        if (!is_array($f) || empty($f['path'])) continue;
        $name = basename((string)$f['path']);
        if ($isSample($f)) { $skipped[] = ['file' => $name, 'why' => 'sample']; continue; }
        $eps = array_values(array_filter(array_map(fn($x) => (int)($x['id'] ?? 0), (array)($f['episodes'] ?? []))));
        $season = $f['seasonNumber'] ?? null; $how = 'sonarr';
        if (!$eps && $qeps && count($videos) === 1) { $eps = $qeps; $season = $season ?? $qseason; $how = 'queue'; }
        $rej = [];
        foreach ((array)($f['rejections'] ?? []) as $r) {
          $why = (string)($r['reason'] ?? 'rejected');
          if (strtolower((string)($r['type'] ?? 'permanent')) !== 'permanent' || preg_match($nameOnly, $why)) continue;
          $rej[] = $why;
        }
        if (!$eps) { $skipped[] = ['file' => $name, 'why' => "Sonarr couldn't tell which episode it is" . (count($videos) > 1 ? ' (the download has several files)' : '')]; continue; }
        if ($rej) { $skipped[] = ['file' => $name, 'why' => implode('; ', $rej)]; continue; }
        $files[] = ['path' => $f['path'], 'folderName' => $f['folderName'] ?? '', 'seriesId' => $sid, 'seasonNumber' => $season,
                    'episodeIds' => $eps, 'quality' => $f['quality'] ?? null, 'languages' => $f['languages'] ?? [], 'releaseGroup' => $f['releaseGroup'] ?? '',
                    'indexerFlags' => $f['indexerFlags'] ?? 0, 'releaseType' => $f['releaseType'] ?? 'unknown', 'downloadId' => $dl];
      }
      $cmd = null;
      if ($files) $cmd = uc_sonarr_req($c, 'POST', 'command', ['name' => 'ManualImport', 'importMode' => 'auto', 'files' => $files]);
      uc_json(['imported' => count($files), 'skipped' => $skipped, 'found' => count($cands), 'command' => (int)($cmd['id'] ?? 0), 'folder' => $out]);
    }
    /* how a Sonarr job went (Import now waits for it, to say what really happened) */
    case 'sonarr_cmd': {
      $id = (int)arg('id'); if ($id < 1) throw new UcError('Bad id');
      $j = uc_sonarr_req(uc_sonarr_cfg(), 'GET', "command/$id");
      uc_json(['status' => (string)($j['status'] ?? ''), 'result' => (string)($j['result'] ?? ''), 'message' => (string)($j['message'] ?? ($j['exception'] ?? ''))]);
    }
    case 'sonarr_remove': case 'sonarr_dismiss': {
      $p = uc_path(arg('path'));
      $h = uc_sonarr_hist(); $e = $h[$p] ?? [];
      if ($action === 'sonarr_remove') {
        $c = uc_sonarr_cfg(); $sid = (int)($e['seriesId'] ?? 0);
        if (!$sid) throw new UcError('unCommander has no record of this show in Sonarr');
        /* Make sure Sonarr's show #id is still THIS show before removing anything: Sonarr can
         * give a freed id to a show added later. Gone already = nothing to do. */
        $series = null;
        try { $series = uc_sonarr_req($c, 'GET', "series/$sid"); }
        catch (UcError $x) { if (!preg_match('/404|not ?found|does not exist/i', $x->getMessage())) throw $x; }
        if ($series) {
          $sp = rtrim((string)($series['path'] ?? ''), '/');
          $hp = uc_sonarr_hostpath($c, $sp);
          $same = $hp !== null ? rtrim($hp, '/') === rtrim($p, '/') : basename($sp) === basename($p);
          if (!$same) throw new UcError('Sonarr\'s show #' . $sid . ' is now "' . ($series['title'] ?? '?') . '" (' . $sp . ') - not this folder, so nothing was removed. Remove the show in Sonarr itself if it\'s still there.');
          /* still downloading or importing? Removing a show mid-import leaves Sonarr's
           * queue pointing at a show that's gone - wait until it's done */
          $q = [];
          try { $q = (array)uc_sonarr_req($c, 'GET', "queue/details?seriesId=$sid"); } catch (UcError $x) {}
          $q = array_filter($q, fn($i) => is_array($i) && (int)($i['seriesId'] ?? $sid) === $sid);
          if ($q) throw new UcError('Sonarr is still downloading or importing ' . count($q) . ' item' . (count($q) === 1 ? '' : 's') . ' for "' . ($series['title'] ?? 'this show') . '" - remove it once they\'re done (Sonarr > Activity)');
          uc_sonarr_req($c, 'DELETE', "series/$sid?deleteFiles=false&addImportListExclusion=false");
        }
        uc_json(['ok' => true, 'sn' => uc_sonarr_note($p, ['state' => 'removed'])]);
      }
      uc_json(['ok' => true, 'sn' => uc_sonarr_note($p, ['dismissed' => true])]);
    }
    /* After a movie arrived: take it out of Radarr (its files stay), or just
     * drop the row from the list. Both are remembered with the scan. */
    case 'radarr_remove': case 'radarr_dismiss': {
      $p = uc_path(arg('path'));
      $e = uc_radarr_hist()[$p] ?? ['state' => 'added'];
      if ((int)arg('id', '0') && empty($e['id'])) $e['id'] = (int)arg('id');
      if ($action === 'radarr_remove') {
        $c = uc_radarr_cfg();
        $id = (int)($e['id'] ?? 0);
        if (!$id) {     /* added before ids were remembered: find it by its folder */
          $want = uc_radarr_path($c, $p);
          foreach ((array)uc_radarr_req($c, 'GET', 'movie') as $mv) if (rtrim($mv['path'] ?? '', '/') === $want) { $id = (int)$mv['id']; break; }
        }
        if (!$id) throw new UcError("Couldn't find this movie in Radarr - it may have been removed already");
        /* still the same movie under that id? (a freed id can be given to a newer movie) */
        $mv = null;
        try { $mv = uc_radarr_req($c, 'GET', "movie/$id"); }
        catch (UcError $err) { if (!preg_match('/404|not ?found|does not exist/i', $err->getMessage())) throw $err; }
        if ($mv) {
          $want = uc_radarr_path($c, $p);
          if ($want !== null && rtrim((string)($mv['path'] ?? ''), '/') !== rtrim($want, '/'))
            throw new UcError('Radarr\'s movie #' . $id . ' is now "' . ($mv['title'] ?? '?') . '" (' . ($mv['path'] ?? '') . ') - not this folder, so nothing was removed. Remove it in Radarr itself if it\'s still there.');
          uc_radarr_req($c, 'DELETE', "movie/$id?deleteFiles=false&addImportExclusion=false");
        }
        $e['state'] = 'removed';
      } else $e['dismissed'] = true;
      uc_json(['ok' => true, 'rd' => uc_radarr_note($p, $e)]);
    }
    /* Send one movie folder to Radarr: find the movie (TMDb id, IMDb id, or
     * title + year), then add it with its existing folder as the path and
     * start a search. Already in Radarr: make sure it's monitored and search. */
    case 'radarr_add': {
      $c = uc_radarr_cfg();
      /* remember what happened for this folder (on the flash drive), so the tool can show it later */
      $remember = fn(array $o) => uc_radarr_note(uc_path(arg('path')), $o + ['dismissed' => false]);
      if (!$c['profile']) throw new UcError('Pick a quality profile for Radarr first (Settings > Tools)');
      $folder = uc_path(arg('path'));
      if (!is_dir($folder)) throw new UcError('That folder is gone');
      $rpath = uc_radarr_path($c, $folder);
      if ($rpath === null) throw new UcError("Radarr can't see this folder: none of its root folders points at " . dirname($folder) . ' (check the folder pairs in Settings > Tools)');
      $tmdb = (int)arg('tmdb', '0'); $imdb = preg_match('/^tt\d+$/', (string)arg('imdb', '')) ? arg('imdb') : '';
      $title = trim((string)arg('title', '')); $year = (int)arg('year', '0');
      $movie = null; $how = '';
      if ($tmdb) { $movie = uc_radarr_req($c, 'GET', 'movie/lookup/tmdb?tmdbId=' . $tmdb); $how = 'TMDb id'; }
      elseif ($imdb !== '') { $movie = uc_radarr_req($c, 'GET', 'movie/lookup/imdb?imdbId=' . rawurlencode($imdb)); $how = 'IMDb id'; }
      else {
        if ($title === '') throw new UcError('No title to search for');
        $list = (array)uc_radarr_req($c, 'GET', 'movie/lookup?term=' . rawurlencode($title . ($year ? " $year" : '')));
        $norm = fn($t) => uc_fold((string)$t);
        $exact = array_values(array_filter($list, fn($m) => $norm($m['title'] ?? '') === $norm($title) && (!$year || (int)($m['year'] ?? 0) === $year)));
        if (count($exact) === 1 && $year) { $movie = $exact[0]; $how = 'title and year'; }
        else {
          $cand = array_map(fn($m) => ['tmdb' => $m['tmdbId'] ?? 0, 'title' => $m['title'] ?? '', 'year' => $m['year'] ?? null,
            'overview' => mb_substr((string)($m['overview'] ?? ''), 0, 260), 'poster' => (function ($m) { foreach ((array)($m['images'] ?? []) as $i) if (($i['coverType'] ?? '') === 'poster') return $i['remoteUrl'] ?? $i['url'] ?? null; return null; })($m)],
            array_slice($exact ?: $list, 0, 6));
          $remember(['state' => 'pick', 'cand' => $cand]);      // kept, so the tool still asks after it's closed and reopened
          uc_json(['status' => 'pick', 'candidates' => $cand]);
        }
      }
      if (!is_array($movie) || empty($movie['tmdbId'])) throw new UcError("Radarr couldn't find this movie by its $how");
      $have = (array)uc_radarr_req($c, 'GET', 'movie?tmdbId=' . (int)$movie['tmdbId']);
      if ($have) {
        $m = $have[0];
        if (empty($m['monitored'])) { $m['monitored'] = true; uc_radarr_req($c, 'PUT', 'movie/' . $m['id'], $m); }
        if ($c['search']) uc_radarr_req($c, 'POST', 'command', ['name' => 'MoviesSearch', 'movieIds' => [$m['id']]]);
        $remember(['state' => 'exists', 'id' => $m['id'], 'searching' => $c['search'], 'msg' => $m['title'] . ' (' . ($m['year'] ?? '') . ') → ' . ($m['path'] ?? '')]);
        uc_json(['status' => 'exists', 'title' => $m['title'], 'year' => $m['year'] ?? null, 'path' => $m['path'] ?? '', 'searching' => $c['search']]);
      }
      $body = ['title' => $movie['title'], 'tmdbId' => (int)$movie['tmdbId'], 'year' => $movie['year'] ?? 0, 'titleSlug' => $movie['titleSlug'] ?? '',
               'images' => $movie['images'] ?? [], 'qualityProfileId' => (int)$c['profile'], 'path' => $rpath, 'monitored' => true,
               'minimumAvailability' => $c['availability'], 'addOptions' => ['searchForMovie' => (bool)$c['search'], 'monitor' => 'movieOnly']];
      $added = uc_radarr_req($c, 'POST', 'movie', $body);
      $remember(['state' => 'added', 'id' => $added['id'] ?? null, 'searching' => (bool)$c['search'], 'msg' => ($added['title'] ?? $movie['title']) . ' → ' . ($added['path'] ?? $rpath)]);
      uc_json(['status' => 'added', 'id' => $added['id'] ?? null, 'title' => $added['title'] ?? $movie['title'], 'year' => $added['year'] ?? $movie['year'] ?? null,
               'path' => $added['path'] ?? $rpath, 'how' => $how, 'searching' => (bool)$c['search']]);
    }

    case 'empty_scan_start': {
      $mounts = uc_array_mounts();
      $disks = array_values(array_filter(array_map('strval', arg_list('disks')), fn($d) => in_array($d, $mounts, true)));
      if (!$disks) throw new UcError('Pick at least one disk or pool');
      $share = trim((string)arg('share', ''), '/');
      if ($share !== '' && (str_contains($share, '/') || $share === '.' || $share === '..' || $share[0] === '.')) throw new UcError('Pick a share name (top-level folder), or leave it empty for all');
      $dir = UC_STATE . '/scans'; @mkdir($dir, 0700, true);
      foreach (glob("$dir/*.json") ?: [] as $old) if (time() - filemtime($old) > 86400) { @unlink($old); @unlink(substr($old, 0, -5) . '.results'); }
      $id = bin2hex(random_bytes(6));
      $skip = $share === '' ? array_values(array_filter(array_map('strval', arg_list('skip')), fn($n) => preg_match('/^[^\/.][^\/]*$/', $n))) : [];
      file_put_contents("$dir/$id.json", json_encode(['id' => $id, 'tool' => 'empty', 'state' => 'queued', 'created' => time(), 'disks' => $disks, 'share' => $share, 'skip' => $skip,
        'disks_state' => array_map(fn($d) => ['disk' => $d, 'state' => 'waiting', 'seen' => 0, 'found' => 0], $disks), 'results' => []], JSON_UNESCAPED_SLASHES));
      $php = PHP_BINARY && !str_contains(PHP_BINARY, 'fpm') ? PHP_BINARY : 'php';
      $io = is_executable('/usr/bin/ionice') ? '/usr/bin/ionice -c3 ' : '';
      exec('setsid nohup nice -n 10 ' . $io . escapeshellarg($php) . ' -d memory_limit=1024M ' . escapeshellarg(__DIR__ . '/emptyscan.php') . ' ' . escapeshellarg($id) . ' >/dev/null 2>&1 &');
      uc_json(['ok' => true, 'id' => $id]);
    }
    case 'movie_scan_start': {
      $root = uc_path(arg('root'));
      if (!is_dir($root)) throw new UcError("That folder doesn't exist");
      if ($root === '/' || preg_match('#^/mnt/[^/]+$#', $root)) throw new UcError('Pick your movies folder (e.g. /mnt/user/Movies), not a whole disk');
      $dir = UC_STATE . '/scans'; @mkdir($dir, 0700, true);
      foreach (glob("$dir/*.json") ?: [] as $old) if (time() - filemtime($old) > 86400) { @unlink($old); @unlink(substr($old, 0, -5) . '.results'); }
      $id = bin2hex(random_bytes(6));
      file_put_contents("$dir/$id.json", json_encode(['id' => $id, 'tool' => 'movies', 'state' => 'queued', 'created' => time(), 'root' => $root, 'total' => 0, 'seen' => 0, 'results' => []], JSON_UNESCAPED_SLASHES));
      $php = PHP_BINARY && !str_contains(PHP_BINARY, 'fpm') ? PHP_BINARY : 'php';
      $io = is_executable('/usr/bin/ionice') ? '/usr/bin/ionice -c3 ' : '';
      exec('setsid nohup nice -n 10 ' . $io . escapeshellarg($php) . ' -d memory_limit=1024M ' . escapeshellarg(__DIR__ . '/moviescan.php') . ' ' . escapeshellarg($id) . ' >/dev/null 2>&1 &');
      uc_json(['ok' => true, 'id' => $id]);
    }
    /* Tools > TV shows with missing episodes: start a background scan */
    case 'tv_scan_start': {
      $root = uc_path(arg('root'));
      if (!is_dir($root)) throw new UcError("That folder doesn't exist");
      if ($root === '/' || preg_match('#^/mnt/[^/]+$#', $root)) throw new UcError('Pick your TV shows folder (e.g. /mnt/user/TV), not a whole disk');
      $dir = UC_STATE . '/scans'; @mkdir($dir, 0700, true);
      foreach (glob("$dir/*.json") ?: [] as $old) if (time() - filemtime($old) > 86400) { @unlink($old); @unlink(substr($old, 0, -5) . '.results'); }
      $id = bin2hex(random_bytes(6));
      file_put_contents("$dir/$id.json", json_encode(['id' => $id, 'tool' => 'tv', 'state' => 'queued', 'created' => time(), 'root' => $root, 'total' => 0, 'seen' => 0, 'done' => 0], JSON_UNESCAPED_SLASHES));
      $php = PHP_BINARY && !str_contains(PHP_BINARY, 'fpm') ? PHP_BINARY : 'php';
      $io = is_executable('/usr/bin/ionice') ? '/usr/bin/ionice -c3 ' : '';
      exec('setsid nohup nice -n 10 ' . $io . escapeshellarg($php) . ' -d memory_limit=1024M ' . escapeshellarg(__DIR__ . '/tvscan.php') . ' ' . escapeshellarg($id) . ' >/dev/null 2>&1 &');
      uc_json(['ok' => true, 'id' => $id]);
    }
    /* search TVmaze for the "Which show is this?" picker */
    case 'tv_search': {
      $q = trim((string)arg('q'));
      if ($q === '') throw new UcError('Type a show name to search for');
      /* a TVmaze link or id, an IMDb id (tt...) or a TheTVDB id (tvdb:123) finds that exact show */
      $j = null;
      if (preg_match('#tvmaze\.com/shows/(\d+)#i', $q, $m) || preg_match('/^tvmaze[: ]*(\d{1,7})$/i', $q, $m)) $j = uc_tvmaze_get("shows/{$m[1]}");
      elseif (preg_match('/\b(tt\d{5,10})\b/i', $q, $m)) $j = uc_tvmaze_get('lookup/shows?imdb=' . strtolower($m[1]));
      elseif (preg_match('/^(?:tvdb|thetvdb)[: ]*(\d+)$/i', $q, $m) || preg_match('#thetvdb\.com/.*?[?&/]id[=/](\d+)#i', $q, $m)) $j = uc_tvmaze_get("lookup/shows?thetvdb={$m[1]}");
      if ($j && !empty($j['id'])) uc_json(['results' => [uc_tv_brief($j)], 'exact' => true]);
      if (preg_match('#^https?://|^tt\d|^(tvdb|thetvdb)[: ]*\d#i', $q)) uc_json(['results' => [], 'exact' => true]);
      uc_json(['results' => array_slice(uc_tv_search($q), 0, 10)]);
    }
    /* you picked the show for a folder: remember it, send back its episodes */
    case 'tv_pick': {
      $path = uc_path(arg('path')); $tvm = (int)arg('id');
      if (!is_dir($path)) throw new UcError('That folder is gone');
      if ($tvm < 1) throw new UcError('Bad show id');
      $sh = uc_tv_show($tvm);
      if (!$sh) throw new UcError("TVmaze doesn't have that show");
      $m = uc_tv_store('matches'); $m[$path] = ['id' => $tvm, 'how' => 'picked', 'name' => $sh['show']['name']]; uc_tv_store('matches', $m);
      require_once __DIR__ . '/tvparse.php';
      $row = ['show' => $sh['show'], 'eps' => $sh['eps'], 'how' => 'picked', 'have' => uc_tv_folder_have($path, $sh['eps'])];
      uc_tv_try_sonarr_order($row);
      $row['have'] = uc_tv_folder_have($path, $row['eps'], $odd); $row['odd'] = (object)$odd;
      uc_json($row);
    }
    /* your choices for a show: ignore it, ignore seasons, mark it complete */
    case 'tv_rule': {
      $path = uc_path(arg('path'));
      $in = arg('rule', []); if (is_string($in)) $in = json_decode($in, true) ?: [];
      $r = uc_tv_store('rules');
      $one = ['show' => !empty($in['show']), 'complete' => !empty($in['complete']),
              'seasons' => array_values(array_unique(array_map('intval', array_filter((array)($in['seasons'] ?? []), 'is_numeric'))))];
      if (!$one['show'] && !$one['complete'] && !$one['seasons']) unset($r[$path]); else $r[$path] = $one;
      uc_tv_store('rules', $r);
      uc_json(['rule' => $r[$path] ?? null]);
    }
    /* Save a tool's list as a file in a folder (never replaces one: adds (2), (3)...) */
    case 'save_report': {
      $dir = uc_path(arg('dir'));
      if (!is_dir($dir)) throw new UcError("That folder doesn't exist");
      $name = uc_name((string)arg('name'));
      if (!preg_match('/\.(csv|txt)$/i', $name)) throw new UcError('Reports are saved as .csv or .txt');
      $text = (string)arg('text');
      if (strlen($text) > 20 * 1048576) throw new UcError('That list is too big to save');
      $out = uc_join($dir, $name);
      $stem = preg_replace('/\.(csv|txt)$/i', '', $name); $ext = pathinfo($name, PATHINFO_EXTENSION);
      for ($k = 2; file_exists($out); $k++) $out = uc_join($dir, "$stem ($k).$ext");
      if (@file_put_contents($out, $text) === false) throw new UcError("Couldn't write " . basename($out));
      @chown($out, 'nobody'); @chgrp($out, 'users'); @chmod($out, 0666);
      uc_json(['ok' => true, 'path' => $out]);
    }
    /* the newest scan a tool ran (any device), so reopening the tool can show it */
    case 'scan_last': {
      $tool = in_array(arg('tool'), ['empty', 'tv'], true) ? arg('tool') : 'movies';
      $best = null;
      foreach (glob(UC_STATE . '/scans/*.json') ?: [] as $f) {
        if (time() - filemtime($f) > 86400) continue;
        $st = json_decode((string)@file_get_contents($f), true);
        if (!$st || ($st['tool'] ?? '') !== $tool) continue;
        if (!$best || ($st['created'] ?? 0) > ($best['created'] ?? 0)) $best = $st;
      }
      uc_json(['id' => $best['id'] ?? null]);
    }
    case 'scan_status': case 'scan_stop': {
      $id = (string)arg('id');
      if (!preg_match('/^[a-z0-9]{6,32}$/', $id)) throw new UcError('Bad id');
      $st = json_decode((string)@file_get_contents(UC_STATE . "/scans/$id.json"), true);
      if (!$st) throw new UcError('That scan is no longer available');
      if ($action === 'scan_stop') { if (!empty($st['pid'])) posix_kill($st['pid'], SIGTERM); uc_json(['ok' => true]); }
      if ($st['state'] === 'running' && !empty($st['pid']) && !posix_kill($st['pid'], 0)) $st['state'] = 'failed';
      unset($st['results']);                    // progress only - the list comes from scan_results
      uc_json(['scan' => $st]);
    }
    /* A scan's results, read and sent one line at a time so even a huge list
     * never sits in the server's memory. fresh=1 leaves out folders that have
     * gone since (deleted or tidied up). */
    case 'scan_results': {
      $id = (string)arg('id');
      if (!preg_match('/^[a-z0-9]{6,32}$/', $id)) throw new UcError('Bad id');
      $st = json_decode((string)@file_get_contents(UC_STATE . "/scans/$id.json"), true);
      if (!$st) throw new UcError('That scan is no longer available');
      $fresh = arg('fresh', '0') === '1';
      @set_time_limit(0);
      header('Content-Type: application/json');
      echo '{"tool":' . json_encode($st['tool']) . ',"results":[';
      $h = @fopen(UC_STATE . "/scans/$id.results", 'r');
      $first = true;
      $rd = $st['tool'] === 'movies' ? uc_radarr_hist() : [];
      $tvMatches = $st['tool'] === 'tv' ? uc_tv_store('matches') : [];
      $snHist = $st['tool'] === 'tv' ? uc_sonarr_hist() : [];
      $emitted = [];
      $vre = '.*\\.(' . implode('|', ['mkv', 'mp4', 'm4v', 'avi', 'mov', 'wmv', 'mpg', 'mpeg', 'ts', 'm2ts', 'mts', 'iso', 'vob', 'webm', 'divx', 'strm', 'mk3d']) . ')';
      while ($h && ($line = fgets($h)) !== false) {
        $line = rtrim($line, "\n"); if ($line === '') continue;
        if ($fresh) {
          $r = json_decode($line, true);
          $p = in_array($st['tool'], ['movies', 'tv'], true) ? ($r['path'] ?? '') : '/mnt/' . $r[0] . '/' . $r[1];
          if (!is_dir($p)) continue;
          /* a movie folder that has a video again: if it went through Radarr, keep it as
           * "arrived" so it can be reviewed (and removed from Radarr); otherwise leave it out */
          if ($st['tool'] === 'movies') {
            $sent = $rd[$p] ?? null;
            if ($sent && !empty($sent['dismissed'])) continue;
            if (trim((string)shell_exec('find -H ' . escapeshellarg($p) . ' -regextype posix-extended -type f -iregex ' . escapeshellarg($vre) . ' ! -iname ' . escapeshellarg('*sample*') . ' -print -quit 2>/dev/null')) !== '') {
              if (!$sent || !in_array($sent['state'] ?? '', ['added', 'exists', 'removed'], true)) continue;
              $r['done'] = true; $line = json_encode($r, JSON_UNESCAPED_SLASHES | JSON_INVALID_UTF8_SUBSTITUTE);
            }
          }
        }
        /* TV: a show you picked (or re-picked) since the scan gets its new episode list */
        if ($st['tool'] === 'tv') {
          $r = json_decode($line, true);
          if (isset($snHist[$r['path'] ?? ''])) {
            $r['sn'] = $snHist[$r['path']];
            /* sent to Sonarr (even if since removed or cleared from the green box):
             * look in the folder again, so what arrived counts without a rescan */
            if ($fresh && is_dir($r['path'])) { require_once __DIR__ . '/tvparse.php'; uc_tv_refresh_row($r); $r['rechecked'] = true; }
            $line = json_encode($r, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE | JSON_INVALID_UTF8_SUBSTITUTE);
          }
          if ($fresh && empty($r['files']) && empty($r['rechecked']) && is_dir($r['path'] ?? '')) {
            require_once __DIR__ . '/tvparse.php'; uc_tv_refresh_row($r);
            if (!empty($r['files'])) $line = json_encode($r, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE | JSON_INVALID_UTF8_SUBSTITUTE);
          }
          $m = $tvMatches[$r['path'] ?? ''] ?? null;
          if ($m && (int)($r['show']['id'] ?? 0) !== (int)$m['id']) {
            try { $sh = uc_tv_show((int)$m['id']); } catch (UcError $e) { $sh = null; }
            if ($sh) {
              $r['show'] = $sh['show']; $r['eps'] = $sh['eps']; $r['how'] = $m['how'] ?? 'picked'; unset($r['cand'], $r['err'], $r['order'], $r['tvmaze_fit']);
              /* a different episode list: count the folder against it again */
              require_once __DIR__ . '/tvparse.php'; uc_tv_refresh_row($r);
              $line = json_encode($r, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE | JSON_INVALID_UTF8_SUBSTITUTE); }
          }
          /* files that don't line up with TVmaze: try Sonarr's numbering (also for
           * scans made before unCommander knew how - no rescan needed) */
          if (empty($r['order']) && uc_tv_try_sonarr_order($r)) {
            require_once __DIR__ . '/tvparse.php'; uc_tv_refresh_row($r);
            $line = json_encode($r, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE | JSON_INVALID_UTF8_SUBSTITUTE);
          }
        }
        if ($st['tool'] === 'movies') {
          $r = json_decode($line, true); $emitted[$r['path'] ?? ''] = true;
          if (isset($rd[$r['path'] ?? ''])) { $r['rd'] = $rd[$r['path']]; $line = json_encode($r, JSON_UNESCAPED_SLASHES | JSON_INVALID_UTF8_SUBSTITUTE); }
        }
        $r = null;
        echo ($first ? '' : ','), $line; $first = false;
      }
      if ($h) fclose($h);
      /* Arrived movies the scan didn't list (it skips folders that have a video):
       * only ones unCommander sent to Radarr, whose video is now in place. */
      if ($st['tool'] === 'movies' && $fresh) {
        $root = rtrim($st['root'], '/'); $extra = [];
        $under = fn($p) => str_starts_with($p, $root . '/') && substr_count(substr($p, strlen($root) + 1), '/') === 0;
        $why = null;
        foreach ($rd as $p => $e) {
          if (isset($emitted[$p]) || isset($extra[$p]) || !empty($e['dismissed']) || !$under($p) || !in_array($e['state'] ?? '', ['added', 'exists', 'removed'], true) || !is_dir($p)) continue;
          if (trim((string)shell_exec('find -H ' . escapeshellarg($p) . ' -regextype posix-extended -type f -iregex ' . escapeshellarg($vre) . ' -print -quit 2>/dev/null')) === '') continue;
          $extra[$p] = ['title' => basename($p), 'rd' => $e];
        }
        foreach ($extra as $p => $x) {
          if (!is_dir($p)) continue;
          $poster = null; foreach (['poster.jpg', 'folder.jpg', 'poster.png', 'cover.jpg'] as $pn) if (is_file("$p/$pn")) { $poster = $pn; break; }
          $row = ['name' => basename($p), 'path' => $p, 'kind' => 'meta', 'files' => 0, 'bytes' => 0, 'title' => $x['title'], 'year' => $x['year'] ?? null,
                  'tmdb' => $x['tmdb'] ?? null, 'imdb' => $x['imdb'] ?? null, 'poster' => $poster, 'done' => true, 'rd' => $x['rd']];
          echo ($first ? '' : ','), json_encode($row, JSON_UNESCAPED_SLASHES | JSON_INVALID_UTF8_SUBSTITUTE); $first = false;
        }
        echo '],"radarr_note":' . json_encode($why) . '}';
        exit;
      }
      if ($st['tool'] === 'tv') { echo '],"rules":' . json_encode((object)uc_tv_store('rules'), JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE) . ',"today":' . json_encode(date('Y-m-d')) . '}'; exit; }
      echo ']}';
      exit;
    }

    /* Delete empty folders found by the scan. Each one is checked again right
     * now, and only ever removed with rmdir(), which the system refuses for a
     * folder with anything at all inside - so nothing with content can go. */
    case 'empty_delete': {
      uc_practice_block('deleting');
      $mounts = uc_array_mounts();
      $removed = []; $skipped = [];
      foreach (arg_list('paths') as $raw) {
        $p = rtrim((string)$raw, '/');
        $why = null;
        if (!preg_match('#^/mnt/([^/]+)/(.+)$#', $p, $m) || !in_array($m[1], $mounts, true)) $why = 'not on a disk or pool';
        elseif (in_array('..', explode('/', $m[2]), true) || str_contains($p, '/' . UC_TRASH)) $why = 'not allowed';
        elseif (is_link($p) || !is_dir($p)) $why = 'no longer a folder';
        elseif (realpath($p) !== $p) $why = 'path goes through a link';
        else {
          /* anything that isn't a folder, or anything hidden (file or folder), anywhere inside? */
          $any = trim((string)shell_exec('find -H ' . escapeshellarg($p) . ' -mindepth 1 \\( ! -type d -o -name ' . escapeshellarg('.*') . ' \\) -print -quit 2>&1'));
          if ($any === '' && basename($p)[0] === '.') $any = $p . '/(hidden folder itself)';
          if ($any !== '') $why = 'not empty - has ' . substr($any, strlen($p) + 1) . ' inside';
        }
        if ($why) { $skipped[] = [$p, $why]; continue; }
        /* deepest first; remember each folder's owner, mode and date for Undo */
        $list = array_filter(explode("\0", (string)shell_exec('find ' . escapeshellarg($p) . ' -depth -type d -print0 2>/dev/null')), 'strlen');
        foreach ($list as $d) {
          $sst = @stat($d);
          if (!@rmdir($d)) { $skipped[] = [$d, 'the system refused (not empty)']; break; }
          $removed[] = [$d, $sst['mode'] & 07777, $sst['uid'], $sst['gid'], $sst['mtime']];
        }
      }
      $token = null;
      if ($removed) {
        @mkdir(UC_UNDO, 0700, true);
        $token = bin2hex(random_bytes(6));
        file_put_contents(UC_UNDO . "/rmdir-$token.json", json_encode(array_reverse($removed), JSON_UNESCAPED_SLASHES));
      }
      uc_json(['ok' => true, 'removed' => count($removed), 'skipped' => $skipped, 'undo' => $token]);
    }
    case 'empty_undo': {
      $token = (string)arg('token');
      if (!preg_match('/^[a-f0-9]{12}$/', $token)) throw new UcError('Bad undo token');
      $f = UC_UNDO . "/rmdir-$token.json";
      $list = json_decode((string)@file_get_contents($f), true);
      if (!$list) throw new UcError("There's no record of those folders any more, so they can't be put back");
      $n = 0;
      foreach ($list as [$d, $mode, $uid, $gid]) {           // parents first
        if (!is_dir($d) && @mkdir($d)) $n++;
        @chmod($d, $mode); @chown($d, $uid); @chgrp($d, $gid);
      }
      foreach (array_reverse($list) as [$d, , , , $mt]) @touch($d, $mt);   // dates last, deepest first
      @unlink($f);
      uc_json(['ok' => true, 'restored' => $n]);
    }

    /* Folder sizes: read-only, so it runs straight away beside any copy. */
    case 'size_start': {
      $paths = array_map('uc_path', arg_list('paths'));
      $items = [];
      foreach (array_slice($paths, 0, 200) as $p) {
        if (!is_dir($p)) continue;
        $items[] = ['path' => $p, 'state' => 'waiting', 'files' => 0, 'dirs' => 0, 'bytes' => 0, 'now' => ''];
      }
      if (!$items) throw new UcError('Pick one or more folders first');
      $dir = UC_STATE . '/sizes';
      @mkdir($dir, 0700, true);
      foreach (glob("$dir/*.json") ?: [] as $old) if (time() - filemtime($old) > 86400) { @unlink($old); @unlink(substr($old, 0, -5) . '.results'); }
      $id = bin2hex(random_bytes(6));
      file_put_contents("$dir/$id.json", json_encode(['id' => $id, 'state' => 'queued', 'created' => time(), 'items' => $items], JSON_UNESCAPED_SLASHES));
      $php = PHP_BINARY && !str_contains(PHP_BINARY, 'fpm') ? PHP_BINARY : 'php';
      exec('setsid nohup nice -n 10 ' . escapeshellarg($php) . ' -d memory_limit=1024M ' . escapeshellarg(__DIR__ . '/sizer.php') . ' ' . escapeshellarg($id) . ' >/dev/null 2>&1 &');
      uc_json(['ok' => true, 'id' => $id]);
    }

    case 'size_status': {
      $id = (string)arg('id');
      if (!preg_match('/^[a-z0-9]{6,32}$/', $id)) throw new UcError('Bad id');
      $st = json_decode((string)@file_get_contents(UC_STATE . "/sizes/$id.json"), true);
      if (!$st) throw new UcError('That size count is no longer available');
      if ($st['state'] === 'running' && !empty($st['pid']) && !posix_kill($st['pid'], 0)) $st['state'] = 'failed';
      uc_json(['size' => $st]);
    }

    case 'size_stop': {
      $id = (string)arg('id');
      if (!preg_match('/^[a-z0-9]{6,32}$/', $id)) throw new UcError('Bad id');
      $st = json_decode((string)@file_get_contents(UC_STATE . "/sizes/$id.json"), true);
      if ($st && !empty($st['pid'])) @posix_kill(-$st['pid'], SIGTERM);
      uc_json(['ok' => true]);
    }

    case 'jobs': {
      /* ids the progress window is showing right now */
      $watch = arg('watch', '[]');
      foreach ((array)(is_string($watch) ? json_decode($watch, true) : $watch) as $id)
        if (is_string($id) && preg_match('/^[a-z0-9]{6,32}$/', $id) && is_file(UC_JOBS . "/$id.json")) uc_job_touch($id);
      $jobs = [];
      foreach (glob(UC_JOBS . '/*.json') ?: [] as $f) {
        $j = json_decode(@file_get_contents($f), true);
        if (!$j) continue;
        /* watched to the end in the progress window: kept just long enough
         * for the window to show it finished, then forgotten */
        $ended = !in_array($j['state'], ['running', 'queued'], true);
        if ($ended && empty($j['alert']) && (empty($j['seen']) || time() - ($j['finished'] ?? 0) > 20)) { uc_job_forget($j['id']); continue; }
        /* A worker that died without saying so (server reboot, OOM). */
        if (in_array($j['state'], ['running', 'queued'], true) && !empty($j['pid']) && !posix_kill($j['pid'], 0)) {
          $j['state'] = 'failed'; $j['error'] = 'Worker stopped unexpectedly'; $j['alert'] = true; $j['finished'] = time();
          uc_job_write($j);
        }
        $jobs[] = $j;
      }
      usort($jobs, fn($a, $b) => $b['created'] <=> $a['created']);
      uc_json(['jobs' => $jobs]);
    }

    case 'job_cancel': {
      $j = uc_job_read(arg('id'));
      if (!$j) throw new UcError('No such job');
      if (!empty($j['pid'])) @posix_kill(-$j['pid'], SIGTERM);
      if ($j['state'] === 'queued' || $j['state'] === 'running') {
        $j['state'] = 'cancelled'; uc_job_write($j);
      }
      uc_json(['ok' => true]);
    }

    /* The progress window was closed (Continue in background, Esc, leaving
     * the page): these jobs are no longer being watched. */
    case 'job_unwatch': {
      foreach (arg_list('ids') as $id) if (is_string($id) && preg_match('/^[a-z0-9]{6,32}$/', $id)) @unlink(uc_job_watch_file($id));
      uc_json(['ok' => true]);
    }

    /* Dismiss a finished job's alert row (all devices see it dismissed). */
    case 'job_ack': {
      $ids = arg('id') === '*' ? array_map(fn($f) => basename($f, '.json'), glob(UC_JOBS . '/*.json') ?: []) : [arg('id')];
      foreach ($ids as $id) {
        $j = uc_job_read($id);
        if ($j && !in_array($j['state'], ['running', 'queued'], true)) uc_job_forget($id);   // dismissed: gone for good
      }
      uc_json(['ok' => true]);
    }

    case 'job_clear': {
      foreach (glob(UC_JOBS . '/*.json') ?: [] as $f) {
        $j = json_decode(@file_get_contents($f), true);
        if ($j && !in_array($j['state'], ['running', 'queued'], true)) { @unlink($f); @unlink(substr($f, 0, -5) . '.log'); @unlink(substr($f, 0, -5) . '.watch'); }
      }
      uc_json(['ok' => true]);
    }

    default:
      throw new UcError('Unknown action');
  }
} catch (Throwable $e) {
  uc_json(['error' => $e->getMessage()], 400);
}
