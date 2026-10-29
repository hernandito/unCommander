<?php
/* unCommander - TV tool: reading episode numbers from file names.
 * Used by the scan (tvscan.php) and by the quick recheck of shows sent to Sonarr. */
const TV_VIDEO = ['mkv', 'mp4', 'm4v', 'avi', 'mov', 'wmv', 'mpg', 'mpeg', 'ts', 'm2ts', 'mts', 'iso', 'vob', 'webm', 'flv', 'divx', 'xvid',
               'ogm', 'rmvb', 'asf', 'strm', 'mk3d', 'wtv', 'dvr-ms', 'f4v', '3gp'];
/* folders that hold extras, not episodes */
const TV_EXTRAS = ['extras', 'extra', 'featurettes', 'featurette', 'behind the scenes', 'deleted scenes', 'interviews', 'scenes', 'shorts',
                'trailers', 'trailer', 'other', 'others', 'samples', 'sample', 'bonus', 'bonus features', 'specials', 'special'];
/* ---------- reading episode numbers from a file's path ---------- */
/* returns ['eps' => [[s, e], ...], 'dates' => ['2019-03-14'], 'skip' => bool] */
function uc_tv_parse_ep(string $inner): array {
  $dirs = explode('/', $inner); $name = array_pop($dirs);
  foreach ($dirs as $d) if (in_array(strtolower(trim($d)), TV_EXTRAS, true)) return ['eps' => [], 'dates' => [], 'skip' => true];
  $stem = preg_replace('/\.[^.]+$/', '', $name);
  if (preg_match('/(^|[ ._\-\[(])(sample|trailer)([ ._\-\])]|$)/i', $stem)) return ['eps' => [], 'dates' => [], 'skip' => true];
  $out = [];
  /* S01E05, S01E05E06, S01E05-E07, S01E05-07. A second number needs an "E" unless it
   * follows the dash directly: in "S04E15 - 100th Day of School" the 100 is the title.
   * Ordinals (1st, 100th) and resolutions (720p) are never episode numbers. */
  $SEP = '(?:-e?|[ ._]+-[ ._]*e|-[ ._]+e|[ ._]?e)';
  $NUM = '(\d{1,4})(?!\d)(?!(?:st|nd|rd|th|p|i)(?![a-z]))';
  if (preg_match('/(?<![a-z0-9])s(\d{1,3})[ ._-]?e(\d{1,4})(?!\d)((?:' . $SEP . '\d{1,4}(?!\d)(?!(?:st|nd|rd|th|p|i)(?![a-z])))*)/i', $stem, $m)) {
    $s = (int)$m[1]; $prev = (int)$m[2]; $out[] = [$s, $prev];
    if ($m[3] !== '' && preg_match_all('/(' . $SEP . ')' . $NUM . '/i', $m[3], $mm, PREG_SET_ORDER)) {
      foreach ($mm as [, $sep, $n]) {
        $n = (int)$n;
        if ($n <= $prev || $n - $prev > 20) break;      // not a believable next episode: stop reading
        if (str_contains($sep, '-')) { for ($k = $prev + 1; $k <= $n; $k++) $out[] = [$s, $k]; }
        else $out[] = [$s, $n];
        $prev = $n;
      }
    }
    return ['eps' => $out, 'dates' => [], 'skip' => false];
  }
  /* 1x05, 1x05-1x06 */
  if (preg_match('/(?<![a-z0-9])(\d{1,2})x(\d{2,3})(?![0-9p])((?:(?:-|[ ._]*-[ ._]*\d{1,2}x)\d{2,3}(?!\d)(?!(?:st|nd|rd|th|p|i)(?![a-z])))*)/i', $stem, $m)) {
    $s = (int)$m[1]; $prev = (int)$m[2]; $out[] = [$s, $prev];
    if ($m[3] !== '' && preg_match_all('/(?:\d{1,2}x)?(\d{2,3})(?!\d)/i', $m[3], $mm)) foreach ($mm[1] as $n) { $n = (int)$n; if ($n <= $prev || $n - $prev > 20) break; $out[] = [$s, $n]; $prev = $n; }
    return ['eps' => $out, 'dates' => [], 'skip' => false];
  }
  /* daily shows: 2019-03-14 / 2019.03.14 */
  if (preg_match('/(?<!\d)((?:19|20)\d{2})[.\-_ ](\d{2})[.\-_ ](\d{2})(?!\d)/', $stem, $m)) return ['eps' => [], 'dates' => ["$m[1]-$m[2]-$m[3]"], 'skip' => false];
  /* "Season 2/Episode 05.mkv", "Season 2/E05 - Title.mkv", "Season 2/05 - Title.mkv" */
  $season = null;
  foreach (array_reverse($dirs) as $d) if (preg_match('/^(?:season|series|staffel|saison|temporada|s)[ ._-]*(\d{1,3})$/i', trim($d), $m)) { $season = (int)$m[1]; break; }
  if ($season !== null) {
    if (preg_match('/(?<![a-z0-9])(?:ep(?:isode)?|e)[ ._-]?(\d{1,3})(?![0-9])/i', $stem, $m) || preg_match('/^(\d{1,3})(?![0-9])(?:[ ._-]|$)/', $stem, $m))
      return ['eps' => [[$season, (int)$m[1]]], 'dates' => [], 'skip' => false];
  }
  return ['eps' => [], 'dates' => [], 'skip' => false];
}


