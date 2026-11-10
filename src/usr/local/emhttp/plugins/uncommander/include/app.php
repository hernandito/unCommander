<?php
/* unCommander itself - shared by the page inside unRAID (UnCommanderMain.page)
 * and the stand-alone tab (uncommander.php, $ucSolo = true). Inside unRAID the
 * webGUI provides $var and $display; on its own it reads the same files. */
$ucSolo = !empty($ucSolo);
if ($ucSolo) {
  $var = @parse_ini_file('/var/local/emhttp/var.ini') ?: [];
  $display = (@parse_ini_file('/boot/config/plugins/dynamix/dynamix.cfg', true) ?: [])['display'] ?? [];
}
$ucTheme = in_array($display['theme'] ?? 'white', ['black', 'gray']) ? 'dark' : 'light';
$ucCsrf = $var['csrf_token'] ?? '';
$ucVer = preg_match('/<!ENTITY\s+version\s+"([^"]+)"/', (string)@file_get_contents('/var/log/plugins/uncommander.plg'), $ucVm) ? $ucVm[1] : '';
$ucArray = ($var['mdState'] ?? '') === 'STARTED' ? 'array started' : 'array stopped';
require_once '/usr/local/emhttp/plugins/uncommander/include/lib.php';
$ucSet = uc_settings();
?>
<link rel="stylesheet" href="/plugins/uncommander/css/uncommander.css?v=<?=filemtime('/usr/local/emhttp/plugins/uncommander/css/uncommander.css')?>">
<style id="uc-palette"><?=str_ireplace('</style', '', uc_palette_css($ucSet['palette'] ?? []))?></style>
<style id="uc-custom"><?=str_ireplace('</style', '<\/style', $ucSet['css'])?></style>
<script>window.UC_SETTINGS = <?=json_encode($ucSet, JSON_HEX_TAG | JSON_HEX_AMP | JSON_UNESCAPED_SLASHES)?>;</script>
<div id="uc" data-unraid-theme="<?=$ucTheme?>" class="uc uc-<?=(($ucSet['palette']['always'] ?? '') === 'dark') ? 'dark' : $ucTheme?><?=$ucSolo ? ' uc-solo' : ''?>" data-csrf="<?=htmlspecialchars($ucCsrf)?>" data-version="<?=htmlspecialchars($ucVer)?>" tabindex="-1">
  <div class="uc-appbar">
    <div class="uc-logo">un<span>Commander</span></div>
    <div class="uc-sysseg" role="group" aria-label="Top folder" aria-label="Where the folder tree starts"<?=empty($ucSet['sysmode']) ? ' hidden' : ''?>>
      <button class="uc-bm sys-b" data-sys="0" title="Shares - start at /mnt: your shares, disks, pools and Unassigned Devices">Shares</button><button class="uc-bm sys-b" data-sys="1" title="Whole OS - start at / : the whole running system, like Midnight Commander on the console">Whole OS</button>
    </div>
    <button type="button" class="uc-goto" title="Go to a share, disk, pool, drive or the flash" aria-haspopup="true" data-mounts="<?=htmlspecialchars(json_encode(uc_array_mounts()))?>" data-ud="<?=is_dir('/mnt/disks') ? '1' : ''?>" data-rem="<?=is_dir('/mnt/remotes') ? '1' : ''?>"><span>Go to…</span><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 6l4 4 4-4"/></svg></button>
    <input class="uc-jump" type="search" placeholder="Jump to name…" title="Type a name to jump to it in the active pane — Enter opens it, ↑↓ for other matches" autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false" enterkeyhint="go">
    <button class="uc-btn uc-toolbtn uc-termbtn" title="Terminal - a command line at the bottom, like SSH" aria-label="Terminal"><svg viewBox="0 0 16 16" aria-hidden="true"><rect x="1.5" y="2.5" width="13" height="11" rx="1.5"/><path d="M4.5 6.5 7 8.5l-2.5 2M8.5 11h3"/></svg></button>
    <button class="uc-btn uc-toolbtn uc-usbtn" title="User Scripts - run your scripts from here" aria-label="User Scripts"<?=is_dir('/boot/config/plugins/user.scripts/scripts') || getenv('UC_US_DIR') ? '' : ' hidden'?>><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 1.5h5.5l3 3v10H4z"/><path d="M9.5 1.5v3h3"/><path d="M6.3 8.2 5 9.5l1.3 1.3M9.7 8.2 11 9.5l-1.3 1.3"/></svg></button>
    <button class="uc-btn uc-toolbtn uc-histbtn" title="History - every change, newest first; undo any step, or part of one" aria-label="History"><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M2.6 9.2A5.6 5.6 0 1 0 4 4.1"/><path d="M1.9 2.4v2.9h2.9"/><path d="M8 4.9v3.4l2.2 1.4"/></svg></button>
    <button class="uc-btn uc-toolbtn uc-plbtn" title="Music player - shows or hides the player at the bottom, with your playlist" aria-label="Music player"<?=($ucSet['player'] ?? true) ? '' : ' hidden'?>><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M6 12.2V3.4l7.6-1.7v8.6"/><ellipse cx="4.1" cy="12.3" rx="2.1" ry="1.8"/><ellipse cx="11.6" cy="10.4" rx="2.1" ry="1.8"/></svg></button>
    <span class="uc-tabcombo"><button class="uc-btn uc-toolbtn uc-tabbtn" title="New tab or window" aria-label="New tab or window"><svg viewBox="0 0 16 16" aria-hidden="true"><rect x="1.5" y="2.5" width="13" height="11" rx="1.5"/><path d="M1.5 5.5h13M8 7.5v4M6 9.5h4"/></svg></button><button type="button" class="uc-tabname empty" title="Name this tab">tab name…</button></span>
    <div class="uc-sep"></div>
    <button class="uc-chip uc-toolpill" hidden title="Bring the tool back"></button>
    <button class="uc-chip uc-jobchip" hidden title="Copies, moves and permission changes"></button>
    <div class="uc-chip uc-free" id="uc-free">free —</div>
