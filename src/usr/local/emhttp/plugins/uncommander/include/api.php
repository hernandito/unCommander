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
            'svg' => 'image/svg+xml', 'pdf' => 'application/pdf',
            /* video and music for the gallery preview - the browser plays what it can */
            'mp4' => 'video/mp4', 'm4v' => 'video/mp4', 'mov' => 'video/quicktime', 'mkv' => 'video/x-matroska', 'webm' => 'video/webm',
            'mp3' => 'audio/mpeg', 'm4a' => 'audio/mp4', 'm4b' => 'audio/mp4', 'aac' => 'audio/aac', 'flac' => 'audio/flac', 'ogg' => 'audio/ogg', 'oga' => 'audio/ogg', 'opus' => 'audio/ogg', 'wav' => 'audio/wav',
            'aif' => 'audio/aiff', 'aiff' => 'audio/aiff', 'caf' => 'audio/x-caf', 'mka' => 'audio/x-matroska', 'weba' => 'audio/webm', 'mp2' => 'audio/mpeg'];
  try { $p = uc_arc_real(uc_path((string)($_GET['path'] ?? ''))); } catch (Throwable $e) { http_response_code(403); exit; }
  $ext = strtolower(pathinfo($p, PATHINFO_EXTENSION));
  if (!isset($types[$ext]) || !is_file($p) || !is_readable($p)) { http_response_code(404); exit; }
  if (preg_match('#^(video|audio)/#', $types[$ext])) $p = uc_direct($p);      // big media: straight from its disk
  $size = filesize($p);
  /* Range requests: a video can be started anywhere, and the player only
   * reads the parts it needs (a 40 GB film doesn't get read end to end). */
  $from = 0; $to = $size - 1;
  if (preg_match('/^bytes=(\d*)-(\d*)$/', $_SERVER['HTTP_RANGE'] ?? '', $m) && $size > 0) {
    if ($m[1] === '' && $m[2] !== '') { $from = max(0, $size - (int)$m[2]); }
    else { $from = (int)$m[1]; if ($m[2] !== '') $to = min($to, (int)$m[2]); }
    if ($from > $to || $from >= $size) { http_response_code(416); header("Content-Range: bytes */$size"); exit; }
    http_response_code(206);
    header("Content-Range: bytes $from-$to/$size");
  }
  header('Content-Type: ' . $types[$ext]);
  header('Accept-Ranges: bytes');
  header('Content-Length: ' . ($to - $from + 1));
  header('Content-Disposition: inline; filename="' . str_replace(['"', "\r", "\n"], '', basename($p)) . '"');
  header('X-Content-Type-Options: nosniff');
  header('Cache-Control: private, max-age=300');
  if ($ext === 'svg') header("Content-Security-Policy: default-src 'none'; style-src 'unsafe-inline'; img-src data:; sandbox");
  while (ob_get_level()) ob_end_clean();
  if ($from === 0 && $to === $size - 1) { readfile($p); exit; }
  $fh = fopen($p, 'rb'); fseek($fh, $from); $left = $to - $from + 1;
  while ($left > 0 && !feof($fh) && !connection_aborted()) { $chunk = fread($fh, min(1048576, $left)); if ($chunk === false) break; echo $chunk; flush(); $left -= strlen($chunk); }
  fclose($fh);
  exit;
}

/* Download to this computer: a GET with a ticket from dl_prep (made by a POST,
 * so the csrf check still applies). One file comes as it is; several files or a
 * folder come as one .zip, made while it downloads (stored, not compressed, so
 * it runs at disk speed and nothing is written on the server). Zip64, so files
 * and archives over 4 GB work. */
function uc_dl_plan(array $paths): array {
  $list = []; $seen = 0;
  $add = function (string $p, string $name) use (&$add, &$list, &$seen) {
    if (++$seen > 200000) throw new UcError('Too many files for one download (200,000)');
    if (is_link($p) && is_dir($p)) return;                   // don't follow folder links (loops)
    if (is_dir($p)) {
      $kids = @scandir($p) ?: [];
      $kids = array_values(array_diff($kids, ['.', '..']));
      if (!$kids) { $list[] = ['p' => $p, 'n' => "$name/", 'd' => true, 's' => 0, 't' => @filemtime($p) ?: time()]; return; }
      foreach ($kids as $k) $add("$p/$k", "$name/$k");
    } elseif (is_file($p) && is_readable($p)) $list[] = ['p' => $p, 'n' => $name, 'd' => false, 's' => filesize($p), 't' => @filemtime($p) ?: time()];
  };
  $names = [];
  foreach ($paths as $p) {
    $n = basename($p);
    for ($k = 2, $b = $n; isset($names[$n]); $k++) $n = "$b ($k)";   // the same name from two places
    $names[$n] = 1;
    $add($p, $n);
  }
  return $list;
}
function uc_zip_dos(int $t): array {
  $d = getdate($t);
  if ($d['year'] < 1980) $d = getdate(315532800);
  return [($d['hours'] << 11) | ($d['minutes'] << 5) | intdiv($d['seconds'], 2),
          (($d['year'] - 1980) << 9) | ($d['mon'] << 5) | $d['mday']];
}
/* Sizes are known up front, only the CRC isn't, so it goes in a data descriptor
 * after each file - and the total length can be told to the browser (it shows
 * real progress and the time left). */
function uc_zip_len(array $list): int {
  $off = 0; $cd = 0; $n = 0;
  foreach ($list as $f) {
    $nl = strlen($f['n']); $z = $f['s'] >= 0xFFFFFFFF || $off >= 0xFFFFFFFF;
    $off += 30 + $nl + ($z ? 20 : 0) + $f['s'] + ($f['d'] ? 0 : ($z ? 24 : 16));
    $cd += 46 + $nl + ($z ? 28 : 0); $n++;
  }
  $z64 = $off >= 0xFFFFFFFF || $cd >= 0xFFFFFFFF || $n >= 0xFFFF;
  return $off + $cd + ($z64 ? 56 + 20 : 0) + 22;
}
function uc_zip_stream(array $list): void {
  $out = function (string $s) { echo $s; };
  $off = 0; $cd = '';
  foreach ($list as $f) {
    if (connection_aborted()) return;
    [$tm, $dt] = uc_zip_dos($f['t']);
    $name = $f['n']; $nl = strlen($name); $size = $f['s'];
    $z = $size >= 0xFFFFFFFF || $off >= 0xFFFFFFFF;
    $flag = 0x0800 | ($f['d'] ? 0 : 0x0008);                 // UTF-8 names; CRC after the data
    $ver = $z ? 45 : 20;
    $ex = $z ? pack('vvPP', 1, 16, $size, $size) : '';
    $out(pack('VvvvvvVVVvv', 0x04034b50, $ver, $flag, 0, $tm, $dt, 0, $z ? 0xFFFFFFFF : $size, $z ? 0xFFFFFFFF : $size, $nl, strlen($ex)) . $name . $ex);
    $here = $off; $off += 30 + $nl + strlen($ex);
    $crc = 0;
    if (!$f['d']) {
      $h = hash_init('crc32b'); $left = $size;
      $fh = @fopen(uc_direct($f['p']), 'rb');
      while ($fh && $left > 0 && !feof($fh)) {
        $c = fread($fh, (int)min(4194304, $left)); if ($c === false || $c === '') break;
        hash_update($h, $c); $out($c); $left -= strlen($c);
        if (connection_aborted()) { fclose($fh); return; }
      }
      if ($fh) fclose($fh);
      while ($left > 0) { $c = str_repeat("\0", (int)min(1048576, $left)); hash_update($h, $c); $out($c); $left -= strlen($c); }   // it shrank while downloading: keep the zip readable
      $crc = hexdec(hash_final($h));
      $off += $size;
      $out($z ? pack('VVPP', 0x08074b50, $crc, $size, $size) : pack('VVVV', 0x08074b50, $crc, $size, $size));
      $off += $z ? 24 : 16;
    }
    $cz = $size >= 0xFFFFFFFF || $here >= 0xFFFFFFFF;
    $cex = $cz ? pack('vvPPP', 1, 24, $size, $size, $here) : '';
    $cd .= pack('VvvvvvvVVVvvvvvVV', 0x02014b50, ($cz ? 45 : 20) | 0x0300, $cz ? 45 : 20, $flag, 0, $tm, $dt, $crc,
                $cz ? 0xFFFFFFFF : $size, $cz ? 0xFFFFFFFF : $size, $nl, strlen($cex), 0, 0, 0,
                $f['d'] ? (040755 << 16) | 0x10 : (0100644 << 16), $cz ? 0xFFFFFFFF : $here) . $name . $cex;
    if (strlen($cd) > 8388608) { /* keep going; the central directory stays in memory (small per file) */ }
  }
  $n = count($list); $cdLen = strlen($cd);
  $out($cd);
  $z64 = $off >= 0xFFFFFFFF || $cdLen >= 0xFFFFFFFF || $n >= 0xFFFF;
  if ($z64) {
    $out(pack('VPvvVVPPPP', 0x06064b50, 44, 45, 45, 0, 0, $n, $n, $cdLen, $off));
    $out(pack('VVPV', 0x07064b50, 0, $off + $cdLen, 1));
  }
  $out(pack('VvvvvVVv', 0x06054b50, 0, 0, $z64 ? 0xFFFF : $n, $z64 ? 0xFFFF : $n, $z64 ? 0xFFFFFFFF : $cdLen, $z64 ? 0xFFFFFFFF : $off, 0));
}
if (($_GET['action'] ?? '') === 'dl') {
  $t = (string)($_GET['t'] ?? '');
  $tf = UC_STATE . "/dl-$t.json";
  if (!preg_match('/^[0-9a-f]{24}$/', $t) || !is_file($tf) || filemtime($tf) < time() - 3600) { http_response_code(410); header('Content-Type: text/plain'); echo 'This download link has expired - start the download again from unCommander.'; exit; }
  $job = json_decode((string)file_get_contents($tf), true) ?: [];
  @set_time_limit(0); ignore_user_abort(false);
  while (ob_get_level()) ob_end_clean();
  $fn = (string)($job['name'] ?? 'download');
  $disp = 'attachment; filename="' . preg_replace('/[^\x20-\x7e]|["\\\\]/', '_', $fn) . '"; filename*=UTF-8\'\'' . rawurlencode($fn);
  header('Content-Disposition: ' . $disp);
  header('X-Content-Type-Options: nosniff');
  header('Cache-Control: no-store');
  header('X-Accel-Buffering: no');                            // nginx: pass it straight through
  if (($job['kind'] ?? '') === 'file') {
    $p = uc_direct((string)$job['paths'][0]);
    if (!is_file($p)) { http_response_code(404); exit; }
    header('Content-Type: application/octet-stream');
    header('Content-Length: ' . filesize($p));
    readfile($p); exit;
  }
  try { $list = uc_dl_plan(array_map('uc_path', (array)$job['paths'])); }
  catch (Throwable $e) { http_response_code(400); header('Content-Type: text/plain'); echo $e->getMessage(); exit; }
  header('Content-Type: application/zip');
  header('Content-Length: ' . uc_zip_len($list));
  uc_zip_stream($list);
  exit;
}

/* Video with its sound converted while it plays (needs ffmpeg). The picture is
 * passed through untouched; the sound becomes AAC stereo, which every browser
 * plays. Two ways out:
 *   stream - one fragmented MP4 straight to the browser (Chrome, Edge, Firefox);
 *            ffmpeg only runs as fast as the browser reads.
 *   hls    - small pieces plus a list, for Safari (iPad/Mac), which won't play
 *            an endless stream; made at playing speed, old pieces are deleted.
 * Starting again from another point is a new request (t = seconds). One player
 * per browser tab (sid): a new request stops the previous ffmpeg. */
function uc_stream_stop(string $sid): void {
  $pf = UC_STATE . "/vp-$sid.pid";
  if (is_file($pf)) { $pid = (int)file_get_contents($pf); if ($pid > 1 && is_dir("/proc/$pid") && str_contains((string)@file_get_contents("/proc/$pid/cmdline"), 'ffmpeg')) { if (function_exists('posix_kill')) posix_kill($pid, 9); else exec('kill -9 ' . $pid); } @unlink($pf); }
  $d = UC_STATE . "/hls-$sid";
  if (is_dir($d)) exec('rm -rf -- ' . escapeshellarg($d));
}
/* The ffmpeg command line. o: a = sound track (stream number), vt = convert the
 * picture too (to H.264, with the graphics chosen in Settings), h = picture
 * height, ad = sound delay in ms (+ later, - earlier), abs = keep the film's
 * own timestamps (the progressive stream; the browser then shows real times). */
function uc_stream_args(string $p, float $t, array $o): string {
  $in = ''; $v = ' -c:v copy' . (!empty($o['hevc']) ? ' -tag:v hvc1' : ''); $vmap = ' -map 0:v:0?';
  $sb = (int)($o['sb'] ?? -1);
  if ($sb >= 0) {
    /* picture subtitles (PGS / DVD): drawn onto the picture, so it has to be
     * converted. Decoded and drawn on the CPU (light), encoded where Settings says. */
    $h = (int)($o['h'] ?? 0); $down = $h > 1080;
    $mode = uc_vconv();
    $chain = "[0:v:0][0:$sb]overlay" . ($down ? ',scale=-2:1080' : '');
    if ($mode === 'nvidia') { $in = ' -init_hw_device cuda=cu -filter_hw_device cu'; $chain .= ',format=nv12,hwupload'; $enc = ' -c:v h264_nvenc -preset p4 -b:v 8M -maxrate 12M -bufsize 16M -g 48'; }
    elseif ($mode === 'vaapi') { $dev = array_column(uc_gpus(), 'dev', 'id')['vaapi'] ?? '/dev/dri/renderD128'; $in = ' -vaapi_device ' . escapeshellarg($dev); $chain .= ',format=nv12,hwupload'; $enc = ' -c:v h264_vaapi -b:v 8M -maxrate 12M -bufsize 16M -g 48'; }
    else { $chain .= ',format=yuv420p'; $enc = ' -c:v libx264 -preset veryfast -crf 22 -maxrate 10M -bufsize 20M -g 48'; }
    $vmap = ' -filter_complex ' . escapeshellarg($chain . '[v]') . ' -map ' . escapeshellarg('[v]');
    $v = $enc;
  } elseif (!empty($o['vt'])) {
    $h = (int)($o['h'] ?? 0); $down = $h > 1080;        // 4K is made 1080p: easier on everything, plenty for a preview
    $mode = uc_vconv();
    if ($mode === 'nvidia') {
      $in = ' -hwaccel cuda -hwaccel_output_format cuda';
      $v = ' -vf ' . escapeshellarg('scale_cuda=' . ($down ? '-2:1080:' : '') . 'format=yuv420p') . ' -c:v h264_nvenc -preset p4 -b:v 8M -maxrate 12M -bufsize 16M -g 48';
    } elseif ($mode === 'vaapi') {
      $dev = (uc_gpus()[array_search('vaapi', array_column(uc_gpus(), 'id'))]['dev'] ?? '/dev/dri/renderD128');
      $in = ' -hwaccel vaapi -hwaccel_device ' . escapeshellarg($dev) . ' -hwaccel_output_format vaapi';
      $v = ' -vf ' . escapeshellarg('scale_vaapi=' . ($down ? 'w=-2:h=1080:' : '') . 'format=nv12') . ' -c:v h264_vaapi -b:v 8M -maxrate 12M -bufsize 16M -g 48';
    } else {
      $v = ' -vf ' . escapeshellarg(($down ? 'scale=-2:1080,' : '') . 'format=yuv420p') . ' -c:v libx264 -preset veryfast -crf 22 -maxrate 10M -bufsize 20M -g 48';
    }
  }
  $ad = (int)($o['ad'] ?? 0); $af = '';
  if ($ad > 0) $af = ' -af ' . escapeshellarg("adelay={$ad}:all=1");
  elseif ($ad < 0) $af = ' -af ' . escapeshellarg('atrim=start=' . sprintf('%.3f', -$ad / 1000) . ',asetpts=PTS-STARTPTS');
  $a = (int)($o['a'] ?? -1);
  return '-hide_banner -loglevel error -nostdin' . $in . (!empty($o['abs']) ? ' -copyts -start_at_zero' : '') . ' -ss ' . sprintf('%.2f', $t) . ' -i ' . escapeshellarg(uc_direct($p))
    . $vmap . ' -map ' . ($a >= 0 ? "0:$a" : '0:a:0?') . $v . ' -c:a aac -b:a 192k -ac 2' . $af . ' -sn -dn';
}
function uc_stream_opts(array $src): array {
  return ['a' => (int)($src['a'] ?? -1), 'hevc' => ($src['vc'] ?? '') === 'hevc', 'vt' => !empty($src['vt']), 'h' => (int)($src['h'] ?? 0), 'ad' => max(-3000, min(3000, (int)($src['ad'] ?? 0))), 'sb' => isset($src['sb']) && $src['sb'] !== '' ? (int)$src['sb'] : -1];
}
if (($_GET['action'] ?? '') === 'stream') {
  try { $p = uc_arc_real(uc_path((string)($_GET['path'] ?? ''))); } catch (Throwable $e) { http_response_code(403); exit; }
  $ff = uc_ffmpeg();
  if (!$ff || !is_file($p)) { http_response_code(404); exit; }
  $sid = preg_replace('/[^a-z0-9]/', '', (string)($_GET['sid'] ?? '')) ?: 'x';
  @mkdir(UC_STATE, 0700, true);
  uc_stream_stop($sid);
  /* music (ao=1): plain MP3, which every browser plays as a stream */
  $ao = !empty($_GET['ao']);
  $cmd = 'exec nice -n 5 ' . escapeshellarg($ff) . ' ' . ($ao
      ? '-hide_banner -loglevel error -nostdin -ss ' . sprintf('%.2f', max(0, (float)($_GET['t'] ?? 0))) . ' -i ' . escapeshellarg(uc_direct($p)) . ' -map ' . ((int)($_GET['a'] ?? -1) >= 0 ? '0:' . (int)$_GET['a'] : '0:a:0') . ' -vn -c:a libmp3lame -b:a 256k -f mp3 pipe:1'
      : uc_stream_args($p, max(0, (float)($_GET['t'] ?? 0)), uc_stream_opts($_GET)) . ' -f mp4 -movflags frag_keyframe+empty_moov+default_base_moof pipe:1');
  $pr = proc_open($cmd, [1 => ['pipe', 'w'], 2 => ['file', '/dev/null', 'w']], $pipes);
  if (!$pr) { http_response_code(500); exit; }
  $pid = proc_get_status($pr)['pid'];
  file_put_contents(UC_STATE . "/vp-$sid.pid", $pid);
  set_time_limit(0); ignore_user_abort(true);
  header('Content-Type: ' . ($ao ? 'audio/mpeg' : 'video/mp4'));
  header('Cache-Control: no-store');
  header('X-Accel-Buffering: no');          // nginx: pass it on as it comes
  while (ob_get_level()) ob_end_clean();
  while (!feof($pipes[1])) {
    $c = fread($pipes[1], 65536);
    if ($c === false) break;
    if ($c === '') { usleep(20000); continue; }
    echo $c; flush();
    if (connection_aborted()) break;
  }
  proc_terminate($pr, 9); @fclose($pipes[1]); proc_close($pr);
  if ((int)@file_get_contents(UC_STATE . "/vp-$sid.pid") === $pid) @unlink(UC_STATE . "/vp-$sid.pid");
  exit;
}
if (($_GET['action'] ?? '') === 'hls') {
  $sid = preg_replace('/[^a-z0-9]/', '', (string)($_GET['sid'] ?? ''));
  $f = (string)($_GET['f'] ?? '');
  if (!$sid || !preg_match('/^(index\.m3u8|init\.mp4|s\d{5}\.m4s)$/', $f)) { http_response_code(404); exit; }
  $file = UC_STATE . "/hls-$sid/$f";
  for ($i = 0; $i < 40 && !is_file($file); $i++) usleep(250000);          // the next piece may still be on its way
  if (!is_file($file)) { http_response_code(404); exit; }
  @touch(UC_STATE . "/hls-$sid");                                          // still being watched
  header('Content-Type: ' . (str_ends_with($f, '.m3u8') ? 'application/vnd.apple.mpegurl' : 'video/mp4'));
  header('Cache-Control: no-store');
  while (ob_get_level()) ob_end_clean();
  if (str_ends_with($f, '.m3u8')) {
    /* ffmpeg writes the pieces' names as they are (s00000.m4s); next to api.php they'd point at files that
     * don't exist, so each becomes this same address with its own name - otherwise Safari waits forever */
    $u = "api.php?action=hls&sid=$sid&f=";
    $txt = preg_replace(['/URI="(init\.mp4)"/', '/^(s\d{5}\.m4s)$/m'], ["URI=\"$u\$1\"", "$u\$1"], (string)file_get_contents($file));
    header('Content-Length: ' . strlen($txt));
    echo $txt; exit;
  }
  header('Content-Length: ' . filesize($file));
  readfile($file);
  exit;
}

/* A song's cover: the picture inside the file, or cover/folder.jpg next to it.
 * For a folder (an album in the music library): its cover picture, made small
 * like the gallery's, else the picture inside its first song. */
const UC_AUDIO_RE = '/\.(mp3|m4a|m4b|aac|flac|ogg|oga|opus|wav|wma|aiff?|alac|ape|wv|mka|ac3|eac3|dts|mp2|amr|caf|dsf|dff|weba)$/i';
/* Why a playlist's song isn't where the playlist says. 'enc': the name on the
 * disk isn't UTF-8 (an old Windows encoding - the browser can't use it as it
 * is); 'nfd': the same letters, written another way in Unicode; 'gone': not
 * there. 'near' is the deepest folder of its path that is there. */
