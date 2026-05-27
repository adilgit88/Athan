/**
 * ============================================================
 *  Islamic Smart Clock — Renderer Process (renderer.js)
 *
 *  Responsibilities:
 *    · Live clock (12/24 hr) with blinking colons
 *    · Gregorian + Hijri date display
 *    · Prayer times — computed offline via adhan library,
 *      optionally refreshed from aladhan.com API with caching
 *    · Prayer card state management (current / next / passed)
 *    · Countdown timer to next prayer
 *    · Athan audio trigger
 *    · Quran verse rotation with fade transition
 *    · Auto cursor-hide on inactivity
 *
 *  Runs inside Electron renderer with nodeIntegration: true.
 * ============================================================
 */

'use strict';

// ─────────────────────────────────────────────────────────────
//  Node / Electron dependencies
// ─────────────────────────────────────────────────────────────
const adhan  = require('adhan');
const fs     = require('fs');
const path   = require('path');
const https  = require('https');
const http   = require('http'); // kept for ip-api.com (HTTP only)

// When running as a portable .exe, electron-builder sets PORTABLE_EXECUTABLE_DIR
// to the folder where the .exe lives.  We write settings + cache there so they
// survive across runs even though __dirname points to a temp extraction folder.
const APP_DIR = process.env.PORTABLE_EXECUTABLE_DIR || __dirname;

// CONFIG is injected by config.js (loaded before this script in index.html).
// We keep a live mutable copy so settings changes apply without restart.
let LOC         = { ...CONFIG.location };
let CALC_METHOD = CONFIG.calculationMethod;
let ASR_METHOD  = CONFIG.asrMethod;
let HL_RULE     = CONFIG.highLatitudeRule;
const AUDIO_CFG = CONFIG.audio;
const API_CFG   = CONFIG.api;
let DISP_CFG    = { ...CONFIG.display };

// ─────────────────────────────────────────────────────────────
//  Auto-detect location via ip-api.com (IP-based, no GPS needed)
//  Returns { latitude, longitude, city } or null on failure.
// ─────────────────────────────────────────────────────────────
function detectLocationByIP() {
  return new Promise((resolve) => {
    const url = 'http://ip-api.com/json?fields=status,city,regionName,lat,lon,timezone';
    const req = http.get(url, { timeout: 5000 }, (res) => {
      let raw = '';
      res.on('data', chunk => { raw += chunk; });
      res.on('end', () => {
        try {
          const json = JSON.parse(raw);
          if (json.status === 'success') {
            console.log(`[Location] Auto-detected: ${json.city}, ${json.regionName} (${json.lat}, ${json.lon})`);
            resolve({ latitude: json.lat, longitude: json.lon, city: json.city });
          } else {
            console.warn('[Location] ip-api returned failure status');
            resolve(null);
          }
        } catch (e) {
          console.warn('[Location] Failed to parse ip-api response:', e.message);
          resolve(null);
        }
      });
    });
    req.on('error',   () => { console.warn('[Location] ip-api request error'); resolve(null); });
    req.on('timeout', () => { req.destroy(); console.warn('[Location] ip-api timeout'); resolve(null); });
  });
}


const SETTINGS_FILE = path.join(APP_DIR, 'settings.json');

function loadSettings() {
  try {
    if (!fs.existsSync(SETTINGS_FILE)) return;
    const saved = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
    if (saved.location)         LOC         = { ...LOC,      ...saved.location };
    if (saved.calculationMethod) CALC_METHOD = saved.calculationMethod;
    if (saved.asrMethod)         ASR_METHOD  = saved.asrMethod;
    if (saved.highLatitudeRule)  HL_RULE     = saved.highLatitudeRule;
    if (saved.display)           DISP_CFG    = { ...DISP_CFG, ...saved.display };
    console.log('[Settings] Loaded from settings.json');
  } catch (e) {
    console.warn('[Settings] Could not load settings.json:', e.message);
  }
}

function saveSettings(data) {
  try {
    fs.writeFileSync(SETTINGS_FILE, JSON.stringify(data, null, 2), 'utf8');
    console.log('[Settings] Saved.');
  } catch (e) {
    console.warn('[Settings] Could not save settings.json:', e.message);
  }
}

// ─────────────────────────────────────────────────────────────
//  Wallpaper rotation — crossfades images from assets/images/
// ─────────────────────────────────────────────────────────────
let wallpaperTimer    = null;   // setInterval handle
let wallpaperImages   = [];     // array of file:// URLs
let wallpaperIndex    = 0;
let wallpaperActiveEl = 'a';    // which layer is currently visible ('a' or 'b')

function loadWallpaperImages() {
  const imgDir = path.join(__dirname, 'assets', 'images');
  const exts   = /\.(jpg|jpeg|png|webp|gif|bmp)$/i;
  try {
    if (!fs.existsSync(imgDir)) return [];
    return fs.readdirSync(imgDir)
      .filter(f => exts.test(f))
      .map(f => `file://${path.join(imgDir, f).replace(/\\/g, '/')}`);
  } catch (e) {
    console.warn('[Wallpaper] Could not read images folder:', e.message);
    return [];
  }
}

function showWallpaperImage(url) {
  // Alternate between layer A and layer B
  const next     = wallpaperActiveEl === 'a' ? 'b' : 'a';
  const layerNext = document.getElementById(`wallpaper-${next}`);
  const layerPrev = document.getElementById(`wallpaper-${wallpaperActiveEl}`);

  if (!layerNext || !layerPrev) return;

  // Load new image into the hidden layer, then crossfade
  layerNext.style.backgroundImage = `url("${url}")`;
  layerNext.classList.add('active');
  layerPrev.classList.remove('active');
  wallpaperActiveEl = next;

  // Sample the image and update clock color to contrast nicely
  updateClockColorFromImage(url);
}

function startWallpaperRotation(intervalMs) {
  wallpaperImages = loadWallpaperImages();
  if (wallpaperImages.length === 0) {
    console.warn('[Wallpaper] No images found in assets/images/ — wallpaper disabled');
    return;
  }

  // Shuffle so order is random each session
  wallpaperImages.sort(() => Math.random() - 0.5);

  // Show first image immediately
  showWallpaperImage(wallpaperImages[0]);
  wallpaperIndex = 0;

  // Rotate on interval
  clearInterval(wallpaperTimer);
  wallpaperTimer = setInterval(() => {
    wallpaperIndex = (wallpaperIndex + 1) % wallpaperImages.length;
    showWallpaperImage(wallpaperImages[wallpaperIndex]);
  }, intervalMs || 30000);

  console.log(`[Wallpaper] Rotating ${wallpaperImages.length} images every ${(intervalMs||30000)/1000}s`);
}

function stopWallpaperRotation() {
  clearInterval(wallpaperTimer);
  wallpaperTimer = null;
  const a = document.getElementById('wallpaper-a');
  const b = document.getElementById('wallpaper-b');
  if (a) a.classList.remove('active');
  if (b) b.classList.remove('active');
  resetClockColor();  // back to default gold
}

