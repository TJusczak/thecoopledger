# App install screenshots

These power the **rich install dialog** on Android. With at least one valid
`form_factor: "narrow"` screenshot in `manifest.json`, Chrome swaps its small
"Add to Home screen?" infobar for a Play-Store-style card showing the app icon,
name, description and swipeable screenshots.

Until the files below exist, nothing breaks — Chrome just falls back to the
plain install prompt, exactly as before.

## What to capture

Four files, referenced by `manifest.json`:

| File | Suggested view |
| --- | --- |
| `dashboard.png` | Overview tab, a month with good egg/feed/money data |
| `flock.png` | Flock tab, list or grid with a few birds |
| `finances.png` | Finances tab showing category tiles |
| `year-review.png` | Year Review with the charts and year-over-year chips |

## Size

**1080 × 1920** (portrait). If you capture at a different size, update the
`sizes` field for that entry in both `manifest.json` and `manifest-beta.json`
to match exactly — Chrome ignores screenshots whose declared size is wrong.

## Easiest way to capture

Chrome desktop, using device emulation so you get a true portrait phone frame:

1. Open the app and press **F12** for DevTools.
2. Click the device-toolbar icon (**Ctrl+Shift+M**).
3. Choose **Responsive** and set the size to **1080 × 1920**, zoom 100%.
4. Set DPR to 1 so the capture is exactly 1080 wide.
5. Command menu (**Ctrl+Shift+P**) → *Capture screenshot*.

Or from a phone: take normal screenshots on a 1080×1920-class device and crop
off the status/nav bars.

## Before you publish them

These ship inside the container and are visible to anyone who installs the app,
so use the **demo data** or scrub anything you would not want public — coop
names, notes, real spend figures.

## Checking it worked

In Chrome DevTools → **Application** → **Manifest**, the screenshots appear at
the bottom with any validation warnings. On an Android device, uninstall first,
then reload — the install prompt should now show the richer card.
