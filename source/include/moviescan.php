<?php
/* unCommander — Tools > Movie folders without a video.
 * Looks at each folder directly inside the chosen root (one folder per movie)
 * and flags the ones with no video file anywhere inside. For those it reads
 * the local .nfo (title, year, plot, rating, ids) and finds a poster. Read-only. */
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

const VIDEO = ['mkv', 'mp4', 'm4v', 'avi', 'mov', 'wmv', 'mpg', 'mpeg', 'mpe', 'ts', 'm2ts', 'mts', 'iso', 'img', 'vob', 'webm', 'flv', 'divx', 'xvid',
               '3gp', 'ogv', 'ogm', 'rmvb', 'rm', 'asf', 'strm', 'mk3d', 'dvr-ms', 'wtv', 'f4v', 'm2v', 'bdmv'];
const IMAGE = ['jpg', 'jpeg', 'png', 'webp', 'tbn', 'gif', 'bmp'];
$root = rtrim($st['root'], '/');

/* the movie folders */
$folders = [];
foreach (scandir($root) ?: [] as $n) {
  if ($n === '.' || $n === '..' || $n === UC_TRASH || $n[0] === '.') continue;
  if (is_dir("$root/$n") && !is_link("$root/$n")) $folders[$n] = ['video' => 0, 'sample' => 0, 'nfo' => [], 'img' => [], 'other' => 0, 'files' => 0, 'bytes' => 0, 'list' => []];
}
$st['total'] = count($folders); save($st);

/* every file below them, in one pass */
$h = popen('find ' . escapeshellarg($root) . ' -mindepth 2 -name ' . escapeshellarg(UC_TRASH) . ' -prune -o ! -type d -printf ' . escapeshellarg('%P\t%s\0') . ' 2>/dev/null', 'r');
$buf = ''; $seen = 0; $last = 0;
while ($h && !feof($h)) {
  if ($stop) break;
  $buf .= fread($h, 1 << 16);
  $parts = explode("\0", $buf); $buf = array_pop($parts);
  foreach ($parts as $e) {
    $t = strrpos($e, "\t"); if ($t === false) continue;
    $rel = substr($e, 0, $t); $size = (int)substr($e, $t + 1);
    $i = strpos($rel, '/'); if ($i === false) continue;
    $top = substr($rel, 0, $i); if (!isset($folders[$top])) continue;
    $f = &$folders[$top];
    $inner = substr($rel, $i + 1); $name = basename($inner);
    $ext = strtolower(pathinfo($name, PATHINFO_EXTENSION));
    $f['files']++; $f['bytes'] += $size;
    if (count($f['list']) < 40) $f['list'][] = [$inner, $size];
    if (in_array($ext, VIDEO, true) || strtoupper($name) === 'VIDEO_TS.IFO') {
      if (preg_match('/(^|[ ._\-\[(])(sample|trailer)([ ._\-\])]|$)/i', $name) || preg_match('#(^|/)(samples?|trailers?)/#i', $inner)) $f['sample']++;
      else $f['video']++;
    } elseif ($ext === 'nfo') $f['nfo'][] = $inner;
    elseif (in_array($ext, IMAGE, true)) $f['img'][] = $inner;
    else $f['other']++;
    unset($f);
    $seen++;
  }
  if (microtime(true) - $last > 0.5) { $last = microtime(true); $st['seen'] = $seen; save($st); }
}
if ($h) pclose($h);