// ─────────────────────────────────────────────────────────────
//  Color extraction — samples the clock region of a wallpaper
//  image and returns the average RGB color there.
//  Uses Node.js fs to read the file as base64 (avoids canvas
//  taint issues with file:// URLs in Electron).
// ─────────────────────────────────────────────────────────────
function fileUrlToPath(fileUrl) {
  // file://C:/path/to/img.jpg  →  C:\path\to\img.jpg  (Windows)
  let p = decodeURIComponent(fileUrl.replace(/^file:\/\//, ''));
  if (process.platform === 'win32' && p.startsWith('/')) p = p.slice(1);
  return p.replace(/\//g, path.sep);
}

function extractAvgColor(imageUrl) {
  return new Promise((resolve) => {
    try {
      const filePath = fileUrlToPath(imageUrl);
      const buffer   = fs.readFileSync(filePath);
      const ext      = path.extname(filePath).slice(1).toLowerCase();
      const mime     = (ext === 'jpg' || ext === 'jpeg') ? 'image/jpeg'
                     : ext === 'png' ? 'image/png'
                     : ext === 'webp' ? 'image/webp' : 'image/jpeg';
      const dataUrl  = `data:${mime};base64,${buffer.toString('base64')}`;

      const img = new Image();
      img.onload = () => {
        try {
          // Sample just the clock area: centre-top 60% wide × top 40% tall
          const sw = img.naturalWidth  * 0.6;
          const sh = img.naturalHeight * 0.4;
          const sx = img.naturalWidth  * 0.2;
          const sy = img.naturalHeight * 0.02;

          const canvas = document.createElement('canvas');
          canvas.width  = 80;
          canvas.height = 40;
          const ctx = canvas.getContext('2d');
          ctx.drawImage(img, sx, sy, sw, sh, 0, 0, 80, 40);

          const data = ctx.getImageData(0, 0, 80, 40).data;
          let r = 0, g = 0, b = 0, n = 0;
          for (let i = 0; i < data.length; i += 4) {
            if (data[i + 3] > 20) { r += data[i]; g += data[i+1]; b += data[i+2]; n++; }
          }
          resolve(n > 0 ? { r: r/n, g: g/n, b: b/n } : null);
        } catch (e) { resolve(null); }
      };
      img.onerror = () => resolve(null);
      img.src = dataUrl;
    } catch (e) { resolve(null); }
  });
}

// ─────────────────────────────────────────────────────────────
//  Color math helpers
// ─────────────────────────────────────────────────────────────
function rgbToHsl(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  const l   = (max + min) / 2;
  if (max === min) return { h: 0, s: 0, l: l * 100 };
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h;
  switch (max) {
    case r: h = ((g - b) / d + (g < b ? 6 : 0)) / 6; break;
    case g: h = ((b - r) / d + 2) / 6; break;
    default: h = ((r - g) / d + 4) / 6;
  }
  return { h: h * 360, s: s * 100, l: l * 100 };
}

function luminance(r, g, b) {
  // Relative luminance (WCAG formula)
  const lin = v => { v /= 255; return v <= 0.03928 ? v/12.92 : Math.pow((v+0.055)/1.055, 2.4); };
  return 0.2126*lin(r) + 0.7152*lin(g) + 0.0722*lin(b);
}

// Given the average background color under the clock, pick a
// high-contrast, vibrant clock color with a matching neon glow.
function generateClockColor(avg) {
  if (!avg) {
    // Default: gold
    return { color: '#d4af37', glow: 'rgba(212,175,55,0.45)' };
  }

  const lum = luminance(avg.r, avg.g, avg.b);
  const { h } = rgbToHsl(avg.r, avg.g, avg.b);

  // Complementary hue (opposite on wheel)
  const compH = (h + 180) % 360;

  let clockL, clockS;
  if (lum < 0.2) {
    // Very dark background → bright vivid colour
    clockL = 78; clockS = 90;
  } else if (lum < 0.5) {
    // Medium background → bright saturated
    clockL = 82; clockS = 85;
  } else {
    // Light background → deep rich colour
    clockL = 38; clockS = 95;
  }

  const color = `hsl(${Math.round(compH)}, ${clockS}%, ${clockL}%)`;
  const glow  = `hsla(${Math.round(compH)}, ${clockS}%, ${Math.max(clockL - 15, 30)}%, 0.55)`;

  return { color, glow };
}

// Apply clock color to :root CSS variables
function applyClockColor(color, glow) {
  const root = document.documentElement;
  root.style.setProperty('--clock-color', color);
  root.style.setProperty('--clock-glow',  glow);
}

// Reset to default gold when wallpaper is off
function resetClockColor() {
  const root = document.documentElement;
  root.style.setProperty('--clock-color', '#d4af37');
  root.style.setProperty('--clock-glow',  'rgba(212,175,55,0.40)');
}

// ─────────────────────────────────────────────────────────────
//  Update clock color based on current wallpaper image
// ─────────────────────────────────────────────────────────────
async function updateClockColorFromImage(imageUrl) {
  const avg = await extractAvgColor(imageUrl);
  const { color, glow } = generateClockColor(avg);
  applyClockColor(color, glow);
  console.log(`[Color] bg≈rgb(${avg ? [Math.round(avg.r),Math.round(avg.g),Math.round(avg.b)].join(',') : '?'}) → clock: ${color}`);
}

function applyTheme(themeName, intervalMs) {
  const body = document.body;
  if (themeName === 'wallpaper') {
    body.classList.add('theme-wallpaper');
    startWallpaperRotation(intervalMs || DISP_CFG.wallpaperIntervalMs || 30000);
  } else {
    body.classList.remove('theme-wallpaper');
    stopWallpaperRotation();
  }
}

// ─────────────────────────────────────────────────────────────
//  Quran Verses (Arabic + English + Surah reference)
// ─────────────────────────────────────────────────────────────
const VERSES = [
  // --- ORIGINAL ENTRIES ---
  { ar: 'بِسْمِ ٱللَّهِ ٱلرَّحْمَٰنِ ٱلرَّحِيمِ', en: 'In the name of Allah, the Most Gracious, the Most Merciful.', ref: 'Al-Fatiha 1:1' },
  { ar: 'ٱلْحَمْدُ لِلَّهِ رَبِّ ٱلْعَٰلَمِينَ', en: 'All praise is due to Allah, Lord of all the worlds.', ref: 'Al-Fatiha 1:2' },
  { ar: 'إِنَّ مَعَ ٱلْعُسْرِ يُسْرًا', en: 'Indeed, with hardship comes ease.', ref: 'Ash-Sharh 94:6' },
  { ar: 'وَٱسْتَعِينُوا۟ بِٱلصَّبْرِ وَٱلصَّلَوٰةِ ۚ إِنَّ ٱللَّهَ مَعَ ٱلصَّٰبِرِينَ', en: 'Seek help through patience and prayer. Indeed, Allah is with the patient.', ref: 'Al-Baqarah 2:153' },
  { ar: 'حَٰفِظُوا۟ عَلَى ٱلصَّلَوَٰتِ وَٱلصَّلَوٰةِ ٱلْوُسْطَىٰ', en: 'Guard strictly your prayers, especially the middle prayer.', ref: 'Al-Baqarah 2:238' },
  { ar: 'وَلَذِكْرُ ٱللَّهِ أَكْبَرُ', en: 'And the remembrance of Allah is the greatest.', ref: 'Al-Ankabut 29:45' },
  { ar: 'أَلَا بِذِكْرِ ٱللَّهِ تَطْمَئِنُّ ٱلْقُلُوبُ', en: 'Verily, in the remembrance of Allah do hearts find rest.', ref: 'Ar-Ra\'d 13:28' },
  { ar: 'وَهُوَ مَعَكُمْ أَيْنَ مَا كُنتُمْ', en: 'And He is with you wherever you are.', ref: 'Al-Hadid 57:4' },
  { ar: 'إِنَّ ٱللَّهَ لَا يُضِيعُ أَجْرَ ٱلْمُحْسِنِينَ', en: 'Indeed, Allah does not waste the reward of the doers of good.', ref: 'At-Tawbah 9:120' },
  { ar: 'وَمَن يَتَّقِ ٱللَّهَ يَجْعَل لَّهُۥ مَخْرَجًا', en: 'And whoever fears Allah — He will make a way out for him.', ref: 'At-Talaq 65:2' },
  { ar: 'وَمَن يَتَوَكَّلْ عَلَى ٱللَّهِ فَهُوَ حَسْبُهُۥٓ', en: 'And whoever relies upon Allah — then He is sufficient for him.', ref: 'At-Talaq 65:3' },
  { ar: 'فَٱذْكُرُونِىٓ أَذْكُرْكُمْ', en: 'Remember Me, and I will remember you.', ref: 'Al-Baqarah 2:152' },
  { ar: 'وَإِذَا سَأَلَكَ عِبَادِى عَنِّى فَإِنِّى قَرِيبٌ', en: 'And when My servants ask about Me — indeed I am near.', ref: 'Al-Baqarah 2:186' },
  { ar: 'رَبَّنَآ ءَاتِنَا فِى ٱلدُّنْيَا حَسَنَةً وَفِى ٱلْآخِرَةِ حَسَنَةً', en: 'Our Lord, give us good in this world and good in the Hereafter.', ref: 'Al-Baqarah 2:201' },
  { ar: 'لَا يُكَلِّفُ ٱللَّهُ نَفْسًا إِلَّا وُسْعَهَا', en: 'Allah does not burden a soul beyond that it can bear.', ref: 'Al-Baqarah 2:286' },
  { ar: 'قُلْ هُوَ ٱللَّهُ أَحَدٌ', en: 'Say: He is Allah, the One.', ref: 'Al-Ikhlas 112:1' },
  { ar: 'ٱللَّهُ لَآ إِلَٰهَ إِلَّا هُوَ ٱلْحَىُّ ٱلْقَيُّومُ', en: 'Allah — there is no deity except Him, the Ever-Living, the Sustainer of all existence.', ref: 'Al-Baqarah 2:255' },
  { ar: 'إِنَّ ٱللَّهَ كَانَ عَلِيمًا حَكِيمًا', en: 'Indeed, Allah is ever Knowing and Wise.', ref: 'An-Nisa 4:11' },
  { ar: 'وَبِٱلْأَسْحَارِ هُمْ يَسْتَغْفِرُونَ', en: 'And in the hours before dawn they would ask forgiveness.', ref: 'Adh-Dhariyat 51:18' },
  { ar: 'وَأَقِمِ ٱلصَّلَوٰةَ إِنَّ ٱلصَّلَوٰةَ تَنْهَىٰ عَنِ ٱلْفَحْشَآءِ وَٱلْمُنكَرِ', en: 'Establish prayer. Indeed, prayer prohibits immorality and wrongdoing.', ref: 'Al-Ankabut 29:45' },
  { ar: 'وَسَبِّحْ بِحَمْدِ رَبِّكَ قَبْلَ طُلُوعِ ٱلشَّمْسِ وَقَبْلَ غُرُوبِهَا', en: 'Glorify the praises of your Lord before sunrise and before sunset.', ref: 'Taha 20:130' },
  { ar: 'يَٰٓأَيُّهَا ٱلَّذِينَ ءَامَنُوا۟ ٱسْتَعِينُوا۟ بِٱلصَّبْرِ وَٱلصَّلَوٰةِ', en: 'O you who believe! Seek help through patience and prayer.', ref: 'Al-Baqarah 2:153' },
  { ar: 'تَبَٰرَكَ ٱلَّذِى بِيَدِهِ ٱلْمُلْكُ وَهُوَ عَلَىٰ كُلِّ شَىْءٍ قَدِيرٌ', en: 'Blessed is He in whose hand is dominion, and He is over all things competent.', ref: 'Al-Mulk 67:1' },
  { ar: 'وَٱعْبُدْ رَبَّكَ حَتَّىٰ يَأْتِيَكَ ٱلْيَقِينُ', en: 'And worship your Lord until there comes to you the certainty.', ref: 'Al-Hijr 15:99' },
  { ar: 'سُبْحَٰنَ رَبِّكَ رَبِّ ٱلْعِزَّةِ عَمَّا يَصِفُونَ', en: 'Glory be to your Lord, the Lord of might, above what they describe.', ref: 'As-Saffat 37:180' },

  // --- NEW QURANIC VERSES (MOTIVATION, HOPES, & LIFE LESSONS) ---
  { ar: 'لَئِن شَكَرْتُمْ لَأَزِيدَنَّكُمْ', en: 'If you are grateful, I will surely increase you.', ref: 'Ibrahim 14:7' },
  { ar: 'قُلْ يَا عِبَادِيَ الَّذِينَ أَسْرَفُوا عَلَىٰ أَنفُسِهِمْ لَا تَقْنَطُوا مِن رَّحْمَةِ اللَّهِ', en: 'Say, "O My servants who have transgressed against themselves, do not despair of the mercy of Allah."', ref: 'Az-Zumar 39:53' },
  { ar: 'وَتَزَوَّدُوا فَإِنَّ خَيْرَ الزَّادِ التَّقْوَىٰ', en: 'And take provisions, but indeed, the best provision is righteousness.', ref: 'Al-Baqarah 2:197' },
  { ar: 'وَقُل رَّبِّ زِدْنِي عِلْمًا', en: 'And say, "My Lord, increase me in knowledge."', ref: 'Taha 20:114' },
  { ar: 'عَسَىٰ أَن تَكْرَهُوا شَيْئًا وَهُوَ خَيْرٌ لَّكُمْ', en: 'Perhaps you hate a thing and it is good for you.', ref: 'Al-Baqarah 2:216' },
  { ar: 'وَعَسَىٰ أَن تُحِبُّوا شَيْئًا وَهُوَ شَرٌّ لَّكُمْ ۗ وَاللَّهُ يَعْلَمُ وَأَنتُمْ لَا تَعْلَمُونَ', en: 'And perhaps you love a thing and it is bad for you. And Allah knows, while you know not.', ref: 'Al-Baqarah 2:216' },
  { ar: 'إِنَّ اللَّهَ يُحِبُّ التَّوَّابِينَ وَيُحِبُّ الْمُتَطَهِّرِينَ', en: 'Indeed, Allah loves those who are constantly repentant and loves those who purify themselves.', ref: 'Al-Baqarah 2:222' },
  { ar: 'وَأَحْسِنُوا ۛ إِنَّ اللَّهَ يُحِبُّ الْمُحْسِنِينَ', en: 'And do good; indeed, Allah loves the doers of good.', ref: 'Al-Baqarah 2:195' },
  { ar: 'إِنَّ اللَّهَ يُحِبُّ الْمُتَوَكِّلِينَ', en: 'Indeed, Allah loves those who rely [upon Him].', ref: 'Ali \'Imran 3:159' },
  { ar: 'فَاصْبِرْ صَبْرًا جَمِيلًا', en: 'So be patient with a beautiful patience.', ref: 'Al-Ma\'arij 70:5' },
  { ar: 'وَاصْبِرْ وَمَا صَبْرُكَ إِلَّا بِاللَّهِ', en: 'And be patient, and your patience is not but through Allah.', ref: 'An-Nahl 16:127' },
  { ar: 'وَالَّذِينَ جَاهَدُوا فِينَا لَنَهْدِيَنَّهُمْ سُبُلَنَا', en: 'And those who strive for Us - We will surely guide them to Our ways.', ref: 'Al-\'Ankabut 29:69' },
  { ar: 'إِنَّ اللَّهَ مَعَ الَّذِينَ اتَّقَوا وَّالَّذِينَ هُم مُّحْسِنُونَ', en: 'Indeed, Allah is with those who fear Him and those who are doers of good.', ref: 'An-Nahl 16:128' },
  { ar: 'وَمَن يَقْتَرِفْ حَسَنَةً نَّزِدْ لَهُ فِيهَا حُسْنًا', en: 'And whoever commits a good deed - We will increase for him good therein.', ref: 'Ash-Shura 42:22' },
  { ar: 'إِنَّ الْحَسَنَاتِ يُذْهِبْنَ السَّيِّئَاتِ', en: 'Indeed, good deeds do away with misdeeds.', ref: 'Hud 11:114' },
  { ar: 'فَمَن يَعْمَلْ مِثْقَالَ ذَرَّةٍ خَيْرًا يَرَهُ', en: 'So whoever does an atom\'s weight of good will see it.', ref: 'Az-Zalzalah 99:7' },
  { ar: 'وَقُولُوا لِلنَّاسِ حُسْنًا', en: 'And speak to people good words.', ref: 'Al-Baqarah 2:83' },
  { ar: 'ادْفَعْ بِالَّتِي هِيَ أَحْسَنُ', en: 'Repel [evil] by that [deed] which is better.', ref: 'Fussilat 41:34' },
  { ar: 'وَالْكَاظِمِينَ الْغَيْظَ وَالْعَافِينَ عَنِ النَّاسِ', en: 'And who restrain anger and who pardon the people.', ref: 'Ali \'Imran 3:134' },
  { ar: 'فَإِذَا عَزَمْتَ فَتَوَكَّلْ عَلَى اللَّهِ', en: 'And when you have decided, then rely upon Allah.', ref: 'Ali \'Imran 3:159' },
  { ar: 'وَلَا تَهِنُوا وَلَا تَحْزَنُوا وَأَنتُمُ الْأَعْلَوْنَ إِن كُنتُم مُّؤْمِنِينَ', en: 'So do not weaken and do not grieve, and you will be superior if you are [true] believers.', ref: 'Ali \'Imran 3:139' },
  { ar: 'إِن يَنصُرْكُمُ اللَّهِ فَلَا غَالِبَ لَكُمْ', en: 'If Allah should aid you, no one can overcome you.', ref: 'Ali \'Imran 3:160' },
  { ar: 'رَبَّنَا لَا تُزِغْ قُلُوبَنَا بَعْدَ إِذْ هَدَيْتَنَا', en: 'Our Lord, let not our hearts deviate after You have guided us.', ref: 'Ali \'Imran 3:8' },
  { ar: 'يَا أَيُّهَا النَّاسُ أَنْتُمُ الْفُقَرَاءُ إِلَى اللَّهِ ۖ وَاللَّهُ هُوَ الْغَنِيُّ الْحَمِيدُ', en: 'O mankind, you are those in need of Allah, while Allah is the Free of need, the Praiseworthy.', ref: 'Fatir 35:15' },
  { ar: 'مَنْ عَمِلَ صَالِحًا مِّن ذَكَرٍ أَوْ أُنثَىٰ وَهُوَ مُؤْمِنٌ فَلَنُحْيِيَنَّهُ حَيَاةً طَيِّبَةً', en: 'Whoever does righteousness, whether male or female, while he is a believer - We will surely cause him to live a good life.', ref: 'An-Nahl 16:97' },
  { ar: 'وَأَن لَّيْسَ لِلْإِنسَانِ إِلَّا مَا سَعَىٰ', en: 'And that there is not for man except that for which he strives.', ref: 'An-Najm 53:39' },
  { ar: 'وَأَنَّ سَعْيَهُ سَوْفَ يُرَىٰ', en: 'And that his effort is going to be seen.', ref: 'An-Najm 53:40' },
  { ar: 'وَلَسَوْفَ يُعْطِيكَ رَبُّكَ فَتَرْضَىٰ', en: 'And your Lord is going to give you, and you will be satisfied.', ref: 'Ad-Duha 93:5' },
  { ar: 'أَلَمْ يَجِدْكَ يَتِيمًا فَآوَىٰ', en: 'Did He not find you an orphan and give [you] refuge?', ref: 'Ad-Duha 93:6' },
  { ar: 'وَوَجَدَكَ ضَالًّا فَهَدَىٰ', en: 'And He found you lost and guided [you].', ref: 'Ad-Duha 93:7' },
  { ar: 'وَوَجَدَكَ عَائِلًا فَأَغْنَىٰ', en: 'And He found you poor and made [you] self-sufficient.', ref: 'Ad-Duha 93:8' },
  { ar: 'مَا وَدَّعَكَ رَبُّكَ وَمَا قَلَىٰ', en: 'Your Lord has not taken leave of you, nor has He detested you.', ref: 'Ad-Duha 93:3' },
  { ar: 'وَلَلْآخِرَةُ خَيْرٌ لَّكَ مِنَ الْأُولَىٰ', en: 'And the Hereafter is better for you than the first [life].', ref: 'Ad-Duha 93:4' },
  { ar: 'فَاجْعَلْ أَفْئِدَةً مِّنَ النَّاسِ تَهْوِي إِلَيْهِمْ', en: 'So make hearts among the people incline toward them.', ref: 'Ibrahim 14:37' },
  { ar: 'وَجَعَلْنَا بَعْضَكُمْ لِبَعْضٍ فِتْنَةً أَتَصْبِرُونَ', en: 'And We have made some of you as a trial for others - will you have patience?', ref: 'Al-Furqan 25:20' },
  { ar: 'وَمَا كَانَ رَبُّكَ نَسِيًّا', en: 'And never is your Lord forgetful.', ref: 'Maryam 19:64' },
  { ar: 'قَالَ لَا تَخَافَا ۖ إِنَّنِي مَعَكُمَا أَسْمَعُ وَأَرَىٰ', en: 'He said, "Fear not. Indeed, I am with you both; I hear and I see."', ref: 'Taha 20:46' },
  { ar: 'إِنَّ رَبِّي لَسَمِيعُ الدُّعَاءِ', en: 'Indeed, my Lord is the Hearer of supplication.', ref: 'Ibrahim 14:39' },
  { ar: 'رَبِّ اشْرَحْ لِي صَدْرِي', en: 'My Lord, expand for me my breast [with assurance].', ref: 'Taha 20:25' },
  { ar: 'وَيَسِّرْ لِي أَمْرِي', en: 'And ease for me my task.', ref: 'Taha 20:26' },
  { ar: 'وَاحْلُلْ عُقْدَةً مِّن لِّسَانِي', en: 'And untie the knot from my tongue.', ref: 'Taha 20:27' },
  { ar: 'يَفْقَهُوا قَوْلِي', en: 'That they may understand my speech.', ref: 'Taha 20:28' },
  { ar: 'أَنِّي مَسَّنِيَ الضُّرُّ وَأَنتَ أَرْحَمُ الرَّاحِمِينَ', en: '"Indeed, adversity has touched me, and you are the Most Merciful of the merciful."', ref: 'Al-Anbiya 21:83' },
  { ar: 'لَّا إِلَٰهَ إِلَّا أَنتَ سُبْحَانَكَ إِنِّي كُنتُ مِنَ الظَّالِمِينَ', en: '"There is no deity except You; exalted are You. Indeed, I have been of the wrongdoers."', ref: 'Al-Anbiya 21:87' },
  { ar: 'فَاسْتَجَبْنَا لَهُ وَنَجَّيْنَاهُ مِنَ الْغَمِّ ۚ وَكَذَٰلِكَ نُنجِي الْمُؤْمِنِينَ', en: 'So We answered him and delivered him from the distress. And thus do We save the believers.', ref: 'Al-Anbiya 21:88' },
  { ar: 'رَبِّ لَا تَذَرْنِي فَرْدًا وَأَنتَ خَيْرُ الْوَارِثِينَ', en: '"My Lord, do not leave me alone [with no heir], while you are the best of inheritors."', ref: 'Al-Anbiya 21:89' },
  { ar: 'وَخُلِقَ الْإِنزَانُ ضَعِيفًا', en: 'And mankind was created weak.', ref: 'An-Nisa 4:28' },
  { ar: 'يُرِيدُ اللَّهُ أَن يُخَفِّفَ عَنكُمْ', en: 'Allah intends to lighten [the burden] for you.', ref: 'An-Nisa 4:28' },
  { ar: 'إِنَّ رَحْمَتَ اللَّهِ قَرِيبٌ مِّنَ الْمُحْسِنِينَ', en: 'Indeed, the mercy of Allah is near to the doers of good.', ref: 'Al-A\'raf 7:56' },
  { ar: 'وَأُفَوِّضُ أَمْرِي إِلَى اللَّهِ ۚ إِنَّ اللَّهَ بَصِيرٌ بِالْعِبَادِ', en: 'And I entrust my affair to Allah. Indeed, Allah is Seeing of [His] servants.', ref: 'Ghafir 40:44' },
  { ar: 'قُلْ لَنْ يُصِيبَنَا إِلَّا مَا كَتَبَ اللَّهُ لَنَا', en: 'Say, "Never will we be struck except by what Allah has decreed for us."', ref: 'At-Tawbah 9:51' },
  { ar: 'هُوَ مَوْلَانَا ۚ وَعَلَى اللَّهِ فَلْيَتَوَكَّلِ الْمُؤْمِنُونَ', en: 'He is our protector; and upon Allah let the believers rely.', ref: 'At-Tawbah 9:51' },
  { ar: 'وَتَوَكَّلْ عَلَى الْحَيِّ الَّذِي لَا يَمُوتُ', en: 'And rely upon the Ever-Living who does not die.', ref: 'Al-Furqan 25:58' },
  { ar: 'الَّذِي خَلَقَنِي فَهُوَ يَهْدِينِ', en: 'Who created me, and He [it is who] guides me.', ref: 'Ash-Shu\'ara 26:78' },
  { ar: 'وَالَّذِي هُوَ يُطْعِمُنِي وَيَسْقِينِ', en: 'And it is He who feeds me and gives me drink.', ref: 'Ash-Shu\'ara 26:79' },
  { ar: 'وَإِذَا مَرِضْتُ فَهُوَ يَشْفِينِ', en: 'And when I am ill, it is He who cures me.', ref: 'Ash-Shu\'ara 26:80' },
  { ar: 'إِنَّ هَٰذَا الْقُرْآنَ يَهْدِي لِلَّتِي هِيَ أَقْوَمُ', en: 'Indeed, this Quran guides to that which is most suitable.', ref: 'Al-Isra 17:9' },
  { ar: 'وَنُنَزِّلُ مِنَ الْقُرْآنِ مَا هُوَ شِفَاءٌ وَرَحْمَةٌ لِّلْمُؤْمِنِينَ', en: 'And We send down of the Quran that which is healing and mercy for the believers.', ref: 'Al-Isra 17:82' },
  { ar: 'يَا أَيُّهَا الْإِنسَانُ مَا غَرَّكَ بِرَبِّكَ الْكَرِيمِ', en: 'O mankind, what has deceived you concerning your Lord, the Generous?', ref: 'Al-Infitar 82:6' },
  { ar: 'فَاطِرَ السَّمَاوَاتِ وَالْأَرْضِ أَنتَ وَلِيِّي فِي الدُّنْيَا وَالْآخِرَةِ', en: 'Creator of the heavens and earth, You are my protector in this world and the Hereafter.', ref: 'Yusuf 12:101' },
  { ar: 'تَوَفَّنِي مُسْلِمًا وَأَلْحِقْنِي بِالصَّالِحِينَ', en: 'Cause me to die a Muslim and join me with the righteous.', ref: 'Yusuf 12:101' },
  { ar: 'إِنَّ اللَّهَ مَعَنَا', en: '"Do not grieve; indeed Allah is with us."', ref: 'At-Tawbah 9:40' },
  { ar: 'وَمَا تَوْفِيقِي إِلَّا بِاللَّهِ ۚ عَلَيْهِ تَوَكَّلْتُ وَإِلَيْهِ أُنِيبُ', en: 'And my success is not but through Allah. Upon Him I have relied, and to Him I return.', ref: 'Hud 11:88' },

  // --- SAHIH HADITH (PROPHETIC WISDOM FROM PROPHET MUHAMMAD, peace be upon him) ---
  { ar: 'إِنَّمَا الأَعْمَالُ بِالنِّيَّاتِ', en: 'Actions are judged by motives and intentions.', ref: 'Sahih al-Bukhari 1' },
  { ar: 'إِنَّ اللَّهَ رَفِيقٌ يُحِبُّ الرِّفْقَ', en: 'Indeed, Allah is gentle and He loves gentleness.', ref: 'Sahih Muslim 2593' },
  { ar: 'الدِّينُ النَّصِيحَةُ', en: 'The religion is sincere advice.', ref: 'Sahih Muslim 55' },
  { ar: 'لَا يَشْكُرُ اللَّهَ مَنْ لَا يَشْكُرُ النَّاسَ', en: 'He who does not thank the people does not thank Allah.', ref: 'Sunan Abi Dawud 4811 (Sahih)' },
  { ar: 'الْكَلِمَةُ الطَّيِّبَةُ صَدَقَةٌ', en: 'A good word is a charitable act.', ref: 'Sahih al-Bukhari 2989' },
  { ar: 'تَبَسُّمُكَ فِي وَجْهِ أَخِيكَ لَكَ صَدَقَةٌ', en: 'Your smiling in the face of your brother is charity.', ref: 'Jami\' at-Tirmidhi 1956 (Sahih)' },
  { ar: 'الْمُؤْمِنُ الْقَوِيُّ خَيْرٌ وَأَحَبُّ إِلَى اللَّهِ مِنَ الْمُؤْمِنِ الضَّعِيفِ', en: 'A strong believer is better and more lovable to Allah than a weak believer.', ref: 'Sahih Muslim 2664' },
  { ar: 'احْرِصْ عَلَى مَا يَنْفَعُكَ وَاسْتَعِنْ بِاللَّهِ وَلَا تَعْجِزْ', en: 'Cherish that which gives you benefit, seek help from Allah and do not lose heart.', ref: 'Sahih Muslim 2664' },
  { ar: 'وَإِنْ أَصَابَكَ شَيْءٌ فَلَا تَقُلْ لَوْ أَنِّي فَعَلْتُ كَانَ كَذَا وَكَذَا', en: 'If anything afflicts you, do not say: "If I had only done such and such..."', ref: 'Sahih Muslim 2664' },
  { ar: 'قُلْ قَدَرُ اللَّهِ وَمَا شَاءَ فَعَلَ', en: 'Say: "It is the decree of Allah and He does what He wills."', ref: 'Sahih Muslim 2664' },
  { ar: 'يَسِّرُوا وَلَا تُعَسِّرُوا ، وَبَشِّرُوا وَلَا تُنَفِّرُوا', en: 'Make things easy for people and do not make them difficult, give good tidings and do not repel them.', ref: 'Sahih al-Bukhari 6125' },
  { ar: 'خَيْرُكُمْ مَنْ تَعَلَّمَ الْقُرْآنَ وَعَلَّمَهُ', en: 'The best among you are those who learn the Quran and teach it.', ref: 'Sahih al-Bukhari 5027' },
  { ar: 'اتَّقِ اللَّهَ حَيْثُمَا كُنْتَ', en: 'Fear Allah wherever you may be.', ref: 'Jami\' at-Tirmidhi 1987 (Sahih)' },
  { ar: 'وَأَتْبِعِ السَّيِّئَةَ الْحَسَنَةَ تَمْحُهَا', en: 'Follow up a bad deed with a good deed and it will wipe it out.', ref: 'Jami\' at-Tirmidhi 1987 (Sahih)' },
  { ar: 'وَخَالِقِ النَّاسَ بِخُلُقٍ حَسَنٍ', en: 'And behave towards the people with a good character.', ref: 'Jami\' at-Tirmidhi 1987 (Sahih)' },
  { ar: 'احْفَظِ اللَّهَ يَحْفَظْكَ', en: 'Be mindful of Allah and He will protect you.', ref: 'Jami\' at-Tirmidhi 2516 (Sahih)' },
  { ar: 'احْفَظِ اللَّهَ تَجِدْهُ تُجَاهَكَ', en: 'Be mindful of Allah and you will find Him in front of you.', ref: 'Jami\' at-Tirmidhi 2516 (Sahih)' },
  { ar: 'إِذَا سَأَلْتَ فَاسْأَلِ اللَّهَ', en: 'When you ask, ask Allah [alone].', ref: 'Jami\' at-Tirmidhi 2516 (Sahih)' },
  { ar: 'وَإِذَا اسْتَعَنْتَ فَاسْتَعِنْ بِاللَّهِ', en: 'And when you seek assistance, seek an assistance from Allah.', ref: 'Jami\' at-Tirmidhi 2516 (Sahih)' },
  { ar: 'وَاعْلَمْ أَنَّ النَّصْرَ مَعَ الصَّبْرِ', en: 'And know that victory comes with patience.', ref: 'Musnad Ahmad 2803 (Sahih)' },
  { ar: 'وَأَنَّ الْفَرَجَ مَعَ الْكَرْبِ', en: 'And relief comes with distress.', ref: 'Musnad Ahmad 2803 (Sahih)' },
  { ar: 'أَقْرَبُ مَا يَكُونُ الْعَبْدُ مِنْ رَبِّهِ وَهُوَ سَاجِدٌ', en: 'The nearest a servant comes to his Lord is when he is prostrating.', ref: 'Sahih Muslim 482' },
  { ar: 'مَنْ سَلَكَ طَرِيقًا يَلْتَمِسُ فِيهِ عِلْمًا سَهَّلَ اللَّهُ لَهُ بِهِ طَرِيقًا إِلَى الْجَنَّةِ', en: 'Whoever takes a path upon which to obtain knowledge, Allah makes the path to Paradise easy for him.', ref: 'Sahih Muslim 2699' },
  { ar: 'إِنَّ اللَّهَ لَا يَنْظُرُ إِلَى صُوَرِكُمْ وَأَمْوَالِكُمْ وَلَكِنْ يَنْظُرُ إِلَى قُلُوبِكُمْ وَأَعْمَالِكُمْ', en: 'Verily Allah does not look at your faces and your wealth, but He looks at your hearts and your deeds.', ref: 'Sahih Muslim 2564' },
  { ar: 'مَنْ كَانَ يُؤْمِنُ بِاللَّهِ وَالْيَوْمِ الآخِرِ فَلْيَقُلْ خَيْرًا أَوْ لِيَصْمُتْ', en: 'Whoever believes in Allah and the Last Day should speak what is good or keep quiet.', ref: 'Sahih al-Bukhari 6018' },
  { ar: 'لاَ يَدْخُلُ الْجَنَّةَ مَنْ كَانَ فِي قَلْبِهِ مِثْقَالُ ذَرَّةٍ مِنْ كِبْرٍ', en: 'He who has in his heart the weight of a mustard seed of pride shall not enter Paradise.', ref: 'Sahih Muslim 91' },
  { ar: 'لَيْسَ الْغِنَى عَنْ كَثْرَةِ الْعَرَضِ وَلَكِنَّ الْغِنَى غِنَى النَّفْسِ', en: 'Richness does not lie in the abundance of worldly goods, but true richness is the richness of the soul.', ref: 'Sahih al-Bukhari 6446' },
  { ar: 'مَنْ لاَ يَرْحَمِ النَّاسَ لاَ يَرْحَمْهُ اللَّهُ', en: 'He who does not show mercy to the people, Allah will not show mercy to him.', ref: 'Sahih Muslim 2319' },
  { ar: 'أَحَبُّ الأَعْمَالِ إِلَى اللَّهِ أَدْوَمُهَا وَإِنْ قَلَّ', en: 'The most beloved of deeds to Allah are those that are most consistent, even if they are small.', ref: 'Sahih al-Bukhari 5861' },
  { ar: 'مَنْ صَلَّى عَلَىَّ وَاحِدَةً صَلَّى اللَّهُ عَلَيْهِ عَشْرًا', en: 'Whoever sends blessings upon me once, Allah will send blessings upon him ten times.', ref: 'Sahih Muslim 408' },
  { ar: 'الدُّعَاءُ هُوَ الْعِبَادَةُ', en: 'Supplication (Dua) is the essence of worship.', ref: 'Jami\' at-Tirmidhi 2969 (Sahih)' },
  { ar: 'إِنَّ الدِّينَ يُسْرٌ', en: 'Indeed, the religion is easy.', ref: 'Sahih al-Bukhari 39' },
  { ar: 'طُوبَى لِمَنْ وَجَدَ فِي صَحِيفَتِهِ اسْتِغْفَارًا كَثِيرًا', en: 'Glad tidings to him who finds a lot of seeking forgiveness in his record.', ref: 'Sunan Ibn Majah 3818 (Sahih)' },
  { ar: 'مَا نَقَصَتْ صَدَقَةٌ مِنْ مَالٍ', en: 'Charity does not decrease wealth.', ref: 'Sahih Muslim 2588' },
  { ar: 'وَمَا زَادَ اللَّهُ عَبْدًا بِعَفْوٍ إِلاَّ عِزًّا', en: 'And Allah increases the honor of him who forgives.', ref: 'Sahih Muslim 2588' },
  { ar: 'وَمَا تَوَاضَعَ أَحَدٌ لِلَّهِ إِلاَّ رَفَعَهُ اللَّهُ', en: 'And no one humbles himself before Allah but Allah will exalt him.', ref: 'Sahih Muslim 2588' },
  { ar: 'الْطهُورُ شَطْرُ الإِيمَانِ', en: 'Purity is half of faith.', ref: 'Sahih Muslim 223' },
  { ar: 'الْحَمْدُ لِلَّهِ تَمْلأُ الْمِيزَانَ', en: 'Saying "Al-Hamdulillah" (All praise belongs to Allah) fills the scale.', ref: 'Sahih Muslim 223' },
  { ar: 'وَالصَّلاَةُ نُورٌ', en: 'And prayer is a light.', ref: 'Sahih Muslim 223' },
  { ar: 'وَالصَّدَقَةُ بُرْهَانٌ', en: 'And charity is a proof of faith.', ref: 'Sahih Muslim 223' },
  { ar: 'وَالصَّبْرُ ضِيَاءٌ', en: 'And patience is a bright glow.', ref: 'Sahih Muslim 223' },
  { ar: 'كُلُّ ابْنِ آدَمَ خَطَّاءٌ وَخَيْرُ الْخَطَّائِينَ التَّوَّابُونَ', en: 'Every son of Adam commits sin, and the best of those who commit sin are those who repent.', ref: 'Sunan Ibn Majah 4251 (Sahih)' },
  { ar: 'لَا تُظْهِرِ الشَّمَاتَةَ لِأَخِيكَ فَيَرْحَمَهُ اللَّهُ وَيَبْتَلِيكَ', en: 'Do not express joy at your brother\'s misfortune, lest Allah have mercy on him and afflict you.', ref: 'Jami\' at-Tirmidhi 2506 (Sahih)' }
];

// ─────────────────────────────────────────────────────────────
//  Hijri month names (Arabic)
// ─────────────────────────────────────────────────────────────
const HIJRI_MONTHS_AR = [
  'مُحَرَّم', 'صَفَر', 'رَبِيع الأَوَّل', 'رَبِيع الآخِر',
  'جُمَادَى الأُولَى', 'جُمَادَى الآخِرَة', 'رَجَب', 'شَعْبَان',
  'رَمَضَان', 'شَوَّال', 'ذُو القَعْدَة', 'ذُو الحِجَّة',
];

// ─────────────────────────────────────────────────────────────
//  Application State
// ─────────────────────────────────────────────────────────────
let prayerTimes    = null;   // { fajr, sunrise, dhuhr, asr, maghrib, isha } — Date objects
let todayKey       = '';     // YYYY-MM-DD, detect midnight rollover
let athanFired     = {};     // { prayerName: true } — reset each day
let verseIndex     = 0;
let cursorTimer    = null;

// ─────────────────────────────────────────────────────────────
//  DOM helpers
// ─────────────────────────────────────────────────────────────
const $ = id => document.getElementById(id);

// ─────────────────────────────────────────────────────────────
//  Utility — zero-pad numbers
// ─────────────────────────────────────────────────────────────
function pad2(n) { return String(Math.max(0, Math.round(n))).padStart(2, '0'); }

// ─────────────────────────────────────────────────────────────
//  Utility — date string key  YYYY-MM-DD
// ─────────────────────────────────────────────────────────────
function dateKey(d) {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

// ─────────────────────────────────────────────────────────────
//  Utility — format a Date for prayer display  (hh:mm AM/PM or HH:MM)
// ─────────────────────────────────────────────────────────────
function formatPrayerTime(date) {
  if (!date) return '--:--';
  const h = date.getHours();
  const m = date.getMinutes();
  if (DISP_CFG.clockFormat === '12') {
    const suffix = h >= 12 ? 'PM' : 'AM';
    const h12    = h % 12 || 12;
    return `${pad2(h12)}:${pad2(m)} ${suffix}`;
  }
  return `${pad2(h)}:${pad2(m)}`;
}

// ─────────────────────────────────────────────────────────────
//  Gregorian → Hijri calendar conversion
//  Algorithm: Tabular Islamic calendar (Reingold–Dershowitz)
// ─────────────────────────────────────────────────────────────
function toHijri(date) {
  const y = date.getFullYear();
  const m = date.getMonth() + 1; // 1–12
  const d = date.getDate();

  // Gregorian date → Julian Day Number
  const a  = Math.floor((14 - m) / 12);
  const y2 = y + 4800 - a;
  const m2 = m + 12 * a - 3;
  const jdn = d
    + Math.floor((153 * m2 + 2) / 5)
    + 365 * y2
    + Math.floor(y2 / 4)
    - Math.floor(y2 / 100)
    + Math.floor(y2 / 400)
    - 32045;

  // Julian Day Number → Hijri
  const l  = jdn - 1948440 + 10632;
  const n  = Math.floor((l - 1) / 10631);
  const l2 = l - 10631 * n + 354;
  const j  = Math.floor((10985 - l2) / 5316) * Math.floor((50 * l2) / 17719)
           + Math.floor(l2 / 5670) * Math.floor((43 * l2) / 15238);
  const l3 = l2
    - Math.floor((30 - j) / 15) * Math.floor((17719 * j) / 50)
    - Math.floor(j / 16) * Math.floor((15238 * j) / 43)
    + 29;

  const hMonth = Math.floor((24 * l3) / 709);
  const hDay   = l3 - Math.floor((709 * hMonth) / 24);
  const hYear  = 30 * n + j - 30;

  const mIdx = Math.max(0, Math.min(11, hMonth - 1));
  return `${hDay} ${HIJRI_MONTHS_AR[mIdx]} ${hYear} هـ`;
}

// ─────────────────────────────────────────────────────────────
//  Build adhan CalculationParameters from CONFIG
// ─────────────────────────────────────────────────────────────
function buildAdhanParams() {
  const methods = {
    NorthAmerica:          () => adhan.CalculationMethod.NorthAmerica(),
    MuslimWorldLeague:     () => adhan.CalculationMethod.MuslimWorldLeague(),
    Egyptian:              () => adhan.CalculationMethod.Egyptian(),
    Karachi:               () => adhan.CalculationMethod.Karachi(),
    UmmAlQura:             () => adhan.CalculationMethod.UmmAlQura(),
    Dubai:                 () => adhan.CalculationMethod.Dubai(),
    Kuwait:                () => adhan.CalculationMethod.Kuwait(),
    Qatar:                 () => adhan.CalculationMethod.Qatar(),
    Singapore:             () => adhan.CalculationMethod.Singapore(),
    Turkey:                () => adhan.CalculationMethod.Turkey(),
    Tehran:                () => adhan.CalculationMethod.Tehran(),
    MoonsightingCommittee: () => adhan.CalculationMethod.MoonsightingCommittee(),
  };

  const factory = methods[CALC_METHOD] || methods.NorthAmerica;
  const params  = factory();

  // Asr juristic school
  params.madhab = (ASR_METHOD === 'Hanafi')
    ? adhan.Madhab.Hanafi
    : adhan.Madhab.Shafi;

  // High-latitude rule
  const hlrMap = {
    None:              adhan.HighLatitudeRule.None,
    MiddleOfTheNight:  adhan.HighLatitudeRule.MiddleOfTheNight,
    SeventhOfTheNight: adhan.HighLatitudeRule.SeventhOfTheNight,
    TwilightAngle:     adhan.HighLatitudeRule.TwilightAngle,
  };
  params.highLatitudeRule = hlrMap[HL_RULE] || adhan.HighLatitudeRule.MiddleOfTheNight;

  return params;
}

// ─────────────────────────────────────────────────────────────
//  Calculate prayer times locally (offline — always available)
// ─────────────────────────────────────────────────────────────
function calcPrayerTimesLocal(date) {
  const coords = new adhan.Coordinates(LOC.latitude, LOC.longitude);
  const params = buildAdhanParams();
  const times  = new adhan.PrayerTimes(coords, date, params);

  return {
    fajr:    times.fajr,
    sunrise: times.sunrise,
    dhuhr:   times.dhuhr,
    asr:     times.asr,
    maghrib: times.maghrib,
    isha:    times.isha,
  };
}

// ─────────────────────────────────────────────────────────────
//  Parse a "HH:MM" string from aladhan into a Date for today
// ─────────────────────────────────────────────────────────────
function apiTimeToDate(timeStr, referenceDate) {
  if (!timeStr) return null;
  const [hh, mm] = timeStr.split(':').map(Number);
  const d = new Date(referenceDate);
  d.setHours(hh, mm, 0, 0);
  return d;
}

// ─────────────────────────────────────────────────────────────
//  Load cache (returns null if not found / stale)
// ─────────────────────────────────────────────────────────────
function loadCache(key) {
  try {
    const cachePath = path.join(APP_DIR, API_CFG.cacheFile);
    if (!fs.existsSync(cachePath)) return null;
    const data = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
    if (data.date !== key) return null;
    return data.timings; // { Fajr, Sunrise, Dhuhr, Asr, Maghrib, Isha }
  } catch (_) {
    return null;
  }
}

// ─────────────────────────────────────────────────────────────
//  Save to cache
// ─────────────────────────────────────────────────────────────
function saveCache(key, timings) {
  try {
    const cachePath = path.join(APP_DIR, API_CFG.cacheFile);
    const dir = path.dirname(cachePath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(cachePath, JSON.stringify({ date: key, timings }), 'utf8');
  } catch (e) {
    console.warn('[Cache] Write failed:', e.message);
  }
}

// ─────────────────────────────────────────────────────────────
//  Fetch prayer times from aladhan.com API (async, best-effort)
// ─────────────────────────────────────────────────────────────
function fetchApiPrayerTimes(date, key) {
  return new Promise((resolve, reject) => {
    const ts  = Math.floor(date.getTime() / 1000);
    const url = `https://api.aladhan.com/v1/timings/${ts}?latitude=${LOC.latitude}&longitude=${LOC.longitude}&method=${API_CFG.method}`;

    const req = https.get(url, { timeout: API_CFG.timeout }, (res) => {
      let raw = '';
      res.on('data', chunk => { raw += chunk; });
      res.on('end', () => {
        try {
          const json = JSON.parse(raw);
          if (json.code === 200 && json.data && json.data.timings) {
            saveCache(key, json.data.timings);
            resolve(json.data.timings);
          } else {
            reject(new Error('API returned unexpected data'));
          }
        } catch (e) {
          reject(e);
        }
      });
    });
    req.on('error',   reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('API timeout')); });
  });
}

// ─────────────────────────────────────────────────────────────
//  Load today's prayer times (API + cache + local fallback)
// ─────────────────────────────────────────────────────────────
async function loadPrayerTimes(date) {
  const key = dateKey(date);

  // Always start with local calculation (instant, no network needed)
  prayerTimes = calcPrayerTimesLocal(date);
  renderPrayerTimes();

  if (!API_CFG.enabled) return;

  // Try cache first
  const cached = loadCache(key);
  if (cached) {
    console.log('[Prayer] Using cached API times for', key);
    prayerTimes = {
      fajr:    apiTimeToDate(cached.Fajr,    date),
      sunrise: apiTimeToDate(cached.Sunrise, date),
      dhuhr:   apiTimeToDate(cached.Dhuhr,   date),
      asr:     apiTimeToDate(cached.Asr,     date),
      maghrib: apiTimeToDate(cached.Maghrib, date),
      isha:    apiTimeToDate(cached.Isha,    date),
    };
    renderPrayerTimes();
    return;
  }

  // Fetch from API
  try {
    console.log('[Prayer] Fetching from aladhan.com…');
    const timings = await fetchApiPrayerTimes(date, key);
    prayerTimes = {
      fajr:    apiTimeToDate(timings.Fajr,    date),
      sunrise: apiTimeToDate(timings.Sunrise, date),
      dhuhr:   apiTimeToDate(timings.Dhuhr,   date),
      asr:     apiTimeToDate(timings.Asr,     date),
      maghrib: apiTimeToDate(timings.Maghrib, date),
      isha:    apiTimeToDate(timings.Isha,    date),
    };
    console.log('[Prayer] API times loaded successfully');
    renderPrayerTimes();
  } catch (e) {
    console.warn('[Prayer] API fetch failed, using local calculation:', e.message);
  }
}

// ─────────────────────────────────────────────────────────────
//  Render prayer times to the DOM
// ─────────────────────────────────────────────────────────────
function renderPrayerTimes() {
  if (!prayerTimes) return;
  $('time-fajr').textContent    = formatPrayerTime(prayerTimes.fajr);
  $('time-sunrise').textContent = formatPrayerTime(prayerTimes.sunrise);
  $('time-dhuhr').textContent   = formatPrayerTime(prayerTimes.dhuhr);
  $('time-asr').textContent     = formatPrayerTime(prayerTimes.asr);
  $('time-maghrib').textContent = formatPrayerTime(prayerTimes.maghrib);
  $('time-isha').textContent    = formatPrayerTime(prayerTimes.isha);
}

// ─────────────────────────────────────────────────────────────
//  Prayer list (ordered) for state management
// ─────────────────────────────────────────────────────────────
const PRAYER_ORDER = ['fajr', 'sunrise', 'dhuhr', 'asr', 'maghrib', 'isha'];

const PRAYER_STATUS_LABELS = {
  fajr:    { current: 'CURRENT',  next: 'NEXT' },
  sunrise: { current: 'SHURUQ',   next: 'NEXT' },
  dhuhr:   { current: 'CURRENT',  next: 'NEXT' },
  asr:     { current: 'CURRENT',  next: 'NEXT' },
  maghrib: { current: 'CURRENT',  next: 'NEXT' },
  isha:    { current: 'CURRENT',  next: 'NEXT' },
};

// ─────────────────────────────────────────────────────────────
//  Update prayer card states (current / next / passed)
// ─────────────────────────────────────────────────────────────
function updatePrayerStates(now) {
  if (!prayerTimes) return;

  // Determine which prayer window is "current" (the most recent prayer that has passed)
  // and which is "next" (the first future prayer)
  let currentPrayer = null;
  let nextPrayer    = null;

  for (let i = 0; i < PRAYER_ORDER.length; i++) {
    const name = PRAYER_ORDER[i];
    const t    = prayerTimes[name];
    if (!t) continue;
    if (t <= now) {
      currentPrayer = name;
    } else if (!nextPrayer) {
      nextPrayer = name;
    }
  }

  // Apply CSS state classes
  PRAYER_ORDER.forEach(name => {
    const card       = document.getElementById(`prayer-${name}`);
    const statusEl   = document.getElementById(`status-${name}`);
    if (!card || !statusEl) return;

    card.classList.remove('state-current', 'state-next', 'state-passed');
    statusEl.textContent = '';

    if (name === currentPrayer) {
      card.classList.add('state-current');
      statusEl.textContent = PRAYER_STATUS_LABELS[name].current;
    } else if (name === nextPrayer) {
      card.classList.add('state-next');
      statusEl.textContent = PRAYER_STATUS_LABELS[name].next;
    } else if (prayerTimes[name] && prayerTimes[name] < now && name !== currentPrayer) {
      card.classList.add('state-passed');
    }
  });

  return { currentPrayer, nextPrayer };
}

// ─────────────────────────────────────────────────────────────
//  Update countdown to next prayer
// ─────────────────────────────────────────────────────────────
function updateCountdown(now) {
  if (!prayerTimes) return;

  // Find next prayer time
  let nextName = null;
  let nextTime = null;

  for (const name of PRAYER_ORDER) {
    const t = prayerTimes[name];
    if (t && t > now) {
      nextName = name;
      nextTime = t;
      break;
    }
  }

  const nameEl    = $('next-prayer-name');
  const cdDisplay = $('countdown-display');
  const cdH       = $('cd-h');
  const cdM       = $('cd-m');
  const cdS       = $('cd-s');

  if (!nextName || !nextTime) {
    // After Isha — show "until Fajr tomorrow" placeholder
    nameEl.textContent = 'Fajr';
    cdH.textContent    = '--';
    cdM.textContent    = '--';
    cdS.textContent    = '--';
    cdDisplay.classList.remove('imminent');
    return;
  }

  const diffMs  = nextTime.getTime() - now.getTime();
  const diffSec = Math.max(0, Math.floor(diffMs / 1000));
  const hours   = Math.floor(diffSec / 3600);
  const mins    = Math.floor((diffSec % 3600) / 60);
  const secs    = diffSec % 60;

  nameEl.textContent = nextName.charAt(0).toUpperCase() + nextName.slice(1);
  cdH.textContent    = pad2(hours);
  cdM.textContent    = pad2(mins);
  cdS.textContent    = pad2(secs);

  // Flash red when < 5 minutes remain
  cdDisplay.classList.toggle('imminent', diffMs < 5 * 60 * 1000);
}

// ─────────────────────────────────────────────────────────────
//  Athan audio trigger
// ─────────────────────────────────────────────────────────────
function checkAndPlayAthan(now) {
  if (!prayerTimes) return;

  const audioEl = $('athan-audio');
  if (!audioEl) return;

  for (const name of PRAYER_ORDER) {
    // Optionally skip Shuruq
    if (name === 'sunrise' && !AUDIO_CFG.playForShuruq) continue;
    if (athanFired[name]) continue;

    const t = prayerTimes[name];
    if (!t) continue;

    const diff = Math.abs(now.getTime() - t.getTime());
    if (diff <= AUDIO_CFG.triggerWindowMs && now >= t) {
      athanFired[name] = true;
      playAthan(name);
      break; // only one athan at a time
    }
  }
}

function playAthan(prayerName) {
  const audioEl = $('athan-audio');
  if (!audioEl) return;

  const src = path.join(__dirname, 'assets', 'audio', AUDIO_CFG.athanFile);
  if (!fs.existsSync(src)) {
    console.warn('[Athan] Audio file not found:', src);
    return;
  }

  console.log('[Athan] Playing for', prayerName);
  audioEl.src    = `file://${src}`;
  audioEl.volume = Math.min(1, Math.max(0, AUDIO_CFG.volume));
  audioEl.currentTime = 0;
  audioEl.play().catch(e => console.warn('[Athan] Playback error:', e.message));

  showAthanIndicator(prayerName);
}

function showAthanIndicator(prayerName) {
  // Create / reuse a floating toast indicator
  let indicator = document.querySelector('.athan-indicator');
  if (!indicator) {
    indicator = document.createElement('div');
    indicator.className = 'athan-indicator';
    document.body.appendChild(indicator);
  }
  const label = prayerName.charAt(0).toUpperCase() + prayerName.slice(1);
  indicator.textContent = `🕌  ${label} Athan`;
  indicator.classList.add('visible');

  // Auto-hide after 30 s
  setTimeout(() => indicator.classList.remove('visible'), 30000);
}

// ─────────────────────────────────────────────────────────────
//  Clock — update every second
// ─────────────────────────────────────────────────────────────
function tickClock() {
  const now = new Date();
  const key = dateKey(now);

  // ── Midnight rollover — reload prayer times for new day ──
  if (key !== todayKey) {
    todayKey   = key;
    athanFired = {};
    loadPrayerTimes(now);
    updateDates(now);
    updateLocation();
  }

  // ── Digital clock ────────────────────────────────────────
  let h   = now.getHours();
  const m = now.getMinutes();
  const s = now.getSeconds();

  if (DISP_CFG.clockFormat === '12') {
    $('ampm-display').textContent = h >= 12 ? 'PM' : 'AM';
    h = h % 12 || 12;
  } else {
    $('ampm-display').textContent = '';
  }

  $('clock-h').textContent = pad2(h);
  $('clock-m').textContent = pad2(m);

  if (DISP_CFG.showSeconds) {
    $('clock-s').textContent = pad2(s);
    document.querySelectorAll('.colon').forEach(el => el.style.display = '');
  } else {
    $('clock-s').textContent = '';
    // hide second colon
    const colons = document.querySelectorAll('.colon');
    if (colons[1]) colons[1].style.display = 'none';
  }

  // ── Prayer states + countdown ────────────────────────────
  updatePrayerStates(now);
  updateCountdown(now);
  checkAndPlayAthan(now);
}

// ─────────────────────────────────────────────────────────────
//  Date display (Gregorian + Hijri)
// ─────────────────────────────────────────────────────────────
function updateDates(date) {
  const DAYS   = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
  const MONTHS = ['January','February','March','April','May','June',
                  'July','August','September','October','November','December'];

  const dayName  = DAYS[date.getDay()];
  const monthName = MONTHS[date.getMonth()];
  const day      = date.getDate();
  const year     = date.getFullYear();

  $('date-gregorian').textContent = `${dayName}, ${day} ${monthName} ${year}`;
  $('date-hijri').textContent     = toHijri(date);
}

// ─────────────────────────────────────────────────────────────
//  Location chip
// ─────────────────────────────────────────────────────────────
function updateLocation() {
  const el = $('location-label');
  if (el) el.textContent = LOC.city || `${LOC.latitude.toFixed(2)}°, ${LOC.longitude.toFixed(2)}°`;
}

// ─────────────────────────────────────────────────────────────
//  Verse pool — merge hardcoded VERSES with ISLAMIC_DATABASE
//  (ISLAMIC_DATABASE comes from config.js and can be extended there)
// ─────────────────────────────────────────────────────────────
function buildVersePool() {
  // Normalise ISLAMIC_DATABASE entries to {ar, en, ref} shape
  const dbEntries = (typeof ISLAMIC_DATABASE !== 'undefined' ? ISLAMIC_DATABASE : [])
    .map(item => ({
      ar:  item.arabic      || '',
      en:  item.translation || '',
      ref: (item.type === 'hadith' ? 'Hadith: ' : '') + (item.reference || ''),
    }));

  // Merge: hardcoded VERSES first, then any extras from config.js
  return [...VERSES, ...dbEntries];
}

// ─────────────────────────────────────────────────────────────
//  Quran verse rotation (single implementation)
// ─────────────────────────────────────────────────────────────
function showVerse(pool, idx) {
  const v = pool[idx];
  if (!v) return;
  $('verse-arabic').textContent      = v.ar;
  $('verse-translation').textContent = v.en;
  $('verse-reference').textContent   = v.ref;
}

function startVerseRotation() {
  const pool      = buildVersePool();
  const container = $('verse-container');

  // Show first verse immediately
  showVerse(pool, verseIndex);

  // Rotate using CSS fade-out class (matches styles.css .fade-out transition)
  setInterval(() => {
    if (container) container.classList.add('fade-out');

    setTimeout(() => {
      verseIndex = (verseIndex + 1) % pool.length;
      showVerse(pool, verseIndex);
      if (container) container.classList.remove('fade-out');
    }, DISP_CFG.fadeMs);
  }, DISP_CFG.verseIntervalMs);
}

// ─────────────────────────────────────────────────────────────
//  Auto cursor-hide on inactivity
// ─────────────────────────────────────────────────────────────
function setupCursorHide() {
  const HIDE_DELAY = DISP_CFG.cursorHideMs || 3000;

  function showCursor() {
    document.body.classList.remove('hide-cursor');
    clearTimeout(cursorTimer);
    cursorTimer = setTimeout(() => {
      document.body.classList.add('hide-cursor');
    }, HIDE_DELAY);
  }

  document.addEventListener('mousemove',  showCursor, { passive: true });
  document.addEventListener('mousedown',  showCursor, { passive: true });
  document.addEventListener('touchstart', showCursor, { passive: true });

  // Start hidden
  cursorTimer = setTimeout(() => {
    document.body.classList.add('hide-cursor');
  }, HIDE_DELAY);
}

// ─────────────────────────────────────────────────────────────
//  Settings Modal — open / close / populate / save
// ─────────────────────────────────────────────────────────────
function setupSettingsModal() {
  const overlay    = $('settings-overlay');
  const openBtn    = $('settings-btn');
  const closeBtn   = $('settings-close');
  const cancelBtn  = $('settings-cancel');
  const saveBtn    = $('settings-save');
  const presetSel  = $('s-preset');

  if (!overlay) return;

  // ── Show/hide interval row based on theme selection ──────
  function syncWallpaperRow() {
    const theme = $('setting-theme') ? $('setting-theme').value : 'default';
    const row   = $('wp-interval-row');
    if (row) row.style.display = (theme === 'wallpaper') ? '' : 'none';
  }
  if ($('setting-theme')) {
    $('setting-theme').addEventListener('change', syncWallpaperRow);
  }

  // ── Open ──────────────────────────────────────────────────
  function openSettings() {
    // Populate fields with current live values
    $('s-city').value    = LOC.city || '';
    $('s-lat').value     = LOC.latitude;
    $('s-lng').value     = LOC.longitude;
    $('s-method').value  = CALC_METHOD;
    $('s-asr').value     = ASR_METHOD;
    $('s-hl').value      = HL_RULE;
    $('s-clockfmt').value = DISP_CFG.clockFormat;
    $('s-seconds').checked = DISP_CFG.showSeconds;
    if ($('setting-theme')) $('setting-theme').value = DISP_CFG.theme || 'default';
    if ($('s-wp-interval')) $('s-wp-interval').value = String(DISP_CFG.wallpaperIntervalMs || 30000);
    presetSel.value = '';
    syncWallpaperRow();

    overlay.classList.add('open');
    $('s-city').focus();
  }

  // ── Close ─────────────────────────────────────────────────
  function closeSettings() {
    overlay.classList.remove('open');
  }

  // ── Preset picker — auto-fills lat/lng/city ───────────────
  presetSel.addEventListener('change', () => {
    const val = presetSel.value;
    if (!val) return;
    const [lat, lng, city] = val.split(',');
    $('s-lat').value  = lat;
    $('s-lng').value  = lng;
    $('s-city').value = city;
  });

  // ── Save & Apply ──────────────────────────────────────────
  saveBtn.addEventListener('click', () => {
    const lat  = parseFloat($('s-lat').value);
    const lng  = parseFloat($('s-lng').value);
    const city = $('s-city').value.trim() || `${lat.toFixed(2)}°N`;

    if (isNaN(lat) || isNaN(lng) || lat < -90 || lat > 90 || lng < -180 || lng > 180) {
      showToast('⚠ Invalid coordinates — check Latitude / Longitude');
      return;
    }

    // Apply to live variables
    LOC.latitude   = lat;
    LOC.longitude  = lng;
    LOC.city       = city;
    CALC_METHOD    = $('s-method').value;
    ASR_METHOD     = $('s-asr').value;
    HL_RULE        = $('s-hl').value;
    DISP_CFG.clockFormat        = $('s-clockfmt').value;
    DISP_CFG.showSeconds        = $('s-seconds').checked;
    DISP_CFG.theme              = $('setting-theme') ? $('setting-theme').value : 'default';
    DISP_CFG.wallpaperIntervalMs = $('s-wp-interval') ? parseInt($('s-wp-interval').value) : 30000;

    // Apply theme immediately
    applyTheme(DISP_CFG.theme, DISP_CFG.wallpaperIntervalMs);

    // Persist
    saveSettings({
      location:          { latitude: lat, longitude: lng, city },
      calculationMethod: CALC_METHOD,
      asrMethod:         ASR_METHOD,
      highLatitudeRule:  HL_RULE,
      display: {
        clockFormat:         DISP_CFG.clockFormat,
        showSeconds:         DISP_CFG.showSeconds,
        theme:               DISP_CFG.theme,
        wallpaperIntervalMs: DISP_CFG.wallpaperIntervalMs,
      },
    });

    // Refresh prayer times + UI immediately
    athanFired = {};
    loadPrayerTimes(new Date());
    updateLocation();

    closeSettings();
    showToast('✓ Settings saved');
  });

  // ── Event bindings ────────────────────────────────────────
  openBtn.addEventListener('click', openSettings);
  closeBtn.addEventListener('click', closeSettings);
  cancelBtn.addEventListener('click', closeSettings);

  // ── Detect My Location button ─────────────────────────────
  const detectBtn = $('s-detect-btn');
  if (detectBtn) {
    detectBtn.addEventListener('click', async () => {
      detectBtn.textContent = '⟳ Detecting…';
      detectBtn.disabled = true;
      const detected = await detectLocationByIP();
      if (detected) {
        $('s-lat').value  = detected.latitude;
        $('s-lng').value  = detected.longitude;
        $('s-city').value = detected.city;
        detectBtn.textContent = '✓ Detected: ' + detected.city;
      } else {
        detectBtn.textContent = '✗ Failed — check internet';
      }
      setTimeout(() => {
        detectBtn.textContent = '⦿ Detect My Location';
        detectBtn.disabled = false;
      }, 3000);
    });
  }

  // Click backdrop to close
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) closeSettings();
  });

  // Escape key to close
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && overlay.classList.contains('open')) {
      closeSettings();
    }
  });
}

