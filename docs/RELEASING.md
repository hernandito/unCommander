# Releasing an update

## Repo layout

| Path | What it is |
|---|---|
| `uncommander.plg` | The plugin file Unraid installs. It downloads every file below from this repo. |
| `build-plg.sh` | Bumps the version, rebuilds the file list in the `.plg` and fills in the MD5s. |
| `source/` | The plugin itself. Installed as-is into `/usr/local/emhttp/plugins/uncommander/`. |
| `icon.png` | Plugin icon (Plugins page and Community Applications). |
| `logo.png` | The banner at the top of the README. |
| `description.txt` | The short text shown on Unraid's Plugins page. |
| `uncommander.xml` | The Community Applications template (a copy goes in your templates repo). |
| `screenshots/` | Images used by the README and CA. |
| `docs/` | The user guide and this file. |

## Every release

1. Edit files in `source/` (or add / remove files - the list updates itself).
2. Add a line for the new version at the top of `<CHANGES>` in `uncommander.plg`.
3. On the server, in the repo folder:
   ```bash
   bash build-plg.sh
   ```
   It sets the version to today's date (with a, b, c... for more releases the same day), lists every file with its MD5, and checks the `.plg` is still valid.
4. Commit and push.
5. On the server: **Plugins → Check for Updates**.

If you edit a file after running `build-plg.sh`, run it again - otherwise the install stops with "bad file MD5". Use `bash build-plg.sh --no-bump` to refresh the MD5s without changing the version.

## Community Applications

CA reads plugin templates from your templates repository (the same one that holds `quick.favorites.xml`):

1. Copy `uncommander.xml` into `hernandito/docker-templates` (next to `quick.favorites.xml`) and push.
2. CA picks it up on its next scan (usually within a few hours). If your templates repo isn't listed in CA yet, it has to be submitted once through the CA support thread on the Unraid forums.
3. When the forum support thread exists, put its link in:
   - `uncommander.xml` → `<Support>`
   - `uncommander.plg` → `support="..."` on the `<PLUGIN>` line
   - `README.md` → Support section

## Testing a branch before release

The `.plg` takes the branch from one entity at the top:

```xml
<!ENTITY branch    "main">
```

Change it to a test branch, run `build-plg.sh --no-bump`, push that branch, and install from
`https://raw.githubusercontent.com/hernandito/uncommander/<branch>/uncommander.plg`.
Set it back to `main` before merging.