/* read a Kodi-style .nfo: title, year, plot, rating, ids, genres */
function nfo_read(string $path): array {
  $raw = @file_get_contents($path, false, null, 0, 262144);
  if ($raw === false || $raw === '') return [];
  $o = [];
  $tag = function (string $t) use ($raw) { return preg_match('#<' . $t . '(?:\s[^>]*)?>(.*?)</' . $t . '>#is', $raw, $m) ? trim(html_entity_decode(strip_tags(preg_replace('#<!\[CDATA\[(.*?)\]\]>#s', '$1', $m[1])), ENT_QUOTES | ENT_XML1, 'UTF-8')) : ''; };
  foreach (['title', 'originaltitle', 'year', 'plot', 'outline', 'tagline', 'runtime', 'mpaa', 'premiered'] as $t) { $v = $tag($t); if ($v !== '') $o[$t] = mb_substr($v, 0, 1500); }
  if (empty($o['year']) && !empty($o['premiered']) && preg_match('/^(\d{4})/', $o['premiered'], $m)) $o['year'] = $m[1];
  if (preg_match('#<rating[^>]*default="true"[^>]*>.*?<value>([\d.]+)</value>#is', $raw, $m) || preg_match('#<ratings>.*?<value>([\d.]+)</value>#is', $raw, $m) || preg_match('#<rating>([\d.]+)</rating>#i', $raw, $m)) $o['rating'] = round((float)$m[1], 1);
  if (preg_match('#<uniqueid[^>]*type="tmdb"[^>]*>(\d+)<#i', $raw, $m) || preg_match('#<tmdbid>(\d+)<#i', $raw, $m)) $o['tmdb'] = $m[1];
  if (preg_match('#<uniqueid[^>]*type="imdb"[^>]*>(tt\d+)<#i', $raw, $m) || preg_match('#<imdbid>(tt\d+)<#i', $raw, $m) || preg_match('#<id>(tt\d+)</id>#i', $raw, $m) || preg_match('#imdb\.com/title/(tt\d+)#i', $raw, $m)) $o['imdb'] = $m[1];
  if (preg_match_all('#<genre>(.*?)</genre>#is', $raw, $m)) $o['genres'] = array_slice(array_map(fn($g) => trim(strip_tags($g)), $m[1]), 0, 6);
  return $o;
}

$results = [];
foreach ($folders as $name => $f) {
  if ($f['video']) continue;
  $kind = $f['sample'] ? 'sample' : (!$f['files'] ? 'empty' : ($f['nfo'] || $f['img'] ? 'meta' : 'other'));
  $r = ['name' => (string)$name, 'path' => "$root/$name", 'kind' => $kind, 'files' => $f['files'], 'bytes' => $f['bytes'], 'list' => $f['list'],
        'mtime' => @filemtime("$root/$name") ?: 0];
  /* from the folder name: "Title (Year)" and {tmdb-123} / {imdb-tt123} / [tmdbid-123] tags */
  $n = (string)$name;
  if (preg_match('/[\[{](?:tmdb|tmdbid)[-=](\d+)[\]}]/i', $n, $m)) $r['tmdb'] = $m[1];
  if (preg_match('/[\[{](?:imdb|imdbid)[-=](tt\d+)[\]}]/i', $n, $m)) $r['imdb'] = $m[1];
  $clean = trim(preg_replace('/\s*[\[{][^\]}]*[\]}]/', '', $n));
  if (preg_match('/^(.*?)[\s.(\[]+((?:19|20)\d{2})[)\]]?(?:\s|$|\.)/', $clean, $m)) { $r['title'] = trim(str_replace('.', ' ', $m[1])); $r['year'] = $m[2]; }
  else $r['title'] = $clean;
  /* the .nfo: prefer movie.nfo or one named like the folder */
  if ($f['nfo']) {
    usort($f['nfo'], fn($a, $b) => (substr_count($a, '/') <=> substr_count($b, '/')) ?: ((basename($b) === 'movie.nfo') <=> (basename($a) === 'movie.nfo')));
    $info = nfo_read("$root/$name/" . $f['nfo'][0]);
    foreach ($info as $k => $v) if ($v !== '' && $v !== []) $r[$k] = $v;
    $r['nfo'] = $f['nfo'][0];
  }
  /* a poster */
  $best = null;
  foreach ($f['img'] as $img) {
    $b = strtolower(basename($img));
    $score = preg_match('/^(poster|folder|cover|movie)\.\w+$/', $b) ? 3 : (str_contains($b, 'poster') ? 2 : (str_contains($b, 'fanart') || str_contains($b, 'backdrop') ? 0 : 1));
    if (substr_count($img, '/')) $score -= 2;
    if ($best === null || $score > $best[0]) $best = [$score, $img];
  }
  if ($best) $r['poster'] = $best[1];
  $results[] = $r;
}
usort($results, fn($a, $b) => strnatcasecmp($a['name'], $b['name']));
/* the list goes to its own file, one JSON line per folder; the status file stays small */
$out = fopen(UC_STATE . "/scans/$id.results", 'w');
foreach ($results as $r) fwrite($out, json_encode($r, JSON_UNESCAPED_SLASHES | JSON_INVALID_UTF8_SUBSTITUTE) . "\n");
fclose($out);
$st['found'] = count($results); $st['seen'] = $seen;
$st['state'] = $stop ? 'stopped' : 'done'; $st['finished'] = time();
save($st);
