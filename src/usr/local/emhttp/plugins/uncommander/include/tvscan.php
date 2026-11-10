<?php
/* unCommander - Tools > TV shows with missing episodes.
 * Each folder directly inside the chosen root is one show. For each show:
 *   1. read the episode numbers from the video file names (S01E05, 1x05,
 *      S01E01-E02, dates for daily shows; specials, extras and samples skipped)
 *   2. work out which show it is: the folder's saved match, then ids in
 *      tvshow.nfo or the folder name, then a title (+ year) search - with your
 *      episode files deciding between look-alikes
 *   3. get the show's episode list from TVmaze (cached in memory)
 * The verdict (complete, missing...) is worked out in the browser, so your
 * "ignore" choices apply straight away. Read-only: nothing is changed. */
require_once __DIR__ . '/lib.php';
require_once __DIR__ . '/tvparse.php';

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
$st['pid'] = getmypid(); $st['state'] = 'running'; $st['phase'] = 'files'; save($st);

$root = rtrim($st['root'], '/');

/* the show folders */
$shows = [];
foreach (scandir($root) ?: [] as $n) {
  if ($n === '.' || $n === '..' || $n[0] === '.' || $n === UC_TRASH) continue;
  if (is_dir("$root/$n") && !is_link("$root/$n")) $shows[$n] = ['files' => [], 'count' => 0, 'bytes' => 0];
}
$st['total'] = count($shows); save($st);

/* every video file below them, in one pass */
$h = popen('find -H ' . escapeshellarg($root) . ' -mindepth 2 -name ' . escapeshellarg(UC_TRASH) . ' -prune -o -type f -printf ' . escapeshellarg('%P\t%s\0') . ' 2>/dev/null', 'r');
$buf = ''; $seen = 0; $last = 0;
while ($h && !feof($h) && !$stop) {
  $buf .= fread($h, 1 << 16);
  $parts = explode("\0", $buf); $buf = array_pop($parts);
  foreach ($parts as $e) {
    $t = strrpos($e, "\t"); if ($t === false) continue;
    $rel = substr($e, 0, $t); $i = strpos($rel, '/'); if ($i === false) continue;
    $top = substr($rel, 0, $i); if (!isset($shows[$top])) continue;
    $inner = substr($rel, $i + 1);
    $ext = strtolower(pathinfo($inner, PATHINFO_EXTENSION));
    if (!in_array($ext, TV_VIDEO, true)) continue;
    $seen++;
    $shows[$top]['count']++; $shows[$top]['bytes'] += (int)substr($e, $t + 1);
    if (count($shows[$top]['files']) < 5000) $shows[$top]['files'][] = $inner;
  }
  if (microtime(true) - $last > 0.5) { $last = microtime(true); $st['seen'] = $seen; save($st); }
}
if ($h) pclose($h);

/* ---------- tvshow.nfo: ids, title and year (only to know WHICH show) ---------- */
function nfo_ids(string $dir): array {
  $f = "$dir/tvshow.nfo";
  if (!is_file($f)) return [];
  $raw = (string)@file_get_contents($f, false, null, 0, 262144);
  $o = [];
  $tag = fn($t) => preg_match('#<' . $t . '(?:\s[^>]*)?>(.*?)</' . $t . '>#is', $raw, $m) ? trim(html_entity_decode(strip_tags(preg_replace('#<!\[CDATA\[(.*?)\]\]>#s', '$1', $m[1])), ENT_QUOTES | ENT_XML1, 'UTF-8')) : '';
  if (preg_match('#<uniqueid[^>]*type="(?:tvdb|thetvdb)"[^>]*>\s*(\d+)\s*<#i', $raw, $m) || preg_match('#<tvdbid>\s*(\d+)\s*<#i', $raw, $m)) $o['tvdb'] = $m[1];
  if (preg_match('#<uniqueid[^>]*type="imdb"[^>]*>\s*(tt\d+)\s*<#i', $raw, $m) || preg_match('#<imdb_?id>\s*(tt\d+)\s*<#i', $raw, $m) || preg_match('#imdb\.com/title/(tt\d+)#i', $raw, $m)) $o['imdb'] = $m[1];
  if (empty($o['tvdb']) && preg_match('#<id>\s*(\d{4,7})\s*</id>#i', $raw, $m)) $o['tvdb'] = $m[1];   // old Kodi files: <id> is the TheTVDB id
  if (preg_match('#<uniqueid[^>]*type="tvmaze"[^>]*>\s*(\d+)\s*<#i', $raw, $m)) $o['tvmaze'] = $m[1];
  $t = $tag('title'); if ($t !== '') $o['title'] = $t;
  $y = $tag('year') ?: substr($tag('premiered'), 0, 4); if (preg_match('/^(19|20)\d{2}$/', $y)) $o['year'] = $y;
  return $o;
}

