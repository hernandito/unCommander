<?php
/* unCommander — History: every change, newest first, kept on the flash drive
 * so it survives reboots. Each step is made of parts (one per item), and any
 * part can be undone on its own. Before undoing, each part is checked against
 * the disk as it is NOW; if something changed since (moved again, renamed,
 * emptied from the trash), that part is left alone and the reason is shown -
 * never a silent "Undone".
 *
 * Part states:  ''  can be undone       'u'  undone
 *               'w'  its job is running  'm'  being moved back by a job
 *               'x'  can't be undone (the reason is in 'why')
 * Part kinds:   mkdir {p}         new folder
 *               ren   {a,b}       renamed a -> b (same folder)
 *               move  {a,b}       moved a -> b ('merged': b was already there; 'job': rsync did it)
 *               copy  {b,rel,job} copied to b (rel = its name under the job's destination)
 *               trash {p,bin}     deleted to the trash
 *               gone  {p}         deleted for good
 *               made  {p,job}     an archive made by Compress, or a new folder made by Extract
 *               into  {p,job}     extracted into a folder that already existed
 *               rmdirs {p,dirs}   empty folders removed by Tools > Empty folders */

/* Where History is kept: on the array (Settings > Trash & History, appdata by default) while it's
 * started, so changes aren't written to the flash drive; in RAM while it's stopped (the trash is
 * on the array, so there's nothing to undo then). What was kept on the flash drive before, or in
 * RAM while the array was stopped, is brought over the next time the array is there. */
function uc_array_up(): bool {
  static $up = null;
  if ($up === null) { $v = @parse_ini_file('/var/local/emhttp/var.ini') ?: []; $up = ($v['mdState'] ?? '') === 'STARTED' || getenv('UC_ARRAY_UP') === '1'; }
  return $up;
}
function uc_hist_dir(): string {
  $f = dirname(UC_CFG) . '/settings.json'; $s = is_file($f) ? (json_decode((string)file_get_contents($f), true) ?: []) : [];
  $d = rtrim(trim((string)($s['hist_dir'] ?? '')), '/');
  return $d !== '' && str_starts_with($d, '/mnt/') && !str_contains($d, '..') ? $d : '/mnt/user/appdata/uncommander';
}
/* unCommander's folder (Settings › Trash & History; appdata by default) also keeps the small lists the
 * tools write - playlists list, Radarr "sent", TV choices - so they never wear the flash drive. Once a day,
 * if any changed, a few-KB copy of them goes to the flash drive (uncommander-lists.tgz) so unRAID's flash
 * backup has them; on a fresh setup with an empty folder they come back from it. While the folder isn't
 * there (array stopped) they're kept in memory. */
