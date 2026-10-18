# unCommander - User Guide

The full reference for every feature. For a quick overview see the [README](../README.md).

## Using it

| Action | Button / key | What runs |
|---|---|---|
| Open folder | click its name, Enter — on a tablet, tap once to pick the row, tap it again to open | `find -printf '%y %f'` — names + types from readdir, no stat |
| Jump up the path | tap any name in the path bar; deeper folders you came from stay greyed so you can tap back into them. Drag (or long-press on iPad) to select and copy the path; the copy icon copies it all; the pencil or the empty space types a path | |
| Up a level | `..` (always a single tap or click), Backspace | |
| Switch pane | click, Tab | the active pane sets direction: Copy → or ← Copy |
| Select | checkbox, Space/Insert, shift-click for ranges, All / None / Invert | |
| Select by pattern | type `*.bak`, Add / Remove (Enter / Shift+Enter) | |
| Jump to name | start typing over the panes, or tap the Jump box (tablets) | jumps, doesn't filter; Enter opens it, ↑↓ for other matches |
| Rename | F4 | `rename()` |
| View | F2 | text: line numbers; from a search, jumps to the matching line and highlights it. Pictures (png, jpg, gif, webp, svg, …): shown fitted, tap for actual size, ‹ Prev / Next › (or ←/→, or swipe) through the folder's pictures. PDFs: shown in the viewer; Open in new tab for full screen |
| Edit | F3 | text files up to 5 MB; saved in place so owner and permissions are kept; warns if the file changed on disk |
| Copy | F5 | `rsync -a --info=progress2`, detached, cancellable |
| Move | F6 | `rename()` on the same device (instant), else rsync + remove |
| New folder | F7 | created as nobody:users |
| Delete | F8 / Del | moved into `.uncommander-trash` at the top of the share/disk |
| Find | F9 | mc-style dialog; with Content, one result per matching line (`grep -n`). Results: Go to file, View, Edit, List in pane |
| Permissions | F10 | `chown`/`chmod`, or the unRAID default (nobody:users, folders 777, files 666) |

A folder that's slow to open (often a disk spinning up) shows *Opening… N s* with a **Cancel** button (or Esc); opening anything else replaces the slow request, and after 60 s it gives up with a message. If it took over 3 s, a note says whether the server was reading the disk or the request was queued.

**Back and Forward:** the ‹ button at the left of each pane's header goes back to the folder that pane showed before (like a browser's Back), however you got there - a shortcut, the Go to menu, a breadcrumb or opening a folder. Each pane keeps its own history (the last 50 folders), remembered across reloads; hovering the button shows where it will go. The › button after the LEFT/RIGHT label goes forward again after going back.

**Show one pane:** the Left | Right toggle at the right end of the shortcuts row hides a pane (tap a lit side to hide it, tap again to bring it back) so the other gets the full width for long names. The hidden pane still counts as the other side for Copy and Move.

**Ticks are remembered:** leave unCommander's page and come back, and each pane's ticked items and cursor are restored (if it still shows the same folder).

**More row:** the › button at the right end of the F-keys slides in a second row (Folder sizes, Compress, Extract, Batch rename, Compare, Undo); ‹ slides back.

**Colour highlighting:** View (F2) and Edit (F3) colour text by file type - unRAID .cfg and other key=value settings, shell scripts (including /boot/config/go), XML/.nfo/.plg/HTML, JSON, YAML and Docker compose files, logs (errors red, warnings amber, timestamps grey, IP addresses), PHP, JavaScript, CSS, Python, Markdown, Dockerfiles and diffs. The type is guessed from the name or the first line; the Colours menu at the top right changes it and is remembered per kind of file. The editor draws the colours behind a transparent text box, so typing is unchanged; files over 400 KB are edited without colours. Switch it off in Settings > Look & sound; the colours are CSS variables (--hl-*) you can override.

**Tool windows tuck away:** the tools open in their own window layer. **Show** on a row - or the — button next to ✕ - tucks the tool away into a purple pill at the top ("↩ Movie folders · 12") and leaves it running; tap the pill to bring it back exactly as it was (list, ticks, scroll). Ordinary dialogs (View, Copy...) work while a tool is tucked away. Only ✕ or Close closes a tool.

