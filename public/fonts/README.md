# Departure Mono font assets

The site expects the Departure Mono font files to be present in this directory so it can load them locally.

## Required files

- `DepartureMono-Regular.woff2`
- `DepartureMono-Regular.woff`

## How to add the fonts

1. Download the official font files from the Departure Mono repository:
   - https://github.com/rektdeckard/departure-mono
2. From the `public/assets` folder in that repository, copy the following files into `public/fonts/` in this project:
   - `DepartureMono-Regular.woff2`
   - `DepartureMono-Regular.woff`
3. Keep `DepartureMono-LICENSE.txt` alongside the font files to preserve the license.

Once these files are in place, the site will load the font via the `@font-face` rule in `public/styles.css`.