const UC_LISTS = ['playlists.json', 'radarr-sent.json', 'lidarr-jobs.json', 'music-accept.json'];       // + tv-*.json
function uc_lists_snap(): string { return dirname(UC_CFG) . '/uncommander-lists.tgz'; }
function uc_data_dir(): ?string {
  static $d = false;
  if ($d !== false) return $d;
  $dir = uc_hist_dir();
  $root = '/mnt/' . explode('/', substr($dir, 5))[0];
  $d = uc_array_up() && is_dir($root) && (is_dir($dir) || @mkdir($dir, 0777, true)) && is_writable($dir) ? $dir : null;
  if ($d) {
    /* earlier versions kept these on the flash drive: moved over once, checked, then removed there */
    $cfg = dirname(UC_CFG);
    foreach (array_merge(['playlists.json', 'radarr-sent.json'], array_map('basename', glob("$cfg/tv-*.json") ?: [])) as $n) {
      $old = "$cfg/$n"; if (!is_file($old)) continue;
      if (!is_file("$d/$n") && @copy($old, "$d/$n.tmp") && md5_file($old) === md5_file("$d/$n.tmp")) @rename("$d/$n.tmp", "$d/$n");
      if (is_file("$d/$n")) @unlink($old); else @unlink("$d/$n.tmp");
    }
    /* a new or emptied folder: the lists come back from the flash copy */
    $snap = uc_lists_snap();
    if (is_file($snap) && !is_file("$d/.lists-snap") && !glob("$d/{" . implode(',', UC_LISTS) . ",tv-*.json}", GLOB_BRACE)) {     // (.lists-snap: this folder has had lists - emptied on purpose)
      exec('tar -xzf ' . escapeshellarg($snap) . ' -C ' . escapeshellarg($d) . ' 2>/dev/null', $o, $rc);
      if (!$rc) { @mkdir(UC_STATE, 0700, true); @touch(UC_STATE . '/lists-restored'); }
    }
  }
  return $d;
}
/* unCommander's folder moved (Settings): its files go along - nothing is overwritten at the new place */
function uc_data_move(string $from, string $to): void {
  if (!uc_array_up() || !is_dir($from) || $from === $to) return;
  @mkdir($to, 0777, true); if (!is_dir($to) || !is_writable($to)) return;
  $l = uc_hist_lock();
  foreach (array_merge(['history.json', '.lists-snap', 'ffmpeg'], UC_LISTS, array_map('basename', glob("$from/tv-*.json") ?: [])) as $n)
    if (file_exists("$from/$n") && !file_exists("$to/$n")) exec('mv ' . escapeshellarg("$from/$n") . ' ' . escapeshellarg("$to/$n"));
  flock($l, LOCK_UN);
  @rmdir("$from/ffmpeg"); @rmdir($from);           // only if nothing else is left there
}
/* where one of those lists lives right now */
function uc_data_file(string $name): string {
  $d = uc_data_dir();
  if ($d) return "$d/$name";
  @mkdir(UC_STATE . '/data', 0700, true);
  return UC_STATE . "/data/$name";
}
/* the daily copy to the flash drive - written only when a list changed since the last one */
function uc_lists_snapshot(): string {
  $d = uc_data_dir(); if (!$d) return 'the array is stopped';
  $files = array_values(array_filter(array_merge(UC_LISTS, array_map('basename', glob("$d/tv-*.json") ?: [])), fn($n) => is_file("$d/$n")));
  if (!$files) return 'nothing to keep';
  $sum = md5(implode('|', array_map(fn($n) => $n . ':' . md5_file("$d/$n"), $files)));
  $mark = "$d/.lists-snap";
  if (is_file(uc_lists_snap()) && trim((string)@file_get_contents($mark)) === $sum) return 'unchanged';
  $tmp = UC_STATE . '/lists-snap.tgz'; @mkdir(UC_STATE, 0700, true);
  exec('tar -czf ' . escapeshellarg($tmp) . ' -C ' . escapeshellarg($d) . ' ' . implode(' ', array_map('escapeshellarg', $files)) . ' 2>/dev/null', $o, $rc);
  if ($rc || !is_file($tmp)) return 'failed';
  @copy($tmp, uc_lists_snap() . '.tmp') && @rename(uc_lists_snap() . '.tmp', uc_lists_snap());
  @unlink($tmp); @file_put_contents($mark, $sum);
  return 'saved ' . count($files) . ' lists';
}
function uc_hist_path(): string {
  static $p = null;
  if ($p !== null) return $p;
  $ram = UC_STATE . '/history.json';
  $dir = uc_hist_dir();
  $root = '/mnt/' . explode('/', substr($dir, 5))[0];       // /mnt/user, /mnt/cache... has to be there
  if (uc_array_up() && is_dir($root) && (is_dir($dir) || @mkdir($dir, 0777, true)) && is_writable($dir)) {
    $p = "$dir/history.json";
    foreach ([dirname(UC_CFG) . '/history.json', $ram] as $old) {
      if (!is_file($old)) continue;
      $a = is_file($p) ? (json_decode((string)file_get_contents($p), true) ?: []) : [];
      $b = json_decode((string)file_get_contents($old), true) ?: [];
      $steps = []; foreach ([...($a['steps'] ?? []), ...($b['steps'] ?? [])] as $st) if (isset($st['id']) && !isset($steps[$st['id']])) $steps[$st['id']] = $st;
      $steps = array_values($steps); usort($steps, fn($x, $y) => ($y['at'] ?? 0) <=> ($x['at'] ?? 0));
      file_put_contents("$p.tmp", json_encode(['v' => 1, 'steps' => $steps], JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE | JSON_INVALID_UTF8_SUBSTITUTE));
      if (@rename("$p.tmp", $p)) @unlink($old);
    }
  } else $p = $ram;
  return $p;
}
define('UC_HIST_STEPS', 1000);       // newest steps kept (a safety cap - the days setting decides)
define('UC_HIST_PARTS', 30000);      // and at most this many parts in all