/* how well a candidate's episode list fits the episodes in the folder (0..1) */
function fit(array $have, array $eps): float {
  if (!$have) return 0.0;
  $set = []; foreach ($eps as [$s, $e]) $set["$s.$e"] = true;
  $hit = 0; foreach ($have as $k => $_) if (isset($set[$k])) $hit++;
  return $hit / count($have);
}

/* ---------- each show ---------- */
$matches = uc_tv_store('matches'); $newMatches = 0;
$out = fopen(UC_STATE . "/scans/$id.results", 'w');
$done = 0; $looked = 0; $down = null;   // once TVmaze can't be reached, don't wait on it again for every show $st['phase'] = 'shows'; save($st);
uksort($shows, 'strnatcasecmp');
foreach ($shows as $name => $f) {
  if ($stop) break;
  $path = "$root/$name";
  $st['current'] = $name; $st['done'] = $done; save($st);

  /* the episodes in the folder */
  $have = []; $dates = []; $unparsed = []; $extras = 0; $fileOf = [];
  natcasesort($f['files']);
  foreach ($f['files'] as $inner) {
    $p = uc_tv_parse_ep($inner);
    if ($p['skip']) { $extras++; continue; }
    foreach ($p['eps'] as [$s, $e]) if ($s > 0) { $have["$s.$e"] = true; $fileOf["$s.$e"] ??= $inner; }
    foreach ($p['dates'] as $d) $dates[$d] = $inner;
    if (!$p['eps'] && !$p['dates']) { if (count($unparsed) < 25) $unparsed[] = $inner; else $unparsed[25] = '…'; }
  }
  $row = ['name' => (string)$name, 'path' => $path, 'files' => $f['count'], 'bytes' => $f['bytes'], 'extras' => $extras, 'unparsed' => array_values($unparsed)];

  /* which show is it? */
  $nfo = nfo_ids($path);
  $folderTitle = trim(preg_replace('/\s*[\[{(][^\]})]*[\]})]\s*/', ' ', $name));
  $folderTitle = trim(preg_replace('/[._]+/', ' ', $folderTitle));
  $year = preg_match('/\((\d{4})\)/', $name, $m) ? $m[1] : ($nfo['year'] ?? null);
  $title = $nfo['title'] ?? $folderTitle;
  $tvm = null; $how = null; $cand = [];
  try {
    if (!empty($matches[$path]['id'])) { $tvm = (int)$matches[$path]['id']; $how = $matches[$path]['how'] ?? 'saved'; }
    if ($down !== null) {
      /* TVmaze is unreachable: use what's cached, otherwise say so */
      $sh = $tvm ? uc_tv_show($tvm, true) : null;
      if (!$sh) throw new UcError($down);
    }
    if (!$tvm && !empty($nfo['tvmaze'])) { $tvm = (int)$nfo['tvmaze']; $how = 'nfo'; }
    /* an id from a saved match or tvshow.nfo that TVmaze doesn't know (any more):
     * forget it and fall back to the title search below */
    if ($tvm && !uc_tv_show($tvm, $down !== null)) {
      if (!empty($matches[$path]['id']) && (int)$matches[$path]['id'] === $tvm) { unset($matches[$path]); $newMatches++; }
      $tvm = null; $how = null; $row['stale'] = true;
    }
    $tag = fn($k) => preg_match('/[\[{](?:' . $k . ')(?:id)?[-=]([a-z]*\d+)[\]}]/i', $name, $mm) ? $mm[1] : null;
    foreach ([['thetvdb', $nfo['tvdb'] ?? $tag('tvdb'), 'nfo'], ['imdb', $nfo['imdb'] ?? $tag('imdb'), 'nfo']] as [$k, $v, $src]) {
      if ($tvm || !$v) continue;
      $looked++;
      $j = uc_tvmaze_get("lookup/shows?$k=" . rawurlencode((string)$v));
      if ($j && !empty($j['id'])) { $tvm = (int)$j['id']; $how = isset($nfo['tvdb']) || isset($nfo['imdb']) ? 'nfo' : 'folder'; }
    }
    if (!$tvm && $title !== '') {
      /* title search: an exact title (and year, when known) that only one show has */
      $looked++;
      $list = uc_tv_search($title);
      $want = uc_tv_norm($title);
      $exact = array_values(array_filter($list, fn($c) => uc_tv_norm($c['name']) === $want));
      if ($year) { $y = array_values(array_filter($exact, fn($c) => $c['year'] === $year)); if ($y) $exact = $y; }
      if (count($exact) === 1) { $tvm = $exact[0]['id']; $how = 'title'; }
      elseif (count($exact) > 1 && $have) {
        /* look-alikes: the one whose episode list fits the files best */
        $scores = [];
        foreach (array_slice($exact, 0, 4) as $c) { $sh = uc_tv_show($c['id']); $scores[$c['id']] = $sh ? fit($have, $sh['eps']) : 0; }
        arsort($scores); $ids = array_keys($scores); $best = $scores[$ids[0]]; $second = $scores[$ids[1]] ?? 0;
        if ($best >= 0.9 && $best - $second >= 0.3) { $tvm = $ids[0]; $how = 'fit'; }
      }
      if (!$tvm) $cand = array_slice($exact ?: $list, 0, 8);
    }
    if ($tvm) {
      $sh = uc_tv_show($tvm);
      if (!$sh) { $row['err'] = "TVmaze doesn't have the show this folder was matched to - pick it again"; $tvm = null; }
      else {
        /* daily shows named by date: find the episode that aired that day */
        if ($dates) { $byDate = []; foreach ($sh['eps'] as [$s, $e, $d]) if ($d !== '') $byDate[$d][] = "$s.$e"; foreach ($dates as $d => $_) foreach ($byDate[$d] ?? [] as $k) $have[$k] = true; }
        $row['show'] = $sh['show']; $row['eps'] = $sh['eps']; $row['how'] = $how;
        /* numbered differently from TVmaze? Sonarr's numbering may be the one the files use */
        $row['have'] = array_keys($have);
        uc_tv_try_sonarr_order($row);
        /* the file names behind episode numbers the list doesn't have - shown in Details */
        $odd = uc_tv_odd_files($fileOf, $row['eps']); if ($odd) $row['odd'] = $odd;
        if (empty($matches[$path]['id']) || (int)$matches[$path]['id'] !== $tvm) { $matches[$path] = ['id' => $tvm, 'how' => $how, 'name' => $sh['show']['name']]; $newMatches++; }
      }
    } else { $row['cand'] = $cand; $row['title'] = $title; $row['year'] = $year; }
  } catch (UcError $e) {
    $row['err'] = $e->getMessage();
    if (str_starts_with($row['err'], "Can't reach")) $down = $row['err'];
  }
  $row['have'] = array_keys($have);
  fwrite($out, json_encode($row, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE | JSON_INVALID_UTF8_SUBSTITUTE) . "\n");
  fflush($out);
  $done++;
  $st['done'] = $done; $st['looked'] = $looked; save($st);
}
fclose($out);
/* matches found this time are remembered - one write at the end */
if ($newMatches) uc_tv_store('matches', $matches);
$st['current'] = null; $st['found'] = $done; $st['seen'] = $seen;
$st['state'] = $stop ? 'stopped' : 'done'; $st['finished'] = time();
save($st);
