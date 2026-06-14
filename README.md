# World Cup 2026 · Bedtime Tracker 🌙

A mobile-first, installable PWA that shows World Cup 2026 fixtures in **KSA time
(GMT+3)** and **hides every kickoff after 10:00 PM KSA** so late-night games
don't wreck your sleep.

- Live data: `https://worldcup26.ir/get/games`
- Times converted from the feed's Tehran wall-clock (GMT+3:30) to **KSA (−30 min)**
- Filter: only kickoffs **≤ 22:00 KSA** are shown
- Handles knockout placeholders ("Winner Group A") and swaps to real teams on refresh
- Installable to your phone home screen, works offline (last-known fixtures)

## Develop

```bash
npm install
npm run dev        # http://localhost:5173
```

## Build / preview

```bash
npm run build
npm run preview    # serves the production build at http://localhost:4173
```

## Deploy (free, HTTPS) — Vercel

From inside this folder:

```bash
npx vercel          # first run: log in + accept defaults -> preview URL
npx vercel --prod   # promote to your permanent https URL
```

The first command will ask you to log in (GitHub/Google/email) and confirm a few
defaults — just press Enter through them (the framework is auto-detected as Vite).
You'll get a `https://wc26-tracker-xxxx.vercel.app` URL.

## Install on your phone

Open the Vercel HTTPS URL on your phone, then:

- **iPhone (Safari):** Share button → **Add to Home Screen**
- **Android (Chrome):** ⋮ menu → **Install app** / **Add to Home Screen**

It will appear as an app icon, open fullscreen, and work offline.