function uc_hist_lock() {
  @mkdir(UC_STATE, 0700, true);
  $h = fopen(UC_STATE . '/history.lock', 'c');
  flock($h, LOCK_EX);
  return $h;
}
function uc_hist_read(): array {
  $h = is_file(uc_hist_path()) ? json_decode((string)file_get_contents(uc_hist_path()), true) : null;
  $h = is_array($h) && isset($h['steps']) ? $h : ['v' => 1, 'steps' => []];
  /* Settings > Trash & History: "Keep deleted items and History for N days" - one
   * number for both, so History never points at trash that's already gone
   * (0 = keep forever). A step with a job still running is kept until it finishes. */
  $days = (int)(uc_settings()['trash_days'] ?? 7);
  if ($days > 0) {
    $cut = time() - $days * 86400;
    $h['steps'] = array_values(array_filter($h['steps'], fn($s) => ($s['at'] ?? 0) >= $cut
      || array_filter($s['parts'] ?? [], fn($p) => in_array($p['s'] ?? '', ['w', 'm'], true))));
  }
  return $h;
}
function uc_hist_write(array $h): void {
  $h['steps'] = array_slice($h['steps'], 0, UC_HIST_STEPS);
  $n = 0;
  foreach ($h['steps'] as $k => $s) { $n += count($s['parts']); if ($n > UC_HIST_PARTS && $k > 0) { $h['steps'] = array_slice($h['steps'], 0, $k); break; } }
  $f = uc_hist_path();
  @mkdir(dirname($f), 0777, true);
  file_put_contents($f . '.tmp', json_encode($h, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE | JSON_INVALID_UTF8_SUBSTITUTE));
  rename($f . '.tmp', $f);
}
/* A new step. Returns its id (null when there was nothing to record). */
function uc_hist_add(string $label, array $parts, array $extra = []): ?string {
  if (!$parts) return null;
  foreach ($parts as &$p) $p['s'] = $p['s'] ?? '';
  unset($p);
  $l = uc_hist_lock();
  $h = uc_hist_read();
  $id = bin2hex(random_bytes(5));
  array_unshift($h['steps'], ['id' => $id, 'at' => time(), 'label' => mb_substr($label, 0, 160), 'parts' => array_values($parts)] + $extra);
  uc_hist_write($h);
  flock($l, LOCK_UN);
  return $id;
}
/* Change one step under the lock. $fn gets the step by reference. */
function uc_hist_mod(string $id, callable $fn): void {
  $l = uc_hist_lock();
  $h = uc_hist_read();
  foreach ($h['steps'] as &$s) if ($s['id'] === $id) { $fn($s); uc_hist_write($h); break; }
  unset($s);
  flock($l, LOCK_UN);
}
/* More parts for an existing step (a Compare copy both ways is one step) */
function uc_hist_append(string $id, array $parts, string $label): ?string {
  $found = false;
  uc_hist_mod($id, function (&$s) use ($parts, $label, &$found) {
    foreach ($parts as $p) $s['parts'][] = $p + ['s' => ''];
    $s['label'] = $label; $found = true;
  });
  return $found ? $id : uc_hist_add($label, $parts);
}
function uc_hist_label(string $verb, array $paths): string {
  return $verb . ' ' . (count($paths) === 1 ? basename($paths[0]) : count($paths) . ' items');
}

