# RSVP Reader

A dependency-free speed-reading app (Rapid Serial Visual Presentation) that runs on macOS and iOS as a PWA.

- **Press and hold** anywhere (or hold `Space`) to read; release to stop.
- One word at a time with the **optimal recognition point (ORP)** letter highlighted and pinned to the center, so your eyes never move along the line.
- Smart pauses on punctuation and long words, ramp-up on press, 100–1000 WPM.
- Paste text or open `.txt` / `.epub`; reading position is saved per text.
- Stats (words, avg WPM, streak) and a local cloze-style comprehension quiz.
- Themes, fonts, size and highlight color.

## Controls

| Input | Action |
| --- | --- |
| Hold pointer / `Space` | Read |
| Swipe left/right, `←` `→` | Next / previous sentence |
| `↑` `↓` | WPM ±25 |
| `R` | Restart |

## Run

```sh
python3 -m http.server 8080
```

Open `http://localhost:8080` on the Mac. On iPhone, open the same URL via your Mac's LAN IP, or host the folder on any static HTTPS host, then Share → **Add to Home Screen**. (Service worker/offline needs HTTPS or localhost.)
