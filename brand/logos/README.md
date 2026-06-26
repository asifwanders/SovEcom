# SovEcom Logo Assets

Logo system based on the **Headless Node** mark (a central API core linked to decoupled storefront "heads") in the SovEcom teal palette. Wordmark type is **Ubuntu** (the SovEcom default UI typeface).

## Structure

```
brand/logos/
├── icon/          # mark only (square, 128×128 source)
│   ├── svg/       # sovecom-icon-{light,dark,mono}.svg
│   └── png/       # sovecom-icon-{variant}-{16,32,48,64,128,256,512,1024}.png
├── wordmark/      # mark + "SovEcom" lockup (no tagline)
│   ├── svg/       # sovecom-wordmark-{light,dark,mono}.svg
│   └── png/       # sovecom-wordmark-{variant}-{320,640,960,1280}.png  (width in px)
└── favicon/       # browser/app icons — solid teal tile + white node mark
    ├── favicon.svg
    ├── favicon.ico            # multi-res 16/32/48
    ├── favicon-{16,32,48,64,180,192,512}.png
    └── apple-touch-icon.png   # 180×180, opaque (iOS)
```

The favicon uses a solid teal tile with a white mark (rather than the transparent icon) so it stays legible on any browser chrome, light or dark.

All PNGs have transparent backgrounds.

## Variants — which to use

| Variant   | Use on                 | Notes                                                                        |
| --------- | ---------------------- | ---------------------------------------------------------------------------- |
| **light** | light backgrounds      | dark-teal + teal accents; default for the admin/storefront in light mode     |
| **dark**  | dark backgrounds       | brighter teal + warm off-white accents; for dark mode and dark hero sections |
| **mono**  | single-colour contexts | one brand-teal tone; stamps, watermarks, favicons on a brand-colour field    |

## Colours

| Role                               | Hex       |
| ---------------------------------- | --------- |
| Primary teal                       | `#00B9A0` |
| Bright teal (dark-mode primary)    | `#2DD4BF` |
| Dark teal-black                    | `#04221D` |
| Warm off-white (dark-mode accents) | `#E8E4DE` |
| Cream (light hole)                 | `#FAF9F7` |

## Notes

- **Font:** the wordmark SVGs reference `Ubuntu` (with a `system-ui` fallback). The PNGs have Ubuntu baked in as pixels, so they are fully portable. For a font-independent SVG, request outlined-path versions.
- Self-host the Ubuntu font with the app — never load it from the Google Fonts CDN (RGPD).
- Source artboards: icon 128×128; wordmark 300×80.
