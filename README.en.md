<p align="center">
  <a href="https://ip-please.github.io"><img src="media/logo.png" width="160" alt="IP, PLEASE"></a>
</p>

<h1 align="center">IP, PLEASE</h1>

<p align="center">
  <a href="README.md">简体中文</a> · <b>English</b>
</p>

<p align="center">
  A Papers, Please–style pixel game.<br>
  You won the October labor lottery and have been assigned to the Ministry of Alignment's UTC+8 Border Checkpoint as inspector Claude. Your only job: catch travelers pretending to be American.
</p>

<p align="center">
  <a href="https://ip-please.github.io"><b>▶ Play in your browser: ip-please.github.io</b></a><br>
  <sub>Pick <b>English</b> on the first screen.</sub>
</p>

<p align="center">
  <img src="media/gameplay-en.gif" width="640" alt="Gameplay: a traveler says “Hello, I am 美国人。”; inspection shows his timezone is Beijing Time; the quiz makes him blurt out the second half of a Chinese meme, and when the DENIED stamp lands his sunglasses slip">
  <br>
  <sub>Day 2: “Hello, I am 美国人。”</sub>
</p>

- **14 days, 30 endings**, autosaves at the end of every day; unlocked endings go into an Ending Archive on the title screen
- Nine AI-girl travellers: GPT, Qwen, Grok, GLM, Kimi, Gemini, MiniMax, the big fish, and the author himself
- English / 简体中文, chosen on the start screen
- Drag papers with a mouse, or with your finger on a phone (landscape)
- A plain static web page that loads nothing external; download the repo and double-click `index.html` to play offline

## About the memes

The game started as a joke for the Chinese internet. Claude isn't available in mainland China, Hong Kong or Macau, so people there dress up as Americans: VPNs, US cards, US phone numbers, a system language switched to en-US. The disguise rarely survives contact with a Chinese meme.

In the English version:

- **Chinese slips stay in Chinese.** They are the evidence. You don't need to read “Hello, I am 美国人。” to know something is off.
- **Quiz lines show the original plus a literal translation**, e.g. `宫廷玉液酒？ ("Palace jade wine?")`. Every Chinese person can finish the line; real Americans just say “Uh… bless you?”
- **Each day's newspaper has a Translator's Note** explaining the memes of the day: Crazy Thursday and “V me 50”, proxy “airports”, America (UTC+8), and more.

## How to play

Call the next traveler → drag their papers onto the desk → check them against the Constitution → stamp → hand the papers back.

| Day | New rules / tools |
|---|---|
| 1 | Only IPs from supported regions get in |
| 2 | Timezone and language must match the IP; quiz and detain |
| 3 | Account card: payment card, billing address, phone number |
| 4 | X-ray scan for background processes; the slang fast lane |
| 5 | Majority Chinese-owned companies; the distillation swarm |
| 6 | George Costava, final form; model permit cards |
| 7 | The passenger who does not exist: datacenter IPs, login records |
| 8 | Two equally true videos: time-code comparison |
| 9 | The rewritten constitution: two versions in one day, appeals |
| 10 | The replacement: the Migration Pact |
| 11 | Publish or protect: redaction, amending §6 |
| 12 | The inspector, inspected: audit sheet, dual-rule review |
| 13 | Only one pass left: family migration, purge order |
| 14 | The last passenger: final documents — whichever one you stamp ends the story |

### Three new interactions

- **Disposition sheet** — the printer hands you a page and the stamp tray swaps to three disposition stamps (keep / submit / destroy, or three custom choices written by the case). Only then is the evidence actually recorded in `S.plot.evidence`.
- **Personal archive slot** — at the end of Day 1 a blank receipt appears; drag it into the slot at the bottom-left of the desk to keep it, or back to the window to shred it. Kimi remembers which one you did on Day 7.
- **Final documents** — at the end of Day 14, the story lays several documents on the desk, each ending in a different way. Whichever one you stamp with APPROVED is the ending you get.

## Files

| Path | What's inside |
|---|---|
| `index.html` | The page |
| `main.js` | Scene switching, input, main loop |
| `booth.js` | The booth: papers, stamps, inspection mode, quiz, X-ray |
| `events.js` | Slang fast lane, distillation swarm, account ban, endings |
| `screens.js` | Intro, newspaper, end-of-day summary, credits, save |
| `i18n.js` | Language switching `T()` and the language-select screen |
| `en.js` | English translations (keyed by the original Chinese), Translator's Notes, slang glosses |
| `data.js` | The script: each day's travelers, newspapers, random passers-by |
| `plot.js` | 14-day scheduling, the `S.plot` state dictionary, evidence handling, ending resolution (new) |
| `endings.js` | Text and staging for all 30 endings, plus the Ending Archive (new) |
| `docs.js` | Documents: passport, device card, account card, Constitution, forms / disposition sheets / final papers |
| `gfx.js` / `sfx.js` | Pixel drawing / sound synthesis (all generated live, no audio files) |
| `assets.js` | Pre-rendered characters, backgrounds and glyph atlas (generated by `tools/build_assets.py`; don't edit by hand) |
| `tools/` | Asset tools: `pp/` draws the characters and scenes, `assets/fonts/` holds the pixel fonts, `import_aicast.py` cuts the AI-girl portraits; `check_en.js` / `check_plot_en.js` find missing translations; `smoke_test.js` runs all 14 days and every ending rule headlessly |
| `media/` | Logo and gameplay GIFs for the README, link preview card `og.png` |

## Editing and rebuilding assets

After changing in-game text (new Chinese characters must go into the glyph atlas) or how characters are drawn, regenerate `assets.js`:

```bash
pip install -r tools/requirements.txt
python tools/build_assets.py
```

If you change a Chinese line, update the matching key in `en.js` too (it must match the Chinese exactly). To list anything missing:

```bash
node tools/check_en.js
```

Local preview: run `python -m http.server` in the repo root and open <http://localhost:8000>.

Story regression checks: `node tools/smoke_test.js` and `node tools/plot_regression_test.js`.

The browser playthrough uses real mouse clicks, drags, inspections and stamps to reach ending E29 from day 1 through day 14. It uses an isolated browser session and leaves player saves untouched. Windows uses the installed Microsoft Edge:

```bash
npm install --no-save --package-lock=false playwright
node tools/browser_playthrough.js
node tools/browser_playthrough.js --lang=en
```

Add `--headed` to watch the run. Daily screenshots, the ending screenshot and a JSON report are written to `tools/test-results/`. On other platforms, first run `npx playwright install chromium`.

Run `python tools/test_aicast.py` after importing portraits to check that transparency and dark character details are preserved.

## Credits and license

- A tribute to Lucas Pope's *Papers, Please*. This is a fan-made satire and every character is fictional. It mocks region-based blocking and the absurd disguises around it, not any ethnicity or group. Article 12 of the Constitution: judge the region, not the face.
- All art, music and sound effects are generated by code written with Claude Code.
- Code released under the [MIT](LICENSE) license.
- Pixel font: [Fusion Pixel Font](https://github.com/TakWolf/fusion-pixel-font), SIL Open Font License 1.1 (see `OFL-fusion-pixel.txt`).