/* A job finished (worker.php): its parts become undoable - or not. */
function uc_hist_job_done(array $job): void {
  if (empty($job['hist'])) return;
  $ok = $job['state'] === 'done';
  uc_hist_mod($job['hist'], function (&$s) use ($job, $ok) {
    foreach ($s['parts'] as &$p) {
      if (($p['job'] ?? '') !== $job['id'] || $p['s'] !== 'w') continue;
      if ($p['t'] === 'made' && !file_exists($p['p'])) { $p['s'] = 'x'; $p['why'] = "it didn't finish, so nothing was made"; continue; }
      if ($p['t'] === 'into') { $p['s'] = 'x'; $p['why'] = "the files came out into a folder that already had things in it, and unCommander doesn't keep a list of them - remove them by hand"; continue; }
      if ($p['t'] === 'copy' && $ok === false && !file_exists($p['b']) && !is_link($p['b'])) { $p['s'] = 'x'; $p['why'] = "the copy stopped before this one, so there's nothing to undo"; continue; }
      if ($p['t'] === 'move' && $ok === false && !file_exists($p['b']) && !is_link($p['b'])) { $p['s'] = 'x'; $p['why'] = "the move stopped before this one, so it's still where it was"; continue; }
      $p['s'] = '';
    }
    unset($p);
    if (!$ok) $s['label'] .= $job['state'] === 'cancelled' ? ' (stopped part way)' : ' (failed part way)';
    /* Compress / Extract with "delete the originals": those went to the trash */
    foreach (uc_hist_delete_parts((array)($job['removed_items'] ?? [])) as $it) $s['parts'][] = $it + ['s' => ''];
  });
}

/* A move-back job (from an undo) finished: those parts are undone, or say why not. */
function uc_hist_back_done(array $job): void {
  $ok = $job['state'] === 'done';
  uc_hist_mod((string)$job['hist'], function (&$s) use ($job, $ok) {
    foreach ((array)$job['hparts'] as $i) {
      if (!isset($s['parts'][$i]) || $s['parts'][$i]['s'] !== 'm') continue;
      $s['parts'][$i]['s'] = $ok ? 'u' : '';
      unset($s['parts'][$i]['mjob']);
      if ($ok) unset($s['parts'][$i]['why']);
      else $s['parts'][$i]['why'] = 'moving it back ' . ($job['state'] === 'cancelled' ? 'was stopped' : 'failed' . ($job['error'] ? ': ' . $job['error'] : '')) . ' - check both folders';
    }
  });
}

/* The parts of a delete, from uc_delete_paths()'s per-item list */
function uc_hist_delete_parts(array $items): array {
  $parts = [];
  foreach ($items as $it) $parts[] = isset($it['bin']) ? ['t' => 'trash', 'p' => $it['p'], 'bin' => $it['bin']]
                                                        : ['t' => 'gone', 'p' => $it['p'], 's' => 'x', 'why' => $it['gone']];
  return $parts;
}
function uc_hist_delete_label(array $items): string {
  $forever = !array_filter($items, fn($it) => isset($it['bin']));
  return ($forever ? 'Deleted for good: ' : 'Deleted ') . (count($items) === 1 ? basename($items[0]['p']) : count($items) . ' items');
}

/* Refresh parts whose job is still running or moving things back. */
function uc_hist_settle(array &$h): bool {
  $changed = false;
  foreach ($h['steps'] as &$s) foreach ($s['parts'] as &$p) {
    if ($p['s'] === 'w' && !empty($p['job'])) {
      $j = uc_job_read($p['job']);
      if (!$j) { $p['s'] = ''; $changed = true; }          // job record gone (reboot): let the checks decide
    } elseif ($p['s'] === 'm' && !empty($p['mjob'])) {
      $j = uc_job_read($p['mjob']);
      if (!$j || !in_array($j['state'], ['queued', 'running'], true)) {
        $ok = $j && $j['state'] === 'done';
        $p['s'] = $ok ? 'u' : '';
        if (!$ok) $p['why'] = 'moving it back ' . ($j ? ($j['state'] === 'cancelled' ? 'was stopped' : 'failed' . ($j['error'] ? ': ' . $j['error'] : '')) : 'was interrupted') . ' - check both folders';
        else unset($p['why']);
        unset($p['mjob']); $changed = true;
      }
    }
  }
  unset($s, $p);
  return $changed;
}