**Resolved movies:** when the movie tool shows results, folders that have a video again are checked. Movies that **unCommander sent to Radarr** and whose video has now arrived appear in a fixed green **✓ Arrived through Radarr** panel at the top of the results (movies downloaded any other way are not shown): **Remove from Radarr** takes the movie out of Radarr (its files stay), **Clear** drops the row, and Remove all / Clear all do every row at once. Other folders that got a video just leave the list. What was sent to Radarr is remembered per folder on the flash drive (radarr-sent.json), independent of scans and reboots. Delete never applies to arrived movies.

**Tools remember their last scan:** close a tool's window (or leave the page) and reopening it shows the last results straight away, with when they're from - or the progress, if the scan is still running. Folders deleted or fixed since are left out; Scan again refreshes everything. The server remembers each tool's latest scan, so this works on any device and doesn't depend on browser storage. Results are kept for a day (in memory, so a reboot clears them). The Settings title shows the installed version - if it's older than the one you just installed, reload the page.

**Settings and Tools windows** close only with their own buttons (Cancel, Save, Close) or the ✕ in the corner - tapping outside them or pressing Esc does nothing, so changes aren't lost by accident.

**Tools (Settings > Tools):**
- *Empty folders on disks* - scans each disk and pool directly (in the background, low priority) for folders with nothing inside: no files and nothing hidden (a hidden file or folder, such as a trash folder, counts as content). By default it lists only leftovers, folders whose same path also exists on another disk; a box shows ones that exist on one disk only. Folders holding nothing but empty folders are one row ("only N empty folders inside"). Delete is two-step, re-checks every folder, and removes them only with rmdir, which the system refuses for anything not empty. Undo recreates them with the same owner, permissions and dates. The scan reads each disk in one depth-first pass and keeps only the current path in memory, so even disks with millions of items need just a few MB; buttons per share narrow big result lists, and if a scan ever dies it says so and keeps what it found on the disks it finished. Results go to their own file and are sent once, a line at a time, so status checks stay tiny. Each disk shows its leftovers (empty folders that also exist on another disk) and its total empty folders. appdata, system, domains and isos are skipped by default (untick to include them).
- *Movie folders without a video* - pick the movies folder (each folder directly inside is one movie). Lists the movie folders with no video file anywhere inside, grouped as Posters / .nfo only, Empty, Sample only (only a sample or trailer) and Other files. Details shows the poster, plot, rating, runtime, genres and IMDb/TMDb links from a local .nfo (Plex-only libraries usually have none, so only the folder name is shown), plus the files inside. Export the listed or picked movies as CSV or text - downloaded to the device or saved in a folder on the server. Delete moves the picked folders to the trash (Undo puts them back). Add to Radarr sends movies back to Radarr to download again into their existing folders (see Radarr below).

