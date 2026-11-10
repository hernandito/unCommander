<?php
/* The tools' lists (playlists, Radarr "sent", TV choices, Lidarr, music-check) to the flash drive as one
 * small file, so unRAID's flash backup has them - only when one changed since the last copy. */
require_once __DIR__ . '/../include/lib.php';
echo uc_lists_snapshot(), "\n";