// ─────────────────────────────────────────────────────────────
//  Toast notification
// ─────────────────────────────────────────────────────────────
function showToast(msg) {
  let toast = document.querySelector('.settings-toast');
  if (!toast) {
    toast = document.createElement('div');
    toast.className = 'settings-toast';
    document.body.appendChild(toast);
  }
  toast.textContent = msg;
  toast.classList.add('show');
  setTimeout(() => toast.classList.remove('show'), 2800);
}

// ─────────────────────────────────────────────────────────────
//  Keyboard shortcuts (dev convenience)
// ─────────────────────────────────────────────────────────────
function setupKeyboardShortcuts() {
  document.addEventListener('keydown', (e) => {
    // Ctrl+Shift+D — reload prayer times (useful after config change)
    if (e.ctrlKey && e.shiftKey && e.key === 'D') {
      console.log('[Dev] Force reloading prayer times…');
      athanFired = {};
      loadPrayerTimes(new Date());
    }
  });
}

// ─────────────────────────────────────────────────────────────
//  Burn-in protection
//  Two complementary strategies:
//    1. Pixel drift   — shifts .app-main by a small random offset
//                       every 4 minutes so static elements never
//                       sit on the same pixels for long.
//    2. Dim cycle     — briefly dims the whole screen every 28 min
//                       (gives the panel a rest and breaks up any
//                       residual image forming on bright elements).
//
//  The slow CSS float animations (clock, countdown) in styles.css
//  are the third layer — they run independently of this code.
// ─────────────────────────────────────────────────────────────
function startBurnInProtection() {
  const DRIFT_INTERVAL = 4 * 60 * 1000;   // every 4 minutes
  const DIM_INTERVAL   = 28 * 60 * 1000;  // every 28 minutes
  const DIM_DURATION   = 9000;            // stay dim for 9 seconds

  // ── Pixel drift ───────────────────────────────────────────
  setInterval(() => {
    const el = document.querySelector('.app-main');
    if (!el) return;
    // Random offset ±5px horizontal, ±4px vertical
    const x = (Math.random() * 10 - 5).toFixed(1);
    const y = (Math.random() * 8  - 4).toFixed(1);
    el.style.transition = 'transform 8s ease';
    el.style.transform  = `translate(${x}px, ${y}px)`;
  }, DRIFT_INTERVAL);

  // ── Periodic dim cycle ────────────────────────────────────
  setInterval(() => {
    // Skip if settings modal is open — jarring to dim mid-interaction
    if (document.querySelector('.settings-overlay.open')) return;
    document.body.style.transition = 'opacity 2.5s ease';
    document.body.style.opacity    = '0.20';
    setTimeout(() => {
      document.body.style.opacity = '1';
    }, DIM_DURATION);
  }, DIM_INTERVAL);

  console.log('[BurnIn] Protection active — drift every 4 min, dim cycle every 28 min');
}