**Radarr (Settings > Tools):** enter Radarr's address, port, optional URL base and API key, then Test connection - it shows Radarr's version, fills the Quality profile list, and reads Radarr's root folders. Each root folder is paired with the same folder on this server, read from the Radarr container's Docker volume mappings (or unRAID's saved template); edit the pair if it's wrong. Pick the quality profile, minimum availability and whether to search right away, then Save (the API key is kept on the server and never sent to the browser). In the movie tool, tick movies and press Add N to Radarr, or use the Radarr button on a row. Each movie is matched by its TMDb id (from the .nfo or a {tmdb-…} folder tag), then IMDb id, then exact title and year; anything less certain shows "Radarr needs you to pick the movie" with Radarr's suggestions. It's added with your quality profile and its existing folder as Radarr's path (translated through the folder pairs), monitored, and searched. A movie Radarr already has is set to monitored and searched instead. Each row shows the outcome; movies are sent one at a time so one failure doesn't stop the rest.

**Colour picker (Settings > Look & sound):** tap the swatch next to the examples menu: a saturation/brightness square with hue and opacity bars (drag with a finger), HEX / RGB / HSL fields (type any CSS colour, even a name like tomato), a palette with a grey ramp, unCommander's own theme colours, and your recent colours. Pick the output format (HEX, RGB or HSL - with opacity it becomes #rrggbbaa, rgba() or hsla()), then Copy or Insert it into the CSS box at the cursor. Tap the lower half of the preview to go back to the starting colour. An Eyedropper button appears in browsers that support one (not Safari).

**Compare:** with a folder open in each pane, Compare tags every item in both panes (only here, newer, older, differs, folder in both, the same) and ticks the active pane's items that are missing or newer on the other side. The active pane (blue border) is always the source; a bar above the panes says which way F5 Copy will go, and tapping the other pane flips the direction. Copy opens with "Replace if older" picked. Compare is top level only (folders are compared by name, not their contents), re-runs itself after a copy, and ends when you leave either folder or press Close compare. "Differs" means the same date but a different size and is never ticked automatically.

**Detailed compare (subfolders included):** the **⊞ Detailed compare…** button on the Compare bar opens a window that compares both folders all the way down. Each difference is one row with the left file, an arrow, and the right file. Tap the arrow to choose: → copy right, ← copy left, = leave alone (an amber arrow means it replaces the copy on the other side). Filters (Differences, Only left, Only right, Newer left/right, Same date different size, Same, Everything) and "for every row shown" buttons make bulk choices quick. A folder that exists on one side only is a single row, and copying it brings everything inside. One button runs it, as up to two background copy jobs (one per direction). Nothing is ever deleted; practice mode never replaces existing files. Trash folders are skipped.

**Folder sizes:** adds up the ticked folders (or the one under the cursor) with `find`, in the background beside any copy. A window shows each folder's running total and where it is; closing it doesn't stop the count, and the totals appear in the Size column (blue) and the selection tally until you leave the folder. Sizes use decimal units (1 GB = 1,000,000,000 bytes), like unRAID. The right end of the row is kept clear for unRAID's floating scroll arrows (`--fk-clear`).

**Columns:** the sliders icon at the top left of each pane's column titles shows or hides Size, Disk, Date and Mode; each pane remembers its choice. **Disk** (off by default, /mnt/user panes and search results only) shows which disk(s) or pool each item really lives on - `d1`, `d2 d5`, `cache`, or `d1 +2` when spread wider. Tap a Disk cell to see what each disk holds (files, size, or "empty folder") and open any one disk's copy in the other pane. It asks unRAID's share filesystem (`system.LOCATIONS`), or checks each disk and pool if that isn't available.

**Jobs:** copies, moves and permission changes open a progress window listing the job and any queued behind it. Watch it to the end and that's it. Press *Continue in background*, close the tab or go to another page while it runs, and when it ends you get a row at the top of unCommander (on every device, until dismissed) plus an unRAID notification (Settings > Jobs can switch the notification off). Jobs you watched to the end are forgotten; the green Jobs button in the top bar shows what's running and any background results you haven't dismissed.

**Compress / Extract** (More row): Compress packs the ticked items (or the one under the cursor) into a .zip or .tar.gz, saved in the other pane or this folder, with "don't squeeze photos and videos" (store) on by default and an optional "delete the originals once the archive is saved" (to the trash; off by default). Extract unpacks the archive under the cursor - .zip, .rar (incl. RAR5), .7z, .tar(.gz/.bz2/.xz/.zst) and more - into the other pane or this folder, by default into a new folder named after the archive; existing files are skipped unless you choose Replace, and "delete the archive once everything is extracted" (all parts of a multi-part archive, to the trash) is optional. The progress window shows each step (counting, compressing/extracting, saving, tidying up) with a real progress bar, file x of y, sizes and the current file. Both run as jobs with the progress window, and what they create gets unRAID's usual nobody:users ownership. F2 on an archive lists what's inside.

**7-Zip:** the official static Linux build (`7zzs`, 26.03) is downloaded once at install from the 7-Zip GitHub releases, checked against a pinned SHA-256, cached on the flash drive (`/boot/config/plugins/uncommander/`) and unpacked into `/usr/local/emhttp/plugins/uncommander/bin/`. It isn't on the system PATH and nothing else on unRAID uses it. Without internet at install, .zip and .tar.* still work; .rar/.7z need a reinstall while online.

**/mnt is the top:** tap the "/" at the start of the path bar (or Go to… → /mnt) to open /mnt, which holds user (all shares), every disk and pool, and disks/ and remotes/ (Unassigned Devices). There is no ".." above it (in the Whole OS view there is, up to /); /boot (flash) is in Go to…, along with each disk, pool and the Unassigned Devices folders.

**Batch rename** (More row): rename the ticked items four ways - Replace text (optionally regex), Add text, Number (pattern with [n] [name] [date] [folder], start, digits, order by name or date) and Change case - with a live Now → After list, red rows for clashes or invalid names, per-row untick, and a "How does this work?" guide. Rename is all-or-nothing: if any item can't be renamed, every item keeps its old name. Swaps (a ↔ b) and case-only changes work, and Undo puts all the old names back.

**Undo:** after a rename, batch rename, move, delete (to trash) or new folder, the message has an **Undo** link for 10 seconds; the Undo button in the More row (or Ctrl/Cmd+Z) undoes the most recent one until something else replaces it. Undo of a move moves the items back; of a delete restores them from the trash; of a new folder removes it only if it's still empty. Copies and Compare copies can be undone too: the new copies go to the trash and any files they replaced come back. That works because a copy, move or Compare copy that replaces files first sets the old versions aside in the trash (an entry named "Replaced by copy" / "Replaced by move"); restoring such an entry from the trash merges the files back into their folder. Before anything is replaced, a confirmation lists the files and says how far it can be undone - with the trash switched off, replacing cannot be undone at all. Undoing a move also puts back files the move replaced (if the move back is a background job, restore them from the trash). Permission changes, Compress/Extract, editor saves and permanent deletes can't be undone. The Delete dialog has a "Delete permanently - skip the trash" box for removing things for good straight away.

Ops act on ticked items, or on the cursor row if nothing is ticked. Owner/group other than `nobody:users` shows in amber.

**Restore:** open a `.uncommander-trash` folder: each entry shows what it holds, when it was deleted and where from (on disk the folder is named like `20261013-141907 Arrival (2016)`). Tick entries and press **Restore** — each goes back to its original path.

**Trash retention:** bins older than 30 days are purged daily at 04:17. Change `TRASH_DAYS` in `/boot/config/plugins/uncommander/uncommander.cfg` (`0` = keep forever).

## Settings (⚙ in the top bar)

- **General** - the name shown for unCommander in the Unraid top menu; how a tap on a row behaves (Automatic, Always pick first, Always open straight away); notifications when a job finishes; and **Automatically show directory changes** (see Auto-refresh).
- **Shortcuts** - buttons under the top bar that open a folder in the active pane. Add one with ＋ (adds the active folder) or here, where you can rename, reorder and remove them.
- **Look & sound**
  - **Text size on this device** - 80% to 140% in 5% steps. Scales all of unCommander's text, row heights and columns; from 110% the active pane's outline gets thicker. Saved in this browser only, so an iPad and a desktop can each have their own size. 100% is the standard look.
  - **Theme** - *Standard* or *Midnight Commander* (blue panels, cyan bars, yellow ticked files - windows keep the standard look). Previews as soon as you pick it.
  - **Your own CSS** - applied over unCommander's, with live preview, ready-made examples, a colour picker, and a **Starting CSS** button that puts the labelled default colours back in the box.
  - **Sounds** - synthesised clicks for button presses, opening folders / going back, row taps and errors; volume and per-group switches.
- **Safety & trash**
  - **Practice mode** - for learning without risk: Delete, Move, Rename, Permissions, Restore, saving edits and replacing files on copy are locked (checked on the server too). A 🔒 badge shows in the top bar while it's on.
  - **Whole system view** - adds the **Shares | Whole OS** switch (see below).
  - **Trash** - switch it off (Delete then erases immediately), and how many days to keep deleted items (0 = forever).
- **Tools** - open the tools, set up Radarr and Sonarr, and tick **Display icon in UI** to show the movie / TV tool buttons next to Settings.
- **Keyboard** - every keyboard shortcut, grouped.

Saved to `/boot/config/plugins/uncommander/settings.json` (except text size, which is per device), so they're the same on every device and survive reboots.

## Safety

- Only paths under `/mnt` and `/boot` are reachable - unless Whole system view is switched on in Settings > Safety & trash, which opens the whole file system.
- Copying or moving between `/mnt/user/...` and disk or pool paths is allowed, except when the destination is the very same file or folder seen through the other view (e.g. `/mnt/cache/Media/x` onto `/mnt/user/Media`) - that would destroy it, so it's refused.
- Can't copy or move a folder into itself.
- Default for existing files is **skip**; you choose per operation.
- Jobs run one at a time, in order, and survive a closed tab (not a reboot).

## Auto-refresh

Settings > General > **Automatically show directory changes** (off by default). Every few seconds (5, 10, 30 or 60) unCommander checks the open folders' last-changed time - one tiny request, no folder listing - and re-reads a folder only when something was added, removed or renamed. New items flash briefly; ticks, cursor and scroll stay put. Checks pause while the browser tab is hidden, a window is open, or Compare is on.

## Custom CSS

Settings > Look & sound > **Your own CSS** starts with a short, labelled set of colour rules - the accent colour, the active pane's header bar, and the same for the Whole OS view (rules starting `#uc.uc-sys`). Change any value; the preview updates as you type, and **Starting CSS** brings the original set back.

Other handy variables:

```css
#uc {
  --r-btn: 6px;              /* corners of buttons */
  --r-input: 6px;            /* corners of text boxes, drop-downs, path boxes */
  --name-font: var(--mono);  /* font for file names and the path boxes */
  --row: 25px;               /* row height (at 100% text size) */
}
#uc .uc-row .nm:not(.dir) { color: #4b4b4b; }   /* regular file names */
```

For bigger or smaller text on one device, use **Text size on this device** instead of CSS - it scales everything together.

## TV shows with missing episodes (Settings > Tools)

Pick the TV folder (each folder directly inside it is one show) and press Scan. For each show unCommander:

1. reads the episode numbers from the video file names - S01E05, 1x05, double episodes (S01E01-E02, S01E01E02), and dates for daily shows. Specials (Season 0), extras folders (Featurettes, Extras, Behind the Scenes...) and samples are skipped.
2. works out which show it is: a match saved earlier, then the TheTVDB/IMDb id in tvshow.nfo or in the folder name, then a title (+ year) search on TVmaze. When several shows share a title, the one whose episode list fits your files is chosen. If it still isn't sure, the show goes in the amber "needs you to pick" box; your answer is remembered.
3. gets the show's episode list from TVmaze (no account or key needed), at most one request every 0.6 s to stay inside TVmaze's limit. Episode lists are cached in memory (ended shows 30 days, running ones 12 hours), so rescans are quick until the next reboot.

Results: **Missing episodes**, **Missing seasons** (a whole aired season absent), **Needs a look** (numbering that doesn't line up - DVD order, absolute anime numbering, odd file names), **No videos**, **Not matched**, **Couldn't check** (TVmaze unreachable - never reported as missing), **Complete** (ended, everything there) and **Up to date** (running, everything aired so far there). Only episodes that aired 3 or more days ago count.

Details shows a season grid (green = in the folder, red = missing, dashed = not aired yet) with **Ignore season**, **Ignore this show** and **Mark as complete** - remembered on the flash drive (tv-rules.json; matches in tv-matches.json, a few KB). Export lists the missing episodes as CSV or text. Nothing in the folders is ever changed.

### Sonarr (Settings > Tools, in the TV card)

Enter Sonarr's address, port, optional URL base and API key, then Test connection - it fills the quality profile list and pairs each Sonarr root folder with the same folder on this server (read from the Sonarr container's Docker mappings; edit if needed). Save.

In the TV tool, the **Sonarr** button on a show (or **Get the N missing episodes with Sonarr** in Details, or tick several shows and **Send N to Sonarr**) asks Sonarr for that show's missing aired episodes:

1. If Sonarr doesn't have the show (matched by its TheTVDB id from TVmaze), it's added with its existing folder, monitored but with no episodes wanted. Daily talk and news shows are added as daily shows.
2. Once Sonarr has loaded the episode list (a few seconds - the row says "Sonarr is loading the show…"), only the missing episodes are marked wanted, and searched if "Search for the episodes as soon as they're sent" is on.
3. Episodes Sonarr already has a file for are skipped; episodes Sonarr numbers differently are reported as "not in Sonarr's list".

The season grid shows asked-for episodes in blue. After the next scan, a show whose asked-for episodes are all in the folder appears in the green **Arrived through Sonarr** panel: **Remove from Sonarr** takes the show out of Sonarr (files stay), **Clear** drops the row. What was sent is remembered on the flash drive (tv-sonarr.json). Problems appear in the amber box with **Retry**.

### Fixing "Needs a look"

Details opens with a **What's wrong** box that lists every problem in plain words: missing seasons and episodes, files with an episode number that doesn't exist (with the file name), file names without a season/episode number, and shows **numbered differently** from TVmaze. For those, a table compares your files with the episode list season by season. When your files don't line up with TVmaze (a season released in two halves, "parts", DVD order), the show is checked against **Sonarr's numbering** (TheTVDB) and counted by that when it fits - the row then says "by Sonarr's numbering". If everything really is there, **They're all here - mark as complete** settles it for good.

### Wrong show?

**🔍 Wrong show? Search TVmaze** in Details opens a search. Type the name, or paste a TVmaze link, an IMDb id (tt1234567) or `tvdb:12345` to find exactly that show. Pick **This one**; the choice is remembered for future scans.

### Sonarr: by season, packs, and stuck imports

- Each season in Details with missing episodes has its own **⬇ Get season N** button.
- A season that is missing in full is searched as a **season pack** and, as well, episode by episode (there often is no pack). The seasons you ask for are switched on (monitored) in Sonarr; others are left alone.
- If Sonarr downloads an episode but won't import it on its own ("matched to series by ID"), the show gets an amber **Downloaded - waiting for an import in Sonarr** label and an **Import now** button. It does what Sonarr's Manual Import does - only for this download's files, using the episodes Sonarr grabbed it for - then waits for Sonarr's result and checks the folder again.
- **Remove from Sonarr** first checks that Sonarr's show is still the one in this folder and that nothing is still downloading or importing for it.

### Deleting a show's or movie's folder

**Delete this show's folder…** (TV Details) and **Delete…** (each movie row and movie Details) ask first: **Move to the trash** (Undo or Restore brings it back) or **Delete for good** (frees the space now; needs an "I understand" tick). If the show or movie is in Sonarr / Radarr, a ticked box also removes it there so it isn't downloaded again.

## Whole OS view

Switch on **Whole system view** in Settings > Safety & trash, and a **Shares | Whole OS** switch appears next to the unCommander name. **Whole OS** makes `/` the top, like Midnight Commander on the console: `/boot`, `/etc`, `/var`, `/tmp`, `/usr` and the rest, with every action available. **Shares** goes back to `/mnt` (panes outside /mnt and /boot return to /mnt). The choice is remembered per device.

Things to know: everything outside /mnt and /boot lives in RAM, so changes there are gone after a reboot, and there's no trash there - deleting is for good. Find skips /proc, /sys and /dev when it starts at /. With the setting off, the server refuses anything outside /mnt and /boot.

## Keyboard

All shortcuts are listed in Settings > Keyboard. They work once unCommander has the focus (click or tap inside it). Ctrl / Alt / Cmd + an F-key is left to the browser - **Ctrl+F5** reloads the page, while plain F5 is Copy.

## Quick buttons

- **↻** before **Left** and after **Right** refresh that pane's folder (the cursor stays on the same item).
- The **film** and **TV** buttons next to Settings open the movie and TV tools (Settings > Tools > Display icon in UI).
