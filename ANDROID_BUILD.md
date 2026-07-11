# Building the Android app (Bubblewrap / TWA)

The Android app isn't a separate codebase — it's a thin wrapper (a
**Trusted Web Activity**, TWA) around the same PWA already running at
thecoopledger.com or beta.thecoopledger.com. **Bubblewrap** is Google's
official CLI for generating, building, and signing that wrapper.

There are two separate Android apps, built the same way but pointed at
different domains, with different icons so they're visually distinct in
the app drawer:

| | Production | Beta |
|---|---|---|
| Points at | thecoopledger.com | beta.thecoopledger.com |
| Package ID | `com.thecoopledger.twa` (already in use) | `com.thecoopledger.beta` |
| Icon | `static/icon-512.png` (the egg ring, warm tones) | `static/icon-512-beta.png` (the egg ring, purple tones) |
| App name | The Coop Ledger | The Coop Ledger Beta |

Both need their own signing key and their own entry in `assetlinks.json`
(more on both below) — they're independent apps as far as Android and
Google Play are concerned, even though they share almost everything else.

## Prerequisites

- **Node.js** 14.15+ (check with `node -v`)
- That's genuinely it to get started. Bubblewrap needs a JDK and the
  Android command-line tools too, but **let it install those itself** the
  first time it runs — this is Google's own recommendation, since it
  guarantees compatible versions. Don't pre-install your own JDK/Android
  SDK and point Bubblewrap at them unless you already know why you'd want
  to.

## Installing Bubblewrap

```
npm i -g @bubblewrap/cli
```

**Don't use `sudo npm i -g @bubblewrap/cli`** — this is called out
explicitly in Bubblewrap's own docs. If you hit permission errors without
sudo, fix your npm global prefix instead of reaching for sudo.

---

## Building the production app

Do this in its own directory, separate from the beta build below —
Bubblewrap generates a full Android project per directory, and keeping
them apart avoids any risk of one overwriting the other.

```
mkdir bubblewrap-prod && cd bubblewrap-prod
bubblewrap init --manifest https://thecoopledger.com/app/manifest.json
```

The first run downloads the JDK and Android build tools — let it. This
takes a few minutes and only happens once.

Bubblewrap reads the manifest and walks you through a wizard confirming
values before generating the project. Things worth getting right:

- **Package ID**: this one already exists in production — use
  `com.thecoopledger.twa` to match. (For beta, see below — it needs a
  *different* ID so both apps can be installed side by side.)
- **App name**: The Coop Ledger
- **Launcher icon**: point this at `static/icon-512.png` from this repo
  (the regular warm-toned version)
- **Signing key**: if this is genuinely the first time this app has been
  built, let Bubblewrap generate a new key and fill in the prompts (org
  name, key password, etc). **If a signing key already exists from a
  previous build, use that one instead of generating a new one** — see
  the warning below on why this matters so much.

```
bubblewrap build
```

This produces two files in the project directory:

- `app-release-signed.apk` — for sideloading directly onto a test device
- `app-release-bundle.aab` — what you'd actually upload to the Play Store

### ⚠️ About the signing key

**The same signing key must be used for every future update of this
app, forever.** Android will refuse to install an update signed with a
different key over an existing install, and the Play Store will reject
it outright. If the key is lost, the only way to "update" the app again
is to publish it as a brand new listing — you cannot recover access to
the original one.

- Back up the generated keystore file (and its password) somewhere safe
  and durable — not just on the machine you happened to build on
- This is *not* the same thing as the site's TLS certificate — it's a
  separate, self-signed certificate that exists only to prove future
  updates come from you

### Digital Asset Links (making the app open full-screen, not in a browser tab)

Without this step, the app technically installs and runs, but opens your
site inside a visible browser UI (a Custom Tab) instead of full-screen
like a real app. Android checks this the first time the app launches.

1. Get the app's SHA256 fingerprint:
   ```
   keytool -list -v -keystore <path-to-your-keystore> -alias <your-key-alias>
   ```
   Look for the line starting `SHA256:` in the output.

2. thecoopledger.com's production fingerprint is already live at
   `landing/assetlinks.json` in this repo, deployed to
   `/.well-known/assetlinks.json` (see the **Deploying the landing site**
   section of the main README for why it's structured that way). If
   you're rebuilding with the *same* existing key, nothing to do here. If
   this is a genuinely new key, update the `sha256_cert_fingerprints`
   value in that file to match.

### Testing on a device

With a device connected over USB (USB debugging enabled):

```
bubblewrap install
```

or manually with `adb install app-release-signed.apk`.

---

## Building the beta app

Same process, different domain, different identity throughout — this is
what actually keeps the two apps distinct rather than colliding.

```
mkdir bubblewrap-beta && cd bubblewrap-beta
bubblewrap init --manifest https://beta.thecoopledger.com/app/manifest.json
```

In the wizard:

- **Package ID**: `com.thecoopledger.beta` — **must** differ from the
  production package ID, or Android will treat this as an update to the
  production app instead of a separate install
- **App name**: The Coop Ledger Beta (so it's unmistakable in the app
  drawer, not just in-app)
- **Launcher icon**: `static/icon-512-beta.png` — the purple-toned
  version, built specifically so beta is visually distinct at a glance
- **Signing key**: generate a **new, separate** key for this app — don't
  reuse the production key. They're independent apps; there's no reason
  for them to share signing identity, and keeping them separate means a
  problem with one key can never affect the other app.

```
bubblewrap build
```

### Digital Asset Links for beta

Same idea as production, pointed at the beta domain instead:

1. Get the beta app's fingerprint the same way:
   ```
   keytool -list -v -keystore <path-to-beta-keystore> -alias <your-key-alias>
   ```
2. Add it as a **second entry** in `landing/assetlinks.json` (don't
   replace the production entry — both can coexist in the same file; a
   domain's assetlinks.json can list multiple apps, and Android only
   looks for a match for whichever package is actually asking):
   ```jsonc
   [
     {
       "relation": ["delegate_permission/common.handle_all_urls"],
       "target": {
         "namespace": "android_app",
         "package_name": "com.thecoopledger.twa",
         "sha256_cert_fingerprints": ["<production fingerprint>"]
       }
     },
     {
       "relation": ["delegate_permission/common.handle_all_urls"],
       "target": {
         "namespace": "android_app",
         "package_name": "com.thecoopledger.beta",
         "sha256_cert_fingerprints": ["<beta fingerprint>"]
       }
     }
   ]
   ```
   Since `landing/` is the shared source both thecoopledger.com and
   beta.thecoopledger.com deploy from, this one file update covers both
   domains at once — no need to maintain two separate copies.

---

## Updating either app later

Whenever the underlying PWA changes meaningfully enough to want a fresh
Android build (new icon, updated manifest, etc.), from inside that
project's own directory:

```
bubblewrap update --manifest=./twa-manifest.json
bubblewrap build
```

`update` regenerates the entire Android project from `twa-manifest.json`
and bumps the version automatically — it does **not** touch the signing
key, so the existing key keeps getting used automatically. Only
`twa-manifest.json` itself needs to be kept around/backed up between
builds; the generated Android project files are disposable and get
fully regenerated each time.

## Icon file reference

All sizes for both variants already live in this repo:

| File | Use |
|---|---|
| `static/icon-512.png` | Production launcher icon (Bubblewrap, Play Store listing) |
| `static/icon-512-beta.png` | Beta launcher icon |
| `static/icon-512-maskable.png` / `-beta-maskable.png` | Pre-padded for Android's adaptive icon masking, if Bubblewrap or a future asset pipeline wants a maskable-specific source separately |