/* The newer step that touched this path, to say "undo that first". */
function uc_hist_later(array $h, int $before, string $path): string {
  for ($k = $before - 1; $k >= 0; $k--) {
    foreach ($h['steps'][$k]['parts'] as $p) {
      foreach (['a', 'p'] as $f) if (isset($p[$f]) && ($p[$f] === $path || str_starts_with($path, $p[$f] . '/')) && $p['s'] !== 'u') {
        $st = $h['steps'][$k];
        return " - undo \"{$st['label']}\" (" . date('H:i', $st['at']) . ') first';
      }
    }
  }
  return '';
}

/* Undo a copy's part: the files it wrote under $rel go to the trash, files it
 * replaced come back, folders it made are removed if empty. */
function uc_hist_undo_copy(array $p): ?string {
  $m = uc_undo_meta((string)$p['job']);
  if (!$m) return "unCommander's list of what this copy wrote is gone (the server restarted, or it was over 7 days ago) - delete the copy by hand if you don't want it";
  if (!empty($m['blocked'])) return 'it replaced files while the trash was switched off, so the old versions are gone';
  $dest = $m['dest']; $rel = rtrim((string)$p['rel'], '/');
  $bk = $m['bin'] ? $m['bin'] . '/' . basename($dest) : null;
  $names = array_filter(explode("\0", (string)@file_get_contents(UC_UNDO . '/' . $p['job'] . '.written')), 'strlen');
  $mine = array_filter($names, fn($n) => rtrim($n, '/') === $rel || str_starts_with($n, $rel . '/'));
  $dirs = []; $ubin = null; $trash = uc_settings()['trash'];
  foreach ($mine as $n) {
    if ($n[0] === '/' || in_array('..', explode('/', $n), true)) continue;
    if (str_ends_with($n, '/')) { $dirs[] = rtrim($n, '/'); continue; }
    $f = "$dest/$n";
    if ($bk && (file_exists("$bk/$n") || is_link("$bk/$n"))) continue;      // replaced: the old one comes back below
    if (!is_link($f) && !is_file($f)) continue;
    if (!$trash) { @unlink($f); continue; }
    if (!$ubin) { $ubin = uc_trash_merge_bin($dest, 'Undone copy'); @mkdir($ubin, 0700, true); uc_trash_merge_mark($ubin, $dest); }
    $t = "$ubin/" . basename($dest) . "/$n";
    if (!is_dir(dirname($t))) @mkdir(dirname($t), 0777, true);
    @rename($f, $t);
  }
  if ($bk && (file_exists("$bk/$rel") || is_link("$bk/$rel"))) {
    if (is_dir("$bk/$rel") && !is_link("$bk/$rel")) uc_merge_back("$bk/$rel", "$dest/$rel");
    elseif (!is_dir("$dest/$rel") || is_link("$dest/$rel")) @rename("$bk/$rel", "$dest/$rel");     // the copy's version is still at its source
    exec('find ' . escapeshellarg($m['bin']) . ' -depth -mindepth 1 -type d -empty -delete 2>/dev/null');
  }
  usort($dirs, fn($a, $b) => substr_count($b, '/') <=> substr_count($a, '/'));
  foreach ($dirs as $d) if ($d !== '' && $d !== '.') @rmdir("$dest/$d");
  return null;
}

/* Undo one part. Returns null when done, a reason string when it can't be
 * done, or ['back' => task] when it has to be moved back by a job. */