<?php if ($ucArray !== 'array started'): ?>
    <a class="uc-btn uc-toolbtn uc-arrstop" href="/Main" target="_top" title="The array is stopped - shares and disks under /mnt aren't there until it's started. Click to go to Main." aria-label="The array is stopped"><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M5.3 1.2h5.4l3.8 3.8v5.4l-3.8 3.8H5.3l-3.8-3.8V5z"/><path d="M4.6 8h6.8"/></svg></a>
<?php endif; ?>
    <button class="uc-chip uc-practice" hidden title="Practice mode: nothing can be deleted, moved, renamed or overwritten. Tap to change.">🔒 Practice mode</button>
    <button class="uc-btn uc-toolbtn" data-opentool="tools" title="Tools" aria-label="Tools"<?=empty($ucSet['toolbtns']['tools']) ? ' hidden' : ''?>><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M10.2 1.9a3.3 3.3 0 0 0-3.9 4.4L1.9 10.7a1.4 1.4 0 0 0 2 2l4.4-4.4a3.3 3.3 0 0 0 4.4-3.9l-2 2-1.8-.5-.5-1.8z"/><path d="M10.5 10.5l3.6 3.6M12.6 9.4l1.3 1.3-2.2 2.2-1.3-1.3"/></svg></button>
    <button class="uc-btn uc-toolbtn" data-opentool="movies" title="Movie folders without a video" aria-label="Movie folders without a video"<?=empty($ucSet['toolbtns']['movies']) ? ' hidden' : ''?>><svg viewBox="0 0 16 16" aria-hidden="true"><rect x="1.75" y="2.75" width="12.5" height="10.5" rx="1.5"/><path d="M4.75 2.75v10.5M11.25 2.75v10.5M1.75 6h3M1.75 10h3M11.25 6h3M11.25 10h3"/></svg></button>
    <button class="uc-btn uc-toolbtn" data-opentool="tv" title="TV shows with missing episodes" aria-label="TV shows with missing episodes"<?=empty($ucSet['toolbtns']['tv']) ? ' hidden' : ''?>><svg viewBox="0 0 16 16" aria-hidden="true"><rect x="1.5" y="3.25" width="13" height="8.75" rx="1.5"/><path d="M5.5 14.25h5M8 12v2.25M5.75 1.25 8 3.25l2.25-2"/></svg></button>
    <button class="uc-btn uc-toolbtn uc-reloadbtn" hidden title="Reload the page (as a Home Screen app there is no address bar to do it)" aria-label="Reload the page"><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M13.5 8a5.5 5.5 0 1 1-1.6-3.9M12.5 1.8v2.9H9.6"/></svg></button>
    <button class="uc-btn uc-settings-btn" title="Shortcuts, appearance, sounds and trash">⚙<span class="t"> Settings</span></button>
  </div>

  <div class="uc-alerts" hidden></div>

  <div class="uc-bmrow">
    <div class="uc-bookmarks"></div>
    <div class="uc-panetog" role="group" aria-label="Show or hide a pane" title="Show or hide the left or right pane - handy for long file names">
      <button class="uc-bm pt-rf" data-rf="0" title="Refresh the left pane - read its folder again" aria-label="Refresh the left pane"><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M13.2 8a5.2 5.2 0 1 1-1.6-3.75"/><path class="h" d="M12.2 1.6v3.1H9.1"/></svg></button>
      <button class="uc-bm pt-seg" data-p="0"><svg viewBox="0 0 16 16" aria-hidden="true"><rect x="1.5" y="2.5" width="13" height="11" rx="1.5"/><rect class="f" x="1.5" y="2.5" width="6.5" height="11" rx="1.5"/></svg>Left</button>
      <button class="uc-bm pt-seg" data-p="1">Right<svg viewBox="0 0 16 16" aria-hidden="true"><rect x="1.5" y="2.5" width="13" height="11" rx="1.5"/><rect class="f" x="8" y="2.5" width="6.5" height="11" rx="1.5"/></svg></button>
      <button class="uc-bm pt-rf" data-rf="1" title="Refresh the right pane - read its folder again" aria-label="Refresh the right pane"><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M13.2 8a5.2 5.2 0 1 1-1.6-3.75"/><path class="h" d="M12.2 1.6v3.1H9.1"/></svg></button>
    </div>
  </div>

  <div class="uc-crumbs">
    <div class="uc-path" data-pane="0">
      <div class="uc-trail" title="Tap a folder name to go there. Tap the empty space or ✎ to type a path."></div>
      <input class="uc-crumb" data-pane="0" spellcheck="false" autocomplete="off" autocapitalize="off" autocorrect="off" enterkeyhint="go">
      <button class="uc-path-btn" data-path="copy" title="Copy this path" aria-label="Copy this path"><svg viewBox="0 0 16 16" aria-hidden="true"><rect x="5.5" y="5.5" width="8" height="8" rx="1.5"/><path d="M10.5 3.5v-.5a1.5 1.5 0 0 0-1.5-1.5H4a1.5 1.5 0 0 0-1.5 1.5v5A1.5 1.5 0 0 0 4 9.5h.5"/></svg></button>
      <button class="uc-path-btn" data-path="edit" title="Type a path" aria-label="Type a path"><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M11 2.5l2.5 2.5L6 12.5l-3.2.7.7-3.2z"/><path d="M9.5 4l2.5 2.5"/></svg></button>
    </div>
    <div class="uc-crumb-btns">
      <button class="uc-btn uc-swap" title="Swap panes">⇄</button>
      <button class="uc-btn uc-same" title="Open the same folder in the other pane">=</button>
    </div>
    <div class="uc-path" data-pane="1">
      <div class="uc-trail" title="Tap a folder name to go there. Tap the empty space or ✎ to type a path."></div>
      <input class="uc-crumb" data-pane="1" spellcheck="false" autocomplete="off" autocapitalize="off" autocorrect="off" enterkeyhint="go">
      <button class="uc-path-btn" data-path="copy" title="Copy this path" aria-label="Copy this path"><svg viewBox="0 0 16 16" aria-hidden="true"><rect x="5.5" y="5.5" width="8" height="8" rx="1.5"/><path d="M10.5 3.5v-.5a1.5 1.5 0 0 0-1.5-1.5H4a1.5 1.5 0 0 0-1.5 1.5v5A1.5 1.5 0 0 0 4 9.5h.5"/></svg></button>
      <button class="uc-path-btn" data-path="edit" title="Type a path" aria-label="Type a path"><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M11 2.5l2.5 2.5L6 12.5l-3.2.7.7-3.2z"/><path d="M9.5 4l2.5 2.5"/></svg></button>
    </div>
  </div>

  <div class="uc-cmpbar" hidden></div>

  <div class="uc-panes">
    <div class="uc-pane" data-pane="0"></div>
    <div class="uc-pane" data-pane="1"></div>
  </div>

  <div class="uc-term" hidden><div class="ut-bar"><span class="ut-t">Terminal</span><span class="ut-dir"></span><button type="button" class="ut-b ut-clear" title="Clear the screen (types clear)">clear</button><button type="button" class="ut-b ut-paste" title="A box to paste or type a command into and fix it up with the mouse - Enter runs it">paste w/ edit</button><span class="ut-sp"></span><span class="ut-tip">Copy: select text · Paste: Ctrl+V or right-click</span><button type="button" class="ut-b ut-exit" title="Log off and close the terminal">Exit</button><button type="button" class="ut-b ut-hide" title="Hide the terminal - it keeps running">Hide</button></div><div class="ut-pbox" hidden><textarea class="ut-pta" rows="1" placeholder="Paste (Ctrl+V) or type a command, edit it with the mouse - Enter runs it · Shift+Enter: new line · Up: the last one · Esc: close" spellcheck="false" autocapitalize="off" autocorrect="off"></textarea><button type="button" class="ut-b ut-prun" title="Run it (Enter)">Run</button><button type="button" class="ut-b ut-pcan">Close</button></div><iframe class="ut-frame" title="Terminal"></iframe></div>
  <div class="uc-selbar">
    <span class="uc-lbl">Select</span>
    <button class="uc-btn" data-sel="all">All</button>
    <button class="uc-btn" data-sel="none">None</button>
    <button class="uc-btn" data-sel="invert">Invert</button>
    <input class="uc-pat" placeholder="*.bak" spellcheck="false">
    <button class="uc-btn" data-sel="add">Add</button>
    <button class="uc-btn" data-sel="remove">Remove</button>
    <span class="uc-spacer"></span>
    <div class="uc-bp" hidden><div class="bp-host"></div><span class="bp-vol"><button type="button" class="bp-vb" aria-label="Volume"></button><input type="range" class="bp-vr" min="0" max="100" step="1" aria-label="Volume"></span><button type="button" class="bp-qb"><b></b></button><button type="button" class="bp-x" title="Stop, and empty the queue" aria-label="Stop and close the player">✕</button></div>
    <span class="uc-spacer bp-sp"></span>
    <span class="uc-lbl">Sort</span>
    <select class="uc-sort">
      <option value="name">Name</option>
      <option value="size">Size</option>
      <option value="mtime">Modified</option>
      <option value="perm">Perms</option>
    </select>
    <button class="uc-btn uc-sortdir" title="Reverse">↑</button>
    <label class="uc-hidden"><input type="checkbox" class="uc-showhidden"> Show hidden</label>
    <label class="uc-hidden uc-fkbar-l" title="The button bar at the bottom (F-keys and More) - untick for more room"><input type="checkbox" class="uc-fkbar" checked> Buttons</label>
  </div>

  <div class="uc-fkeys">
    <div class="uc-fk-vp"><div class="uc-fk-track">
      <div class="uc-fk-page" data-page="f">
        <button class="uc-fk" data-act="view"><span class="k">F2</span>View</button>
        <button class="uc-fk" data-act="edit"><span class="k">F3</span>Edit</button>
        <button class="uc-fk" data-act="rename"><span class="k">F4</span>Rename</button>
        <button class="uc-fk" data-act="copy"><span class="k">F5</span><span class="t">Copy 🠊</span></button>
        <button class="uc-fk" data-act="move"><span class="k">F6</span><span class="t">Move 🠊</span></button>
        <button class="uc-fk" data-act="mkdir"><span class="k">F7</span>New Folder</button>
        <button class="uc-fk danger" data-act="delete"><span class="k">F8</span>Delete</button>
        <button class="uc-fk" data-act="find"><span class="k">F9</span>Find</button>
        <button class="uc-fk" data-act="perms"><span class="k">F10</span>Perms</button>
        <button class="uc-fk uc-restore" data-act="restore" hidden>Restore</button>
      </div>
      <div class="uc-fk-page" data-page="more">
        <button class="uc-fk" data-more="Properties" data-act="props" title="Size, dates, owner and permissions of the item under the cursor"><span class="ic">ⓘ</span>Properties</button>
        <button class="uc-fk" data-more="New file" data-act="newfile" title="Make a new, empty text file here"><span class="ic">+</span>New File</button>
        <button class="uc-fk" data-more="Batch rename" data-act="brename" title="Rename the ticked files in one go, with a full preview"><span class="ic txt">Aa</span>Batch rename</button>
        <button class="uc-fk" data-more="Compress" data-act="compress" title="Pack the ticked items (or the one under the cursor) into a .zip or .tar.gz"><span class="ic">⇩</span>Compress</button>
        <button class="uc-fk" data-more="Extract" data-act="extract" title="Unpack the archive under the cursor (.zip, .rar, .7z, .tar.gz …)"><span class="ic">⇧</span>Extract</button>
        <button class="uc-fk" data-more="Folder sizes" data-act="sizes" title="Add up the size of the ticked folders, or the folder under the cursor"><span class="ic">Σ</span>Folder sizes</button>
        <button class="uc-fk" data-more="Compare" data-act="compare" title="Compare the two panes' folders and tick what's missing or newer on the active side"><span class="ic">⇆</span>Compare</button>
        <button class="uc-fk" data-more="Undo" data-act="undo" title="Undo the latest step (Ctrl+Z) - History has all of them"><span class="ic">↶</span>Undo</button>
        <button class="uc-fk" data-more="History" data-act="history" title="Every change, newest first - undo any step, or just part of one"><span class="ic">☰</span>History</button>
      </div>
    </div></div>
    <button class="uc-fk uc-fk-toggle" title="More buttons" aria-label="More buttons"><span><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M6 3.5 10.5 8 6 12.5"/></svg></span></button>
  </div>


  <div class="uc-modal" hidden><div class="uc-dlg"></div></div>
  <div class="uc-modal uc-tmodal" hidden><div class="uc-dlg"></div></div>
  <div class="uc-toast" hidden></div>
</div>
<script src="/plugins/uncommander/js/uncommander.js?v=<?=filemtime('/usr/local/emhttp/plugins/uncommander/js/uncommander.js')?>"></script>