function uc_why_missing(string $p): array {
  $parts = array_values(array_filter(explode('/', $p), 'strlen'));
  $nfc = fn($x) => class_exists('Normalizer') ? (Normalizer::normalize($x, Normalizer::FORM_C) ?: $x) : $x;
  $d = '';
  foreach ($parts as $c) {
    if (file_exists("$d/$c")) { $d = "$d/$c"; continue; }
    if ($d === '' || !is_dir($d)) return ['why' => 'gone', 'near' => ''];
    $same = '';
    foreach (@scandir($d) ?: [] as $e) {
      if ($e === '.' || $e === '..') continue;
      if (!mb_check_encoding($e, 'UTF-8') && mb_convert_encoding($e, 'UTF-8', 'Windows-1252') === $c) return ['why' => 'enc', 'near' => $d];
      if (mb_check_encoding($e, 'UTF-8') && $nfc($e) === $nfc($c)) { $same = $e; break; }
    }
    if ($same === '') return ['why' => 'gone', 'near' => str_starts_with($d, '/mnt/') ? $d : ''];
    $d = "$d/$same";      // the same name written another way in Unicode: follow it
  }
  return is_file($d) ? ['why' => 'ok', 'near' => $d] : ['why' => 'gone', 'near' => ''];
}
function uc_dir_cover(string $d): array {
  $pics = []; $song = '';
  foreach ([$d, ...array_slice(array_values(array_filter(array_map(fn($n) => "$d/$n", uc_sorted_names($d)), 'is_dir')), 0, 2)] as $k => $dir) {
    foreach (uc_sorted_names($dir) as $n) {
      if (preg_match('/\.(jpe?g|png|webp)$/i', $n) && is_file("$dir/$n")) $pics[] = [preg_match('/^(cover|folder|front|album)\b/i', $n) ? 0 : (preg_match('/cover|front/i', $n) ? 1 : 2), $k, "$dir/$n"];
      elseif (!$song && preg_match(UC_AUDIO_RE, $n)) $song = "$dir/$n";
    }
    if ($pics && min(array_column($pics, 0)) === 0) break;
  }
  usort($pics, fn($a, $b) => [$a[0], $a[1]] <=> [$b[0], $b[1]]);
  return [$pics ? $pics[0][2] : '', $song];
}
function uc_sorted_names(string $d): array {
  $n = @scandir($d) ?: [];
  $n = array_values(array_filter($n, fn($x) => $x[0] !== '.'));
  natcasesort($n); return array_values($n);
}
/* a cover fetched from the Cover Art Archive, for the tag editor's preview */
if (($_GET['action'] ?? '') === 'mbcover') {
  $id = (string)($_GET['id'] ?? '');
  $f = UC_STATE . "/mbcover/$id.jpg";
  if (!preg_match('/^[0-9a-f-]{36}$/', $id) || !is_file($f)) { http_response_code(404); exit; }
  header('Content-Type: image/jpeg'); header('Content-Length: ' . filesize($f)); header('Cache-Control: private, max-age=600');
  while (ob_get_level()) ob_end_clean();
  readfile($f); exit;
}
if (($_GET['action'] ?? '') === 'cover' && is_dir($_GET['path'] ?? '')) {
  try { $d = uc_path((string)$_GET['path']); } catch (Throwable $e) { http_response_code(403); exit; }
  [$pic, $song] = uc_dir_cover($d);
  if ($pic) { $_GET['action'] = 'thumb'; $_GET['path'] = $pic; $_GET['s'] = $_GET['s'] ?? 320; }
  elseif ($song) $_GET['path'] = $song;
  else { http_response_code(404); exit; }
}
if (($_GET['action'] ?? '') === 'cover') {
  try { $p = uc_path((string)($_GET['path'] ?? '')); } catch (Throwable $e) { http_response_code(403); exit; }
  if (!is_file($p)) { http_response_code(404); exit; }
  $dir = UC_STATE . '/thumbs'; @mkdir($dir, 0700, true);
  $f = "$dir/cover-" . sha1($p . '|' . filemtime($p)) . '.jpg';
  if (!is_file($f) && ($ff = uc_ffmpeg()))
    exec('timeout 15 ' . escapeshellarg($ff) . ' -hide_banner -loglevel error -nostdin -i ' . escapeshellarg(uc_direct($p)) . ' -map 0:v:0 -frames:v 1 -vf ' . escapeshellarg("scale='min(800,iw)':-2") . ' -y ' . escapeshellarg($f) . ' 2>/dev/null');
  if (!is_file($f)) foreach (['cover.jpg', 'folder.jpg', 'Cover.jpg', 'Folder.jpg', 'front.jpg', 'cover.png', 'folder.png'] as $n) if (is_file(dirname($p) . "/$n")) { $f = dirname($p) . "/$n"; break; }
  if (!is_file($f)) { http_response_code(404); exit; }
  header('Content-Type: ' . (str_ends_with($f, '.png') ? 'image/png' : 'image/jpeg'));
  header('Cache-Control: private, max-age=600');
  header('Content-Length: ' . filesize($f));
  while (ob_get_level()) ob_end_clean();
  readfile($f); exit;
}
/* Small pictures for the gallery: made once with PHP's own GD library and kept
 * in RAM (not on the flash drive), keyed by path, date and size. */
if (($_GET['action'] ?? '') === 'thumb') {
  try { $p = uc_path((string)($_GET['path'] ?? '')); } catch (Throwable $e) { http_response_code(403); exit; }
  $ext = strtolower(pathinfo($p, PATHINFO_EXTENSION));
  $make = ['jpg' => 'imagecreatefromjpeg', 'jpeg' => 'imagecreatefromjpeg', 'png' => 'imagecreatefrompng', 'gif' => 'imagecreatefromgif',
           'webp' => 'imagecreatefromwebp', 'bmp' => 'imagecreatefrombmp', 'avif' => 'imagecreatefromavif'][$ext] ?? null;
  if (!$make || !function_exists($make) || !is_file($p) || !is_readable($p)) { http_response_code(404); exit; }
  $s = max(64, min(640, (int)($_GET['s'] ?? 320)));
  $st = stat($p);
  $dir = UC_STATE . '/thumbs';
  $f = "$dir/" . sha1("$p|{$st['mtime']}|{$st['size']}|$s") . '.jpg';
  if (!is_file($f)) {
    @mkdir($dir, 0700, true);
    $info = @getimagesize($p);
    if (!$info || $info[0] * $info[1] > 80000000) { http_response_code(404); exit; }      // unreadable, or too huge to open in memory
    ini_set('memory_limit', '1536M');
    $im = @$make($p);
    if (!$im) { http_response_code(404); exit; }
    if ($ext === 'jpg' || $ext === 'jpeg') {                 // turn it the way the camera said
      $o = uc_jpeg_orientation($p);
      if (in_array($o, [2, 4, 5, 7], true)) imageflip($im, $o === 4 ? IMG_FLIP_VERTICAL : IMG_FLIP_HORIZONTAL);
      $deg = [3 => 180, 5 => 90, 6 => 270, 7 => 270, 8 => 90][$o] ?? 0;      // imagerotate turns anticlockwise
      if ($deg) { $r = imagerotate($im, $deg, 0); if ($r) { imagedestroy($im); $im = $r; } }
    }
    $w = imagesx($im); $h = imagesy($im); $k = min(1, $s / max($w, $h));
    $tw = max(1, (int)round($w * $k)); $th = max(1, (int)round($h * $k));
    $t = imagecreatetruecolor($tw, $th);
    imagefill($t, 0, 0, imagecolorallocate($t, 255, 255, 255));    // see-through parts on white
    imagecopyresampled($t, $im, 0, 0, 0, 0, $tw, $th, $w, $h);
    imagejpeg($t, "$f.tmp", 82); @rename("$f.tmp", $f);
    imagedestroy($im); imagedestroy($t);
    /* keep the RAM cache under 150 MB: now and then, drop the oldest half */
    if (mt_rand(1, 40) === 1) {
      $all = glob("$dir/*.jpg") ?: []; $sum = 0; foreach ($all as $x) $sum += @filesize($x);
      if ($sum > 150 * 1048576) { usort($all, fn($a, $b) => @filemtime($a) <=> @filemtime($b)); foreach (array_slice($all, 0, intdiv(count($all), 2)) as $x) @unlink($x); }
    }
  }
  header('Content-Type: image/jpeg');
  header('Content-Length: ' . filesize($f));
  header('Cache-Control: private, max-age=600');
  while (ob_get_level()) ob_end_clean();
  readfile($f);
  exit;
}

set_error_handler(function ($no, $str) {
  if (!(error_reporting() & $no)) return false;   // silenced with @
  throw new UcError(preg_replace('/^\w+\(\):\s*/', '', $str));
});

$req = $_POST;
if (empty($req) && ($raw = file_get_contents('php://input'))) $req = json_decode($raw, true) ?: [];
$action = $req['action'] ?? '';

/* Tools > Music library check: walks the music folder (or only some folders in it, to
 * check them again) and returns the lists. An album is a folder with songs in it
 * (CD1/CD2 folders count as part of theirs). */
function uc_music_scan(string $root, array $starts): array {
  $t0 = microtime(true);
  $isDisc = fn($n) => (bool)preg_match('/^(cd|dis[ck])\s*\d+$/i', $n);
  $isFmt = fn($n) => (bool)preg_match('/^(mp3|flac|aac|m4a|alac|ogg|opus|wav|wma|ape|dsd|dsf|hi-?res|lossless|24[ -]?bit|16[ -]?bit|320|v0)$/i', $n);
  $skip = '/^(extrafanart|extrathumbs|scans?|artwork|art|covers?|images?|pictures?|booklet|videos?|extras?|lyrics|@eadir|\.[^.].*)$/i';
  $coverRe = '/^(cover|folder|front|album)\b.*\.(jpe?g|png|webp)$/i';
  $u8 = fn($x) => mb_check_encoding($x, 'UTF-8') ? $x : mb_convert_encoding($x, 'UTF-8', 'Windows-1252');
  $albums = []; $empty = []; $names = []; $dirsSeen = 0; $songsSeen = 0;
  /* one folder: [songs here, pictures here, sub-folders, cover?] */
  $look = function (string $d) use (&$names, &$dirsSeen, $u8) {
    $songs = []; $pics = 0; $subs = []; $cover = false; $other = 0; $bytes = 0;
    $dirsSeen++;
    foreach (@scandir($d) ?: [] as $n) {
      if ($n === '.' || $n === '..') continue;
      $f = "$d/$n";
      if (!mb_check_encoding($n, 'UTF-8') && count($names) < 3000) $names[] = ['p' => $u8($f), 'raw' => base64_encode($f)];
      if (is_dir($f)) { $subs[] = $n; continue; }
      if (preg_match(UC_AUDIO_RE, $n)) { $songs[] = $n; $bytes += (int)@filesize($f); }
      elseif (preg_match('/\.(jpe?g|png|webp|gif|bmp)$/i', $n)) { $pics++; if (preg_match('/^(cover|folder|front|album)\b/i', $n)) $cover = true; }
      elseif ($n[0] !== '.') $other++;
    }
    return [$songs, $pics, $subs, $cover, $other, $bytes];
  };
  $hasSongsDeep = function (string $d, int $depth) use (&$hasSongsDeep) {
    foreach (@scandir($d) ?: [] as $n) {
      if ($n === '.' || $n === '..') continue;
      if (is_dir("$d/$n")) { if ($depth < 4 && $hasSongsDeep("$d/$n", $depth + 1)) return true; }
      elseif (preg_match(UC_AUDIO_RE, $n)) return true;
    }
    return false;
  };
  $walk = function (string $d, int $depth) use (&$walk, &$albums, &$empty, &$songsSeen, $look, $isDisc, $isFmt, $skip, $hasSongsDeep, $root, $t0, $u8) {
    if ($depth > 6 || microtime(true) - $t0 > 540) return;
    [$songs, $pics, $subs, $cover, $other, $bytes] = $look($d);
    /* parts of the album: CD1/CD2... folders, and folders for one format (an "mp3" folder next to the FLAC songs) */
    $discs = array_values(array_filter($subs, fn($c) => $isDisc($c) || $isFmt($c)));
    $discSongs = []; $discCover = false; $partDirs = [];
    foreach ($discs as $c) { [$s2, , , $cv2, , $b2] = $look("$d/$c"); foreach ($s2 as $x) $discSongs[] = "$c/$x"; if ($s2) $partDirs[] = $u8("$d/$c"); $discCover = $discCover || $cv2; $bytes += $b2; }
    $all = array_merge($songs, $discSongs);
    if ($all && $d !== $root) {
      $songsSeen += count($all);
      /* gaps in the track numbers, per disc */
      $gaps = [];
      $byDisc = ['' => $songs]; foreach ($discs as $c) $byDisc[$c] = array_map(fn($x) => substr($x, strlen($c) + 1), array_filter($discSongs, fn($x) => str_starts_with($x, "$c/")));
      foreach ($byDisc as $c => $list) {
        $nums = [];
        foreach ($list as $x) if (preg_match('/^(?:\d-)?(\d{1,3})(?!\d)/', $x, $m) && (int)$m[1] > 0) $nums[(int)$m[1]] = true;
        if (count($nums) >= 3) { $max = max(array_keys($nums)); $miss = []; for ($k = 1; $k <= $max; $k++) if (!isset($nums[$k])) $miss[] = $k; if ($miss && count($miss) <= 40) $gaps[] = [$c, $miss]; }
      }
      $fx = []; foreach ($all as $x) { $e = strtolower(pathinfo($x, PATHINFO_EXTENSION)); $fx[$e] = ($fx[$e] ?? 0) + 1; }
      $albums[] = ['p' => $u8($d), 'n' => count($all), 'b' => $bytes, 'cover' => $cover || $discCover, 'first' => $u8($d . '/' . $all[0]), 'gaps' => $gaps, 'pics' => $pics, 'fx' => $fx, 'dirs' => array_merge($songs ? [$u8($d)] : [], $partDirs)];
    } elseif (!$all && $d !== $root && !preg_match($skip, basename($d)) && !$isDisc(basename($d)) && !$isFmt(basename($d)) && !$hasSongsDeep($d, 0)) {
      $empty[] = ['p' => $u8($d), 'pics' => $pics, 'other' => $other, 'subs' => count($subs), 'depth' => $depth];
      return;
    }
    foreach ($subs as $c) if (!in_array($c, $discs, true) && !preg_match($skip, $c)) $walk("$d/$c", $depth + 1);
  };
  foreach ($starts as $s) if (is_dir($s)) $walk($s, $s === $root ? 0 : substr_count(substr($s, strlen($root)), '/'));
  /* the same album twice: two folders side by side whose names match once years, brackets and words like Deluxe are taken out */
  $norm = function (string $n) {
    $n = mb_strtolower($n);
    $n = preg_replace('/[\(\[\{][^\)\]\}]*[\)\]\}]/u', ' ', $n);
    $n = preg_replace('/\b(deluxe|remaster(ed)?|edition|expanded|anniversary|bonus|explicit|version|special|limited|reissue|mono|stereo|\d{4})\b/u', ' ', $n);
    if (class_exists('Normalizer')) $n = Normalizer::normalize($n, Normalizer::FORM_KD) ?: $n;
    return preg_replace('/[^\p{L}\p{N}]+/u', '', $n);
  };
  $groups = [];
  foreach ([...array_map(fn($a) => $a + ['k' => 'a'], $albums), ...array_map(fn($e) => $e + ['k' => 'e'], $empty)] as $x) {
    $key = dirname($x['p']) . '|' . $norm(basename($x['p']));
    if ($norm(basename($x['p'])) === '') continue;
    $groups[$key][] = $x;
  }
  $dups = array_values(array_filter($groups, fn($g) => count($g) > 1 && count(array_filter($g, fn($x) => $x['k'] === 'a')) >= 1));
  $dups = array_map(fn($g) => array_map(fn($x) => ['p' => $x['p'], 'n' => $x['n'] ?? 0, 'b' => $x['b'] ?? 0, 'cover' => $x['cover'] ?? false, 'pics' => $x['pics'] ?? 0], $g), $dups);
  /* one album in more than one format (FLAC and MP3 copies side by side, or in an mp3 folder inside it) */
  $byAlb = [];
  foreach ($albums as $a) {
    $rel = explode('/', substr($a['p'], strlen($u8($root)) + 1));
    if (count($rel) < 1) continue;
    $key = $u8($root) . '/' . implode('/', array_slice($rel, 0, min(2, count($rel))));
    foreach ($a['fx'] as $e => $c) $byAlb[$key]['fx'][$e] = ($byAlb[$key]['fx'][$e] ?? 0) + $c;
    $byAlb[$key]['n'] = ($byAlb[$key]['n'] ?? 0) + $a['n'];
    foreach ($a['dirs'] ?: [$a['p']] as $x) $byAlb[$key]['dirs'][] = $x;
  }
  $mixed = [];
  foreach ($byAlb as $k => $v) if (count($v['fx']) > 1) { arsort($v['fx']); $mixed[] = ['p' => $k, 'n' => $v['n'], 'fx' => $v['fx'], 'dirs' => array_values(array_unique($v['dirs']))]; }
  foreach ($dups as &$g) usort($g, fn($x, $y) => strcmp($x['p'], $y['p'])); unset($g);
  return [
    'mixed' => $mixed,
    'secs' => round(microtime(true) - $t0, 1), 'dirs' => $dirsSeen, 'songs' => $songsSeen, 'albums' => count($albums), 'partial' => microtime(true) - $t0 > 540,
    'nocover' => array_values(array_map(fn($a) => ['p' => $a['p'], 'n' => $a['n'], 'first' => $a['first'], 'pics' => $a['pics']], array_filter($albums, fn($a) => !$a['cover']))),
    'dups' => $dups,
    'empty' => $empty,
    'names' => $names,
    'gaps' => array_values(array_map(fn($a) => ['p' => $a['p'], 'n' => $a['n'], 'gaps' => $a['gaps']], array_filter($albums, fn($a) => $a['gaps']))),
  ];
}
const UC_MC_LISTS = ['nocover', 'dups', 'empty', 'names', 'gaps', 'mixed'];
const UC_MC_TTL = 3600;          // saved results are shown for an hour; after that the tool checks again
function uc_mc_cache(): string { return UC_STATE . '/music-check.json'; }
/* what you said is fine as it is - kept next to History (on the array) */
function uc_mc_accept_file(): string { return uc_data_file('music-accept.json'); }
function uc_mc_accept(): array { $f = uc_mc_accept_file(); return is_file($f) ? (json_decode((string)file_get_contents($f), true) ?: []) : []; }
function uc_mc_key(string $list, array $x): string { return $list === 'dups' ? implode('|', array_map(fn($y) => $y['p'], $x)) : $x['p']; }
/* an accepted item comes back when its folder changes (songs added or taken away) */
function uc_mc_sig(string $list, array $x): string {
  $mt = fn($p) => (int)@filemtime($p);
  if ($list === 'dups') return md5(json_encode(array_map(fn($y) => [$mt($y['p']), $y['n']], $x)));
  if ($list === 'names') return (string)$mt(dirname($x['p']));
  return md5(json_encode([$mt($x['p']), $x['n'] ?? 0, $x['fx'] ?? null, $x['gaps'] ?? null]));
}
/* inside one of the folders (or the folder itself) */
function uc_mc_in(string $p, array $starts): bool { foreach ($starts as $s) if ($p === $s || str_starts_with($p, rtrim($s, '/') . '/')) return true; return false; }
function uc_mc_out(array $r): never {
  $acc = uc_mc_accept(); $shown = []; $hidden = [];
  foreach (UC_MC_LISTS as $l) {
    $shown[$l] = []; $hidden[$l] = [];
    foreach ($r[$l] ?? [] as $x) {
      $k = uc_mc_key($l, $x);
      if (isset($acc[$l][$k]) && $acc[$l][$k] === uc_mc_sig($l, $x)) $hidden[$l][] = $x; else $shown[$l][] = $x;
    }
  }
  uc_json(array_merge($r, $shown, ['acc' => $hidden, 'age' => time() - ($r['at'] ?? time())]));
}
/* Send to…: the settings of the newer destinations (music app, computer, drive, Jellyfin/Emby), kept as given */
function uc_pl_extra(array $v): array {
  $o = [];
  foreach (['lib', 'app', 'mdir', 'pdir', 'user', 'uname', 'name', 'drive'] as $k) if (isset($v[$k])) $o[$k] = mb_substr((string)$v[$k], 0, 500);
  foreach (['win', 'copy'] as $k) if (isset($v[$k])) $o[$k] = !empty($v[$k]);
  return $o;
}
/* Jellyfin and Emby speak the same API: the key goes in a header */
function uc_jf_req(string $url, string $key, string $method, string $path, $body = null) {
  $url = rtrim($url, '/'); if (!preg_match('#^https?://#i', $url)) $url = "http://$url";
  $try = function (string $base) use ($key, $method, $path, $body) {
    $ch = curl_init($base . '/' . ltrim($path, '/'));
    curl_setopt_array($ch, [CURLOPT_RETURNTRANSFER => true, CURLOPT_CUSTOMREQUEST => $method, CURLOPT_CONNECTTIMEOUT => 6, CURLOPT_TIMEOUT => 90,
      CURLOPT_HTTPHEADER => ['X-Emby-Token: ' . $key, 'Accept: application/json', 'Content-Type: application/json'], CURLOPT_SSL_VERIFYPEER => false, CURLOPT_SSL_VERIFYHOST => 0]);
    if ($body !== null) curl_setopt($ch, CURLOPT_POSTFIELDS, json_encode($body, JSON_UNESCAPED_SLASHES));
    $raw = curl_exec($ch); $code = (int)curl_getinfo($ch, CURLINFO_HTTP_CODE); $err = curl_error($ch); curl_close($ch);
    return [$raw, $code, $err];
  };
  [$raw, $code, $err] = $try($url);
  if ($code === 404) { [$raw2, $code2, $err2] = $try("$url/emby"); if ($code2 && $code2 !== 404) { [$raw, $code, $err] = [$raw2, $code2, $err2]; } }   // Emby on its /emby path
  if ($raw === false) throw new UcError("Can't reach $url ($err)");
  if ($code === 401) throw new UcError('The server refused the API key (401) - make one in Jellyfin: Dashboard > API Keys, in Emby: Settings > Advanced > API Keys');
  if ($code >= 400) throw new UcError("The server answered with error $code");
  return json_decode((string)$raw, true);
}
function arg(string $k, $default = null) {
  global $req;
  if (!array_key_exists($k, $req)) {
    if ($default === null) throw new UcError("Missing $k");
    return $default;
  }
  return $req[$k];
}
/* byte-for-byte compare in PHP (no cmp needed), 1 MB at a time */
function uc_same_bytes(string $a, string $b): bool {
  $x = @fopen($a, 'rb'); $y = @fopen($b, 'rb'); if (!$x || !$y) { if ($x) fclose($x); if ($y) fclose($y); return false; }
  $same = true;
  while (!feof($x) || !feof($y)) { $p = fread($x, 1048576); $q = fread($y, 1048576); if ($p !== $q) { $same = false; break; } if ($p === '' || $p === false) break; }
  fclose($x); fclose($y); return $same;
}
function arg_list(string $k): array {
  $v = arg($k);
  if (is_string($v)) $v = json_decode($v, true);
  if (!is_array($v)) throw new UcError("Bad $k");
  return array_values($v);
}