function uc_hist_undo_part(array $h, int $k, array $p) {
  $there = fn($x) => file_exists($x) || is_link($x);
  $later = fn($x) => uc_hist_later($h, $k, $x);
  switch ($p['t']) {
    case 'mkdir':
      if (!is_dir($p['p'])) return $there($p['p']) ? 'something else has that name now' : 'it was moved, renamed or deleted later' . $later($p['p']);
      if (count(scandir($p['p'])) > 2) return 'it has something in it now - empty it first, or delete it';
      if (!@rmdir($p['p'])) return "the system wouldn't remove it";
      return null;

    case 'ren':
      if (!$there($p['b'])) return ($there($p['a']) ? 'it already has its old name again' : 'it was renamed, moved or deleted later' . $later($p['b']));
      if ($there($p['a']) && strcasecmp($p['a'], $p['b']) !== 0) return 'the old name ' . basename($p['a']) . ' is taken now';
      if (!@rename($p['b'], $p['a'])) return "the system wouldn't rename it";
      return null;

    case 'move':
      if (!$there($p['b'])) return $there($p['a']) ? 'it seems to be back in its old place already' : 'it was moved, renamed or deleted later' . $later($p['b']);
      if (!is_dir(dirname($p['a']))) return 'the folder it came from (' . dirname($p['a']) . ') is gone';
      if (!empty($p['merged'])) {
        /* it went into a folder that was already there: only the files it brought go back */
        $m = uc_undo_meta((string)($p['job'] ?? ''));
        if (!$m) return "it was mixed into a folder that was already there, and unCommander's list of the files it brought is gone - move them back by hand";
        if ($there($p['a']) && !is_dir($p['a'])) return 'something new is in its old place (' . $p['a'] . ')';
        if (!$there($p['a']) && is_dir($p['b']) && !is_link($p['b'])) @mkdir($p['a'], 0777, true);   // a folder moved without some contents: its old place is gone if nothing stayed
        $rel = basename($p['b']);
        $names = array_filter(explode("\0", (string)@file_get_contents(UC_UNDO . '/' . $p['job'] . '.written')), 'strlen');
        $files = array_values(array_filter($names, fn($n) => !str_ends_with($n, '/') && ($n === $rel || str_starts_with($n, $rel . '/'))));
        $dirs = array_values(array_map(fn($n) => rtrim($n, '/'), array_filter($names, fn($n) => str_ends_with($n, '/') && $n !== $rel . '/' && str_starts_with($n, $rel . '/'))));
        if (!$files) return "unCommander's list shows no files from this move";
        return ['back' => ['from' => dirname($p['b']), 'to' => dirname($p['a']), 'rel' => $files, 'rec' => false, 'rmdirs' => $dirs, 'job' => $p['job'], 'prefix' => $rel]];
      }
      if ($there($p['a'])) return is_dir($p['a']) && !empty($p['job'])
        ? 'part of it is still in its old place (files the move skipped), so it can\'t simply go back - move the rest by hand'
        : 'something new is in its old place (' . $p['a'] . ')';
      $sa = @stat(dirname($p['a'])); $sb = @stat(dirname($p['b']));
      if ($sa && $sb && $sa['dev'] === $sb['dev'] && @rename($p['b'], $p['a'])) {
        if (!empty($p['job'])) uc_hist_put_back_replaced((string)$p['job'], basename($p['b']));
        return null;
      }
      return ['back' => ['from' => dirname($p['b']), 'to' => dirname($p['a']), 'rel' => [basename($p['b'])], 'rec' => true, 'rmdirs' => [], 'job' => $p['job'] ?? null, 'prefix' => basename($p['b']), 'newname' => basename($p['a'])]];

    case 'copy':
      if (!$there($p['b'])) return 'the copy was moved, renamed or deleted later' . $later($p['b']);
      return uc_hist_undo_copy($p);

    case 'trash': {
      $item = $p['bin'] . '/' . basename($p['p']);
      if (!$there($item)) return $there($p['p']) ? 'it was already put back from the trash' : "it's no longer in the trash - the trash was emptied, or it was deleted from there";
      if ($there($p['p'])) return 'something new is at ' . $p['p'] . ' - rename that first, or restore from the trash folder by hand';
      if (!is_dir(dirname($p['p'])) && !@mkdir(dirname($p['p']), 0777, true)) return "its folder couldn't be made again";
      if (!@rename($item, $p['p'])) return "the system wouldn't move it back";
      @unlink($p['bin'] . '/.uncommander-origin'); @rmdir($p['bin']); @rmdir(dirname($p['bin']));
      return null;
    }

    case 'made':
      if (!$there($p['p'])) return 'it was moved, renamed or deleted later' . $later($p['p']);
      try { uc_delete_paths([$p['p']]); } catch (UcError $e) { return $e->getMessage(); }
      return null;

    case 'rmdirs':
      foreach ($p['dirs'] as [$d, $mode, $uid, $gid]) {            // parents first
        if (!is_dir($d) && !@mkdir($d)) return "couldn't make $d again";
        @chmod($d, $mode); @chown($d, $uid); @chgrp($d, $gid);
      }
      foreach (array_reverse($p['dirs']) as [$d, , , , $mt]) @touch($d, $mt);
      return null;
  }
  return $p['why'] ?? "this can't be undone";
}

