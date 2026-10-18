<?php
/* unCommander — background job runner. Started detached (setsid) by the API,
 * so a copy keeps going after the browser tab closes. Jobs run one at a time:
 * each worker waits on a shared lock, which gives a simple FIFO-ish queue. */
require_once __DIR__ . '/lib.php';

$id = $argv[1] ?? '';
$job = uc_job_read($id);
if (!$job || $job['state'] !== 'queued') exit(1);

$job['pid'] = getmypid();
uc_job_write($job);

$cancelled = false;
$child = null;
pcntl_async_signals(true);
pcntl_signal(SIGTERM, function () use (&$cancelled, &$child) {
  $cancelled = true;
  if ($child) { $st = proc_get_status($child); if ($st['running']) posix_kill($st['pid'], SIGTERM); }
});

$lock = fopen(UC_STATE . '/run.lock', 'c');
while (!flock($lock, LOCK_EX | LOCK_NB)) {
  if ($cancelled) finish('cancelled');
  usleep(500000);
}

$job['state'] = 'running';
$job['started'] = time();
uc_job_write($job);

function finish(string $state, ?string $error = null): never {
  global $job;
  $job['state'] = $state;
  $job['error'] = $error;
  $job['finished'] = time();
  if ($state === 'done') { $job['pct'] = 100; $job['eta'] = ''; }
  try { uc_job_announce($job); } catch (Throwable $e) {}
  uc_job_write($job);
  exit($state === 'done' ? 0 : 1);
}

/* Run a command, feeding each \r- or \n-terminated line to $onLine. */
function run(array $argv, callable $onLine, ?string $cwd = null): array {
  global $child, $cancelled;
  $cmd = implode(' ', array_map('escapeshellarg', $argv));
  /* stdin is /dev/null so nothing can sit waiting for an answer (a password prompt, say) */
  $child = proc_open($cmd, [0 => ['file', '/dev/null', 'r'], 1 => ['pipe', 'w'], 2 => ['pipe', 'w']], $pipes, $cwd);
  if (!$child) return [127, 'could not start ' . $argv[0]];
  stream_set_blocking($pipes[1], false);
  stream_set_blocking($pipes[2], false);
  $buf = ''; $err = '';
  while (true) {
    $r = [$pipes[1], $pipes[2]]; $w = $e = null;
    if (@stream_select($r, $w, $e, 1) === false && !$cancelled) continue;
    foreach ($r as $p) {
      $chunk = fread($p, 65536);
      if ($chunk === '' || $chunk === false) continue;
      if ($p === $pipes[2]) { $err = substr($err . $chunk, -4000); continue; }
      $buf .= preg_replace('/\x08+/', "\n", $chunk);     // 7-Zip redraws its progress with backspaces, not new lines
      while (preg_match('/^([^\r\n]*)[\r\n]/', $buf, $m)) {
        $buf = substr($buf, strlen($m[0]));
        if ($m[1] !== '') $onLine($m[1]);
      }
    }
    if (feof($pipes[1]) && feof($pipes[2])) break;
  }
  fclose($pipes[1]); fclose($pipes[2]);
  $rc = proc_close($child);
  $child = null;
  return [$rc, trim($err)];
}

$lastWrite = 0;
function progress(array $fields): void {
  global $job, $lastWrite;
  $job = array_merge($job, $fields);
  if (microtime(true) - $lastWrite > 0.5) { uc_job_write($job); $lastWrite = microtime(true); }
}

/* Undo bookkeeping for copy, move and Compare copies (see lib.php). */
@mkdir(UC_UNDO, 0700, true);
foreach (glob(UC_UNDO . '/*') ?: [] as $old) if (filemtime($old) < time() - 7 * 86400) @unlink($old);
$undo = null;
function undo_begin(array &$argv): void {
  global $job, $undo;
  $undo = ['id' => $job['id'], 'type' => $job['type'], 'dest' => rtrim($job['dest'], '/'), 'bin' => null, 'at' => time(),
           /* replacing with the trash switched off: the old versions aren't kept, so no undo */
           'blocked' => ($job['exists'] ?? 'skip') !== 'skip' && !uc_settings()['trash']];
  $undo['list'] = fopen(UC_UNDO . '/' . $job['id'] . '.written', 'w');
  if (($job['exists'] ?? 'skip') !== 'skip' && uc_settings()['trash']) {
    $undo['bin'] = uc_trash_merge_bin($undo['dest'], 'Replaced by ' . ($job['type'] === 'move' ? 'move' : 'copy'));
    $argv[] = '--backup';
    $argv[] = '--backup-dir=' . $undo['bin'] . '/' . basename($undo['dest']);
  }
}
function undo_note(string $name): void {
  global $undo;
  if (!$undo) return;
  /* rsync writes odd characters as \#ooo (octal) */
  $name = preg_replace_callback('/\\\\#([0-7]{3})/', fn($m) => chr(octdec($m[1])), $name);
  fwrite($undo['list'], $name . "\0");
}
function undo_end(): void {
  global $undo;
  if (!$undo) return;
  fclose($undo['list']);
  if ($undo['bin'] && is_dir($undo['bin'])) uc_trash_merge_mark($undo['bin'], $undo['dest']);
  else $undo['bin'] = null;
  unset($undo['list']);
  file_put_contents(UC_UNDO . '/' . $undo['id'] . '.json', json_encode($undo, JSON_UNESCAPED_SLASHES));
  $undo = null;
}

