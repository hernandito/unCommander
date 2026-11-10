<?php
/* unCommander in its own browser tab - the same app as inside unRAID, filling
 * the whole window. Opened from Settings (in unCommander, or Settings > User
 * Utilities in unRAID). unRAID's login protects it like every webGUI page. */
$ucSolo = true;
$ucDark = in_array(((@parse_ini_file('/boot/config/plugins/dynamix/dynamix.cfg', true) ?: [])['display']['theme'] ?? 'white'), ['black', 'gray']);
?><!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>unCommander</title>
<link rel="icon" href="/plugins/uncommander/images/favicon.ico" sizes="16x16">
<link rel="icon" type="image/png" href="/plugins/uncommander/images/favicon-32.png" sizes="32x32">
<link rel="apple-touch-icon" href="/plugins/uncommander/images/apple-touch-icon.png">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-title" content="unCommander">
<meta name="apple-mobile-web-app-status-bar-style" content="<?=$ucDark ? 'black' : 'default'?>">
<meta name="theme-color" content="<?=$ucDark ? '#1c2024' : '#e9ecee'?>">
<style>
  html, body { margin: 0; padding: 0; height: 100%; background: <?=$ucDark ? '#131619' : '#eef0f2'?>; }
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; -webkit-text-size-adjust: 100%; }
</style>
</head>
<body>
<?php require __DIR__ . '/include/app.php'; ?>
</body>
</html>