/* Files a move or copy replaced (kept in the trash): put back the ones under $prefix. */
function uc_hist_put_back_replaced(string $job, string $prefix): void {
  $m = uc_undo_meta($job);
  if (!$m || empty($m['bin'])) return;
  $bk = $m['bin'] . '/' . basename($m['dest']);
  if (!file_exists("$bk/$prefix")) return;
  if (is_dir("$bk/$prefix")) uc_merge_back("$bk/$prefix", $m['dest'] . "/$prefix");
  elseif (!is_dir($m['dest'] . "/$prefix") || is_link($m['dest'] . "/$prefix")) @rename("$bk/$prefix", $m['dest'] . "/$prefix");
  exec('find ' . escapeshellarg($m['bin']) . ' -depth -mindepth 1 -type d -empty -delete 2>/dev/null');
}

/* Batch rename undo: several names in one folder, two steps via temporary
 * names so swaps (a <-> b) work. Returns per-index reasons for the ones that
 * couldn't go back; the rest are done. */
function uc_hist_undo_renames(array $h, int $k, array $parts): array {
  $there = fn($x) => file_exists($x) || is_link($x);
  $why = []; $go = [];
  $leaving = [];
  foreach ($parts as $i => $p) $leaving[$p['b']] = true;
  foreach ($parts as $i => $p) {
    if (!$there($p['b'])) { $why[$i] = $there($p['a']) ? 'it already has its old name again' : 'it was renamed, moved or deleted later' . uc_hist_later($h, $k, $p['b']); continue; }
    if ($there($p['a']) && !isset($leaving[$p['a']]) && strcasecmp($p['a'], $p['b']) !== 0) { $why[$i] = 'the old name ' . basename($p['a']) . ' is taken now'; continue; }
    $go[$i] = $p;
  }
  $tag = '.uc-undo-' . bin2hex(random_bytes(4)) . '-';
  $tmp = [];
  foreach ($go as $i => $p) {
    $t = dirname($p['b']) . "/$tag$i";
    if (@rename($p['b'], $t)) $tmp[$i] = $t; else $why[$i] = "the system wouldn't rename it";
  }
  foreach ($tmp as $i => $t) {
    if ($there($go[$i]['a']) || !@rename($t, $go[$i]['a'])) { @rename($t, $go[$i]['b']); $why[$i] = 'the old name ' . basename($go[$i]['a']) . ' is taken now'; }
  }
  return $why;
}

/* Undo the given parts of step $id (all that can be, when $which is null).
 * Returns ['done' => n, 'failed' => [[i, name, why]...], 'job' => id|null]. */