try {
  /* Inside an archive (read-only): what only reads gets the file pulled out into RAM; anything that would
   * change something there is refused - here, once, for every action. */
  $ARC_READ = ['peek', 'open_edit', 'media_info', 'hls_start', 'music_probe', 'mus_info', 'tags_read', 'subs_prep', 'archive_list', 'dl_prep'];
  $ARC_OK = array_merge($ARC_READ, ['list', 'stat', 'watch', 'arc_password', 'job_start', 'durations', 'where', 'stream_stop', 'scan_last', 'scan_status', 'jobs']);
  $inArc = function ($v, bool $asFolder) { if (!is_string($v) || $v === '' || $v[0] !== '/') return false; try { $sp = uc_arc_split(uc_path($v)); } catch (Throwable $e) { return false; } return $sp && ($sp[1] !== '' || $asFolder); };
  if (!in_array($action, $ARC_OK, true)) {
    $hit = $inArc($req['path'] ?? null, true) || $inArc($req['dest'] ?? null, true);
    foreach (['sources', 'paths', 'names'] as $k) if (!$hit && isset($req[$k])) { $l = is_string($req[$k]) ? json_decode($req[$k], true) : $req[$k]; if (is_array($l)) foreach ($l as $x) if ($inArc($x, false)) { $hit = true; break; } }
    if ($hit) throw new UcError("That's inside an archive, which unCommander opens read-only - nothing in it can be changed. Copy it out first (F5).");
  }
  if ($action === 'job_start' && $inArc($req['dest'] ?? null, true)) throw new UcError("Nothing can be copied or moved into an archive - unCommander opens archives read-only");
  if (in_array($action, $ARC_READ, true) && isset($req['path']) && $inArc($req['path'], false)) $req['path'] = uc_arc_real(uc_path((string)$req['path']));
  if (in_array($action, ['durations', 'dl_prep'], true) && isset($req['paths'])) { $l = is_string($req['paths']) ? json_decode($req['paths'], true) : $req['paths']; if (is_array($l)) $req['paths'] = json_encode(array_map(function ($x) { try { return uc_arc_real(uc_path((string)$x)); } catch (Throwable $e) { return (string)$x; } }, $l)); }

  switch ($action) {

    /* Names and types only — find's %y comes from readdir's d_type, so no
     * stat per entry. 3,445 entries in ~90 ms instead of ~7 s. */
    case 'list': {
      $t0 = microtime(true);
      /* /mnt is the top: it already holds user (all shares), every disk and
       * pool, and disks/ + remotes/ (Unassigned Devices). "/" opens it too. */
      $want = (string)arg('path');
      $dir = $want === '/' || $want === '' ? (uc_sys_allowed() && arg('sys', '0') === '1' ? '/' : '/mnt') : uc_path($want);
      if (!is_dir($dir) && ($sp = uc_arc_split($dir))) {
        [$a, $inner] = $sp;
        $st = uc_arc_index($a, 12);
        $base = ['path' => $dir, 'arc' => ['file' => $a, 'inner' => $inner], 'writable' => false, 'trash' => false, 'origins' => null, 'now' => time(),
                 'free' => (@disk_free_space(dirname($a)) ?: null), 'ms' => (int)round((microtime(true) - $t0) * 1000)];
        if (in_array($st['state'] ?? '', ['queued', 'running'], true)) uc_json($base + ['pending' => true, 'entries' => (int)($st['entries'] ?? 0), 'items' => []]);
        if (($st['state'] ?? '') === 'password') uc_json($base + ['need_password' => true, 'why' => $st['error'] ?? '', 'items' => []]);
        if (($st['state'] ?? '') !== 'ready') throw new UcError($st['error'] ?? 'Could not read the archive');
        $rows = uc_arc_rows($st['key'], $inner);
        if ($rows === null) {
          $it = uc_arc_item($st['key'], $inner);
          if ($it && uc_archive_kind($inner)) throw new UcError('An archive inside an archive opens once it is copied out (F5)');
          throw new UcError($it ? basename($inner) . ' is a file inside the archive, not a folder' : basename($inner) . " isn't in " . basename($a));
        }
        $items = []; $stats = [];
        foreach ($rows as $r) { $n = (string)$r[0]; $items[] = [$n, $r[1] ? 'd' : 'f']; $stats[$n] = ['s' => $r[1] ? null : (int)$r[2], 'm' => (int)$r[3], 'p' => '', 'o' => '', 'g' => '', 'd' => (bool)$r[1], 'l' => null]; }
        uc_json($base + ['items' => $items, 'stats' => $stats, 'encrypted' => !empty($st['encrypted'])]);
      }
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
               'ms' => (int)round((microtime(true) - $t0) * 1000), 'origins' => $origins, 'now' => time(),
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
      if (!is_dir($dir) && ($sp = uc_arc_split($dir))) {
        $st = uc_arc_index($sp[0], 5); $rows = ($st['state'] ?? '') === 'ready' ? (uc_arc_rows($st['key'], $sp[1]) ?? []) : [];
        $by = []; foreach ($rows as $r) $by[(string)$r[0]] = $r;
        foreach (arg_list('names') as $n) { $r = $by[(string)$n] ?? null; $out[$n] = $r ? ['s' => $r[1] ? null : (int)$r[2], 'm' => (int)$r[3], 'p' => '', 'o' => '', 'g' => '', 'd' => (bool)$r[1], 'l' => null] : null; }
        uc_json(['stats' => $out]);
      }
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

    case 'arc_password': {
      $a = uc_path(arg('file'));
      if (!is_file($a) || !uc_archive_kind($a)) throw new UcError('Not an archive');
      $pw = (string)arg('password');
      if ($pw === '' || strlen($pw) > 500 || str_contains($pw, "\0")) throw new UcError('Type the password');
      uc_arc_set_pw($a, $pw);
      uc_json(['ok' => true]);
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
      uc_json(['ok' => true, 'name' => basename($p), 'hist' => uc_hist_add('New folder ' . basename($p), [['t' => 'mkdir', 'p' => $p]])]);
    }

    /* New file (an empty one, to fill in the editor) */
    case 'newfile': {
      $p = uc_join(uc_path(arg('path')), uc_name(trim(arg('name'))));
      if (file_exists($p) || is_link($p)) throw new UcError('Something with that name is already there');
      if (@file_put_contents($p, '') === false) throw new UcError("Couldn't create it here");
      @chown($p, 'nobody'); @chgrp($p, 'users'); @chmod($p, 0666);
      uc_json(['ok' => true, 'name' => basename($p), 'path' => $p, 'hist' => uc_hist_add('New file ' . basename($p), [['t' => 'made', 'p' => $p]])]);
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
      $hid = $from === $to ? null : uc_hist_add('Renamed ' . basename($from) . ' → ' . basename($to), [['t' => 'ren', 'a' => $from, 'b' => $to]]);
      uc_json(['ok' => true, 'name' => basename($to), 'hist' => $hid]);
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
      $hid = uc_hist_add('Batch rename: ' . count($pairs) . ' item' . (count($pairs) === 1 ? '' : 's') . ' in ' . basename($dir),
        array_map(fn($pr) => ['t' => 'ren', 'a' => "$dir/{$pr[0]}", 'b' => "$dir/{$pr[1]}"], $pairs));
      uc_json(['ok' => true, 'count' => count($pairs), 'pairs' => $pairs, 'hist' => $hid]);
    }

    /* Delete = move into .uncommander-trash on the same share/disk. */
    case 'trash': {
      uc_practice_block('deleting');
      [$n, $bins] = uc_delete_paths(array_map('uc_path', arg_list('paths')), arg('forever', '0') === '1', $items);
      $label = trim(preg_replace('/[\x00-\x1f]+/', ' ', (string)arg('label', '')));
      $hid = uc_hist_add($label !== '' ? mb_substr($label, 0, 120) : uc_hist_delete_label($items), uc_hist_delete_parts($items));
      uc_json(['ok' => true, 'count' => $n, 'bins' => $bins, 'hist' => $hid]);
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

    /* ---------- History (see history.php) ---------- */
    case 'history': {
      uc_json(['ok' => true, 'steps' => uc_hist_view(), 'now' => time()]);
    }
    case 'history_undo': {
      $which = null;
      if (array_key_exists('parts', $req) && $req['parts'] !== '' && $req['parts'] !== null) $which = array_map('intval', arg_list('parts'));
      uc_json(['ok' => true] + uc_hist_undo((string)arg('id'), $which));
    }
    /* Settings > Trash & History > Empty the trash now: every bin on every share,
     * disk, pool and the flash drive, whatever its age. Runs in the background
     * (a big trash on a spun-down disk can take a while). */
    case 'trash_empty_now': {
      if (uc_settings()['practice']) throw new UcError('Practice mode is on - emptying the trash is locked');
      exec('setsid nohup bash ' . escapeshellarg(__DIR__ . '/../scripts/purge-trash') . ' --all >/dev/null 2>&1 &');
      uc_json(['ok' => true]);
    }
    case 'history_clear': {
      $l = uc_hist_lock(); uc_hist_write(['v' => 1, 'steps' => []]); flock($l, LOCK_UN);
      uc_json(['ok' => true]);
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

    /* Video player: what's inside a video, and the optional ffmpeg download */
    case 'media_info': {
      uc_json(uc_media_info(uc_path(arg('path'))));
    }
    case 'hls_start': {
      $p = uc_path(arg('path'));
      $ff = uc_ffmpeg();
      if (!$ff) throw new UcError('ffmpeg isn\'t downloaded yet - open the video again in a minute');
      $sid = preg_replace('/[^a-z0-9]/', '', arg('sid')) ?: 'x';
      uc_stream_stop($sid);
      /* tidy up players left behind in other tabs (nothing fetched for 2 minutes) */
      foreach (glob(UC_STATE . '/hls-*') ?: [] as $d) if (filemtime($d) < time() - 120) uc_stream_stop(substr(basename($d), 4));
      $d = UC_STATE . "/hls-$sid";
      mkdir($d, 0700, true);
      $cmd = 'setsid nohup nice -n 5 ' . escapeshellarg($ff) . ' -readrate 1.5 -readrate_initial_burst 60 ' . uc_stream_args($p, max(0, (float)arg('t', '0')), uc_stream_opts($req))
        . ' -f hls -hls_time 4 -hls_list_size 20 -hls_flags delete_segments+independent_segments -hls_segment_type fmp4 -hls_fmp4_init_filename init.mp4'
        . ' -hls_segment_filename ' . escapeshellarg("$d/s%05d.m4s") . ' ' . escapeshellarg("$d/index.m3u8") . ' >/dev/null 2>&1 & echo $!';
      $pid = (int)exec($cmd);
      file_put_contents(UC_STATE . "/vp-$sid.pid", $pid);
      for ($i = 0; $i < 60 && !is_file("$d/index.m3u8"); $i++) usleep(200000);
      if (!is_file("$d/index.m3u8")) { uc_stream_stop($sid); throw new UcError("ffmpeg couldn't start on this video"); }
      uc_json(['ok' => true]);
    }
    case 'stream_stop': {
      uc_stream_stop(preg_replace('/[^a-z0-9]/', '', arg('sid')) ?: 'x');
      uc_json(['ok' => true]);
    }
    case 'ffmpeg_status': {
      $part = (string)uc_ff_gz() . '.part';
      $st = uc_ff_state();
      uc_json(['state' => $st, 'gpus' => uc_gpus(), 'pct' => is_file($part) ? min(99, (int)(filesize($part) * 100 / UC_FF_SIZE)) : 0,
               'error' => $st === 'error' ? trim((string)@file_get_contents(UC_STATE . '/ffmpeg.err')) : '', 'mb' => round(UC_FF_SIZE / 1048576),
               'vauto' => trim((string)@file_get_contents(UC_STATE . '/vconv')) ?: null]);
    }
    case 'vconv_auto': {        // Settings › Automatic › Test: find out again which works
      if (!uc_ffmpeg()) throw new UcError('ffmpeg isn\'t there yet');
      @set_time_limit(120);
      uc_json(['ok' => true, 'mode' => uc_vconv(true)]);
    }
    case 'ffmpeg_get': {
      uc_ff_start();
      uc_json(['ok' => true]);
    }
    /* Settings: can the chosen graphics really convert video? A 1-second test */
    case 'gpu_test': {
      $ff = uc_ffmpeg();
      if (!$ff) { uc_ff_start(); throw new UcError('Getting ffmpeg first (58 MB, once) - try again in a minute'); }
      $mode = arg('mode');
      $src = '-f lavfi -i testsrc2=size=1280x720:rate=25 -t 2';
      $cmd = ['cpu' => "$src -vf format=yuv420p -c:v libx264 -preset veryfast",
              'nvidia' => "-init_hw_device cuda=gpu -filter_hw_device gpu $src -vf format=yuv420p,hwupload -c:v h264_nvenc",
              'vaapi' => '-vaapi_device ' . escapeshellarg(array_column(uc_gpus(), 'dev', 'id')['vaapi'] ?? '/dev/dri/renderD128') . " $src -vf format=nv12,hwupload -c:v h264_vaapi"][$mode] ?? null;
      if (!$cmd) throw new UcError('Unknown choice');
      $t = microtime(true);
      exec('timeout 30 ' . escapeshellarg($ff) . " -hide_banner -loglevel error -nostdin $cmd -f null - 2>&1", $out, $rc);
      uc_json(['ok' => $rc === 0, 'secs' => round(microtime(true) - $t, 1), 'error' => $rc ? trim(implode(' ', array_slice($out, -3))) ?: "ffmpeg stopped (code $rc)" : '']);
    }
    /* Subtitles for the player, as WebVTT: embedded ones are pulled out of the
     * video once (in the background - the whole file is read, which takes a while
     * on a big film) and kept in RAM; .srt/.ass files next to it are quick. */
    /* Where a stream started at t really begins: the picture is passed through, so
     * it starts at the key frame at or before t - the player's clock needs that. */
    /* Is this folder a music collection - artist folders holding album folders of songs?
     * Looks at a sample of the folders, a couple of albums each: quick, even on a big collection. */
    case 'music_probe': {
      $p = uc_path(arg('path'));
      $subs = array_values(array_filter(uc_sorted_names($p), fn($n) => is_dir("$p/$n")));
      $n = count($subs);
      if ($n < 2) uc_json(['music' => false]);
      $pick = $n <= 24 ? $subs : array_map(fn($i) => $subs[(int)floor($i * $n / 24)], range(0, 23));
      $art = 0; $loose = 0;
      foreach ($pick as $a) {
        $albums = 0; $songs = false;
        foreach (uc_sorted_names("$p/$a") as $k) {
          $f = "$p/$a/$k";
          if (is_dir($f)) { if ($albums < 1 && count(array_filter(array_slice(uc_sorted_names($f), 0, 80), fn($x) => preg_match(UC_AUDIO_RE, $x)))) $albums++; }
          elseif (preg_match(UC_AUDIO_RE, $k)) $songs = true;
          if ($albums) break;
        }
        if ($albums) $art++; elseif ($songs) $loose++;
      }
      $c = count($pick);
      uc_json(['music' => $art >= max(1, $c * .3) && ($art + $loose) >= $c * .6, 'folders' => $n]);
    }
    /* album covers: how many songs in each album folder (its CD1/CD2 folders included) */
    case 'mus_info': {
      $p = uc_path(arg('path')); $out = [];
      foreach (array_slice(arg_list('names'), 0, 400) as $n) {
        $n = (string)$n; if ($n === '' || str_contains($n, '/') || !is_dir("$p/$n")) continue;
        $c = 0;
        foreach (uc_sorted_names("$p/$n") as $k) {
          if (preg_match(UC_AUDIO_RE, $k)) $c++;
          elseif (is_dir("$p/$n/$k")) foreach (array_slice(uc_sorted_names("$p/$n/$k"), 0, 300) as $x) if (preg_match(UC_AUDIO_RE, $x)) $c++;
        }
        $out[$n] = ['songs' => $c];
      }
      uc_json(['info' => (object)$out]);
    }
    /* song lengths, read by ffmpeg (kept in RAM); none at all without ffmpeg */
    case 'durations': {
      $p = uc_path(arg('path'));
      $ff = uc_ffmpeg();
      if (!$ff) uc_json(['ff' => false]);
      $dir = UC_STATE . '/thumbs'; @mkdir($dir, 0700, true);
      $out = []; $t0 = microtime(true);
      foreach (array_slice(arg_list('names'), 0, 40) as $n) {
        $n = (string)$n; $f = "$p/$n";
        if ($n === '' || str_contains($n, '/') || !is_file($f) || !preg_match(UC_AUDIO_RE, $n)) continue;
        $key = "$dir/dur-" . sha1($f . '|' . filemtime($f) . '|' . filesize($f));
        if (is_file($key)) { $out[$n] = (float)file_get_contents($key); continue; }
        if (microtime(true) - $t0 > 20) continue;
        $o = [];
        exec('timeout 10 ' . escapeshellarg($ff) . ' -hide_banner -nostdin -i ' . escapeshellarg(uc_direct($f)) . ' 2>&1', $o);
        $d = 0.0;
        foreach ($o as $line) if (preg_match('/Duration:\s*(\d+):(\d+):([\d.]+)/', $line, $m)) { $d = $m[1] * 3600 + $m[2] * 60 + (float)$m[3]; break; }
        @file_put_contents($key, (string)$d);
        $out[$n] = $d;
      }
      uc_json(['ff' => true, 'durs' => (object)$out]);
    }
    /* ---------- music tags ---------- */
    case 'tags_read': {
      $ff = uc_ffmpeg();
      if (!$ff) { uc_ff_start(); throw new UcError('Reading music tags needs ffmpeg - unCommander is getting it now (58 MB, once). Try again in a minute.'); }
      $out = []; $t0 = microtime(true);
      foreach (array_slice(arg_list('paths'), 0, 400) as $q) {
        $q = uc_path((string)$q);
        if (microtime(true) - $t0 > 25) { $out[$q] = ['later' => true]; continue; }
        $out[$q] = is_file($q) ? uc_tags_read($q, $ff) : ['ro' => 'Not there any more', 'tags' => (object)[]];
      }
      uc_json(['songs' => (object)$out]);
    }
    case 'tags_write': {
      uc_practice_block('changing music tags');
      $ff = uc_ffmpeg();
      if (!$ff) throw new UcError('Editing music tags needs ffmpeg');
      $src = uc_path(arg('path'));
      if (!is_file($src)) throw new UcError(basename($src) . ' is no longer there');
      $kind = uc_tag_kind($src);
      if (!$kind) throw new UcError("Tags can't be changed in " . basename($src));
      $set = arg('tags', '{}'); if (is_string($set)) $set = json_decode($set, true);
      $cover = (string)arg('cover', '');
      $keep = arg('keep', '1') === '1' && uc_settings()['trash'];
      $info = uc_tags_read($src, $ff);
      if ($info['ro']) throw new UcError(basename($src) . ': ' . $info['ro']);
      $pic = '';
      if (str_starts_with($cover, 'mb:')) { $pic = UC_STATE . '/mbcover/' . substr($cover, 3) . '.jpg'; if (!preg_match('/^mb:[0-9a-f-]{36}$/', $cover) || !is_file($pic)) throw new UcError('That cover is no longer downloaded - pick it again'); }
      elseif ($cover !== '' && $cover !== 'none') { $pic = uc_path($cover); if (!is_file($pic) || !preg_match('/\.(jpe?g|png)$/i', $pic)) throw new UcError('The cover has to be a JPG or PNG picture'); }
      if ($kind === 'ogg' && $pic) throw new UcError("A picture can't be put into OGG files here");
      $up = $kind === 'vorbis' || $kind === 'ogg';     // FLAC/OGG keep their tag names in capitals
      $meta = '';
      foreach ((array)$set as $k => $v) {
        if (!in_array($k, UC_TAG_FIELDS, true)) continue;
        $v = str_replace("\0", '', mb_substr((string)$v, 0, 2000));
        $name = in_array($k, ['album_artist', 'track', 'disc'], true) || !$up ? $k : strtoupper($k);
        $meta .= ' -metadata ' . escapeshellarg("$name=$v");
      }
      $ext = strtolower(pathinfo($src, PATHINFO_EXTENSION));
      $tmp = dirname($src) . '/.uc-tags-' . bin2hex(random_bytes(4)) . '.' . $ext;
      $map = $pic ? ' -i ' . escapeshellarg($pic) . ' -map 0:a -map 1:0 -disposition:v:0 attached_pic' : ($cover === 'none' ? ' -map 0:a' : ' -map 0:a -map 0:v?');
      $cmd = 'timeout 120 ' . escapeshellarg($ff) . ' -hide_banner -loglevel error -nostdin -i ' . escapeshellarg($src) . $map
        . ' -c copy -map_metadata 0' . $meta . ($kind === 'mp3' ? ' -id3v2_version 3' : '') . ' -fflags +bitexact -y ' . escapeshellarg($tmp) . ' 2>&1';
      $o = []; exec($cmd, $o, $rc);
      try {
        if ($rc || !is_file($tmp) || filesize($tmp) < 1) throw new UcError(basename($src) . ": ffmpeg couldn't write it (" . mb_substr(trim(implode(' ', $o)), 0, 200) . ')');
        /* the sound must be exactly the same, bit for bit */
        $md5 = function ($f) use ($ff) { $x = []; exec('timeout 120 ' . escapeshellarg($ff) . ' -v error -nostdin -i ' . escapeshellarg($f) . ' -map 0:a:0 -c copy -f md5 - 2>/dev/null', $x); return trim(implode('', $x)); };
        $a = $md5($src); $b = $md5($tmp);
        if ($a === '' || $a !== $b) throw new UcError(basename($src) . ': the check after writing failed, so the original was left as it was');
        @chown($tmp, fileowner($src)); @chgrp($tmp, filegroup($src)); @chmod($tmp, fileperms($src) & 0777);
        if ($keep) {
          [, , $items] = uc_delete_paths([$src]);
          if (!@rename($tmp, $src)) throw new UcError("Couldn't put " . basename($src) . ' back - the original is in the trash');
          $parts = array_merge($items, [['t' => 'made', 'p' => $src]]);
        } else {
          if (!@rename($tmp, $src)) throw new UcError("Couldn't replace " . basename($src));
          $parts = [['t' => 'gone', 'p' => $src, 'gone' => 'tags rewritten without keeping the original']];
        }
      } finally { if (is_file($tmp)) @unlink($tmp); }
      $label = arg('label', '') !== '' ? mb_substr(arg('label'), 0, 160) : 'Changed the tags of ' . basename($src);
      $join = arg('join', '');
      $hist = $join !== '' ? uc_hist_append($join, $parts, $label) : uc_hist_add($label, $parts);
      uc_json(['ok' => true, 'hist' => $hist, 'kept' => $keep]);
    }
    /* a cover made in the browser (Tools > Music library check > Make a cover): kept for a
     * moment until cover_save puts it in the album as cover.jpg. A note inside the JPEG says
     * unCommander made it, so it can be told apart from real artwork later. */
    case 'cover_upload': {
      $d = (string)arg('data');
      $d = base64_decode(preg_replace('/^data:image\/jpeg;base64,/', '', $d), true);
      if ($d === false || strlen($d) > 6 << 20) throw new UcError('That picture is too big');
      $i = @getimagesizefromstring($d);
      if (!$i || $i[2] !== IMAGETYPE_JPEG) throw new UcError('That is not a JPEG picture');
      $note = 'Made by unCommander: no album artwork';
      $d = substr($d, 0, 2) . "\xFF\xFE" . pack('n', strlen($note) + 2) . $note . substr($d, 2);
      @mkdir(UC_STATE . '/put', 0700, true);
      foreach (glob(UC_STATE . '/put/made-*.jpg') ?: [] as $old) if (filemtime($old) < time() - 3600) @unlink($old);
      $id = bin2hex(random_bytes(8));
      if (@file_put_contents(UC_STATE . "/put/made-$id.jpg", $d) === false) throw new UcError("Couldn't keep the picture");
      uc_json(['ok' => true, 'id' => "up:$id"]);
    }
    /* Tools > Music library check > Same album twice > Merge: one album folder's things go into
     * the other. flat: all in one folder (a name that's taken stays behind); discs: the songs of
     * each go into CD1, CD2... inside the one kept. The other folder then goes to the trash.
     * Every step is in History, so Undo takes it all back. */
    case 'music_merge': {
      uc_practice_block('merging albums');
      $keep = uc_path((string)arg('keep')); $other = uc_path((string)arg('other')); $mode = arg('mode') === 'discs' ? 'discs' : 'flat';
      if (!is_dir($keep) || !is_dir($other)) throw new UcError('One of the two folders is no longer there');
      if ($keep === $other || str_starts_with("$keep/", "$other/") || str_starts_with("$other/", "$keep/")) throw new UcError('Pick two different album folders');
      $isDisc = fn($n) => (bool)preg_match('/^(cd|dis[ck])\s*(\d+)$/i', $n);
      $isPic = fn($n) => (bool)preg_match('/\.(jpe?g|png|webp|gif|bmp)$/i', $n);
      $parts = []; $skipped = [];
      $mv = function (string $a, string $b) use (&$parts, &$skipped) {
        if (file_exists($b) || is_link($b)) { $skipped[] = basename($a); return false; }
        if (!@rename($a, $b)) throw new UcError("Couldn't move " . basename($a));
        $parts[] = ['t' => 'move', 'a' => $a, 'b' => $b]; return true;
      };
      $mk = function (string $d) use (&$parts) { if (is_dir($d)) return; if (!@mkdir($d, 0777)) throw new UcError("Couldn't make " . basename($d)); @chmod($d, 0777); $parts[] = ['t' => 'mkdir', 'p' => $d]; };
      $names = fn($d) => array_values(array_filter(uc_sorted_names($d), fn($n) => $n !== '.' && $n !== '..'));
      try {
        if ($mode === 'flat') {
          /* numbered by disc (1-01..., 2-01...), so the two sets of songs don't mix when sorted by name */
          if (arg('discnum', '') === '1') {
            $num = fn($n) => preg_match(UC_AUDIO_RE, $n) && preg_match('/^\d{1,3}(?!\d)/', $n);
            foreach ($names($keep) as $n) if (is_file("$keep/$n") && $num($n)) $mv("$keep/$n", "$keep/1-$n");
            foreach ($names($other) as $n) if (is_file("$other/$n") && $num($n)) $mv("$other/$n", "$keep/2-$n");
          }
          foreach ($names($other) as $n) $mv("$other/$n", "$keep/$n");
        } else {
          /* the discs already in the kept folder; its loose songs become CD1 when there are none */
          $nums = []; foreach ($names($keep) as $n) if (is_dir("$keep/$n") && preg_match('/^(cd|dis[ck])\s*(\d+)$/i', $n, $m)) $nums[] = (int)$m[2];
          if (!$nums) {
            $loose = array_filter($names($keep), fn($n) => is_file("$keep/$n") && (preg_match(UC_AUDIO_RE, $n) || preg_match('/\.(cue|log|m3u8?)$/i', $n)));
            if ($loose) { $mk("$keep/CD1"); foreach ($loose as $n) $mv("$keep/$n", "$keep/CD1/$n"); $nums[] = 1; }
          }
          $next = ($nums ? max($nums) : 0) + 1;
          $od = array_values(array_filter($names($other), fn($n) => is_dir("$other/$n") && $isDisc($n)));
          $loose = array_values(array_filter($names($other), fn($n) => is_file("$other/$n") && !$isPic($n)));
          if ($loose) { $cd = "$keep/CD$next"; $mk($cd); foreach ($loose as $n) $mv("$other/$n", "$cd/$n"); $next++; }
          foreach ($od as $n) { $mv("$other/$n", "$keep/CD$next"); $next++; }
          foreach ($names($other) as $n) if (is_file("$other/$n") && $isPic($n) && !file_exists("$keep/$n")) $mv("$other/$n", "$keep/$n");
        }
        /* what's left (names that were taken) goes to the trash with the folder */
        [, , $items] = uc_delete_paths([$other]);
        $parts = array_merge($parts, $items);
      } finally {
        if ($parts) $hist = uc_hist_add(($mode === 'discs' ? 'Merged as discs: ' : 'Merged: ') . basename($other) . ' → ' . basename($keep), $parts);
      }
      uc_json(['ok' => true, 'hist' => $hist ?? null, 'skipped' => $skipped]);
    }
    /* a folder's cover: from a picture, from the picture inside a song, or from MusicBrainz */
    case 'cover_save': {
      uc_practice_block('saving covers');
      $dir = uc_path(arg('dir')); $from = (string)arg('from');
      if (!is_dir($dir)) throw new UcError('That folder is no longer there');
      $tmp = '';
      if (str_starts_with($from, 'up:')) {
        $src = UC_STATE . '/put/made-' . substr($from, 3) . '.jpg';
        if (!preg_match('/^up:[0-9a-f]{16}$/', $from) || !is_file($src)) throw new UcError('That picture is gone - make it again');
        $ext = 'jpg'; $tmp = $src;
      } elseif (str_starts_with($from, 'mb:')) {
        $src = UC_STATE . '/mbcover/' . substr($from, 3) . '.jpg';
        if (!preg_match('/^mb:[0-9a-f-]{36}$/', $from) || !is_file($src)) throw new UcError('That cover is no longer downloaded - look it up again');
        $ext = 'jpg';
      } else {
        $src = uc_path($from);
        if (!is_file($src)) throw new UcError(basename($src) . ' is no longer there');
        if (preg_match('/\.(jpe?g|png)$/i', $src, $m)) $ext = strtolower($m[1]) === 'png' ? 'png' : 'jpg';
        else {
          $ff = uc_ffmpeg(); if (!$ff) throw new UcError('Taking the picture out of a song needs ffmpeg');
          $o = []; exec('timeout 15 ' . escapeshellarg($ff) . ' -hide_banner -nostdin -i ' . escapeshellarg(uc_direct($src)) . ' 2>&1', $o);
          $codec = ''; foreach ($o as $l) if (str_contains($l, 'attached pic') && preg_match('/Video: (\w+)/', $l, $m)) { $codec = $m[1]; break; }
          if (!$codec) throw new UcError(basename($src) . ' has no picture inside');
          $ext = $codec === 'png' ? 'png' : 'jpg';
          @mkdir(UC_STATE . '/put', 0700, true);
          $tmp = UC_STATE . '/put/cover-' . bin2hex(random_bytes(4)) . ".$ext";
          exec('timeout 30 ' . escapeshellarg($ff) . ' -hide_banner -loglevel error -nostdin -i ' . escapeshellarg(uc_direct($src)) . ' -map 0:v:0 ' . ($codec === 'mjpeg' || $codec === 'png' ? '-c copy' : '-q:v 2') . ' -frames:v 1 -update 1 -y ' . escapeshellarg($tmp) . ' 2>&1', $o2, $rc);
          if ($rc || !is_file($tmp) || !@getimagesize($tmp)) { @unlink($tmp); throw new UcError("Couldn't take the picture out of " . basename($src)); }
          $src = $tmp;
        }
      }
      try {
        $dest = "$dir/cover.$ext"; $parts = [];
        if ($dest === $src) throw new UcError('That is already the cover');
        if (file_exists($dest)) { [, , $items] = uc_delete_paths([$dest]); $parts = $items; }
        if (!@copy($src, $dest)) throw new UcError("Couldn't write cover.$ext");
        @chown($dest, 'nobody'); @chgrp($dest, 'users'); @chmod($dest, 0666);
        $parts[] = ['t' => 'made', 'p' => $dest];
      } finally { if ($tmp) @unlink($tmp); }
      $label = arg('label', '') !== '' ? mb_substr(arg('label'), 0, 160) : "Saved cover.$ext in " . basename($dir);
      $join = arg('join', '');
      $hist = $join !== '' ? uc_hist_append($join, $parts, $label) : uc_hist_add($label, $parts);
      uc_json(['ok' => true, 'hist' => $hist, 'name' => "cover.$ext"]);
    }
    case 'mb_search': {
      $esc = fn($s) => '"' . str_replace(['\\', '"'], ['\\\\', '\\"'], trim((string)$s)) . '"';
      $q = [];
      if (trim(arg('album', '')) !== '') $q[] = 'release:' . $esc(arg('album'));
      if (trim(arg('artist', '')) !== '') $q[] = 'artist:' . $esc(arg('artist'));
      if (!$q) throw new UcError('Type the album or the artist to look for');
      $j = uc_mb_get('release?fmt=json&limit=15&query=' . rawurlencode(implode(' AND ', $q)));
      $out = [];
      foreach ((array)($j['releases'] ?? []) as $r) {
        $fm = []; foreach ((array)($r['media'] ?? []) as $m) $fm[] = ($m['format'] ?? '?');
        $out[] = ['id' => $r['id'] ?? '', 'title' => $r['title'] ?? '', 'artist' => uc_mb_credit($r['artist-credit'] ?? []), 'date' => $r['date'] ?? '',
          'country' => $r['country'] ?? '', 'tracks' => (int)($r['track-count'] ?? 0), 'format' => implode(' + ', array_unique($fm)) . (count($fm) > 1 ? ' (' . count($fm) . ' discs)' : ''), 'score' => (int)($r['score'] ?? 0)];
      }
      uc_json(['releases' => $out]);
    }
    case 'mb_release': {
      $id = (string)arg('id');
      if (!preg_match('/^[0-9a-f-]{36}$/', $id)) throw new UcError('Bad release');
      $j = uc_mb_get("release/$id?fmt=json&inc=recordings+artist-credits+release-groups+genres");
      if (!$j) throw new UcError('MusicBrainz no longer has that release');
      $discs = [];
      foreach ((array)($j['media'] ?? []) as $m) {
        $tr = [];
        foreach ((array)($m['tracks'] ?? []) as $t) $tr[] = ['n' => (int)($t['position'] ?? 0), 'title' => $t['title'] ?? '', 'artist' => uc_mb_credit($t['artist-credit'] ?? []), 'len' => (int)round(($t['length'] ?? 0) / 1000)];
        $discs[] = ['pos' => (int)($m['position'] ?? 1), 'format' => $m['format'] ?? '', 'tracks' => $tr];
      }
      $g = (array)($j['genres'] ?? []); usort($g, fn($a, $b) => ($b['count'] ?? 0) <=> ($a['count'] ?? 0));
      $year = substr((string)($j['release-group']['first-release-date'] ?? ''), 0, 4) ?: substr((string)($j['date'] ?? ''), 0, 4);
      /* its front cover, if the Cover Art Archive has one (kept in RAM for the preview and for writing) */
      $dir = UC_STATE . '/mbcover'; @mkdir($dir, 0700, true); $f = "$dir/$id.jpg"; $hasCover = is_file($f);
      if (!$hasCover && !empty($j['cover-art-archive']['front'])) {
        $ch = curl_init(uc_caa_base() . "/release/$id/front-500");
        curl_setopt_array($ch, [CURLOPT_RETURNTRANSFER => true, CURLOPT_FOLLOWLOCATION => true, CURLOPT_MAXREDIRS => 5, CURLOPT_CONNECTTIMEOUT => 8, CURLOPT_TIMEOUT => 30,
          CURLOPT_USERAGENT => 'unCommander/1 ( https://github.com/hernandito/unCommander )']);
        $img = curl_exec($ch); $code = (int)curl_getinfo($ch, CURLINFO_HTTP_CODE); curl_close($ch);
        if ($img !== false && $code === 200 && @getimagesizefromstring($img)) { file_put_contents($f, $img); $hasCover = true; }
      }
      $fm = []; foreach ((array)($j['media'] ?? []) as $m) $fm[] = $m['format'] ?? '';
      uc_json(['id' => $id, 'title' => $j['title'] ?? '', 'artist' => uc_mb_credit($j['artist-credit'] ?? []), 'date' => $year,
        'edate' => (string)($j['date'] ?? ''), 'country' => (string)($j['country'] ?? ''), 'format' => implode(' + ', array_unique(array_filter($fm))),
        'genre' => $g ? ucfirst($g[0]['name'] ?? '') : '', 'discs' => $discs, 'cover' => $hasCover]);
    }
    /* the terminal at the bottom: unRAID's own web terminal (ttyd) on a socket of
     * ours, reached through unRAID's /webterminal/ address, so it needs the login */
    case 'term_start': {
      if (!is_executable('/usr/bin/ttyd-exec') && trim((string)shell_exec('command -v ttyd-exec 2>/dev/null')) === '') throw new UcError("This unRAID has no web terminal (it comes with unRAID 6.10 and later)");
      @mkdir(UC_STATE, 0700, true);
      $cwd = (string)arg('cwd', '');
      file_put_contents(UC_STATE . '/term-cwd', $cwd !== '' && is_dir($cwd) ? $cwd : '/root');
      $sock = '/var/run/uctty.sock';
      exec('pgrep -f ' . escapeshellarg("ttyd.*$sock"), $o, $rc);
      if ($rc !== 0) {
        @unlink($sock);
        exec('setsid ttyd-exec -i ' . escapeshellarg($sock) . ' ' . escapeshellarg(UC_DIR . '/scripts/term-shell') . ' >/dev/null 2>&1 &');
        for ($i = 0; $i < 30 && !file_exists($sock); $i++) usleep(100000);
      }
      uc_json(['ok' => true, 'url' => '/webterminal/uctty/']);
    }
    case 'term_stop': {
      $sock = '/var/run/uctty.sock';
      exec('pgrep -f ' . escapeshellarg("ttyd.*$sock"), $pid, $rc);
      if ($rc === 0) { exec('pgrep -P ' . (int)$pid[0], $kids, $rc2); if ($rc2 !== 0) exec('kill ' . (int)$pid[0]); }   // only when no terminal is still open
      @unlink(UC_STATE . '/term.log');          // Exit: the next terminal starts clean
      uc_json(['ok' => true]);
    }
    /* ---------- playlists ---------- */
    /* the songs in what was picked: songs as they are, folders (albums, artists) all the way down */
    /* Tools > Music library check: one walk through the music folder, five lists.
     * An album is a folder with songs in it (CD1/CD2 folders count as part of theirs). */
    case 'music_check': {
      @set_time_limit(600);
      $root = uc_path(rtrim((string)arg('path'), '/'));
      if (!is_dir($root)) throw new UcError('That folder is no longer there');
      $cf = uc_mc_cache();
      $c = is_file($cf) ? (json_decode((string)file_get_contents($cf), true) ?: null) : null;
      if ($c && (($c['root'] ?? '') !== $root)) $c = null;
      /* the saved results, if they're less than an hour old - without what has gone since */
      if (arg('cached', '')) {
        if (!$c || time() - ($c['at'] ?? 0) > UC_MC_TTL) uc_json(['none' => true]);
        foreach (UC_MC_LISTS as $l) if ($l !== 'names') $c[$l] = array_values(array_filter($c[$l] ?? [], fn($x) => $l === 'dups' ? count(array_filter($x, fn($y) => is_dir($y['p']))) > 1 : file_exists($x['p'])));
        uc_mc_out($c);
      }
      $starts = array_values(array_filter(array_map(fn($p) => rtrim((string)$p, '/'), arg('paths', '') === '' ? [] : arg_list('paths')), fn($p) => $p !== '' && uc_mc_in($p, [$root])));
      /* an album is checked with the folder it's in, so "the same album twice" next to it is seen too */
      $starts = array_values(array_unique(array_map(fn($p) => $p !== $root && dirname($p) !== $root && uc_mc_in(dirname($p), [$root]) ? dirname($p) : $p, $starts)));
      $starts = array_values(array_filter($starts, fn($p) => !array_filter($starts, fn($q) => $q !== $p && str_starts_with($p, "$q/"))));
      if (!$starts || !$c) {
        $r = uc_music_scan($root, [$root]) + ['root' => $root, 'at' => time()];
      } else {
        /* check only these folders again: what was in them is replaced by what's there now */
        $n = uc_music_scan($root, $starts);
        $r = $c; $r['secs'] = $n['secs']; $r['rechecked'] = count($starts);
        foreach (UC_MC_LISTS as $l) {
          $keep = array_values(array_filter($c[$l] ?? [], fn($x) => $l === 'dups' ? !array_filter($x, fn($y) => uc_mc_in($y['p'], $starts)) : !uc_mc_in($x['p'], $starts)));
          $r[$l] = [...$keep, ...$n[$l]];
          usort($r[$l], fn($x, $y) => strnatcasecmp($l === 'dups' ? $x[0]['p'] : $x['p'], $l === 'dups' ? $y[0]['p'] : $y['p']));
        }
      }
      @file_put_contents($cf, json_encode($r, JSON_UNESCAPED_SLASHES | JSON_INVALID_UTF8_SUBSTITUTE));
      uc_mc_out($r);
    }
    /* "it's fine as it is": an item leaves its list until its folder changes */
    case 'music_accept': {
      $l = (string)arg('list'); if (!in_array($l, UC_MC_LISTS, true)) throw new UcError('Unknown list');
      $keys = array_map('strval', arg_list('keys')); $on = arg('on') === '1';
      $cf = uc_mc_cache(); $c = is_file($cf) ? (json_decode((string)file_get_contents($cf), true) ?: []) : [];
      $acc = uc_mc_accept();
      foreach ($c[$l] ?? [] as $x) { $k = uc_mc_key($l, $x); if (!in_array($k, $keys, true)) continue; if ($on) $acc[$l][$k] = uc_mc_sig($l, $x); else unset($acc[$l][$k]); }
      if (!$on) foreach ($keys as $k) unset($acc[$l][$k]);
      $f = uc_mc_accept_file(); if (!is_dir(dirname($f))) @mkdir(dirname($f), 0777, true);
      if (@file_put_contents($f, json_encode($acc, JSON_UNESCAPED_SLASHES | JSON_INVALID_UTF8_SUBSTITUTE)) === false) throw new UcError("Couldn't save that in " . dirname($f));
      uc_mc_out($c);
    }
    /* what the songs' tags say an album is (for the same album twice) */
    case 'music_albtags': {
      $out = []; $t0 = microtime(true);
      foreach (array_slice(arg_list('paths'), 0, 40) as $d) {
        if (microtime(true) - $t0 > 25) break;
        try { $d = uc_path((string)$d); } catch (Throwable $e) { continue; }
        $song = '';
        foreach ([$d, ...array_map(fn($n) => "$d/$n", array_filter(uc_sorted_names($d), fn($n) => is_dir("$d/$n")))] as $dd) {
          foreach (uc_sorted_names($dd) as $n) if (preg_match(UC_AUDIO_RE, $n)) { $song = "$dd/$n"; break 2; }
        }
        if (!$song) { $out[$d] = null; continue; }
        $i = uc_media_info($song); if (empty($i['ff'])) uc_json(['ff' => false]);
        $t = $i['tags'] ?? [];
        $out[$d] = ['album' => $t['album'] ?? '', 'year' => preg_match('/(1[89]|20)\d\d/', (string)($t['date'] ?? ''), $m) ? $m[0] : '', 'artist' => $t['albumartist'] ?? ($t['artist'] ?? '')];
      }
      uc_json(['ff' => true, 'tags' => $out]);
    }
    /* a name that isn't UTF-8 (an old Windows encoding) gets its UTF-8 spelling */
    case 'music_fixname': {
      uc_practice_block('renaming');
      $done = 0; $bad = [];
      $raws = array_map(fn($b) => base64_decode((string)$b, true), arg_list('raws'));
      usort($raws, fn($a, $b) => substr_count((string)$b, '/') <=> substr_count((string)$a, '/'));   // the deepest first, so a folder's new name doesn't lose the things inside it
      foreach ($raws as $raw) {
        if ($raw === false || $raw === '' || $raw[0] !== '/' || str_contains($raw, "\0")) { $bad[] = '?'; continue; }
        $dir = dirname($raw); $n = basename($raw);
        try { uc_path(mb_convert_encoding($dir, 'UTF-8', 'Windows-1252')); } catch (Throwable $e) { $bad[] = $n; continue; }
        if (!file_exists($raw)) { $bad[] = mb_convert_encoding($n, 'UTF-8', 'Windows-1252') . ' (no longer there)'; continue; }
        $to = "$dir/" . mb_convert_encoding($n, 'UTF-8', 'Windows-1252');
        if (file_exists($to)) { $bad[] = basename($to) . ' (that name is taken)'; continue; }
        if (@rename($raw, $to)) $done++; else $bad[] = basename($to);
      }
      uc_json(['ok' => true, 'done' => $done, 'bad' => $bad]);
    }
    case 'pl_songs': {
      $out = []; $t0 = microtime(true);
      $walk = function (string $d, int $depth) use (&$walk, &$out, $t0) {
        if ($depth > 8 || count($out) >= 20000 || microtime(true) - $t0 > 90) return;
        $files = []; $dirs = [];
        foreach (uc_sorted_names($d) as $n) { $f = "$d/$n"; if (is_dir($f)) $dirs[] = $f; elseif (preg_match(UC_AUDIO_RE, $n)) $files[] = $f; }
        foreach ($files as $f) { if (count($out) < 20000) $out[] = $f; }
        foreach ($dirs as $f) $walk($f, $depth + 1);
      };
      foreach (array_slice(arg_list('paths'), 0, 2000) as $q) {
        $q = uc_path((string)$q);
        if (is_dir($q)) $walk($q, 0); elseif (is_file($q) && preg_match(UC_AUDIO_RE, $q)) $out[] = $q;
      }
      uc_json(['songs' => array_values(array_unique($out)), 'more' => count($out) >= 20000 || microtime(true) - $t0 > 90]);
    }
    case 'pl_prefs': {
      $p = uc_pl_prefs();
      if (arg('set', '') === '1') {
        $in = arg('prefs'); if (is_string($in)) $in = json_decode($in, true); $in = (array)$in;
        $tg = [];
        foreach ((array)($in['targets'] ?? []) as $k => $v) {
          if (!preg_match('/^[a-z]{2,12}$/', (string)$k) || !is_array($v)) continue;
          $tg[$k] = ['dir' => mb_substr((string)($v['dir'] ?? ''), 0, 500), 'from' => mb_substr((string)($v['from'] ?? ''), 0, 500), 'to' => mb_substr((string)($v['to'] ?? ''), 0, 500), 'ext' => in_array($v['ext'] ?? '', ['m3u', 'xsp'], true) ? $v['ext'] : 'm3u8', 'fmt' => ($v['fmt'] ?? '') === 'xsp' ? 'xsp' : 'm3u', 'order' => ($v['order'] ?? '') === 'artist' ? 'artist' : 'random', 'mode' => in_array($v['mode'] ?? '', ['usb', 'app', 'path'], true) ? $v['mode'] : (($v['mode'] ?? '') === 'map' ? 'path' : 'usb'), 'by' => ($v['by'] ?? '') === 'artist' ? 'artist' : 'album', 'limit' => max(0, min(100000, (int)($v['limit'] ?? 0)))];
        }
        foreach ((array)($in['targets'] ?? []) as $k => $v) if (isset($tg[$k]) && is_array($v)) $tg[$k] += uc_pl_extra($v);
        $p['targets'] = $tg + (array)$p['targets'];
        if (isset($in['last']) && preg_match('/^[a-z]{2,12}$/', (string)$in['last'])) $p['last'] = $in['last'];
        /* where a playlist was sent (Send to…), so its copies can be updated in one go: per playlist file */
        if (isset($in['send']) && is_array($in['send'])) {
          $m = mb_substr((string)($in['send']['master'] ?? ''), 0, 500); $e = (array)($in['send']['entry'] ?? []);
          $dest = mb_substr((string)($e['dest'] ?? ''), 0, 500);
          if ($m !== '' && $dest !== '' && preg_match('/^[a-z]{2,12}$/', (string)($e['tg'] ?? ''))) {
            $row = ['tg' => (string)$e['tg'], 'dest' => $dest, 'from' => mb_substr((string)($e['from'] ?? ''), 0, 500), 'to' => mb_substr((string)($e['to'] ?? ''), 0, 500),
                    'fmt' => ($e['fmt'] ?? '') === 'xsp' ? 'xsp' : 'm3u', 'order' => ($e['order'] ?? '') === 'artist' ? 'artist' : 'random', 'mode' => in_array($e['mode'] ?? '', ['usb', 'app', 'path'], true) ? $e['mode'] : (($e['mode'] ?? '') === 'map' ? 'path' : 'usb'), 'by' => ($e['by'] ?? '') === 'artist' ? 'artist' : 'album', 'limit' => max(0, min(100000, (int)($e['limit'] ?? 0))),
                    'psend' => !empty($e['psend']), 'poster' => mb_substr((string)($e['poster'] ?? ''), 0, 500), 'at' => time()];
            $row += uc_pl_extra($e);
            $list = array_values(array_filter((array)($p['sends'][$m] ?? []), fn($x) => ($x['dest'] ?? '') !== $dest));
            array_unshift($list, $row); $p['sends'][$m] = array_slice($list, 0, 12);
          }
        }
        if (isset($in['unsend']) && is_array($in['unsend'])) {
          $m = (string)($in['unsend']['master'] ?? ''); $dest = (string)($in['unsend']['dest'] ?? '');
          if (isset($p['sends'][$m])) { $p['sends'][$m] = array_values(array_filter($p['sends'][$m], fn($x) => ($x['dest'] ?? '') !== $dest)); if (!$p['sends'][$m]) unset($p['sends'][$m]); }
        }
        if (count((array)($p['sends'] ?? [])) > 200) $p['sends'] = array_slice((array)$p['sends'], -200, null, true);
        if (isset($in['plex_url'])) $p['plex_url'] = mb_substr(trim((string)$in['plex_url']), 0, 200);
        if (isset($in['plex_token']) && trim((string)$in['plex_token']) !== '') $p['plex_token'] = mb_substr(trim((string)$in['plex_token']), 0, 100);
        if (isset($in['jf_url'])) $p['jf_url'] = mb_substr(trim((string)$in['jf_url']), 0, 200);
        if (isset($in['jf_key']) && trim((string)$in['jf_key']) !== '') $p['jf_key'] = preg_replace('/[^A-Za-z0-9]/', '', mb_substr(trim((string)$in['jf_key']), 0, 100));
        if (isset($in['jf_user'])) { $p['jf_user'] = preg_replace('/[^A-Za-z0-9\-]/', '', (string)$in['jf_user']); $p['jf_uname'] = mb_substr((string)($in['jf_uname'] ?? ''), 0, 80); }
        uc_pl_prefs_save($p);
      }
      $maps = uc_docker_maps('/./');           // every container's folders: Send to… > Other app or drive offers them
      $pub = $p; $pub['has_token'] = $p['plex_token'] !== ''; unset($pub['plex_token']); $pub['has_jf_key'] = $p['jf_key'] !== ''; unset($pub['jf_key']);
      uc_json(['prefs' => $pub, 'maps' => $maps, 'host' => strtoupper((string)gethostname())]);
    }
    /* open a playlist: each line back to a file on this server, whichever app it was written for */
    case 'pl_read': {
      $pl = uc_path(arg('path'));
      if (!is_file($pl)) throw new UcError('That playlist is no longer there');
      if (filesize($pl) > 4 * 1048576) throw new UcError('That playlist is too big to open here');
      $txt = (string)file_get_contents($pl);
      if (str_starts_with($txt, "\xEF\xBB\xBF")) $txt = substr($txt, 3);
      if (!mb_check_encoding($txt, 'UTF-8')) $txt = mb_convert_encoding($txt, 'UTF-8', 'Windows-1252');
      $maps = uc_docker_maps('/plex|navidrome|airsonic|jellyfin|emby|kodi/i');
      usort($maps, fn($a, $b) => strlen($b['container']) <=> strlen($a['container']));
      $base = dirname($pl); $items = []; $style = '';
      /* Tools > Playlist check: "paths that start with X are at Y on this server" */
      $mf = rtrim((string)arg('mapfrom', ''), '/'); $mt = rtrim((string)arg('mapto', ''), '/');
      if ($mt !== '') $mt = uc_path($mt);
      $lines = [];
      foreach (preg_split('/\r\n|\r|\n/', $txt) as $l) { $l = trim($l); if ($l !== '' && $l[0] !== '#') $lines[] = $l; }
      foreach ($lines as $l) {
        $l = trim($l); if ($l === '' || $l[0] === '#') continue;
        $raw = $l; $cand = [];
        if ($mf !== '' && $mt !== '' && ($l === $mf || str_starts_with($l, $mf . '/'))) { $style = $style ?: (preg_match('#^[a-z]+://#i', $l) ? 'net' : ($l[0] === '/' ? 'abs' : 'rel')); $cand[] = $mt . rawurldecode(substr($l, strlen($mf))); }
        elseif (preg_match('#^(smb|nfs)://[^/]+/(.+)$#i', $l, $m)) { $style = $style ?: 'net'; $rest = rawurldecode($m[2]); $cand[] = '/mnt/user/' . $rest; $cand[] = '/' . $rest; }
        elseif (preg_match('#^\\\\\\\\[^\\\\]+\\\\(.+)$#', $l, $m)) { $style = $style ?: 'win'; $cand[] = '/mnt/user/' . str_replace('\\', '/', $m[1]); }
        elseif (preg_match('#^[A-Za-z]:[\\\\/]#', $l)) { $style = $style ?: 'win'; }
        elseif ($l[0] === '/') {
          $style = $style ?: 'abs'; $cand[] = $l;
          foreach ($maps as $m) if ($l === $m['container'] || str_starts_with($l, $m['container'] . '/')) $cand[] = $m['host'] . substr($l, strlen($m['container']));
        } else { $style = $style ?: 'rel'; $cand[] = $base . '/' . str_replace('\\', '/', $l); }
        $hit = '';
        foreach ($cand as $c) { $c = uc_norm_path($c); if (is_file($c)) { $hit = $c; break; } }
        if ($hit) { $items[] = ['path' => $hit, 'ok' => true, 'raw' => $raw]; continue; }
        /* not there: show it as a server path (a container's /music/... translated), and say why if it can tell */
        $show = $cand ? uc_norm_path($cand[count($cand) > 1 ? 1 : 0]) : $l;
        $w = $show !== '' && $show[0] === '/' ? uc_why_missing($show) : ['why' => 'gone', 'near' => ''];
        if ($w['why'] === 'ok') { $items[] = ['path' => $w['near'], 'ok' => true, 'raw' => $raw]; continue; }
        $items[] = ['path' => $show, 'ok' => false, 'raw' => $raw, 'why' => $w['why'], 'near' => $w['near']];
      }
      $out = ['name' => pathinfo($pl, PATHINFO_FILENAME), 'items' => $items, 'style' => $style ?: 'rel'];
      if (arg('check', '') === '1') {
        /* where the paths start: the folder all the lines have in common */
        $abs = array_values(array_filter($lines, fn($l) => $l[0] === '/' || preg_match('#^[a-z]+://#i', $l)));
        $prefix = '';
        if ($abs) {
          $prefix = dirname($abs[0]);
          foreach ($abs as $l) while ($prefix !== '' && $prefix !== '/' && !str_starts_with($l, $prefix . '/')) { $np = dirname($prefix); if ($np === $prefix || preg_match('#^[a-z]+:$#i', $np)) { $prefix = ''; break; } $prefix = $np; }
        }
        $out['prefix'] = $prefix;
        /* where that is on this server: a Docker mapping, or found by looking for the first missing song's artist folder */
        $guess = '';
        if ($prefix !== '' && $prefix[0] === '/') {
          if (str_starts_with($prefix, '/mnt/')) $guess = $prefix;
          foreach ($maps as $m) if (!$guess && ($prefix === $m['container'] || str_starts_with($prefix, $m['container'] . '/')) && is_dir($m['host'] . substr($prefix, strlen($m['container'])))) $guess = $m['host'] . substr($prefix, strlen($m['container']));
          if (!$guess) foreach ($abs as $l) {
            $tail = substr($l, strlen($prefix) + 1); $first = explode('/', $tail)[0];
            if ($first === '' || strlen($first) > 200) continue;
            exec('timeout 20 find /mnt/user -maxdepth 5 -type d -name ' . escapeshellarg($first) . ' 2>/dev/null | head -20', $hits);
            foreach ($hits as $h) if (is_file(dirname($h) . '/' . $tail)) { $guess = dirname($h); break 2; }
            break;
          }
        }
        $out['guess'] = $guess;
        $out['lines'] = count($lines);
      }
      uc_json($out);
    }
    case 'pl_write': {
      uc_practice_block('saving playlists');
      $dest = uc_path(arg('path'));
      if (!preg_match('/\.(m3u8?|xsp)$/i', $dest)) throw new UcError('A playlist file ends in .m3u, .m3u8 or .xsp');
      if (preg_match('#^/mnt/remotes/([^/]+)#', $dest, $rm) && !array_filter(uc_ud_mounts(), fn($m) => $m['at'] === "/mnt/remotes/$rm[1]"))
        throw new UcError("The network share $rm[1] isn't mounted - press Mount next to it (or mount it in Main › Unassigned Devices)");
      if (!is_dir(dirname($dest))) throw new UcError('The folder ' . dirname($dest) . " doesn't exist");
      $text = (string)arg('text');
      if (strlen($text) > 8 * 1048576) throw new UcError('That playlist is too big');
      $parts = [];
      if (file_exists($dest)) { if (arg('replace', '0') !== '1') throw new UcError(basename($dest) . ' is already there'); [, , $items] = uc_delete_paths([$dest]); $parts = $items; }
      if (@file_put_contents($dest, $text) === false) throw new UcError("Couldn't write " . basename($dest));
      @chown($dest, 'nobody'); @chgrp($dest, 'users'); @chmod($dest, 0666);
      $parts[] = ['t' => 'made', 'p' => $dest];
      $hist = uc_hist_add(($parts[0]['t'] ?? '') === 'made' ? 'Saved the playlist ' . basename($dest) : 'Saved the playlist ' . basename($dest) . ' (the old one is in the trash)', $parts);
      uc_json(['ok' => true, 'hist' => $hist, 'path' => $dest]);
    }
    /* hand a saved playlist to Plex: Plex reads the file itself, so the path is the one Plex sees */
    /* Save as > Plex: does the address and token work? (the token typed in, or the saved one) */
    case 'plex_test': {
      $p = uc_pl_prefs();
      $url = rtrim(trim((string)arg('url', '')), '/'); $tok = trim((string)arg('token', '')) ?: (string)$p['plex_token'];
      if ($url === '') throw new UcError("Fill in Plex's address first - like http://192.168.0.10:32400");
      if (!preg_match('#^https?://#i', $url)) $url = "http://$url";
      if ($tok === '') throw new UcError('Fill in the Plex token first');
      $get = function (string $u) use ($tok) {
        $ch = curl_init($u . '?X-Plex-Token=' . rawurlencode($tok));
        curl_setopt_array($ch, [CURLOPT_RETURNTRANSFER => true, CURLOPT_CONNECTTIMEOUT => 6, CURLOPT_TIMEOUT => 15,
          CURLOPT_HTTPHEADER => ['Accept: application/json'], CURLOPT_SSL_VERIFYPEER => false, CURLOPT_SSL_VERIFYHOST => 0]);
        $raw = curl_exec($ch); $code = (int)curl_getinfo($ch, CURLINFO_HTTP_CODE); $err = curl_error($ch); curl_close($ch);
        if ($raw === false) throw new UcError("Can't reach Plex at $u ($err)");
        if ($code === 401) throw new UcError('Plex answered, but refused the token (401) - copy it again');
        if ($code >= 400) throw new UcError("Plex answered with error $code - is this Plex's address?");
        $j = json_decode((string)$raw, true);
        if (!is_array($j) || !isset($j['MediaContainer'])) throw new UcError("Something answered at $u, but it isn't Plex");
        return $j['MediaContainer'];
      };
      $me = $get("$url/");
      $music = array_values(array_map(fn($d) => (string)($d['title'] ?? ''), array_filter((array)($get("$url/library/sections")['Directory'] ?? []), fn($d) => ($d['type'] ?? '') === 'artist')));
      uc_json(['ok' => true, 'name' => (string)($me['friendlyName'] ?? 'Plex'), 'version' => (string)($me['version'] ?? ''), 'music' => $music]);
    }
    /* Send to… > Jellyfin / Emby: does it answer, and whose playlists can it make */
    case 'jf_test': {
      $p = uc_pl_prefs();
      $url = trim((string)arg('url', '')) ?: (string)$p['jf_url']; $key = trim((string)arg('key', '')) ?: (string)$p['jf_key'];
      if ($url === '') throw new UcError('Fill in the address first - like http://192.168.0.10:8096');
      if ($key === '') throw new UcError('Fill in the API key first');
      $info = (array)uc_jf_req($url, $key, 'GET', 'System/Info');
      $users = array_values(array_map(fn($u) => ['id' => (string)$u['Id'], 'name' => (string)$u['Name'], 'admin' => !empty($u['Policy']['IsAdministrator'])], array_filter((array)uc_jf_req($url, $key, 'GET', 'Users'), fn($u) => !empty($u['Id']))));
      uc_json(['ok' => true, 'name' => (string)($info['ServerName'] ?? ''), 'product' => (string)($info['ProductName'] ?? (isset($info['Version']) ? 'Jellyfin/Emby' : '')), 'version' => (string)($info['Version'] ?? ''), 'users' => $users]);
    }
    /* Send to… > Jellyfin / Emby: each song found in its library by its path (as the server sees it), then the
     * playlist made - one with the same name is replaced once the new one is there */
    case 'jf_send': {
      $p = uc_pl_prefs(); $url = (string)$p['jf_url']; $key = (string)$p['jf_key']; $user = (string)$p['jf_user'];
      if ($url === '' || $key === '') throw new UcError('Fill in the address and API key, then Test');
      if ($user === '') throw new UcError('Pick whose playlist it is (Test, then the user)');
      $name = trim((string)arg('name')); if ($name === '') throw new UcError('Give the playlist a name');
      $want = array_map('strval', arg_list('paths'));
      @set_time_limit(300);
      $ids = []; $start = 0;
      do {
        $r = (array)uc_jf_req($url, $key, 'GET', "Items?Recursive=true&IncludeItemTypes=Audio&Fields=Path&EnableImages=false&EnableUserData=false&StartIndex=$start&Limit=5000&UserId=" . rawurlencode($user));
        foreach ((array)($r['Items'] ?? []) as $it) if (!empty($it['Path'])) $ids[(string)$it['Path']] = (string)$it['Id'];
        $start += 5000;
      } while ($start < (int)($r['TotalRecordCount'] ?? 0) && $start < 200000);
      $found = []; $miss = 0;
      foreach ($want as $w) { if (isset($ids[$w])) $found[] = $ids[$w]; else $miss++; }
      if (!$found) throw new UcError('None of the songs are in its library under those paths - check "inside its container"' . ($ids ? ' (it has songs like ' . array_key_first($ids) . ')' : ''));
      $old = array_values(array_filter((array)(uc_jf_req($url, $key, 'GET', 'Items?Recursive=true&IncludeItemTypes=Playlist&UserId=' . rawurlencode($user))['Items'] ?? []), fn($x) => ($x['Name'] ?? '') === $name));
      $made = (array)uc_jf_req($url, $key, 'POST', 'Playlists?Name=' . rawurlencode($name) . '&UserId=' . rawurlencode($user) . '&MediaType=Audio&Ids=' . implode(',', array_slice($found, 0, 100)),
        ['Name' => $name, 'UserId' => $user, 'MediaType' => 'Audio', 'Ids' => array_slice($found, 0, 100)]);
      $pid = (string)($made['Id'] ?? ''); if ($pid === '') throw new UcError("The playlist wasn't made");
      foreach (array_chunk(array_slice($found, 100), 100) as $part) uc_jf_req($url, $key, 'POST', "Playlists/$pid/Items?UserId=" . rawurlencode($user) . '&Ids=' . implode(',', $part));
      foreach ($old as $o) if (($o['Id'] ?? '') !== $pid) { try { uc_jf_req($url, $key, 'DELETE', 'Items/' . rawurlencode((string)$o['Id'])); } catch (Throwable $e) {} }
      uc_json(['ok' => true, 'songs' => count($found), 'missing' => $miss, 'replaced' => (bool)$old]);
    }
    case 'plex_send': {
      $p = uc_pl_prefs();
      $url = rtrim((string)$p['plex_url'], '/'); $tok = (string)$p['plex_token'];
      if ($url === '' || $tok === '') throw new UcError("Plex's address and token are needed - fill them in, then save again");
      $get = function (string $u, string $method = 'GET', ?string $body = null) use ($tok) {
        $ch = curl_init($u . (str_contains($u, '?') ? '&' : '?') . 'X-Plex-Token=' . rawurlencode($tok));
        curl_setopt_array($ch, [CURLOPT_RETURNTRANSFER => true, CURLOPT_CONNECTTIMEOUT => 6, CURLOPT_TIMEOUT => 60, CURLOPT_CUSTOMREQUEST => $method,
          CURLOPT_HTTPHEADER => ['Accept: application/json'], CURLOPT_SSL_VERIFYPEER => false, CURLOPT_SSL_VERIFYHOST => 0]);
        if ($body !== null) curl_setopt($ch, CURLOPT_POSTFIELDS, $body);
        $raw = curl_exec($ch); $code = (int)curl_getinfo($ch, CURLINFO_HTTP_CODE); $err = curl_error($ch); curl_close($ch);
        if ($raw === false) throw new UcError("Can't reach Plex at " . preg_replace('/\?.*/', '', $u) . " ($err)");
        if ($code === 401) throw new UcError('Plex refused the token (401) - copy it again');
        if ($code >= 400) throw new UcError("Plex answered with error $code");
        return json_decode((string)$raw, true) ?: [];
      };
      $secs = $get("$url/library/sections");
      $music = array_values(array_filter((array)($secs['MediaContainer']['Directory'] ?? []), fn($d) => ($d['type'] ?? '') === 'artist'));
      if (!$music) throw new UcError('Plex has no music library');
      $want = (string)arg('section', '');
      $sec = $music[0];
      foreach ($music as $d) if ((string)($d['key'] ?? '') === $want) $sec = $d;
      /* Plex reads the playlist file itself, so it needs the file's path as Plex sees it, inside its container.
       * Saved in a folder Plex doesn't have (like a Playlists folder outside the music): a copy goes for a moment
       * into a hidden folder in the music folder Plex has, and is taken away again once Plex has read it. */
      $cpath = (string)arg('path'); $file = (string)arg('file', ''); $stage = '';
      if ($file !== '') {
        $file = uc_path($file);
        $maps = uc_docker_maps('/plex/i');
        usort($maps, fn($a, $b) => strlen($b['host']) <=> strlen($a['host']));
        if ($maps) {
          $cpath = ''; $use = null;
          foreach ($maps as $m) if (str_starts_with($file, $m['host'] . '/')) { $use = $m; break; }
          if ($use && preg_match('/\.m3u$/i', $file)) $cpath = $use['container'] . substr($file, strlen($use['host']));
          else {
            /* Plex reads .m3u for sure (an .m3u8 isn't documented), and only from its own folders:
             * hand it a short-lived .m3u copy in a hidden folder of a folder it has */
            if (!$use) {
              $first = '';
              foreach (preg_split('/\r\n|\r|\n/', (string)@file_get_contents($file)) as $l) { $l = trim($l); if ($l !== '' && $l[0] !== '#') { $first = $l; break; } }
              $byC = $maps; usort($byC, fn($a, $b) => strlen($b['container']) <=> strlen($a['container']));
              foreach ($byC as $m) if ($first !== '' && str_starts_with($first, $m['container'] . '/') && is_dir($m['host'])) { $use = $m; break; }
            }
            if ($use) {
              $dir = $use['host'] . '/.uncommander-plex'; @mkdir($dir, 0777, true);
              $name = pathinfo($file, PATHINFO_FILENAME) . '.m3u';
              $stage = "$dir/$name";
              if (!@copy($file, $stage)) throw new UcError("Couldn't put a copy where Plex can read it ($dir)");
              $cpath = $use['container'] . '/.uncommander-plex/' . $name;
              register_shutdown_function(function () use ($stage, $dir) { @unlink($stage); @rmdir($dir); });
            }
          }
          if ($cpath === '') throw new UcError("Plex can't see the folder the playlist was saved in, and its songs aren't in a folder Plex has either - check \"On this server\" and \"Inside Plex's container\"");
        }
      }
      /* saving it again replaces it: once Plex has made the new one, its old playlist of the same name goes, so there's never a second copy
       * (and if Plex couldn't make the new one, the old one is still there) */
      $title = pathinfo($cpath, PATHINFO_FILENAME); $replaced = false;
      $sameName = fn() => array_values(array_map(fn($m) => (string)$m['ratingKey'], array_filter((array)($get("$url/playlists?playlistType=audio")['MediaContainer']['Metadata'] ?? []), fn($m) => ($m['title'] ?? '') === $title && !empty($m['ratingKey']))));
      $old = $sameName();
      $get("$url/playlists/upload?sectionID=" . rawurlencode((string)$sec['key']) . '&path=' . rawurlencode($cpath), 'POST');
      /* did Plex take it? (it answers OK even when it couldn't read the file) */
      $found = false; $new = [];
      for ($i = 0; $i < 6 && !$found; $i++) {
        if ($i) usleep(700000);
        $now = $sameName(); $new = array_values(array_diff($now, $old));
        $found = $new || ($old && $now);      // a new one - or Plex updated the old one in place
        if ($old && !$new && $i < 3) $found = false;    // give a new one a moment to show up
      }
      if ($new && $old) { foreach ($old as $k) $get("$url/playlists/" . rawurlencode($k), 'DELETE'); $replaced = true; }
      elseif ($old && !$new) $replaced = true;
      if (!$found) throw new UcError("Plex didn't make the playlist - it couldn't read $cpath. Check that \"Inside Plex's container\" is the folder Plex knows your music by (in Plex's Docker settings)");
      /* a poster for it: a picture on this server, or the cover of an album */
      /* the poster is remembered per playlist, so a later Save (which replaces the playlist) puts it back */
      $poster = (string)arg('poster', ''); $posterOk = null;
      $pp = uc_pl_prefs(); $posters = (array)($pp['posters'] ?? []);
      if ($poster === '') $poster = (string)($posters[$title] ?? '');
      elseif (($posters[$title] ?? '') !== $poster) { $posters[$title] = $poster; $pp['posters'] = array_slice($posters, -200, null, true); uc_pl_prefs_save($pp); }
      if ($poster !== '') {
        $img = ''; $tmp = '';
        try {
          if (str_starts_with($poster, 'album:')) {
            $d = uc_path(substr($poster, 6));
            [$pic, $song] = uc_dir_cover($d);
            if ($pic) $img = $pic;
            elseif ($song && ($ff = uc_ffmpeg())) { @mkdir(UC_STATE . '/put', 0700, true); $tmp = UC_STATE . '/put/poster-' . bin2hex(random_bytes(4)) . '.jpg';
              exec('timeout 20 ' . escapeshellarg($ff) . ' -hide_banner -loglevel error -nostdin -i ' . escapeshellarg(uc_direct($song)) . ' -map 0:v:0 -frames:v 1 -y ' . escapeshellarg($tmp) . ' 2>&1'); if (is_file($tmp)) $img = $tmp; }
          } else { $img = uc_path($poster); if (!is_file($img) || !preg_match('/\.(jpe?g|png|webp)$/i', $img)) throw new UcError('The poster has to be a JPG, PNG or WebP picture'); }
          if (!$img) throw new UcError('That album has no cover to use');
          /* Plex names the playlist after the file; find it (newest first) */
          $key = '';
          for ($i = 0; $i < 6 && !$key; $i++) {
            if ($i) usleep(700000);
            foreach ((array)($get("$url/playlists?playlistType=audio")['MediaContainer']['Metadata'] ?? []) as $m) if (($m['title'] ?? '') === $title) { $key = (string)$m['ratingKey']; break; }
          }
          if (!$key) throw new UcError("Plex took the playlist, but it couldn't be found to give it the poster");
          $get("$url/library/metadata/" . rawurlencode($key) . '/posters', 'POST', (string)file_get_contents($img));
          $posterOk = true;
        } catch (UcError $e) { $posterOk = $e->getMessage(); }
        finally { if ($tmp) @unlink($tmp); }
      }
      uc_json(['ok' => true, 'library' => $sec['title'] ?? '', 'poster' => $posterOk, 'replaced' => $replaced]);
    }
    case 'kf': {
      $p = uc_path(arg('path')); $t = max(0, (float)arg('t', '0'));
      $ff = uc_ffmpeg();
      if (!$ff || $t < 0.5) uc_json(['t' => $t]);
      exec('timeout 15 ' . escapeshellarg($ff) . ' -hide_banner -loglevel error -nostdin -copyts -ss ' . sprintf('%.2f', $t) . ' -i ' . escapeshellarg(uc_direct($p)) . ' -map 0:v:0 -c copy -frames:v 1 -f framecrc - 2>/dev/null', $out);
      $tb = 1 / 1000; $pts = null;
      foreach ($out as $line) {
        if (preg_match('/^#tb 0: (\d+)\/(\d+)/', $line, $m)) $tb = $m[1] / $m[2];
        elseif (preg_match('/^0,\s*(-?\d+),\s*(-?\d+),/', $line, $m)) { $pts = (int)$m[2] * $tb; break; }
      }
      uc_json(['t' => $pts !== null && $pts <= $t + 0.5 ? max(0, $pts) : $t]);
    }
    case 'subs_prep': {
      $p = uc_path(arg('path'));
      $ff = uc_ffmpeg();
      if (!$ff) { uc_ff_start(); throw new UcError('Subtitles need ffmpeg - unCommander is getting it now (58 MB, once). Try again in a minute.'); }
      $i = arg('i', ''); $x = arg('ext', '');
      $srcf = $x !== '' ? uc_path($x) : uc_direct($p);
      $key = sha1($srcf . '|' . filemtime($srcf) . '|' . $i);
      $d = UC_STATE . '/subs'; @mkdir($d, 0700, true);
      $f = "$d/$key.vtt";
      if (!is_file($f) && !is_file("$f.run")) {
        touch("$f.run");
        $map = $x !== '' ? '' : ' -map 0:' . (int)$i;
        $sh = 'nice -n 10 ' . escapeshellarg($ff) . ' -hide_banner -loglevel error -nostdin -i ' . escapeshellarg($srcf) . $map . ' -f webvtt ' . escapeshellarg("$f.part") . ' && mv ' . escapeshellarg("$f.part") . ' ' . escapeshellarg($f) . '; rm -f ' . escapeshellarg("$f.run") . ' ' . escapeshellarg("$f.part");
        exec('setsid nohup bash -c ' . escapeshellarg($sh) . ' >/dev/null 2>&1 &');
      }
      uc_json(['key' => $key, 'ready' => is_file($f)]);
    }
    case 'subs_status': {
      $key = preg_replace('/[^0-9a-f]/', '', arg('key'));
      $f = UC_STATE . "/subs/$key.vtt";
      uc_json(['ready' => is_file($f), 'running' => is_file("$f.run"), 'text' => is_file($f) ? file_get_contents($f) : null]);
    }
    case 'ffmpeg_remove': {
      if ($g = uc_ff_gz()) @unlink($g); @unlink(UC_FF_BIN);
      uc_json(['ok' => true]);
    }

    /* Download: checks the items and hands back a ticket for the GET above */
    case 'dl_prep': {
      $paths = array_map('uc_path', arg_list('paths'));
      if (!$paths) throw new UcError('Nothing to download');
      foreach ($paths as $p) if (!file_exists($p)) throw new UcError(basename($p) . ' is no longer there');
      $one = count($paths) === 1 && is_file($paths[0]);
      $name = $one ? basename($paths[0]) : (count($paths) === 1 ? basename($paths[0]) : (basename(dirname($paths[0])) ?: 'files')) . '.zip';
      if (!$one && trim(arg('name', '')) !== '') $name = preg_replace('/(\.zip)?$/i', '.zip', basename(trim(arg('name'))), 1);
      foreach (glob(UC_STATE . '/dl-*.json') ?: [] as $f) if (filemtime($f) < time() - 3600) @unlink($f);
      $t = bin2hex(random_bytes(12));
      @mkdir(UC_STATE, 0700, true);
      file_put_contents(UC_STATE . "/dl-$t.json", json_encode(['kind' => $one ? 'file' : 'zip', 'paths' => $paths, 'name' => $name]));
      $size = 0; $files = 0;
      if ($one) { $size = filesize($paths[0]); $files = 1; }
      else { $l = uc_dl_plan($paths); foreach ($l as $f) { $size += $f['s']; $files += $f['d'] ? 0 : 1; } }
      uc_json(['ok' => true, 't' => $t, 'name' => $name, 'size' => $size, 'files' => $files, 'zip' => !$one]);
    }

    /* Upload from this computer (files dropped on a pane, or picked).
     * up_check: which of these are already there. up_begin -> up_part ... -> up_end:
     * the file is written next to where it goes as a hidden .part file (never in
     * memory), then renamed. One History step for the whole drop (join). */
    case 'up_check': {
      $dir = uc_path(arg('dir'));
      if (!is_dir($dir)) throw new UcError('That folder is no longer there');
      $have = [];
      foreach (array_slice(arg_list('rels'), 0, 50000) as $r) {
        $r = trim((string)$r, '/'); if ($r === '') continue;
        $p = $dir; foreach (explode('/', $r) as $seg) $p = uc_join($p, uc_name($seg));
        if (is_file($p)) $have[] = $r;
      }
      uc_json(['ok' => true, 'have' => $have]);
    }
    case 'up_begin': {
      $dir = uc_path(arg('dir'));
      if (!is_dir($dir)) throw new UcError('That folder is no longer there');
      $segs = array_map('uc_name', array_values(array_filter(explode('/', trim((string)arg('rel'), '/')), 'strlen')));
      if (!$segs) throw new UcError('Invalid name');
      $mode = arg('mode', 'skip');                         // skip | both | replace
      $made = [];
      $d = $dir;
      foreach (array_slice($segs, 0, -1) as $seg) {
        $d = uc_join($d, $seg);
        if (is_dir($d)) continue;
        if (file_exists($d)) throw new UcError("A file called $seg is in the way");
        if (!@mkdir($d, 0777)) throw new UcError("Couldn't make the folder $seg");
        @chown($d, 'nobody'); @chgrp($d, 'users');
        if (!$made) $made[] = $d;                           // the top new folder is enough for undo
      }
      $dest = uc_join($d, end($segs));
      $old = null;
      if (file_exists($dest)) {
        if ($mode === 'skip') uc_json(['ok' => true, 'skip' => true, 'made' => $made]);
        if ($mode === 'replace') { uc_practice_block('replacing files'); $old = $dest; }
        else { $nm = end($segs); $dot = strrpos($nm, '.'); $stem = $dot > 0 ? substr($nm, 0, $dot) : $nm; $ext = $dot > 0 ? substr($nm, $dot) : '';
               for ($k = 2; file_exists($dest = uc_join($d, "$stem ($k)$ext")); $k++); }
      }
      $id = bin2hex(random_bytes(8));
      $part = uc_join($d, ".$id.ucpart");
      if (@file_put_contents($part, '') === false) throw new UcError("Can't write in " . basename($d) . ' - check its permissions');
      @mkdir(UC_STATE . '/put', 0700, true);
      file_put_contents(UC_STATE . "/put/up-$id.json", json_encode(['part' => $part, 'dest' => $dest, 'old' => $old, 'made' => $made, 'size' => (int)arg('size', 0)]));
      uc_json(['ok' => true, 'id' => $id, 'made' => $made]);
    }
    case 'up_part': {
      $id = arg('id');
      if (!preg_match('/^[0-9a-f]{16}$/', $id) || !is_file($jf = UC_STATE . "/put/up-$id.json")) throw new UcError('That upload expired - drop the files again');
      $j = json_decode(file_get_contents($jf), true);
      $d = base64_decode((string)arg('data'), true);
      if ($d === false) throw new UcError('A piece got garbled on the way - try again');
      $fh = @fopen($j['part'], 'c'); if (!$fh) throw new UcError('The upload file went away');
      fseek($fh, (int)arg('off', 0)); fwrite($fh, $d); fclose($fh);
      uc_json(['ok' => true]);
    }
    case 'up_end': {
      $id = arg('id');
      if (!preg_match('/^[0-9a-f]{16}$/', $id) || !is_file($jf = UC_STATE . "/put/up-$id.json")) throw new UcError('That upload expired - drop the files again');
      $j = json_decode(file_get_contents($jf), true); @unlink($jf);
      clearstatcache();
      if (!is_file($j['part']) || filesize($j['part']) !== $j['size']) { @unlink($j['part']); throw new UcError(basename($j['dest']) . " didn't arrive whole - try again"); }
      $parts = [];
      if ($j['old'] && file_exists($j['old'])) { [, , $items] = uc_delete_paths([$j['old']]); $parts = $items; }
      if (file_exists($j['dest'])) { @unlink($j['part']); throw new UcError(basename($j['dest']) . ' appeared while uploading - try again'); }
      if (!@rename($j['part'], $j['dest'])) { @unlink($j['part']); throw new UcError("Couldn't save " . basename($j['dest'])); }
      if ($t = (int)arg('mtime', 0)) @touch($j['dest'], intdiv($t, 1000));
      @chown($j['dest'], 'nobody'); @chgrp($j['dest'], 'users'); @chmod($j['dest'], 0666);
      if (arg('under', '') === '') $parts[] = ['t' => 'made', 'p' => $j['dest']];   // inside a folder this drop made: undoing the folder is enough
      $out = ['ok' => true, 'path' => $j['dest'], 'name' => basename($j['dest'])];
      if (true) {
        foreach (arg_list('made') as $m) array_unshift($parts, ['t' => 'made', 'p' => uc_path($m)]);
        $join = arg('join', ''); $label = mb_substr(arg('label', 'Uploaded ' . basename($j['dest'])), 0, 160);
        $out['hist'] = $join !== '' ? uc_hist_append($join, $parts, $label) : uc_hist_add($label, $parts);
      }
      uc_json($out);
    }
    case 'up_cancel': {
      $id = arg('id');
      if (preg_match('/^[0-9a-f]{16}$/', $id) && is_file($jf = UC_STATE . "/put/up-$id.json")) { $j = json_decode(file_get_contents($jf), true); @unlink($j['part']); @unlink($jf); }
      uc_json(['ok' => true]);
    }

    /* Image editor: the edited picture is sent in pieces (base64 in ordinary form
     * posts), so PHP's upload size limits never get in the way. put_begin ->
     * put_part ... -> put_end, which saves it as a new file next to the original,
     * or replaces the original (the old one goes to the trash - one History step). */
    case 'put_begin': {
      $dir = UC_STATE . '/put';
      @mkdir($dir, 0700, true);
      foreach (glob("$dir/*") ?: [] as $f) if (filemtime($f) < time() - 86400) @unlink($f);   // leftovers from a closed tab
      $id = bin2hex(random_bytes(8));
      touch("$dir/$id");
      uc_json(['ok' => true, 'id' => $id]);
    }
    case 'put_part': {
      $id = arg('id');
      if (!preg_match('/^[0-9a-f]{16}$/', $id) || !is_file($f = UC_STATE . "/put/$id")) throw new UcError('That upload expired - save again');
      $d = base64_decode((string)arg('data'), true);
      if ($d === false) throw new UcError('The picture got garbled on the way - save again');
      if (filesize($f) + strlen($d) > 400 * 1048576) { @unlink($f); throw new UcError('That picture is too big to save from the browser (400 MB)'); }
      file_put_contents($f, $d, FILE_APPEND | LOCK_EX);
      uc_json(['ok' => true]);
    }
    case 'put_end': {
      $id = arg('id');
      if (!preg_match('/^[0-9a-f]{16}$/', $id) || !is_file($f = UC_STATE . "/put/$id")) throw new UcError('That upload expired - save again');
      try {
        if (@getimagesize($f) === false) throw new UcError("That isn't a picture");
        $src = uc_path(arg('path'));
        $replace = arg('mode') === 'replace';
        $name = uc_name(trim(arg('name')));
        $dest = uc_join(dirname($src), $name);
        $parts = [];
        if ($replace) {
          uc_practice_block('replacing pictures');
          if (!is_file($src)) throw new UcError('The original is no longer there');
          if ($dest !== $src && file_exists($dest)) throw new UcError("Something called $name is already there - pick another name");
          [, , $items] = uc_delete_paths([$src]);
          $parts = $items;
        } else {
          if (file_exists($dest)) {
            $dot = strrpos($name, '.'); $stem = $dot > 0 ? substr($name, 0, $dot) : $name; $ext = $dot > 0 ? substr($name, $dot) : '';
            for ($k = 2; file_exists($dest = uc_join(dirname($src), "$stem ($k)$ext")); $k++);
          }
        }
        if (!@copy($f, $dest)) throw new UcError("Couldn't write " . basename($dest));
        @chown($dest, 'nobody'); @chgrp($dest, 'users'); @chmod($dest, 0666);
        $parts[] = ['t' => 'made', 'p' => $dest];
        $label = arg('label', '') !== '' ? mb_substr(arg('label'), 0, 160)
          : ($replace ? 'Edited ' : 'Saved an edited copy of ') . basename($src) . ($replace && basename($dest) !== basename($src) ? ' (now ' . basename($dest) . ')' : ($replace ? '' : ' as ' . basename($dest)));
        $join = arg('join', '');
        $hist = $join !== '' ? uc_hist_append($join, $parts, $label) : uc_hist_add($label, $parts);
        $out = ['ok' => true, 'path' => $dest, 'name' => basename($dest), 'hist' => $hist];
      } finally { @unlink($f); }       // (uc_json exits, so it comes after the clean-up)
      uc_json($out);
    }

    /* Settings live on the flash drive, so they're the same on every device:
     * shortcut buttons, custom CSS, sounds, and trash retention. */
    case 'get_settings': {
      $restored = is_file(UC_STATE . '/lists-restored'); if ($restored) @unlink(UC_STATE . '/lists-restored');
      uc_json(['settings' => uc_settings(), 'restored' => $restored]);
    }
    case 'array_state': {
      uc_data_dir();             // a started array: lists from the flash drive move over (or come back from the copy) now
      $restored = is_file(UC_STATE . '/lists-restored'); if ($restored) @unlink(UC_STATE . '/lists-restored');
      uc_json(['up' => uc_array_up(), 'restored' => $restored]);
    }
    /* unCommander's folder: is this a good place? (the setup window and Settings) */
    case 'data_check': {
      $d = rtrim(trim((string)arg('path')), '/');
      if (!preg_match('#^/mnt/[^/]+/.+#', $d) || str_contains($d, '..')) uc_json(['ok' => false, 'msg' => 'Pick a folder on the array or a pool - under /mnt/user/ or /mnt/<pool>/']);
      if (preg_match('#^/mnt/(disks|remotes|addons|rootshare)/#', $d)) uc_json(['ok' => false, 'msg' => "Unassigned Devices drives and network shares can go away - pick a folder on the array or a pool"]);
      $up = uc_array_up();
      if (!$up) uc_json(['ok' => true, 'array' => false, 'msg' => "The array is stopped, so this can't be checked now - it will be used once the array starts"]);
      /* where it really is: which pool or disk holds it */
      $rel = preg_replace('#^/mnt/[^/]+/#', '', $d); $top = explode('/', $rel)[0]; $where = [];
      if (str_starts_with($d, '/mnt/user/')) { foreach (glob('/mnt/*', GLOB_ONLYDIR) ?: [] as $m) { $b = basename($m); if (in_array($b, ['user', 'user0', 'disks', 'remotes', 'addons', 'rootshare'], true)) continue; if (is_dir("$m/$top")) $where[] = $b; } }
      else $where[] = explode('/', substr($d, 5))[0];
      $arr = array_values(array_filter($where, fn($w) => preg_match('/^disk\d+$/', $w)));
      $par = $d; while (!is_dir($par) && $par !== '/mnt') $par = dirname($par);
      $ok = is_dir($d) ? is_writable($d) : is_writable($par);
      uc_json(['ok' => $ok, 'array' => true, 'exists' => is_dir($d), 'where' => $where, 'hdd' => (bool)$arr && count($arr) === count($where),
        'msg' => !$ok ? "unCommander can't write there" : ($where ? 'On ' . implode(', ', $where) . ($arr && count($arr) === count($where) ? ' - an array hard disk: it works, but saving History will spin that disk up. A pool (cache) is better if you have one.' : ' - a good place for it.') : 'A new folder - it will be made')]);
    }
    case 'data_set': {
      $d = rtrim(trim((string)arg('path')), '/');
      if (!preg_match('#^/mnt/[^/]+/.+#', $d) || str_contains($d, '..') || preg_match('#^/mnt/(disks|remotes|addons|rootshare)/#', $d)) throw new UcError('Pick a folder on the array or a pool');
      if (uc_array_up()) { if (!is_dir($d) && !@mkdir($d, 0777, true)) throw new UcError("Couldn't make $d"); if (!is_writable($d)) throw new UcError("unCommander can't write in $d"); }
      $f = dirname(UC_CFG) . '/settings.json'; @mkdir(dirname($f), 0777, true);
      $all = is_file($f) ? (json_decode((string)file_get_contents($f), true) ?: []) : [];
      $old = uc_hist_dir(); $all['hist_dir'] = $d === '/mnt/user/appdata/uncommander' ? '' : $d;
      if (!is_file($f)) $all['practice'] = true;        // a new install starts in Practice mode (nothing can be lost)
      file_put_contents("$f.tmp", json_encode($all, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE)); rename("$f.tmp", $f);
      if ($old !== $d) uc_data_move($old, $d);
      uc_json(['ok' => true, 'settings' => uc_settings()]);
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
        'collect' => !empty($in['collect']),
        'tree' => !empty($in['tree']),
        'vplay' => !empty($in['vplay']),
        'menu_show' => !empty($in['menu_show']),
        'palette' => uc_palette_clean($in['palette'] ?? null),
        'mythemes' => array_values(array_filter(array_map(fn($t) => is_array($t) && trim((string)($t['name'] ?? '')) !== '' ? ['name' => mb_substr(trim((string)$t['name']), 0, 40)] + uc_palette_clean($t) : null, is_array($in['mythemes'] ?? null) ? array_slice($in['mythemes'], 0, 30) : []))),
        'vsmooth' => !empty($in['vsmooth']),
        'vconv' => in_array($in['vconv'] ?? 'auto', ['auto', 'off', 'cpu', 'nvidia', 'vaapi'], true) ? $in['vconv'] : 'auto',
        'toolbtns' => ['movies' => !empty($in['toolbtns']['movies']), 'tv' => !empty($in['toolbtns']['tv']), 'tools' => !empty($in['toolbtns']['tools'])],
        'highlight' => !array_key_exists('highlight', $in) || !empty($in['highlight']),
        'autorefresh' => ['on' => !empty($in['autorefresh']['on']), 'secs' => in_array((int)($in['autorefresh']['secs'] ?? 10), [5, 10, 30, 60], true) ? (int)$in['autorefresh']['secs'] : 10],
        'radarr' => isset($in['radarr']) && is_array($in['radarr']) ? uc_radarr_clean($in['radarr'], uc_radarr_cfg()) : uc_radarr_cfg(),
        'sonarr' => isset($in['sonarr']) && is_array($in['sonarr']) ? uc_sonarr_clean($in['sonarr'], uc_sonarr_cfg()) : uc_sonarr_cfg(),
        'lidarr' => isset($in['lidarr']) && is_array($in['lidarr']) ? uc_lidarr_clean($in['lidarr'], uc_lidarr_cfg()) : uc_lidarr_cfg(),
        'trash' => !array_key_exists('trash', $in) || !empty($in['trash']),
        'notify_unraid' => !array_key_exists('notify_unraid', $in) || !empty($in['notify_unraid']),
        'player' => !array_key_exists('player', $in) || !empty($in['player']),
        'hist_dir' => (function ($d) { $d = rtrim(trim((string)$d), '/'); if ($d === '') return ''; if (!str_starts_with($d, '/mnt/') || str_contains($d, '..')) throw new UcError("unCommander's folder has to be on the array or a pool: a folder under /mnt/"); return $d; })($in['hist_dir'] ?? ''),
        'pldirs' => uc_pldirs_clean($in['pldirs'] ?? []),
        'uscripts' => uc_us_clean($in['uscripts'] ?? null),
        'sounds' => [
          'enabled' => !empty($snd['enabled']),
          'volume'  => max(0, min(100, (int)($snd['volume'] ?? 40))),
          'buttons' => !empty($snd['buttons']), 'nav' => !empty($snd['nav']),
          'taps' => !empty($snd['taps']), 'errors' => !empty($snd['errors']),
        ],
      ];
      @mkdir(dirname(UC_CFG), 0777, true);
      $f = dirname(UC_CFG) . '/settings.json';
      $oldDir = uc_hist_dir();
      file_put_contents("$f.tmp", json_encode($out, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE));
      rename("$f.tmp", $f);
      if (isset($in['trash_days'])) {
        $days = max(0, min(3650, (int)$in['trash_days']));
        $cfg = is_file(UC_CFG) ? file_get_contents(UC_CFG) : '';
        $cfg = preg_match('/^TRASH_DAYS=.*$/m', $cfg) ? preg_replace('/^TRASH_DAYS=.*$/m', "TRASH_DAYS=\"$days\"", $cfg) : rtrim($cfg) . ($cfg ? "\n" : '') . "TRASH_DAYS=\"$days\"\n";
        file_put_contents(UC_CFG, $cfg);
      }
      if (($out['hist_dir'] ?: '/mnt/user/appdata/uncommander') !== $oldDir) uc_data_move($oldDir, $out['hist_dir'] ?: '/mnt/user/appdata/uncommander');
      uc_apply_menu_name($out['menu_name'], $out['menu_show']);
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
        $hparts = array_map(fn($r) => ['t' => 'copy', 'b' => "$dest/$r", 'rel' => $r, 'job' => $job['id'], 's' => 'w'], $rel);
        $join = (string)arg('hist_join', '');
        $job['hist'] = preg_match('/^[a-f0-9]{10}$/', $join)
          ? uc_hist_append($join, $hparts, 'Compare copy both ways: ' . basename($dest) . ' ⇄ ' . basename($root))
          : uc_hist_add('Compare copy: ' . (count($rel) === 1 ? basename($rel[0]) : count($rel) . ' items') . ' to ' . $dest, $hparts);
        uc_job_write($job);
        uc_job_touch($job['id']);
        $php = PHP_BINARY && !str_contains(PHP_BINARY, 'fpm') ? PHP_BINARY : 'php';
        exec('setsid nohup ' . escapeshellarg($php) . ' -d memory_limit=1024M ' . escapeshellarg(__DIR__ . '/worker.php') . ' ' . escapeshellarg($job['id']) . ' >/dev/null 2>&1 &');
        uc_json(['ok' => true, 'job' => $job['id'], 'hist' => $job['hist']]);
      }
      if ($type === 'move') uc_practice_block('moving');
      if ($type === 'perms') uc_practice_block('changing permissions');
      $sources = array_map('uc_path', arg_list('sources'));
      $arcSrc = array_map(fn($x) => is_dir($x) || is_file($x) ? null : uc_arc_split($x), $sources);
      if (array_filter($arcSrc)) {
        if ($type !== 'copy') throw new UcError("That's inside an archive, which unCommander opens read-only - nothing in it can be moved, changed or deleted. Copy it out instead (F5).");
        if (count(array_filter($arcSrc)) !== count($sources)) throw new UcError('Copy what is inside the archive on its own - not together with other files');
        $a = $arcSrc[0][0]; $par = dirname('/' . $arcSrc[0][1]);
        foreach ($arcSrc as $x) if ($x[0] !== $a || dirname('/' . $x[1]) !== $par) throw new UcError('Copy items from one folder of the archive at a time');
        $dest = uc_path(arg('dest'));
        if (!is_dir($dest)) throw new UcError(uc_arc_split($dest) ? "Nothing can be copied into an archive - it's read-only" : "Destination isn't a folder");
        $st = uc_arc_index($a, 20);
        if (($st['state'] ?? '') === 'password') throw new UcError('This archive needs its password');
        if (($st['state'] ?? '') !== 'ready') throw new UcError($st['error'] ?? 'The archive is still being read - try again in a moment');
        $files = []; $edirs = []; $total = 0; $members = [];
        foreach ($arcSrc as [, $inner]) {
          $it = uc_arc_item($st['key'], $inner);
          if (!$it) throw new UcError(basename($inner) . ' is no longer in the archive');
          $members[] = $inner;
          if ($it[1]) { $f0 = count($files); uc_arc_walk($st['key'], $inner, $files, $edirs); }
          else { $files[] = $it[4] ?? $inner; $total += (int)$it[2]; }
        }
        /* sizes of what's in the folders, for the progress bar */
        foreach ($members as $m) { $it = uc_arc_item($st['key'], $m); if ($it && $it[1]) { $q = [$m]; while ($q) { $d = array_pop($q); foreach (uc_arc_rows($st['key'], $d) ?? [] as $r) { $pth = "$d/{$r[0]}"; if ($r[1]) $q[] = $pth; else $total += (int)$r[2]; } } } }
        $ex = arg('exists', 'skip') === 'skip' ? 'skip' : 'overwrite';
        if ($ex !== 'skip') uc_practice_block('replacing existing files');
        $what = count($members) === 1 ? basename($members[0]) : count($members) . ' items';
        $job = ['id' => bin2hex(random_bytes(6)), 'type' => 'extract', 'sources' => [$a], 'kind' => uc_archive_kind($a), 'target' => $dest, 'dest' => $dest, 'made' => false,
                'exists' => $ex, 'remove' => false, 'members' => $members, 'afiles' => $files, 'edirs' => $edirs, 'akey' => $st['key'], 'total' => $total,
                'state' => 'queued', 'created' => time(), 'pct' => 0, 'bytes' => 0, 'speed' => '', 'eta' => '', 'file' => '', 'error' => null,
                'label' => "Copy $what out of " . basename($a) . " → $dest", 'hlabel' => "Copied $what out of " . basename($a) . " to $dest"];
        uc_job_write($job);
        uc_job_touch($job['id']);
        $php = PHP_BINARY && !str_contains(PHP_BINARY, 'fpm') ? PHP_BINARY : 'php';
        exec('setsid nohup ' . escapeshellarg($php) . ' -d memory_limit=1024M ' . escapeshellarg(__DIR__ . '/worker.php') . ' ' . escapeshellarg($job['id']) . ' >/dev/null 2>&1 &');
        uc_json(['ok' => true, 'job' => $job['id'], 'moved' => [], 'hist' => null]);
      }
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
        /* optional new names (Paste "Keep both"): one per source, '' = keep the name */
        $as = [];
        if (array_key_exists('as', $req)) foreach (arg_list('as') as $k => $n) { $n = trim((string)$n); $as[$k] = $n === '' ? '' : uc_name($n); }
        $nameOf = fn($k, $s) => ($as[$k] ?? '') !== '' ? $as[$k] : basename($s);
        foreach ($sources as $k => $s) {
          if (dirname($s) === $dest && $nameOf($k, $s) === basename($s)) throw new UcError('Source and destination are the same folder');
          if ($dest === $s || str_starts_with($dest . '/', $s . '/')) throw new UcError("Can't put " . basename($s) . ' inside itself');
        }
        if ($as) { foreach ($sources as $k => $s) if ($nameOf($k, $s) !== basename($s) && file_exists(uc_join($dest, $nameOf($k, $s)))) throw new UcError($nameOf($k, $s) . ' already exists there'); $job['as'] = array_map(fn($k) => $as[$k] ?? '', array_keys($sources)); }
        /* optional left-outs (a collected folder with some of its contents unticked): one list per source */
        $excl = [];
        if (array_key_exists('excl', $req)) foreach (arg_list('excl') as $k => $list) {
          $clean = [];
          foreach ((array)$list as $r) { $r = trim((string)$r, '/'); if ($r === '' || str_contains($r, "\0") || in_array('..', explode('/', $r), true) || in_array('.', explode('/', $r), true)) continue; $clean[] = $r; }
          if ($clean) $excl[$k] = $clean;
        }
        if ($excl) $job['excl'] = array_map(fn($k) => $excl[$k] ?? [], array_keys($sources));
        $join = (string)arg('hist_join', '');
        $given = trim(preg_replace('/[\x00-\x1f]+/', ' ', (string)arg('label', '')));
        $hadd = function ($label, $parts) use ($join, $given) {
          if ($given !== '') $label = mb_substr($given, 0, 160);
          return preg_match('/^[a-f0-9]{10}$/', $join) ? uc_hist_append($join, $parts, $label) : uc_hist_add($label, $parts);
        };
        $ex = arg('exists', 'skip');
        $job['dest'] = $dest;
        $job['exists'] = in_array($ex, ['skip', 'overwrite', 'newer'], true) ? $ex : 'skip';
        if ($job['exists'] !== 'skip') uc_practice_block('replacing existing files');

        $what = count($sources) === 1 ? basename($sources[0]) : count($sources) . ' items';
        if ($type === 'move') {
          /* Same filesystem → rename(), instant. Only the leftovers need rsync. */
          $left = []; $leftAs = []; $leftEx = []; $moved = []; $parts = [];
          foreach ($sources as $k => $s) {
            $t = uc_join($dest, $nameOf($k, $s));
            $ss = @stat($s); $ds = @stat($dest);
            if (empty($excl[$k]) && !file_exists($t) && $ss && $ds && $ss['dev'] === $ds['dev'] && @rename($s, $t)) { $moved[] = [$s, $t]; $parts[] = ['t' => 'move', 'a' => $s, 'b' => $t]; continue; }
            $left[] = $s; $leftAs[] = $as[$k] ?? ''; $leftEx[] = $excl[$k] ?? [];
          }
          /* a folder moved without some of its contents (they stay behind): undone file by file, like a merge */
          foreach ($left as $k => $s) { $t = uc_join($dest, $leftAs[$k] !== '' ? $leftAs[$k] : basename($s)); $parts[] = ['t' => 'move', 'a' => $s, 'b' => $t, 'job' => $job['id'], 's' => 'w'] + (file_exists($t) || is_link($t) || $leftEx[$k] ? ['merged' => true] : []); }
          $hid = $hadd("Moved $what to $dest", $parts);
          if (!$left) uc_json(['ok' => true, 'instant' => true, 'moved' => $moved, 'hist' => $hid]);
          $job['hist'] = $hid;
          $job['moved'] = $moved;
          $job['sources'] = $sources = $left;
          if ($as) $job['as'] = $leftAs;
          if ($excl) $job['excl'] = $leftEx;
        } else {
          $job['hist'] = $hadd("Copied $what to $dest", array_map(fn($k) => ['t' => 'copy', 'b' => uc_join($dest, $nameOf($k, $sources[$k])), 'rel' => $nameOf($k, $sources[$k]), 'job' => $job['id'], 's' => 'w'], array_keys($sources)));
        }
        $job['label'] = ($type === 'copy' ? 'Copy ' : 'Move ') . count($sources) . ' item' . (count($sources) > 1 ? 's' : '') . ' → ' . $dest;
      }
      if ($type === 'compress') $job['hist'] = uc_hist_add('Compressed ' . (count($sources) === 1 ? basename($sources[0]) : count($sources) . ' items') . ' into ' . basename($job['out']),
        [['t' => 'made', 'p' => $job['out'], 'job' => $job['id'], 's' => 'w']]);
      if ($type === 'extract') $job['hist'] = uc_hist_add('Extracted ' . basename($sources[0]) . ' to ' . $job['target'],
        [$job['made'] ? ['t' => 'made', 'p' => $job['target'], 'job' => $job['id'], 's' => 'w'] : ['t' => 'into', 'p' => $job['target'], 'job' => $job['id'], 's' => 'w']]);

      uc_job_write($job);
      uc_job_touch($job['id']);        // the page opens its progress window for it straight away
      $php = PHP_BINARY && !str_contains(PHP_BINARY, 'fpm') ? PHP_BINARY : 'php';
      exec('setsid nohup ' . escapeshellarg($php) . ' -d memory_limit=1024M ' . escapeshellarg(__DIR__ . '/worker.php')
           . ' ' . escapeshellarg($job['id']) . ' >/dev/null 2>&1 &');
      uc_json(['ok' => true, 'job' => $job['id'], 'moved' => $job['moved'] ?? [], 'hist' => $job['hist'] ?? null]);
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
    case 'lidarr_test': {
      $in = arg('lidarr', []); if (is_string($in)) $in = json_decode($in, true) ?: [];
      $c = uc_lidarr_clean((array)$in, uc_lidarr_cfg());
      $status = uc_lidarr_req($c, 'GET', 'system/status');
      if (!is_array($status) || empty($status['version'])) throw new UcError("That address answered, but it doesn't look like Lidarr");
      $profiles = array_map(fn($p) => ['id' => $p['id'], 'name' => $p['name']], (array)uc_lidarr_req($c, 'GET', 'qualityprofile'));
      $metas = array_map(fn($p) => ['id' => $p['id'], 'name' => $p['name']], (array)uc_lidarr_req($c, 'GET', 'metadataprofile'));
      $mounts = uc_lidarr_mounts(); $roots = [];
      foreach ((array)uc_lidarr_req($c, 'GET', 'rootfolder') as $r) {
        $rp = rtrim($r['path'] ?? '', '/') ?: '/';
        $host = null; $len = -1;
        foreach ($mounts as $dst => $src) if (($rp === $dst || str_starts_with($rp . '/', $dst . '/')) && strlen($dst) > $len) { $host = $src . substr($rp, strlen($dst)); $len = strlen($dst); }
        $saved = null; foreach ($c['map'] as $m) if ($m['lidarr'] === $rp) $saved = $m['host'];
        $roots[] = ['lidarr' => $rp, 'host' => $saved ?? $host, 'detected' => $host];
      }
      uc_json(['ok' => true, 'version' => $status['version'], 'name' => $status['instanceName'] ?? 'Lidarr', 'profiles' => $profiles, 'metas' => $metas, 'roots' => $roots]);
    }
    /* Ask Lidarr for an album (Music library check): the work runs on its own (scripts/lidarr-ask.php) */
    case 'lidarr_ask': case 'lidarr_pick': {
      uc_practice_block('asking Lidarr');
      $c = uc_lidarr_cfg(); if (!uc_lidarr_public($c)['ok']) throw new UcError('Set up Lidarr first: Settings > Tools > Lidarr (address, API key, profiles)');
      $p = uc_path(rtrim((string)arg('path'), '/'));
      $artist = uc_path(rtrim((string)arg('artist', dirname($p)), '/'));
      if (uc_lidarr_path($c, $artist) === null) throw new UcError("Lidarr doesn't see " . $artist . ' - add a folder pair in Settings > Tools > Lidarr');
      $v = $action === 'lidarr_pick' ? ['pick' => (int)arg('id'), 'state' => 'start', 'msg' => 'Starting…', 'choices' => null]
        : ['artist' => $artist, 'artist_name' => (string)arg('artist_name', ''), 'album' => (string)arg('album', ''), 'year' => (string)arg('year', ''), 'want' => (int)arg('want', 0), 'pick' => 0, 'state' => 'start', 'msg' => 'Starting…', 'choices' => null, 'rels' => null, 'why' => '', 'found' => null, 'grabbed' => null, 'asked' => time()];
      $job = uc_lidarr_job_set($p, $v);
      $php = is_executable('/usr/bin/php') ? '/usr/bin/php' : 'php';
      exec('setsid nohup ' . escapeshellarg($php) . ' ' . escapeshellarg(UC_DIR . '/scripts/lidarr-ask.php') . ' ' . escapeshellarg(base64_encode($p)) . ' >/dev/null 2>&1 &');
      uc_json(['ok' => true, 'job' => $job]);
    }
    /* ---------- Clean up ---------- */
    case 'clean_scan': {
      @set_time_limit(300);
      $out = [];
      foreach (uc_clean_parts() as $k => [$label, $about, $paths]) {
        $n = $k === 'hist' ? count(uc_hist_read()['steps'] ?? []) : count($paths);
        $out[] = ['key' => $k, 'label' => $label, 'about' => $about, 'bytes' => uc_du($paths, $k === 'trash' ? 120 : 30), 'n' => $n,
          'where' => $k === 'trash' ? $paths : null];
      }
      uc_json(['ok' => true, 'items' => $out]);
    }
    case 'clean_run': {
      @set_time_limit(0);
      $keys = arg_list('keys'); $parts = uc_clean_parts(); $freed = 0; $done = [];
      if (in_array('trash', $keys, true) && uc_settings()['practice']) throw new UcError('Practice mode is on - emptying the trash is locked');
      foreach ($keys as $k) {
        if (!isset($parts[$k])) continue;
        $paths = $parts[$k][2]; $before = uc_du($paths, 120);
        switch ($k) {
          case 'trash': exec('bash ' . escapeshellarg(__DIR__ . '/../scripts/purge-trash') . ' --all >/dev/null 2>&1'); break;
          case 'hist': $l = uc_hist_lock(); uc_hist_write(['v' => 1, 'steps' => []]); flock($l, LOCK_UN); break;
          case 'lists':
            /* Lidarr: only the finished ones - albums still being looked for stay */
            $jf = uc_lidarr_jobs_file();
            if (is_file($jf)) { $keep = array_filter(uc_lidarr_jobs(), fn($j) => in_array($j['state'] ?? '', ['start', 'adding', 'waiting', 'searching', 'pick'], true));
              $keep ? file_put_contents($jf, json_encode($keep, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE)) : @unlink($jf); }
            foreach ($paths as $f) if ($f !== $jf) @unlink($f);
            break;
          case 'left': foreach ($paths as $f) if (str_contains(basename($f), 'hls-')) uc_stream_stop(substr(basename($f), 4)); else exec('rm -rf ' . escapeshellarg($f)); break;
          default: foreach ($paths as $f) exec('rm -rf ' . escapeshellarg($f));
        }
        clearstatcache();
        $after = uc_du(array_values(array_filter($paths, 'file_exists')), 120);
        $freed += max(0, $before - $after); $done[] = $parts[$k][0];
      }
      if (in_array('cache', $keys, true)) @mkdir(UC_STATE . '/thumbs', 0700, true);
      uc_json(['ok' => true, 'freed' => $freed, 'done' => $done]);
    }
    /* ---------- User Scripts ---------- */
    case 'us_list': {
      uc_json(['ok' => true, 'scripts' => uc_us_list(), 'order' => uc_settings()['uscripts']]);
    }
    case 'us_order': {       // the scripts the button shows, in order - kept in settings.json
      $f = dirname(UC_CFG) . '/settings.json'; $all = is_file($f) ? (json_decode((string)file_get_contents($f), true) ?: []) : [];
      $all['uscripts'] = arg('reset', '') === '1' ? null : uc_us_clean(arg_list('order'));
      file_put_contents("$f.tmp", json_encode($all, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE)); rename("$f.tmp", $f);
      uc_json(['ok' => true, 'order' => $all['uscripts']]);
    }
    case 'us_run': {
      uc_practice_block('running scripts');
      $id = (string)arg('id'); if ($id === '' || str_contains($id, '/') || $id[0] === '.') throw new UcError('Bad script');
      $src = UC_US_DIR . "/$id/script"; if (!is_file($src)) throw new UcError('That script is no longer there');
      $v = uc_us_vars($src); $bg = arg('bg', '') === '1';
      $var = @parse_ini_file('/var/local/emhttp/var.ini') ?: [];
      if (!empty($v['arrayStarted']) && ($var['mdState'] ?? '') !== 'STARTED') throw new UcError('This script only runs while the array is started');
      if (!empty($v['noParity']) && !empty($var['mdResyncPos'])) throw new UcError('This script doesn\'t run during a parity check or rebuild');
      if ($bg && !empty($v['foregroundOnly'])) throw new UcError('This script can only run in a window (foregroundOnly)');
      if (!$bg && !empty($v['backgroundOnly'])) throw new UcError('This script can only run in the background (backgroundOnly)');
      if ($bg && uc_us_running($id)) throw new UcError('It is already running in the background');
      /* arguments: as User Scripts does it - words split on spaces */
      $args = array_values(array_filter(preg_split('/\s+/', trim((string)arg('args', ''))), 'strlen'));
      $dir = UC_US_TMP . "/tmpScripts/$id"; @mkdir($dir, 0777, true); foreach (['running', 'finished'] as $d) @mkdir(UC_US_TMP . "/$d", 0777, true);
      $code = str_replace("\r", '', (string)file_get_contents($src));
      if (!str_starts_with($code, '#!')) $code = "#!/bin/bash\n" . $code;
      file_put_contents("$dir/script", $code); chmod("$dir/script", 0755);
      $run = escapeshellarg("$dir/script") . ($args ? ' ' . implode(' ', array_map('escapeshellarg', $args)) : '');
      $home = 'export HOME=$(grep "^$(whoami):" /etc/passwd | cut -d: -f6); [ -f "$HOME/.bashrc" ] && . "$HOME/.bashrc"; ';
      if ($bg) {
        $log = "$dir/log.txt"; if (!empty($v['clearLog'])) @unlink($log);
        $L = escapeshellarg($log); $R = escapeshellarg(UC_US_TMP . "/running/$id"); $F = escapeshellarg(UC_US_TMP . "/finished/$id");
        $sh = $home . "echo \"Script Starting \$(date '+%b %d, %Y  %H:%M.%S')\" >> $L; echo >> $L; echo \$\$ > $R; rm -f $F; $run >> $L 2>&1; "
          . "echo \"Script Finished \$(date '+%b %d, %Y  %H:%M.%S')\" >> $L; echo >> $L; rm -f $R; echo finished > $F";
        exec('setsid nohup bash -c ' . escapeshellarg($sh) . ' >/dev/null 2>&1 &');
        for ($i = 0; $i < 10 && !uc_us_running($id); $i++) usleep(100000);      // so the list shows it running
        uc_json(['ok' => true, 'bg' => true]);
      }
      /* in a window: the output goes to a file the page reads as it grows */
      $rid = bin2hex(random_bytes(6)); $o = UC_STATE . "/us-$rid"; @mkdir(UC_STATE, 0700, true);
      foreach (glob(UC_STATE . '/us-*') ?: [] as $old) if (filemtime($old) < time() - 86400) @unlink($old);
      $sh = $home . 'echo $$ > ' . escapeshellarg("$o.pid") . "; $run > " . escapeshellarg("$o.out") . ' 2>&1; echo $? > ' . escapeshellarg("$o.rc");
      touch("$o.out");
      exec('setsid nohup bash -c ' . escapeshellarg($sh) . ' >/dev/null 2>&1 &');
      uc_json(['ok' => true, 'run' => $rid, 'where' => "$dir/script"]);
    }
    case 'us_out': {
      $rid = (string)arg('run'); if (!preg_match('/^[0-9a-f]{12}$/', $rid)) throw new UcError('Bad run');
      $o = UC_STATE . "/us-$rid"; $off = max(0, (int)arg('off', 0));
      $fh = @fopen("$o.out", 'rb'); $txt = '';
      if ($fh) { fseek($fh, $off); $txt = (string)fread($fh, 1048576); fclose($fh); }
      clearstatcache();
      $done = is_file("$o.rc");
      uc_json(['ok' => true, 'text' => mb_convert_encoding($txt, 'UTF-8', 'UTF-8'), 'off' => $off + strlen($txt), 'done' => $done && $off + strlen($txt) >= (int)@filesize("$o.out"), 'rc' => $done ? (int)trim((string)file_get_contents("$o.rc")) : null]);
    }
    case 'us_stop': {
      $rid = (string)arg('run');
      if (preg_match('/^[0-9a-f]{12}$/', $rid)) {
        $pid = (int)@file_get_contents(UC_STATE . "/us-$rid.pid");
        if ($pid > 1) { exec("pkill -TERM -P $pid; kill -TERM -$pid 2>/dev/null; kill -TERM $pid 2>/dev/null"); }
        if (!is_file(UC_STATE . "/us-$rid.rc")) file_put_contents(UC_STATE . "/us-$rid.rc", '143');
        file_put_contents(UC_STATE . "/us-$rid.out", "\n<b>Stopped.</b>\n", FILE_APPEND);
      } else {               // one running in the background
        $id = (string)arg('id'); if ($id === '' || str_contains($id, '/')) throw new UcError('Bad script');
        $pid = (int)@file_get_contents(UC_US_TMP . "/running/$id");
        if ($pid > 1) exec("pkill -TERM -P $pid; kill -9 $pid 2>/dev/null");
        @unlink(UC_US_TMP . "/running/$id"); @file_put_contents(UC_US_TMP . "/finished/$id", 'aborted');
        @file_put_contents(UC_US_TMP . "/tmpScripts/$id/log.txt", "Execution was aborted by user\n\n", FILE_APPEND);
      }
      uc_json(['ok' => true]);
    }
    case 'us_log': {
      $id = (string)arg('id'); if ($id === '' || str_contains($id, '/')) throw new UcError('Bad script');
      $f = UC_US_TMP . "/tmpScripts/$id/log.txt";
      if (!is_file($f)) throw new UcError('No log yet - it has not run in the background since the server started');
      $sz = filesize($f); $fh = fopen($f, 'rb'); fseek($fh, max(0, $sz - 262144)); $t = (string)fread($fh, 262144); fclose($fh);
      uc_json(['ok' => true, 'text' => mb_convert_encoding($t, 'UTF-8', 'UTF-8'), 'path' => $f, 'cut' => $sz > 262144, 'running' => uc_us_running($id)]);
    }
    /* Network shares from Unassigned Devices - list them, mount one (for Send › Kodi) */
    case 'ud_here': {        // asked after a /mnt/remotes or /mnt/disks folder has opened, so it never slows that down
      uc_json(['ok' => true, 'ud' => uc_ud_here(uc_path((string)arg('path')))]);
    }
    case 'ud_remotes': {
      $l = uc_ud_remotes();
      foreach ($l as &$r) $r['kodi'] = $r['mounted'] ? uc_kodi_pldir($r['path']) : null; unset($r);
      uc_json(['ok' => true, 'ud' => is_executable(UC_UD_RC), 'shares' => $l]);
    }
    case 'ud_mount': {
      if (!is_executable(UC_UD_RC)) throw new UcError('Unassigned Devices is not installed');
      $src = (string)arg('src'); $hit = uc_ud_find($src);
      if (!$hit) throw new UcError('Unassigned Devices has nothing called ' . $src);
      if (arg('off', '') === '1') {
        if ($hit['mounted']) {
          exec('timeout 90 ' . escapeshellarg(UC_UD_RC) . ' umount ' . escapeshellarg($src) . ' 2>&1', $o);
          $hit = uc_ud_find($src) ?? $hit;
          if ($hit['mounted']) throw new UcError("Couldn't unmount $src - something may be using it (a pane or a terminal inside it?). Unassigned Devices said: " . mb_substr(trim(implode(' ', array_slice($o, -3))), 0, 200));
        }
        $hit['kodi'] = null;
        uc_json(['ok' => true] + $hit);
      }
      if (!$hit['mounted']) {
        exec('timeout 90 ' . escapeshellarg(UC_UD_RC) . ' mount ' . escapeshellarg($src) . ' 2>&1', $o);
        $hit = uc_ud_find($src) ?? $hit;
        if (!$hit['mounted']) throw new UcError("Couldn't mount $src" . (str_starts_with($src, '/dev/') ? '' : ' - is that computer on?') . " (Unassigned Devices said: " . mb_substr(trim(implode(' ', array_slice($o, -3))), 0, 200) . ')');
      }
      $hit['kodi'] = uc_kodi_pldir($hit['path']);
      uc_json(['ok' => true] + $hit);
    }
    /* Download one of the releases Lidarr turned down (its Interactive Search: grab anyway) */
    case 'lidarr_grab': {
      uc_practice_block('asking Lidarr');
      $c = uc_lidarr_cfg(); $p = (string)arg('path'); $jobs = uc_lidarr_jobs(); $j = $jobs[$p] ?? null;
      if (!$j || empty($j['album_id'])) throw new UcError('Lidarr has no album for that one');
      $r = null; foreach ((array)($j['rels'] ?? []) as $x) if ($x['guid'] === (string)arg('guid')) $r = $x;
      if (!$r) throw new UcError('That release is no longer listed - press Ask again');
      try { uc_lidarr_req($c, 'POST', 'release', ['guid' => $r['guid'], 'indexerId' => $r['idx']], 60); }
      catch (UcError $e) { throw new UcError(preg_match('/cache|not found|404/i', $e->getMessage()) ? 'Lidarr has forgotten that search (it keeps results for 30 minutes) - press Ask again, then pick it again' : $e->getMessage()); }
      $v = ['state' => 'sent', 'msg' => 'Lidarr is downloading ' . $r['title'], 'rels' => null, 'grabbed' => $r['title'], 'asked' => time()];
      uc_lidarr_job_set($p, $v);
      uc_json(['ok' => true] + $v);
    }
    /* where Lidarr put an album it was asked for (its files, as this server sees them), and how complete it is */
    case 'lidarr_where': {
      $c = uc_lidarr_cfg(); $p = (string)arg('path'); $jobs = uc_lidarr_jobs(); $j = $jobs[$p] ?? null;
      if (!$j || empty($j['album_id'])) throw new UcError('Lidarr has no album for that one yet');
      $id = (int)$j['album_id'];
      $al = (array)uc_lidarr_req($c, 'GET', "album/$id");
      $st = (array)($al['statistics'] ?? []);
      $files = (array)uc_lidarr_req($c, 'GET', "trackfile?albumId=$id");
      $dirs = array_values(array_unique(array_map(fn($f) => dirname((string)($f['path'] ?? '')), array_filter($files, fn($f) => !empty($f['path'])))));
      $where = '';
      if ($dirs) {
        $d = $dirs[0]; foreach ($dirs as $x) while ($d !== '/' && $d !== '.' && !($x === $d || str_starts_with($x, $d . '/'))) $d = dirname($d);
        if (count($dirs) > 1 || preg_match('/^(cd|dis[ck])\s*\d+$/i', basename($d))) { if (preg_match('/^(cd|dis[ck])\s*\d+$/i', basename($d))) $d = dirname($d); }
        /* back to this server's path, through the folder pairs */
        $best = null; $len = -1;
        foreach ($c['map'] as $m) if (($d === $m['lidarr'] || str_starts_with($d, $m['lidarr'] . '/')) && strlen($m['lidarr']) > $len) { $best = $m['host'] . substr($d, strlen($m['lidarr'])); $len = strlen($m['lidarr']); }
        $where = (string)$best;
      }
      $v = ['where' => $where, 'have' => (int)($st['trackFileCount'] ?? count($files)), 'total' => (int)($st['trackCount'] ?? $st['totalTrackCount'] ?? 0), 'title' => (string)($al['title'] ?? '')];
      /* downloading now? how far */
      $v['dl'] = null;
      try {
        foreach ((array)uc_lidarr_req($c, 'GET', "queue/details?albumIds=$id") as $q) {
          if ((int)($q['albumId'] ?? 0) !== $id) continue;
          $size = (float)($q['size'] ?? 0); $left = (float)($q['sizeleft'] ?? 0);
          $v['dl'] = ['pct' => $size > 0 ? (int)round(100 * ($size - $left) / $size) : 0, 'status' => (string)($q['trackedDownloadState'] ?? $q['status'] ?? ''), 'eta' => (string)($q['timeleft'] ?? '')];
          break;
        }
      } catch (Throwable $e) {}
      uc_lidarr_job_set($p, $v);
      uc_json(['ok' => true] + $v);
    }
    /* playlists whose songs were in a folder that moved (Lidarr renamed an album's folder and files):
     * each song is found again in the new folder by its disc and track number (else its title) */
    case 'pl_remap': {
      $from = rtrim(uc_path((string)arg('from')), '/'); $to = rtrim(uc_path((string)arg('to')), '/');
      if (!is_dir($to)) throw new UcError('The new folder is no longer there');
      $apply = arg('apply', '') === '1';
      $key = function (string $p, string $root) {
        $rel = substr($p, strlen($root) + 1); $n = pathinfo($p, PATHINFO_FILENAME); $d = 0; $t = 0;
        if (preg_match('#(?:^|/)(?:cd|dis[ck])\s*(\d+)/#i', $rel, $m)) $d = (int)$m[1];
        if (preg_match('/^(?:(\d)[-.])?(\d{1,3})(?!\d)\s*[-._ ]/', $n, $m)) { if ($m[1] !== '') $d = (int)$m[1]; $t = (int)$m[2]; }
        elseif (preg_match('/\s-\s(?:(\d)-)?(\d{1,3})\s-\s/', $n, $m)) { if ($m[1] !== '') $d = (int)$m[1]; $t = (int)$m[2]; }
        $title = preg_replace('/^.*\s-\s/', '', preg_replace('/^(?:\d[-.])?\d{1,3}\s*[-._ ]\s*/', '', $n));
        $w = preg_replace('/[^\p{L}\p{N}]+/u', '', mb_strtolower($title));
        return [$d, $t, $w];
      };
      $new = [];
      $it = new RecursiveIteratorIterator(new RecursiveDirectoryIterator($to, FilesystemIterator::SKIP_DOTS));
      foreach ($it as $f) if ($f->isFile() && preg_match(UC_AUDIO_RE, $f->getFilename())) $new[] = $f->getPathname();
      $nk = array_map(fn($p) => $key($p, $to), $new);
      $find = function (string $old) use ($key, $from, $new, $nk) {
        [$d, $t, $w] = $key($old, $from); $best = null; $bs = 0;
        foreach ($new as $i => $p) {
          [$d2, $t2, $w2] = $nk[$i]; $sc = 0;
          if ($t && $t === $t2 && ($d === $d2 || !$d || !$d2)) $sc += 2;
          if ($w !== '' && $w === $w2) $sc += 2; elseif ($w !== '' && $w2 !== '' && (str_contains($w2, $w) || str_contains($w, $w2))) $sc += 1;
          if ($sc > $bs) { $bs = $sc; $best = $p; }
        }
        return $bs >= 2 ? $best : null;
      };
      $files = []; $map = [];
      foreach (uc_pldirs_clean((array)(uc_settings()['pldirs'] ?? [])) as $dir) {
        foreach (glob(rtrim($dir, '/') . '/*.{m3u,m3u8}', GLOB_BRACE) ?: [] as $pf) {
          $txt = (string)@file_get_contents($pf); if ($txt === '' || !str_contains($txt, $from . '/')) continue;
          $lines = preg_split('/\r?\n/', $txt); $hit = 0; $done = 0;
          foreach ($lines as &$l) { if (!str_starts_with($l, $from . '/')) continue; $hit++; $n = $map[$l] ?? ($map[$l] = $find($l)); if ($n) { $l = $n; $done++; } }
          unset($l);
          $files[] = ['path' => $pf, 'songs' => $hit, 'found' => $done];
          if ($apply && $done) {
            [, , $items] = uc_delete_paths([$pf]);
            if (@file_put_contents($pf, implode("\n", $lines)) === false) throw new UcError("Couldn't write " . basename($pf));
            @chmod($pf, 0666); $parts = array_merge($items, [['t' => 'made', 'p' => $pf]]);
            $hist = uc_hist_add('Updated the playlist ' . basename($pf) . ' (songs moved to ' . basename($to) . ')', $parts);
          }
        }
      }
      /* the songs of the open playlist too (the page asks with them) */
      foreach (arg('songs', '') === '' ? [] : arg_list('songs') as $l) { $l = (string)$l; if (str_starts_with($l, $from . '/') && !array_key_exists($l, $map)) $map[$l] = $find($l); }
      uc_json(['ok' => true, 'files' => $files, 'map' => array_filter($map), 'hist' => $hist ?? null]);
    }
    case 'lidarr_jobs': {
      $all = uc_lidarr_jobs();
      if (arg('forget', '') !== '') { $f = (string)arg('forget'); unset($all[$f]); @file_put_contents(uc_lidarr_jobs_file(), json_encode($all, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE)); }
      uc_json(['ok' => true, 'jobs' => $all]);
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
      /* The show must live in THIS folder - the one with the episodes we have -
       * or new downloads land in a second, slightly differently named folder. */
      $series = uc_arr_same_folder('Sonarr', $series, $rpath, fn($p) => uc_sonarr_hostpath($c, $p),
        fn() => uc_sonarr_req($c, 'GET', 'series/' . (int)$series['id']), fn($full) => uc_sonarr_req($c, 'PUT', 'series/' . (int)$series['id'] . '?moveFiles=false', $full));
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
        $m = uc_arr_same_folder('Radarr', $m, $rpath, fn($p) => uc_radarr_hostpath($c, $p),
          fn() => uc_radarr_req($c, 'GET', 'movie/' . (int)$m['id']), fn($full) => uc_radarr_req($c, 'PUT', 'movie/' . (int)$m['id'] . '?moveFiles=false', $full));
        if ($c['search']) uc_radarr_req($c, 'POST', 'command', ['name' => 'MoviesSearch', 'movieIds' => [$m['id']]]);
        $remember(['state' => 'exists', 'id' => $m['id'], 'searching' => $c['search'], 'msg' => $m['title'] . ' (' . ($m['year'] ?? '') . ') → ' . ($m['path'] ?? '')]);
        uc_json(['status' => 'exists', 'title' => $m['title'], 'year' => $m['year'] ?? null, 'path' => $m['path'] ?? '', 'searching' => $c['search']]);
      }
      $body = ['title' => $movie['title'], 'tmdbId' => (int)$movie['tmdbId'], 'year' => $movie['year'] ?? 0, 'titleSlug' => $movie['titleSlug'] ?? '',
               'images' => $movie['images'] ?? [], 'qualityProfileId' => (int)$c['profile'], 'path' => $rpath, 'monitored' => true,
               'minimumAvailability' => $c['availability'], 'addOptions' => ['searchForMovie' => (bool)$c['search'], 'monitor' => 'movieOnly']];
      $added = uc_radarr_req($c, 'POST', 'movie', $body);
      if (!empty($added['id'])) $added = uc_arr_same_folder('Radarr', $added, $rpath, fn($p) => uc_radarr_hostpath($c, $p),
        fn() => uc_radarr_req($c, 'GET', 'movie/' . (int)$added['id']), fn($full) => uc_radarr_req($c, 'PUT', 'movie/' . (int)$added['id'] . '?moveFiles=false', $full));
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
      uc_scans_tidy();
      $id = bin2hex(random_bytes(6));
      $dirs = uc_rel_dirs(arg('dirs', '[]'));        // folders picked in the tree
      $skip = $share === '' && !$dirs ? array_values(array_filter(array_map('strval', arg_list('skip')), fn($n) => preg_match('/^[^\/.][^\/]*$/', $n))) : [];
      if ($dirs) $share = '';
      file_put_contents("$dir/$id.json", json_encode(['id' => $id, 'tool' => 'empty', 'state' => 'queued', 'created' => time(), 'disks' => $disks, 'share' => $share, 'skip' => $skip, 'dirs' => $dirs,
        'disks_state' => array_map(fn($d) => ['disk' => $d, 'state' => 'waiting', 'seen' => 0, 'found' => 0], $disks), 'results' => []], JSON_UNESCAPED_SLASHES));
      $php = PHP_BINARY && !str_contains(PHP_BINARY, 'fpm') ? PHP_BINARY : 'php';
      $io = is_executable('/usr/bin/ionice') ? '/usr/bin/ionice -c3 ' : '';
      exec('setsid nohup nice -n 10 ' . $io . escapeshellarg($php) . ' -d memory_limit=1024M ' . escapeshellarg(__DIR__ . '/emptyscan.php') . ' ' . escapeshellarg($id) . ' >/dev/null 2>&1 &');
      uc_json(['ok' => true, 'id' => $id]);
    }
    /* Tools > Duplicates: same path on several disks, or same content anywhere in the shares */
    /* Duplicates: are these files still there, and how full is each one's folder (hidden entries count) */
    case 'dup_info': {
      $ex = []; $dn = [];
      foreach (array_slice(arg_list('paths'), 0, 5000) as $p) {
        $p = uc_path((string)$p); $ex[$p] = file_exists($p) || is_link($p);
        $d = dirname($p);
        if (!isset($dn[$d])) { $n = 0; if ($h = @opendir($d)) { while (($e = readdir($h)) !== false) if ($e !== '.' && $e !== '..') $n++; closedir($h); } $dn[$d] = $n; }
      }
      uc_json(['ok' => true, 'exists' => $ex, 'dirn' => $dn]);
    }
    /* Duplicates: are the copies in each set really the same inside (same size, different dates) */
    case 'dup_cmp': {
      @set_time_limit(600);
      $out = [];
      foreach (array_slice(arg_list('sets'), 0, 500) as $k => $set) {
        $set = array_map(fn($p) => uc_path((string)$p), (array)$set);
        $same = count($set) > 1;
        for ($i = 1; $same && $i < count($set); $i++) {
          if (!is_file($set[0]) || !is_file($set[$i]) || filesize($set[0]) !== filesize($set[$i])) { $same = false; break; }
          $same = uc_same_bytes($set[0], $set[$i]);
        }
        $out[] = $same;
      }
      uc_json(['ok' => true, 'same' => $out]);
    }
    case 'dup_start': case 'space_start': {
      $dir = UC_STATE . '/scans'; @mkdir($dir, 0700, true);
      uc_scans_tidy();
      $id = bin2hex(random_bytes(6));
      if ($action === 'dup_start') {
        $mode = arg('mode') === 'content' ? 'content' : 'paths';
        $shares = uc_rel_dirs(arg('dirs', arg('shares', '[]')));
        if (!$shares) throw new UcError('Pick at least one folder to look in');
        $job = ['id' => $id, 'tool' => 'dupes', 'state' => 'queued', 'created' => time(), 'mode' => $mode, 'shares' => $shares, 'min' => max(0, (int)arg('min', 1))];
        $script = 'dupscan.php';
      } else {
        $root = uc_path(arg('root')); if (!is_dir($root)) throw new UcError("That folder doesn't exist");
        $job = ['id' => $id, 'tool' => 'space', 'state' => 'queued', 'created' => time(), 'root' => $root];
        $script = 'spacescan.php';
      }
      file_put_contents("$dir/$id.json", json_encode($job, JSON_UNESCAPED_SLASHES));
      $php = PHP_BINARY && !str_contains(PHP_BINARY, 'fpm') ? PHP_BINARY : 'php';
      $io = is_executable('/usr/bin/ionice') ? '/usr/bin/ionice -c3 ' : '';
      exec('setsid nohup nice -n 10 ' . $io . escapeshellarg($php) . ' -d memory_limit=2048M ' . escapeshellarg(__DIR__ . "/$script") . ' ' . escapeshellarg($id) . ' >/dev/null 2>&1 &');
      uc_json(['ok' => true, 'id' => $id]);
    }
    /* the space map: one folder's sub-folders and biggest files, from the finished scan */
    case 'space_level': {
      $id = (string)arg('id'); if (!preg_match('/^[a-z0-9]{6,32}$/', $id)) throw new UcError('Bad id');
      $rel = trim((string)arg('rel', ''), '/');
      /* a folder deleted since the scan (in the panes) isn't shown any more */
      if ($rel !== '') { $sj = json_decode((string)@file_get_contents(UC_STATE . "/scans/$id.json"), true); $sr = rtrim($sj['root'] ?? '', '/');
        if ($sr !== '' && !is_dir("$sr/$rel")) throw new UcError("That folder isn't there any more"); }
      /* only the one small file this folder is in is read, a line at a time */
      $f = UC_STATE . "/scans/$id.tree." . sprintf('%02x', uc_space_bucket($rel));
      if (!is_file($f)) throw new UcError('That scan is no longer available - scan again');
      $needle = '[' . json_encode($rel, JSON_UNESCAPED_SLASHES | JSON_INVALID_UTF8_SUBSTITUTE) . ',';
      $h = fopen($f, 'r');
      while ($h && ($line = fgets($h)) !== false) {
        if (!str_starts_with($line, $needle)) continue;
        fclose($h); $j = json_decode($line, true);
        uc_json(['ok' => true, 'rel' => $rel] + (is_array($j) ? $j[1] : ['s' => 0, 'c' => 0, 'items' => []]));
      }
      if ($h) fclose($h);
      throw new UcError("That folder isn't in the scan");
    }
    /* the space map, after changes made in the panes: look again at the folders that were open there */
    case 'space_refresh': {
      $id = (string)arg('id'); if (!preg_match('/^[a-z0-9]{6,32}$/', $id)) throw new UcError('Bad id');
      $dirs = json_decode((string)arg('dirs', '[]'), true);
      if (!is_array($dirs)) $dirs = [];
      set_time_limit(300);
      uc_json(['ok' => true, 'changed' => uc_space_refresh($id, array_slice(array_values(array_filter($dirs, 'is_string')), 0, 2000))]);
    }
    case 'movie_scan_start': {
      $root = uc_path(arg('root'));
      if (!is_dir($root)) throw new UcError("That folder doesn't exist");
      if ($root === '/' || preg_match('#^/mnt/[^/]+$#', $root)) throw new UcError('Pick your movies folder (e.g. /mnt/user/Movies), not a whole disk');
      $dir = UC_STATE . '/scans'; @mkdir($dir, 0700, true);
      uc_scans_tidy();
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
      uc_scans_tidy();
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
      $tool = in_array(arg('tool'), ['empty', 'tv', 'dupes', 'space'], true) ? arg('tool') : 'movies';
      $best = null;
      foreach (glob(UC_STATE . '/scans/*.json') ?: [] as $f) {          // the newest of that tool's, however old (until the server restarts)
        $st = json_decode((string)@file_get_contents($f), true);
        if (!$st || ($st['tool'] ?? '') !== $tool) continue;
        if (arg('mode', '') !== '' && ($st['mode'] ?? '') !== arg('mode')) continue;        // Duplicates keeps one per kind
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
      $removed = []; $skipped = []; $hparts = [];
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
        $mine = [];
        foreach ($list as $d) {
          $sst = @stat($d);
          if (!@rmdir($d)) { $skipped[] = [$d, 'the system refused (not empty)']; break; }
          $removed[] = $mine[] = [$d, $sst['mode'] & 07777, $sst['uid'], $sst['gid'], $sst['mtime']];
        }
        if ($mine) $hparts[] = ['t' => 'rmdirs', 'p' => $p, 'dirs' => array_reverse($mine)];
      }
      if (!empty($hparts)) $hid = uc_hist_add('Deleted ' . count($hparts) . ' empty folder' . (count($hparts) === 1 ? '' : 's'), $hparts);
      $token = null;
      if ($removed) {
        @mkdir(UC_UNDO, 0700, true);
        $token = bin2hex(random_bytes(6));
        file_put_contents(UC_UNDO . "/rmdir-$token.json", json_encode(array_reverse($removed), JSON_UNESCAPED_SLASHES));
      }
      uc_json(['ok' => true, 'removed' => count($removed), 'skipped' => $skipped, 'undo' => $token, 'hist' => $hid ?? null]);
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
      uc_scans_tidy();
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
