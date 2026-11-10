<?php
/* unCommander — "What's using space here": one walk of the folder, adding up every file into its
 * folder and all the folders above it. Each folder keeps its sub-folders and its 60 biggest files
 * (the rest as one "smaller files" total), so the map and list can go in and out instantly.
 * Started detached; progress in the scan's JSON file, the result in its .tree file. */
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
$st['pid'] = getmypid(); $st['state'] = 'running'; $st['seen'] = 0; $st['bytes'] = 0; save($st);

$root = $st['root'];
$D = uc_space_walk($root, function ($seen, $bytes) use (&$st, &$stop) { $st['seen'] = $seen; $st['bytes'] = $bytes; save($st); return $stop; });
/* the result: one line per folder, ready to show (its sub-folders with their totals, its biggest files),
 * spread over 64 small files by the folder's name - so showing a folder reads one small file, never the
 * whole scan (a big appdata has hundreds of thousands of folders) */
$st['phase'] = 'saving'; save($st);
$hs = [];
for ($i = 0; $i < UC_SPACE_BUCKETS; $i++) $hs[$i] = fopen(UC_STATE . "/scans/$id.tree." . sprintf('%02x', $i), 'w');
foreach (array_keys($D) as $rel) {
  $rel = (string)$rel;
  fwrite($hs[uc_space_bucket($rel)], json_encode([$rel, uc_space_entry($D, $rel)], JSON_UNESCAPED_SLASHES | JSON_INVALID_UTF8_SUBSTITUTE) . "\n");
}
foreach ($hs as $h2) fclose($h2);
unset($st['phase']);
$st['state'] = $stop ? 'stopped' : 'done'; $st['finished'] = time(); $st['dirs'] = count($D);
save($st);