function uc_hist_undo(string $id, ?array $which): array {
  $l = uc_hist_lock();
  $h = uc_hist_read();
  uc_hist_settle($h);
  if ($id === 'latest') {
    foreach ($h['steps'] as $s) if (array_filter($s['parts'], fn($p) => $p['s'] === '')) { $id = $s['id']; break; }
    if ($id === 'latest') { flock($l, LOCK_UN); throw new UcError('Nothing left to undo'); }
  }
  $k = null;
  foreach ($h['steps'] as $n => $s) if ($s['id'] === $id) { $k = $n; break; }
  if ($k === null) { flock($l, LOCK_UN); throw new UcError('That step is no longer in History'); }
  $step = &$h['steps'][$k];
  $idx = [];
  foreach ($step['parts'] as $i => $p) if ($p['s'] === '' && ($which === null || in_array($i, $which, true))) $idx[] = $i;
  if (!$idx) {
    flock($l, LOCK_UN);
    $w = array_filter($step['parts'], fn($p) => $p['s'] === 'w');
    throw new UcError($w ? 'Wait for it to finish, then undo it' : 'Nothing left to undo in that step');
  }
  /* Practice mode: only new folders can be taken back */
  if (array_filter($idx, fn($i) => $step['parts'][$i]['t'] !== 'mkdir')) {
    try { uc_practice_block('undoing'); } catch (UcError $e) { flock($l, LOCK_UN); throw $e; }
  }
  $failed = []; $done = 0; $back = [];
  $name = fn($p) => basename($p['b'] ?? $p['p'] ?? $p['a'] ?? '');
  /* renames in one folder go together (a swap needs that) */
  $ren = array_filter($idx, fn($i) => $step['parts'][$i]['t'] === 'ren');
  if (count($ren) > 1) {
    $why = uc_hist_undo_renames($h, $k, array_intersect_key($step['parts'], array_flip($ren)));
    foreach ($ren as $i) {
      if (isset($why[$i])) { $step['parts'][$i]['why'] = $why[$i]; $failed[] = [$i, $name($step['parts'][$i]), $why[$i]]; }
      else { $step['parts'][$i]['s'] = 'u'; unset($step['parts'][$i]['why']); $done++; }
    }
    $idx = array_diff($idx, $ren);
  }
  foreach (array_reverse($idx) as $i) {                      // newest effect first
    $p = $step['parts'][$i];
    try { $r = uc_hist_undo_part($h, $k, $p); } catch (Throwable $e) { $r = $e->getMessage(); }
    if ($r === null) { $step['parts'][$i]['s'] = 'u'; unset($step['parts'][$i]['why']); $done++; }
    elseif (is_array($r)) $back[$i] = $r['back'];
    else { $step['parts'][$i]['why'] = $r; $failed[] = [$i, $name($p), $r]; }
  }
  $job = null;
  if ($back) {
    /* across disks: one background job moves them all back */
    $job = ['id' => bin2hex(random_bytes(6)), 'type' => 'back', 'tasks' => array_values($back), 'sources' => array_map(fn($t) => $t['from'] . '/' . $t['prefix'], array_values($back)),
            'state' => 'queued', 'created' => time(), 'pct' => 0, 'bytes' => 0, 'speed' => '', 'eta' => '', 'file' => '', 'error' => null,
            'label' => 'Undo: move ' . (count($back) === 1 ? reset($back)['prefix'] : count($back) . ' items') . ' back',
            'hist' => $id, 'hparts' => array_keys($back)];
    uc_job_write($job);
    uc_job_touch($job['id']);
    foreach ($back as $i => $t) { $step['parts'][$i]['s'] = 'm'; $step['parts'][$i]['mjob'] = $job['id']; unset($step['parts'][$i]['why']); }
  }
  unset($step);
  uc_hist_write($h);
  flock($l, LOCK_UN);
  if ($job) {
    $php = PHP_BINARY && !str_contains(PHP_BINARY, 'fpm') ? PHP_BINARY : 'php';
    exec('setsid nohup ' . escapeshellarg($php) . ' -d memory_limit=1024M ' . escapeshellarg(__DIR__ . '/worker.php') . ' ' . escapeshellarg($job['id']) . ' >/dev/null 2>&1 &');
  }
  return ['done' => $done, 'failed' => $failed, 'job' => $job['id'] ?? null, 'id' => $id, 'label' => $h['steps'][$k]['label'], 'moving' => count($back)];
}

/* What the History window shows: steps with their parts (long steps are cut,
 * with the full count). */
function uc_hist_view(int $maxParts = 400): array {
  $l = uc_hist_lock();
  $h = uc_hist_read();
  if (uc_hist_settle($h)) uc_hist_write($h);
  flock($l, LOCK_UN);
  $out = [];
  foreach ($h['steps'] as $s) {
    $c = ['open' => 0, 'undone' => 0, 'cant' => 0, 'busy' => 0];
    foreach ($s['parts'] as $p) $c[$p['s'] === '' ? 'open' : ($p['s'] === 'u' ? 'undone' : ($p['s'] === 'x' ? 'cant' : 'busy'))]++;
    $parts = [];
    foreach (array_slice($s['parts'], 0, $maxParts) as $p) {
      $q = ['t' => $p['t'], 's' => $p['s']];
      foreach (['a', 'b', 'p', 'why'] as $f) if (isset($p[$f])) $q[$f] = $p[$f];
      $parts[] = $q;
    }
    $out[] = ['id' => $s['id'], 'at' => $s['at'], 'label' => $s['label'], 'count' => count($s['parts']), 'parts' => $parts] + $c;
  }
  return $out;
}