/* The episodes in a show folder now (["1.5", "2.3", ...]) - dates of daily
 * shows are matched to episodes with the show's episode list ($eps). */
function uc_tv_folder_have(string $path, array $eps, ?array &$odd = null, ?array &$info = null): array {
  $raw = (string)shell_exec('find -H ' . escapeshellarg($path) . ' -mindepth 1 -name ' . escapeshellarg(UC_TRASH) . ' -prune -o -type f -printf ' . escapeshellarg('%P\t%s\0') . ' 2>/dev/null');
  $have = []; $dates = []; $fileOf = []; $info = ['files' => 0, 'bytes' => 0, 'extras' => 0, 'unparsed' => []];
  $list = []; foreach (explode("\0", $raw) as $e) { $t = strrpos($e, "\t"); if ($t !== false) $list[substr($e, 0, $t)] = (int)substr($e, $t + 1); }
  uksort($list, 'strnatcasecmp');
  foreach ($list as $inner => $size) {
    if ($inner === '' || !in_array(strtolower(pathinfo($inner, PATHINFO_EXTENSION)), TV_VIDEO, true)) continue;
    $info['files']++; $info['bytes'] += $size;
    $p = uc_tv_parse_ep($inner);
    if ($p['skip']) { $info['extras']++; continue; }
    foreach ($p['eps'] as [$s, $e]) if ($s > 0) { $have["$s.$e"] = true; $fileOf["$s.$e"] ??= $inner; }
    foreach ($p['dates'] as $d) $dates[$d] = true;
    if (!$p['eps'] && !$p['dates'] && count($info['unparsed']) < 25) $info['unparsed'][] = $inner;
  }
  if ($dates) foreach ($eps as [$s, $e, $d]) if ($d !== '' && isset($dates[$d])) $have["$s.$e"] = true;
  $odd = uc_tv_odd_files($fileOf, $eps);
  return array_keys($have);
}

/* the files whose episode number isn't in the show's episode list:
 * "4.100" => "Season 4/Show - S04E100.mkv" (at most 80, so the scan stays small) */
function uc_tv_odd_files(array $fileOf, array $eps): array {
  $known = []; foreach ($eps as $ep) $known["{$ep[0]}.{$ep[1]}"] = true;
  $out = [];
  foreach ($fileOf as $k => $f) { if (isset($known[$k])) continue; $out[(string)$k] = $f; if (count($out) >= 80) break; }
  return $out;
}

/* Look in a scanned show's folder again and update its row: episodes, file count,
 * odd numbers - for downloads that arrived after the scan. */
function uc_tv_refresh_row(array &$r): void {
  if (empty($r['path']) || !is_dir($r['path'])) return;
  $r['have'] = uc_tv_folder_have($r['path'], (array)($r['eps'] ?? []), $odd, $info);
  $r['odd'] = (object)$odd;
  foreach (['files', 'bytes', 'extras', 'unparsed'] as $k) $r[$k] = $info[$k];
}