// ─────────────────────────────────────────────────────────────
//  Initialise everything
// ─────────────────────────────────────────────────────────────
async function init() {
  console.log('[App] Islamic Smart Clock starting…');

  // Load persisted user settings first (overrides config.js defaults)
  loadSettings();

  // Auto-detect location via IP — only if no saved location in settings.json
  // (if the user has manually set a city, we respect that)
  const hasManualLocation = (() => {
    try {
      if (!fs.existsSync(SETTINGS_FILE)) return false;
      const saved = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
      return !!(saved.location && saved.location.city);
    } catch (_) { return false; }
  })();

  if (!hasManualLocation) {
    console.log('[Location] No saved location — attempting auto-detect…');
    const detected = await detectLocationByIP();
    if (detected) {
      LOC.latitude  = detected.latitude;
      LOC.longitude = detected.longitude;
      LOC.city      = detected.city;
      console.log('[Location] Using auto-detected:', LOC.city);
    } else {
      console.warn('[Location] Auto-detect failed — using config.js default:', LOC.city);
    }
  } else {
    console.log('[Location] Using saved location:', LOC.city);
  }

  // Set default clock color CSS vars so they always exist
  resetClockColor();

  // Apply theme (wallpaper or minimal dark) based on loaded settings
  applyTheme(DISP_CFG.theme || 'default', DISP_CFG.wallpaperIntervalMs || 30000);

  const now = new Date();
  todayKey  = dateKey(now);

  // Static setup (runs once)
  updateLocation();
  updateDates(now);

  // Load prayer times (async — local first, API in background)
  await loadPrayerTimes(now);

  // Live clock — tick every second
  tickClock(); // run immediately
  setInterval(tickClock, 1000);

  // Quran verse rotation
  startVerseRotation();

  // UX
  setupCursorHide();
  setupKeyboardShortcuts();
  setupSettingsModal();

  // Burn-in protection for long-running kiosk display
  startBurnInProtection();

  console.log('[App] Ready. Location:', LOC.city, '| Method:', CALC_METHOD);
}

// ─────────────────────────────────────────────────────────────
//  Entry point
// ─────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', init);