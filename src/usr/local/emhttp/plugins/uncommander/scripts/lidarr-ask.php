<?php
/* Tools > Music library check > Ask Lidarr: runs on its own on the server, so closing the page
 * (or the browser) doesn't stop it. One album folder per run; what it's doing is written to
 * lidarr-jobs.json (next to History), which the page reads.
 *   1. the artist in Lidarr, by its folder - or added (folder kept, nothing monitored, nothing searched)
 *   2. Lidarr reads the artist's folder again, and loads its album list (can take minutes)
 *   3. the album: found by name (and year) - when it isn't clear which one, it waits for you
 *   4. only that album is monitored, and searched for */
require_once __DIR__ . '/../include/lib.php';
@set_time_limit(0);
$album = base64_decode((string)($argv[1] ?? ''), true);
if (!$album) exit(1);
$jobs = uc_lidarr_jobs(); $job = $jobs[$album] ?? [];
$c = uc_lidarr_cfg();
$set = fn(array $v) => uc_lidarr_job_set($album, $v);
$norm = function (string $n) {
  $n = mb_strtolower($n);
  $n = preg_replace('/[\(\[\{][^\)\]\}]*[\)\]\}]/u', ' ', $n);
  $n = preg_replace('/\b(deluxe|remaster(ed)?|edition|expanded|anniversary|bonus|explicit|version|special|limited|reissue)\b/u', ' ', $n);
  if (class_exists('Normalizer')) $n = Normalizer::normalize($n, Normalizer::FORM_KD) ?: $n;
  return preg_replace('/[^\p{L}\p{N}]+/u', '', $n);
};
/* folder and tag names are messy: "1997 - Secret Samadhi", "Live - Secret Samadhi [FLAC]", "Secret Samadhi CD1"...
 * the artist's name, years, disc numbers and edition words are taken off before comparing */
$clean = function (string $n, string $artist = '') use ($norm) {
  $n = mb_strtolower(trim($n));
  if ($artist !== '') { $a = mb_strtolower($artist); if (str_starts_with($n, $a)) $n = ltrim(mb_substr($n, mb_strlen($a)), " -–_.:"); }
  $n = preg_replace('/^\(?(19|20)\d\d\)?\s*[-–_.]\s*/u', '', $n);          // 1997 - Title
  $n = preg_replace('/\s*[-–_]\s*(19|20)\d\d$/u', '', $n);                   // Title - 1997
  $n = preg_replace('/\b(cd|dis[ck])\s*\d+\b/u', ' ', $n);
  return $norm($n);
};
$like = function (string $a, string $b) {          // 0..1
  if ($a === '' || $b === '') return 0.0;
  if ($a === $b) return 1.0;
  if (mb_strlen($a) >= 4 && mb_strlen($b) >= 4 && (str_contains($a, $b) || str_contains($b, $a))) return 0.9;
  $l = max(strlen($a), strlen($b));
  return $l > 255 ? 0.0 : 1 - levenshtein($a, $b) / $l;
};
$noThe = fn(string $n) => preg_replace('/^the(?=\p{L})/u', '', $n);
/* until Lidarr is done reading folders and album lists (its routine background tasks don't count) */
$idle = function (int $secs) use ($c) {
  $t0 = time();
  while (time() - $t0 < $secs) {
    try { $busy = array_filter((array)uc_lidarr_req($c, 'GET', 'command'), fn($x) => in_array($x['status'] ?? '', ['queued', 'started'], true)
      && preg_match('/^(RefreshArtist|BulkRefreshArtist|RefreshAlbum|RescanFolders|AddArtist|ImportListSync|RenameFiles|MoveArtist)$/', (string)($x['name'] ?? ''))); } catch (Throwable $e) { return; }
    if (!$busy) return;
    sleep(5);
  }
};
$wait = function (int $cmdId, int $secs) use ($c) {
  $t0 = time();
  while (time() - $t0 < $secs) { sleep(5); try { $s = uc_lidarr_req($c, 'GET', "command/$cmdId"); if (in_array($s['status'] ?? '', ['completed', 'failed', 'aborted'], true)) return; } catch (Throwable $e) { return; } }
};
/* one album at a time: several asked at once would trip over each other (the same artist added twice,
 * each waiting for the other's folder reading) */
