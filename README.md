# Islamic Smart Clock (Athan)

A full-screen Islamic prayer times clock built with Electron. Designed as an always-on kiosk display for desktops and tablets (optimised for Windows 11 / Surface Go).

![Islamic Smart Clock](assets/icons/icon.png)

---

## Features

- 🕌 **Live prayer times** — calculated offline via the `adhan` library, optionally synced from Aladhan.com API
- 📍 **Auto location detect** — detects your city automatically via IP on first launch
- 🖼️ **Rotating wallpaper** — crossfades through mosque images in `assets/images/`
- 🔊 **Athan audio** — plays automatically at each prayer time
- 🌙 **Hijri date** — shown alongside Gregorian date
- 📖 **Quran verse rotation** — scrolls through verses and hadiths at the bottom
- ⚙️ **Settings modal** — change city, calculation method, clock format, theme and more
- 🛡️ **Burn-in protection** — pixel drift + dim cycle for always-on displays

---

## Quick Start

> ⚠️ This is an **Electron desktop app** — it does NOT work by opening `index.html` in a browser.

### 1. Clone the repo
```bash
git clone https://github.com/Ritz341/Athan.git
cd Athan
```

### 2. Install dependencies
```bash
npm install
```

### 3. Run the app
```bash
npm start
```

The app will launch fullscreen and auto-detect your location on first run.

---

## Configuration

### Location
On first launch the app auto-detects your city via IP address. To change it manually:
- Click the **⚙️ Settings** button (top right)
- Use **Quick Presets** to pick a city, or click **⦿ Detect My Location**
- Or enter Latitude / Longitude manually
- Click **Save & Apply**

Your location is saved to `settings.json` (not tracked by Git).

### Prayer Calculation Method
Edit `config.js` to change the default calculation method:
```js
calculationMethod: 'NorthAmerica', // ISNA, MWL, Egyptian, Karachi, UmmAlQura...
asrMethod: 'Standard',             // or 'Hanafi'
```

### Athan Audio
Place your `.mp3` file in `assets/audio/` and update `config.js`:
```js
audio: {
  athanFile: 'Abdul-Basit.mp3',
  volume: 0.85,
}
```

### Wallpaper Images
Add `.jpg` / `.png` images to `assets/images/` — they will rotate automatically.

---

## Changelog (improvements/ui-fixes branch)

| # | Change | Type |
|---|--------|------|
| 1 | HTTP → HTTPS for Aladhan API | Bug Fix |
| 2 | Wallpaper CSP — allowed `file://` image loading | Bug Fix |
| 3 | Wallpaper z-index — images were hidden behind body | Bug Fix |
| 4 | Auto location detect via ip-api.com on first launch | Feature |
| 5 | "Detect My Location" button in Settings modal | Feature |
| 6 | Clock locked to white with dark shadow — always readable | UI |
| 7 | Countdown digits always visible over any background | UI |
| 8 | Settings button — bigger, labelled, tablet-friendly | UI |
| 9 | Current prayer — stronger gold pulse + icon bounce | UI |
| 10 | Next prayer — solid teal glowing border | UI |
| 11 | Other prayers — more dimmed for contrast | UI |
| 12 | SVG icons — replaced inconsistent emojis | UI |
| 13 | `.gitignore` added | Repo |
| 14 | `settings.json` untracked (personal data) | Repo |

---

## Building for Distribution

```bash
# Portable .exe
npm run build:portable

# Installer .exe
npm run build
```

Output goes to the `dist/` folder.

---

## Project Structure

```
Athan/
├── main.js          # Electron main process
├── renderer.js      # UI logic (prayer times, clock, location)
├── config.js        # All user-configurable settings + Quran database
├── index.html       # App layout
├── styles.css       # All styling
├── settings.json    # User overrides (auto-generated, not in Git)
└── assets/
    ├── audio/       # Athan .mp3 files
    ├── fonts/       # DS-Digital clock font
    ├── icons/       # App icon
    └── images/      # Wallpaper photos
```

---

## License

MIT License — see `LICENSE`. Free to use, modify, and distribute with attribution.

## Repository

https://github.com/Ritz341/Athan