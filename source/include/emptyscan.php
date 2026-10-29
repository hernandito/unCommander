<?php
/* unCommander — Tools > Empty folders on disks.
 * Walks the chosen disks/pools and finds folders with no files anywhere
 * inside them (not even hidden ones). Read-only: deleting is a separate,
 * re-checked API call. Started detached; progress goes to a JSON file. */
require_once __DIR__ . '/lib.php';

$id = $argv[1] ?? '';
if (!preg_match('/^[a-z0-9]{6,32}$/', $id)) exit(1);
$file = UC_STATE . "/scans/$id.json";
$st = json_decode((string)@file_get_contents($file), true);
if (!$st) exit(1);

$stop = false;
pcntl_async_signals(true);
pcntl_signal(SIGTERM, function () use (&$stop) { $stop = true; });
function save(array $st): void {
  global $file;
  file_put_contents("$file.tmp", json_encode($st, JSON_UNESCAPED_SLASHES | JSON_INVALID_UTF8_SUBSTITUTE));
  rename("$file.tmp", $file);
}
$st['pid'] = getmypid(); $st['state'] = 'running'; save($st);

/* results go to their own file, one JSON line each, as they're found - the
 * status file stays tiny, so checking progress never loads big lists */
$out = fopen(UC_STATE . "/scans/$id.results", 'w');
$total = 0;
$all = uc_array_mounts();
$SKIP_TOP = ['lost+found'];
$skip = array_values(array_filter((array)($st['skip'] ?? []), fn($n) => $n !== '' && !str_contains($n, '/')));
foreach ($st['disks'] as $k => $disk) {
  if ($stop) break;
  $base = "/mnt/$disk";
  $share = $st['share'];
  $start = $share !== '' ? "$base/$share" : $base;
  $st['disks_state'][$k] = ['disk' => $disk, 'state' => 'running', 'seen' => 0, 'found' => 0];
  save($st);
  if (!is_dir($start)) { $st['disks_state'][$k]['state'] = 'done'; save($st); continue; }

  /* find lists depth-first (a folder, then everything inside it, then the
   * next folder), so a folder can be judged the moment its listing ends.
   * Only the current path is kept in memory - not every folder on the disk.
   * Hidden folders (trash included) aren't walked: they just count as content. */
  /* shares left out (appdata, system...): not walked at all */
  $prune = $share === '' ? implode('', array_map(fn($n) => ' -path ' . escapeshellarg("$base/$n") . ' -prune -o', $skip)) : '';
  $cmd = 'find -H ' . escapeshellarg($start) . ($share !== '' ? ' -mindepth 0' : ' -mindepth 1') . $prune
       . ' \( -type d -name ' . escapeshellarg('.*') . ' -prune -printf ' . escapeshellarg('T\t%p\0') . ' \) -o -printf ' . escapeshellarg('%y\t%p\0') . ' 2>/dev/null';
  $h = popen($cmd, 'r');
  $buf = ''; $seen = 0; $last = 0; $found = 0; $left = 0;
  /* frame: [rel, has content, entries directly inside, empty folders below, pending empty sub-trees] */
  $stack = [['', true, 0, 0, []]];
  $emit = function (array $kids) use (&$found, &$left, &$total, $out, $disk, $all, $SKIP_TOP, $skip) {
    foreach ($kids as [$rel, $sub, $n]) {
      $top = explode('/', $rel)[0];
      if (in_array($top, $SKIP_TOP, true) || in_array($top, $skip, true)) continue;
      /* where else does the same folder exist? (the share shows it from any disk) */
      $also = [];
      foreach ($all as $o) if ($o !== $disk && is_dir("/mnt/$o/$rel")) $also[] = $o;
      fwrite($out, json_encode([$disk, $rel, $n ? 1 : 0, $sub, $also], JSON_UNESCAPED_SLASHES | JSON_INVALID_UTF8_SUBSTITUTE) . "\n");
      $found++; $total++; if ($also) $left++;
    }
  };
  $pop = function () use (&$stack, $emit) {
    [$rel, $content, $n, $sub, $kids] = array_pop($stack);
    $top = count($stack) - 1;
    if ($content) { $stack[$top][1] = true; $emit($kids); }          // not empty: its empty sub-trees are results
    else { $stack[$top][4][] = [$rel, $sub, $n]; $stack[$top][3] += $sub + 1; }   // empty all the way down: decided by its parent
  };
  while ($h && !feof($h)) {
    if ($stop) break;
    $buf .= fread($h, 1 << 16);
    $parts = explode("\0", $buf);
    $buf = array_pop($parts);
    foreach ($parts as $e) {
      $t = strpos($e, "\t"); if ($t === false) continue;
      $type = substr($e, 0, $t); $abs = substr($e, $t + 1);
      if ($abs === $base) continue;
      $rel = substr($abs, strlen($base) + 1);
      $seen++;
      $i = strrpos($rel, '/'); $par = $i === false ? '' : substr($rel, 0, $i);
      while (count($stack) > 1 && $stack[count($stack) - 1][0] !== $par) $pop();
      $stack[count($stack) - 1][2]++;
      if ($type === 'd') $stack[] = [$rel, false, 0, 0, []];
      else $stack[count($stack) - 1][1] = true;        // a file, link, hidden folder or trash: content
    }
    if (microtime(true) - $last > 0.5) { $last = microtime(true); $st['disks_state'][$k]['seen'] = $seen; $st['disks_state'][$k]['found'] = $found; $st['disks_state'][$k]['left'] = $left; save($st); }
  }
  if ($h) pclose($h);
  if ($stop) { $st['disks_state'][$k]['state'] = 'stopped'; save($st); break; }
  while (count($stack) > 1) $pop();
  $emit($stack[0][4]);                                  // empty folders right at the top of the disk
  fflush($out);
  $st['disks_state'][$k] = ['disk' => $disk, 'state' => 'done', 'seen' => $seen, 'found' => $found, 'left' => $left];
  $st['found'] = $total;
  save($st);
}

fclose($out);
$st['found'] = $total;
$st['state'] = $stop ? 'stopped' : 'done';
$st['finished'] = time();
save($st);