/* rsync --info=progress2 lines look like:
 *   5,734,617,088  46%  211.23MB/s    0:00:32 (xfr#3, to-chk=10/50)
 * and --out-format='F:%n' gives us the file currently being sent. */
$parse = function (string $line) {
  if (str_starts_with($line, 'F:')) { undo_note(substr($line, 2)); progress(['file' => substr($line, 2)]); return; }
  if (preg_match('/^\s*([\d,]+)\s+(\d+)%\s+(\S+)\s+(\d+:\d\d:\d\d)/', $line, $m)) {
    $bytes = (int)str_replace(',', '', $m[1]);
    $pct = (int)$m[2];
    $f = [];
    if (preg_match('/xfr#(\d+)/', $line, $x)) $f['files'] = (int)$x[1];
    /* to-chk=left/total counts every item in the list (files and folders) */
    if (preg_match('/to-che?c?k=(\d+)\/(\d+)/', $line, $x)) { $f['count'] = (int)$x[2]; $f['checked'] = (int)$x[2] - (int)$x[1]; }
    progress(['bytes' => $bytes, 'pct' => $pct, 'speed' => $m[3], 'eta' => $m[4],
              'total' => $pct > 0 ? (int)round($bytes * 100 / $pct) : null] + $f);
  }
};

try {
  if ($job['type'] === 'copy' || $job['type'] === 'move') {
    $argv = ['rsync', '-a', '--info=progress2', '--no-inc-recursive', '--out-format=F:%n'];
    if ($job['exists'] === 'skip') $argv[] = '--ignore-existing';
    if ($job['exists'] === 'newer') $argv[] = '--update';
    if ($job['type'] === 'move') $argv[] = '--remove-source-files';
    undo_begin($argv);
    $argv[] = '--';
    foreach ($job['sources'] as $s) $argv[] = rtrim($s, '/');   // no trailing slash: copy the folder itself
    $argv[] = rtrim($job['dest'], '/') . '/';

    [$rc, $err] = run($argv, $parse);
    undo_end();
    if ($cancelled) finish('cancelled');
    if ($rc !== 0) finish('failed', "rsync exited with code $rc" . ($err ? ": $err" : ''));

    if ($job['type'] === 'move') {
      /* rsync removed the files; sweep the now-empty folders it left behind. */
      foreach ($job['sources'] as $s) if (is_dir($s))
        run(['find', $s, '-depth', '-type', 'd', '-empty', '-delete'], fn($l) => null);
    }
    finish('done');
  }

  if ($job['type'] === 'sync') {
    /* exact list from the Compare window; -r so a listed folder brings its contents */
    $list = UC_STATE . '/jobs/' . $job['id'] . '.list';
    file_put_contents($list, implode("\0", $job['rel']) . "\0");
    $argv = ['rsync', '-a', '-r', '--from0', '--files-from=' . $list, '--info=progress2', '--no-inc-recursive', '--out-format=F:%n'];
    if ($job['exists'] !== 'overwrite') $argv[] = '--ignore-existing';
    undo_begin($argv);
    $argv[] = '--';
    $argv[] = rtrim($job['root'], '/') . '/';
    $argv[] = rtrim($job['dest'], '/') . '/';
    [$rc, $err] = run($argv, $parse);
    undo_end();
    @unlink($list);
    if ($cancelled) finish('cancelled');
    if ($rc !== 0) finish('failed', "rsync exited with code $rc" . ($err ? ": $err" : ''));
    finish('done');
  }

  if ($job['type'] === 'perms') {
    $o = $job['options'];
    $R = $o['recursive'] ? ['-R'] : [];
    foreach ($job['sources'] as $s) {
      progress(['file' => $s]);
      if ($o['preset']) {
        /* unRAID's "New Permissions": nobody:users, folders 777, files 666. */
        [$rc, $err] = run(array_merge(['chown'], $R, ['nobody:users', '--', $s]), fn($l) => null);
        if ($rc) finish('failed', $err);
        [$rc, $err] = run(array_merge(['chmod'], $R, ['u-x,go-rwx,go+u,ugo+X', '--', $s]), fn($l) => null);
        if ($rc) finish('failed', $err);
      } else {
        if ($o['owner'] !== '' || $o['group'] !== '') {
          [$rc, $err] = run(array_merge(['chown'], $R, [$o['owner'] . ':' . $o['group'], '--', $s]), fn($l) => null);
          if ($rc) finish('failed', $err);
        }
        if ($o['mode'] !== '') {
          [$rc, $err] = run(array_merge(['chmod'], $R, [$o['mode'], '--', $s]), fn($l) => null);
          if ($rc) finish('failed', $err);
        }
      }
      if ($cancelled) finish('cancelled');
    }
    finish('done');
  }
  /* 7-Zip's -bsp1 progress: "  42% 17 + some/file" redrawn with backspaces */
  $p7 = function (string $line) {
    global $job;
    if (preg_match('/^\s*(\d+)%(?:\s+(\d+))?(?:\s*[+U-]\s+(.*))?/', $line, $m)) {
      $f = ['pct' => min(99, (int)$m[1])];
      if (!empty($job['total'])) $f['bytes'] = (int)($job['total'] * $f['pct'] / 100);
      if (!empty($m[2])) $f['checked'] = (int)$m[2];
      if (!empty($m[3])) $f['file'] = trim($m[3]);
      progress($f);
    }
  };
  /* tar --checkpoint: one "CP n" line per ~1 MB (100 records of 10 KB) */
  $ptar = function (int $total) {
    return function (string $line) use ($total) {
      if (preg_match('/^CP(\d+)/', $line, $m)) {
        $bytes = (int)$m[1] * 100 * 10240;
        progress(['bytes' => $bytes] + ($total > 0 ? ['pct' => min(99, (int)($bytes * 100 / $total)), 'total' => $total] : []));
      }
    };
  };
  /* unRAID's usual ownership and permissions for what we just made */
  $tidy = function (string $path, bool $recursive) {
    run(array_merge(['chown'], $recursive ? ['-R'] : [], ['nobody:users', '--', $path]), fn($l) => null);
    run(array_merge(['chmod'], $recursive ? ['-R'] : [], ['u-x,go-rwx,go+u,ugo+X', '--', $path]), fn($l) => null);
  };

  if ($job['type'] === 'compress') {
    $names = array_map('basename', $job['sources']);
    $out = $job['out'];
    /* step 1: count what's going in, so the bar can show real progress */
    progress(['phase' => 'Counting the files']);
    $cnt = 0; $tot = 0;
    $h = popen('find ' . implode(' ', array_map('escapeshellarg', $job['sources'])) . ' ! -type d -printf ' . escapeshellarg("%s\n") . ' 2>/dev/null', 'r');
    while ($h && ($l = fgets($h)) !== false) { $cnt++; $tot += (int)$l; if ($cancelled) break; }
    if ($h) pclose($h);
    if ($cancelled) finish('cancelled');
    progress(['phase' => 'Compressing', 'count' => $cnt, 'total' => $tot]);
    $tmp = dirname($out) . '/.' . basename($out) . '.part';      // built under a hidden name, renamed when complete
    @unlink($tmp);
    if ($job['format'] === 'zip' && is_executable(UC_7Z)) {
      [$rc, $err] = run(array_merge([UC_7Z, 'a', '-tzip', '-mx=' . ($job['store'] ? 0 : 5), '-bso0', '-bsp1', '-bse2', '-y', '--', $tmp], $names), $p7, $job['srcdir']);
    } elseif ($job['format'] === 'zip') {
      [$rc, $err] = run(array_merge(['zip', '-r', '-q', $job['store'] ? '-0' : '-6', $tmp, '--'], $names), fn($l) => null, $job['srcdir']);
    } else {
      $total = $tot;
      $cmd = 'tar -cz --checkpoint=100 --checkpoint-action=echo=CP%u -f ' . escapeshellarg($tmp) . ' -- ' . implode(' ', array_map('escapeshellarg', $names)) . ' 2>&1';
      [$rc, $err] = run(['sh', '-c', $cmd], $ptar($total), $job['srcdir']);
    }
    if ($cancelled) { @unlink($tmp); finish('cancelled'); }
    if ($rc !== 0 && !($job['format'] === 'zip' && is_executable(UC_7Z) && $rc === 1)) {   // 7-Zip: 1 = warnings (e.g. a file changed while reading)
      @unlink($tmp); finish('failed', "Compressing failed (code $rc)" . ($err ? ": $err" : ''));
    }
    progress(['phase' => 'Saving the archive', 'pct' => 99, 'file' => '']);
    if (!@rename($tmp, $out)) { @unlink($tmp); finish('failed', 'Could not save ' . basename($out)); }
    $tidy($out, false);
    $job['outsize'] = (int)@filesize($out);
    /* "Delete the originals" - only now that the archive is complete and saved */
    if (!empty($job['remove'])) {
      progress(['phase' => 'Moving the originals to the trash']);
      try { [$cnt, $bins] = uc_delete_paths($job['sources']); $job['removed'] = $bins; }
      catch (Throwable $e) { finish('failed', 'The archive was saved, but removing the originals failed: ' . $e->getMessage()); }
    }
    finish('done');
  }

  if ($job['type'] === 'extract') {
    $a = $job['sources'][0]; $target = $job['target']; $skip = $job['exists'] === 'skip';
    progress(['phase' => 'Reading the archive']);
    try { $info = uc_archive_list($a, 0); progress(['count' => $info['files'], 'total' => $info['bytes']]); } catch (Throwable $e) {}
    if (!is_dir($target) && !@mkdir($target, 0777, true)) finish('failed', "Could not create $target");
    progress(['phase' => 'Extracting']);
    $stamp = UC_JOBS . '/' . $job['id'] . '.stamp';
    touch($stamp); sleep(1);              // everything extracted after this moment gets unRAID's ownership below
    if ($job['kind'] === 'tar') {
      $cmd = 'tar -x ' . ($skip ? '--skip-old-files' : '--overwrite') . ' --no-same-owner --checkpoint=100 --checkpoint-action=echo=CP%u -f ' . escapeshellarg($a) . ' -C ' . escapeshellarg($target) . ' 2>&1';
      [$rc, $err] = run(['sh', '-c', $cmd], $ptar((int)($job['total'] ?? 0)));
    } elseif (is_executable(UC_7Z)) {
      [$rc, $err] = run([UC_7Z, 'x', '-o' . $target, $skip ? '-aos' : '-aoa', '-pUCNOPASS', '-bso0', '-bsp1', '-bse2', '-y', '--', $a], $p7);
      if ($rc && stripos($err, 'password') !== false) $err = "it's password-protected - unCommander can't open those yet";
    } else {
      [$rc, $err] = run(['unzip', $skip ? '-n' : '-o', '-q', $a, '-d', $target], fn($l) => null);
    }
    if ($cancelled) { @unlink($stamp); finish('cancelled'); }
    progress(['phase' => 'Setting ownership and permissions', 'pct' => 99, 'file' => '']);
    /* new files belong to nobody:users like the rest of the array */
    if (!empty($job['made'])) $tidy($target, true);
    else run(['sh', '-c', 'find ' . escapeshellarg($target) . ' -mindepth 1 -cnewer ' . escapeshellarg($stamp) . ' -exec chown nobody:users {} + -exec chmod u-x,go-rwx,go+u,ugo+X {} + 2>/dev/null'], fn($l) => null);
    @unlink($stamp);
    if ($rc !== 0 && !($job['kind'] !== 'tar' && is_executable(UC_7Z) && $rc === 1)) finish('failed', "Extracting failed (code $rc)" . ($err ? ": $err" : ''));
    /* "Delete the archive" - only after a clean extract */
    if (!empty($job['remove'])) {
      progress(['phase' => 'Moving the archive to the trash']);
      try { [$cnt, $bins] = uc_delete_paths(uc_archive_parts($a)); $job['removed'] = $bins; }
      catch (Throwable $e) { finish('failed', 'Everything was extracted, but removing the archive failed: ' . $e->getMessage()); }
    }
    progress(['bytes' => (int)($job['total'] ?? 0)]);
    finish('done');
  }

  finish('failed', 'Unknown job type');
} catch (Throwable $e) {
  finish('failed', $e->getMessage());
}
