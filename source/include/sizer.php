<?php
/* unCommander — adds up folder sizes for "Folder sizes" (More row).
 * Started detached by the API, one per request, and independent of the
 * copy/move queue: it only reads. Progress goes to a small JSON file the page
 * polls, so it keeps going if the window is closed. */
require_once __DIR__ . '/lib.php';

$id = $argv[1] ?? '';
if (!preg_match('/^[a-z0-9]{6,32}$/', $id)) exit(1);
$file = UC_STATE . "/sizes/$id.json";
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

$st['pid'] = getmypid();
$st['state'] = 'running';
save($st);

foreach ($st['items'] as $i => $it) {
  if ($stop) { $st['items'][$i]['state'] = 'stopped'; continue; }
  $st['items'][$i]['state'] = 'running';
  $st['items'][$i]['started'] = microtime(true);
  save($st);
  /* %y type, %s apparent size in bytes, %h the folder it's in */
  $h = popen('find -H ' . escapeshellarg($it['path']) . ' -printf ' . escapeshellarg("%y %s %h\n") . ' 2>/dev/null', 'r');
  $files = 0; $dirs = -1; $bytes = 0; $last = 0;
  while ($h && ($line = fgets($h)) !== false) {
    if ($stop) break;
    $p = explode(' ', rtrim($line, "\n"), 3);
    if (($p[0] ?? '') === 'd') $dirs++;
    else { $files++; $bytes += (int)($p[1] ?? 0); }
    if (microtime(true) - $last > 0.5) {
      $last = microtime(true);
      $st['items'][$i] = array_merge($st['items'][$i], ['files' => $files, 'dirs' => max(0, $dirs), 'bytes' => $bytes, 'now' => $p[2] ?? '']);
      save($st);
    }
  }
  if ($h) pclose($h);
  $st['items'][$i] = array_merge($st['items'][$i], ['files' => $files, 'dirs' => max(0, $dirs), 'bytes' => $bytes, 'now' => '',
    'state' => $stop ? 'stopped' : 'done', 'secs' => round(microtime(true) - $st['items'][$i]['started'], 1)]);
  save($st);
}
$st['state'] = $stop ? 'stopped' : 'done';
$st['finished'] = time();
save($st);