@mkdir(UC_STATE, 0700, true);
$lock = fopen(UC_STATE . '/lidarr-ask.lock', 'c');
$t0 = time();
while ($lock && !flock($lock, LOCK_EX | LOCK_NB)) {
  if (time() - $t0 > 7200) { $set(['state' => 'failed', 'msg' => 'Gave up waiting for the other albums sent to Lidarr - ask again']); exit(1); }
  $set(['state' => 'start', 'msg' => 'Waiting - Lidarr is busy with another album you asked for…']);
  sleep(5);
}
try {
  $artistDir = (string)($job['artist'] ?? dirname($album));
  $lp = uc_lidarr_path($c, $artistDir);
  if ($lp === null) throw new UcError("Lidarr doesn't see $artistDir - add a folder pair in Settings > Tools > Lidarr");
  $artistName = (string)($job['artist_name'] ?? '') ?: basename($artistDir);
  /* 1. the artist */
  $set(['state' => 'start', 'msg' => 'Looking for the artist in Lidarr…']);
  $artist = null;
  foreach ((array)uc_lidarr_req($c, 'GET', 'artist') as $a) if (strcasecmp(rtrim((string)($a['path'] ?? ''), '/'), $lp) === 0) { $artist = $a; break; }
  $an = $noThe($norm($artistName));
  if (!$artist) foreach ((array)uc_lidarr_req($c, 'GET', 'artist') as $a) if ($noThe($norm((string)($a['artistName'] ?? ''))) === $an) { $artist = $a; break; }
  if (!$artist) {
    $set(['state' => 'adding', 'msg' => "Adding $artistName to Lidarr (no albums wanted)…"]);
    $found = (array)uc_lidarr_req($c, 'GET', 'artist/lookup?term=' . rawurlencode($artistName));
    $same = array_values(array_filter($found, fn($f) => $noThe($norm((string)($f['artistName'] ?? ''))) === $an));
    /* several artists by that name (there are many bands called Live), or none spelled quite like the
     * folder: look the album up with the artist's name - its artist is the one */
    $albName = (string)($job['album'] ?? '') ?: basename($album);
    if (count($same) !== 1) {
      try {
        $best = null; $bs = 0;
        foreach ((array)uc_lidarr_req($c, 'GET', 'album/lookup?term=' . rawurlencode("$artistName $albName")) as $al) {
          $ar = (array)($al['artist'] ?? []);
          $sc = $like($noThe($norm((string)($ar['artistName'] ?? ''))), $an) + $like($clean((string)($al['title'] ?? '')), $clean($albName, $artistName));
          if ($sc > $bs && !empty($ar['foreignArtistId'])) { $bs = $sc; $best = $ar; }
        }
        if ($best && $bs >= 1.7) {
          $hit = array_values(array_filter($same ?: $found, fn($f) => ($f['foreignArtistId'] ?? '') === $best['foreignArtistId']));
          if (!$hit) $hit = (array)uc_lidarr_req($c, 'GET', 'artist/lookup?term=' . rawurlencode('lidarr:' . $best['foreignArtistId']));
          if ($hit) $same = [$hit[0]];
        }
      } catch (Throwable $e) {}
    }
    $pick = $same[0] ?? null;
    if (!$pick) throw new UcError("Lidarr couldn't find an artist called $artistName - add the artist in Lidarr (its search is smarter with odd names), then ask again");
    $body = array_merge($pick, ['qualityProfileId' => (int)$c['profile'], 'metadataProfileId' => (int)$c['meta'], 'monitored' => true, 'monitorNewItems' => 'none',
      'path' => $lp, 'rootFolderPath' => dirname($lp), 'addOptions' => ['monitor' => 'none', 'searchForMissingAlbums' => false]]);
    try { $artist = uc_lidarr_req($c, 'POST', 'artist', $body); }
    catch (UcError $e) {           // added in the meantime (in Lidarr, or by another ask): use that one
      foreach ((array)uc_lidarr_req($c, 'GET', 'artist') as $a) if (($a['foreignArtistId'] ?? '') === ($pick['foreignArtistId'] ?? '-')) $artist = $a;
      if (!$artist) throw $e;
    }
  } else {
    if (empty($artist['monitored'])) { $artist['monitored'] = true; $artist = uc_lidarr_req($c, 'PUT', 'artist/' . $artist['id'], $artist); }
    /* 2. Lidarr reads the folder again, so it knows the songs that are there */
    $set(['state' => 'waiting', 'msg' => 'Lidarr is reading the artist\'s folder…']);
    try { $cmd = uc_lidarr_req($c, 'POST', 'command', ['name' => 'RefreshArtist', 'artistId' => (int)$artist['id']]); if (!empty($cmd['id'])) $wait((int)$cmd['id'], 300); } catch (Throwable $e) {}
  }
  $aid = (int)$artist['id'];
  /* 2b. its album list (a new artist's takes a while to arrive from MusicBrainz) */
  $albums = []; $t0 = time();
  while (true) {
    $albums = (array)uc_lidarr_req($c, 'GET', "album?artistId=$aid");
    if ($albums || time() - $t0 > 1200) break;
    $set(['state' => 'waiting', 'msg' => 'Waiting for Lidarr to load the artist\'s albums… (' . round((time() - $t0) / 60) . ' min)']);
    sleep(20);
  }
  if (!$albums) throw new UcError('Lidarr has no albums for this artist after 20 minutes - check the artist in Lidarr (metadata profile?)');
  /* 3. the album */
  $id = (int)($job['pick'] ?? 0);
  if (!$id) {
    $want = array_filter([(string)($job['album'] ?? ''), basename($album)]);
    $year = (string)($job['year'] ?? '') ?: (preg_match('/\b(19|20)\d\d\b/', basename($album), $m) ? $m[0] : '');
    /* each of Lidarr's albums gets a score: how close its title is to the songs' album tag or the folder name */
    $score = [];
    foreach ($albums as $a) {
      $t = $clean((string)$a['title']); $sc = 0;
      foreach ($want as $w) $sc = max($sc, $like($t, $clean($w, $artistName)));
      if ($year !== '' && str_starts_with((string)($a['releaseDate'] ?? ''), $year)) $sc += 0.05;
      $score[(int)$a['id']] = $sc;
    }
    arsort($score);
    $top = array_key_first($score); $topS = $score[$top] ?? 0;
    $close = array_filter($score, fn($v) => $v >= $topS - 0.04);
    $second = array_values($score)[1] ?? 0;
    if (($topS >= 0.9 && count($close) === 1) || ($topS >= 0.8 && $second < $topS - 0.3)) $id = (int)$top;     // clearly the one (a typo is fine)
    else {
      $byId = []; foreach ($albums as $a) $byId[(int)$a['id']] = $a;
      $list = array_map(fn($k) => $byId[$k], array_keys($score));         // closest first
      $hits = $topS >= 0.9;
      $set(['state' => 'pick', 'msg' => ($hits ? 'More than one album by that name - which one?' : "Lidarr has no album called " . basename($album) . ' - which one is it? (closest first)')
        . " If it isn't listed, Lidarr's metadata profile may leave that kind out (live, compilation, EP, single) - change it in Lidarr › Settings › Profiles, then ask again.",
        'choices' => array_map(fn($a) => ['id' => (int)$a['id'], 'title' => (string)$a['title'], 'year' => substr((string)($a['releaseDate'] ?? ''), 0, 4), 'type' => (string)($a['albumType'] ?? '')], array_slice($list, 0, 80))]);
      exit(0);
    }
  }
  $title = ''; foreach ($albums as $a) if ((int)$a['id'] === $id) $title = (string)$a['title'];
  $set(['state' => 'waiting', 'msg' => "Waiting for Lidarr to finish reading {$title}…", 'choices' => null, 'lidarr_album' => $title, 'album_id' => $id]);
  $idle(300);
  /* 3b. the edition: Lidarr matches your songs to one release of the album. When it picked one with fewer
   *     songs than the album you have holes in (10 of a 12-song album), it thinks the album is complete -
   *     so the edition with all the songs is picked instead */
  $want = (int)($job['want'] ?? 0); $edition = '';
  if ($want > 0) {
    $al = (array)uc_lidarr_req($c, 'GET', "album/$id");
    $rels = (array)($al['releases'] ?? []); $cur = null;
    foreach ($rels as $r) if (!empty($r['monitored'])) $cur = $r;
    if ($rels && (!$cur || (int)($cur['trackCount'] ?? 0) < $want)) {
      $fit = array_values(array_filter($rels, fn($r) => (int)($r['trackCount'] ?? 0) >= $want));
      usort($fit, function ($a, $b) use ($want, $cur) {
        $sa = [(int)$a['trackCount'] - $want, $cur && ($a['format'] ?? '') === ($cur['format'] ?? '') ? 0 : 1, $cur && ($a['country'] ?? []) == ($cur['country'] ?? []) ? 0 : 1];
        $sb = [(int)$b['trackCount'] - $want, $cur && ($b['format'] ?? '') === ($cur['format'] ?? '') ? 0 : 1, $cur && ($b['country'] ?? []) == ($cur['country'] ?? []) ? 0 : 1];
        return $sa <=> $sb;
      });
      if ($fit) {
        $pick = $fit[0];
        foreach ($al['releases'] as &$r) $r['monitored'] = (int)$r['id'] === (int)$pick['id']; unset($r);
        $al['anyReleaseOk'] = false;
        $set(['state' => 'waiting', 'msg' => "Picking the $pick[trackCount]-song edition of {$title}…"]);
        uc_lidarr_req($c, 'PUT', "album/$id", $al);
        $edition = "the {$pick['trackCount']}-song edition" . (!empty($pick['format']) ? " ({$pick['format']})" : '');
        try { $cmd = uc_lidarr_req($c, 'POST', 'command', ['name' => 'RefreshArtist', 'artistId' => $aid]); if (!empty($cmd['id'])) $wait((int)$cmd['id'], 300); } catch (Throwable $e) {}
        $idle(180);
      } else $edition = 'no edition with ' . $want . ' songs - Lidarr only knows shorter ones';
    }
  }
  /* 4. only this album: monitored, and searched for */
  $set(['state' => 'searching', 'msg' => "Asking Lidarr to search for {$title}…", 'edition' => $edition]);
  uc_lidarr_req($c, 'PUT', 'album/monitor', ['albumIds' => [$id], 'monitored' => true]);
  $cmd = uc_lidarr_req($c, 'POST', 'command', ['name' => 'AlbumSearch', 'albumIds' => [$id]]);
  /* did it grab anything? Lidarr says so when the search ends ("1 reports downloaded"); a grab also shows up
   * in its queue - slow indexers can take minutes, so this waits up to 15 */
  $inQ = false; $done = false; $t0 = time();
  while (!$inQ && time() - $t0 < 900) {
    sleep(5);
    if (!$done && !empty($cmd['id'])) {
      try { $st = uc_lidarr_req($c, 'GET', "command/{$cmd['id']}"); } catch (Throwable $e) { $st = ['status' => 'completed']; }
      if (in_array($st['status'] ?? '', ['completed', 'failed', 'aborted'], true)) {
        $done = time();
        if (preg_match('/(\d+) reports? downloaded/i', (string)($st['message'] ?? ''), $m) && (int)$m[1] > 0) $inQ = true;
      } elseif (time() - $t0 > 60) $set(['state' => 'searching', 'msg' => "Lidarr is still searching for $title (" . round((time() - $t0) / 60) . ' min)…']);
    }
    if (!$inQ) { try { $q = (array)uc_lidarr_req($c, 'GET', "queue/details?albumIds=$id"); $inQ = (bool)array_filter($q, fn($x) => (int)($x['albumId'] ?? 0) === $id); } catch (Throwable $e) {} }
    if ($done && time() - $done >= 20) break;          // the search ended: a few more looks at the queue, then stop
  }
  if ($inQ) $set(['state' => 'sent', 'msg' => "Lidarr is downloading $title" . ($edition && !str_starts_with($edition, 'no ') ? " ($edition)" : '') . " - it lands in the artist's folder"]);
  else {
    /* nothing grabbed: ask Lidarr what it found and why it turned each one down (its Interactive Search) */
    $set(['state' => 'searching', 'msg' => "Lidarr downloaded nothing - asking it why…"]);
    $why = ''; $list = [];
    try {
      $rels = (array)uc_lidarr_req($c, 'GET', "release?albumId=$id", null, 180);
      $count = [];
      foreach ($rels as $r) foreach ((array)($r['rejections'] ?? []) as $x) { $x = is_array($x) ? (string)($x['reason'] ?? '') : (string)$x; if ($x !== '') $count[$x] = ($count[$x] ?? 0) + 1; }
      arsort($count); $why = (string)array_key_first($count);
      /* the ones worth offering: right album, sorted by quality, then seeders */
      $rank = function ($r) { $q = (array)($r['quality']['quality'] ?? []); return [empty($r['approved']) ? 1 : 0, -(int)($r['qualityWeight'] ?? 0), -(int)($r['seeders'] ?? 0), -(float)($r['size'] ?? 0)]; };
      usort($rels, fn($a, $b) => $rank($a) <=> $rank($b));
      foreach (array_slice($rels, 0, 12) as $r) {
        if (empty($r['guid'])) continue;
        $list[] = ['guid' => (string)$r['guid'], 'idx' => (int)($r['indexerId'] ?? 0), 'title' => mb_substr((string)($r['title'] ?? ''), 0, 200),
          'q' => (string)($r['quality']['quality']['name'] ?? ''), 'size' => (float)($r['size'] ?? 0), 'seed' => isset($r['seeders']) ? (int)$r['seeders'] : null,
          'proto' => (string)($r['protocol'] ?? ''), 'indexer' => (string)($r['indexer'] ?? ''), 'age' => (int)($r['ageHours'] ?? 0),
          'no' => array_values(array_map(fn($x) => is_array($x) ? (string)($x['reason'] ?? '') : (string)$x, (array)($r['rejections'] ?? [])))];
      }
      $found = count($rels);
    } catch (Throwable $e) { $found = -1; }
    $msg = $found > 0 ? "Lidarr found $found release" . ($found === 1 ? '' : 's') . " of $title but turned them all down" . ($why !== '' ? ": $why" : '')
      : ($found === 0 ? "Lidarr's indexers have no release of $title" : "Lidarr searched for $title but didn't download anything");
    $set(['state' => 'nothing', 'msg' => $msg, 'why' => $why, 'rels' => $list, 'relsAt' => time(), 'found' => $found]);
  }
} catch (Throwable $e) {
  $set(['state' => 'failed', 'msg' => $e->getMessage()]);
}
