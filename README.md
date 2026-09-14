# MMD — EVE Market Manager · Public Alpha 0.1

MMD is a Windows desktop application for EVE Online market trading, multi-character
management and New Eden tactical planning. This alpha continues
[MMD Public Trader](https://github.com/mdpwbe-sys/mmd-public-trader) with the
recent local features. The old repository remains available for reference.

## Features

- Multi-character EVE SSO using Authorization Code + PKCE, no user Client ID or secret.
- BUY/SELL comparison, BUY range overlap, Fast Copy, hub priorities and margin tools.
- Portfolio, assets, contracts, market history and persistent local account groups.
- New Eden Physical and Tactical views, 2D topology, LOD and Off/Low/Normal graphics.
- Traffic estimates, live intel, combat markers, World Events and local character tracking.
- Jump Planner: Fewest jumps, Least fuel, Safer and Safest; hull/skill eligibility,
  raw fuel estimates, known cyno candidates and route overlays.
- Local clipboard analysis, Local chatlog flood monitoring and optional user-supplied music.

Traffic V3 is experimental and is **not included**. Estimated gate traffic is
not an exact CCP gate-flow measurement. Cyno candidates do not prove module/ship
readiness; fuel rounding still requires in-game validation.

## Windows installation

Download `MMD-Alpha-0.1.exe` from [GitHub Releases](https://github.com/mdpwbe-sys/mmd-alpha/releases).
Only the executable is needed: do not download a development checkout to run MMD.
Windows 10/11 and Microsoft Edge WebView2 Runtime are required. An unsigned
alpha executable may trigger Windows SmartScreen; do not disable system protections.

1. Start MMD. First launch downloads the official CCP SDE and converts its static
   IDs locally. The download is approximately 95 MB for the currently tested build.
2. Wait for setup to complete; a network error offers Retry. Subsequent launches
   reuse the converted cache without downloading again.
3. Click Connect EVE and approve the requested scopes for each character.

The official MMD public Client ID is bundled. No developer application or Client
Secret is needed. Callback: `http://127.0.0.1:8766/callback`.
Tokens are encrypted per installation. Runtime files stay under
`%APPDATA%/MMD-Trader`, outside the executable. Never share this directory.
No user accounts, tokens, music, chatlogs, trading databases or private history
are supplied with the alpha. Optional music can be placed beside
`%APPDATA%/MMD-Trader/music/ambient.mp3`; this initial filename selects the playlist folder.

Replacing the executable does not erase your profile. Back up your profile before
updating. The previous public trader uses the same profile directory; do not run
both versions simultaneously. Never delete that directory as part of an update.

## Known alpha limitations

- Assets without an available price or known acquisition cost contribute **0 ISK**
  to valuation, with an explicit partial-valuation warning. Unknown purchase costs
  do not become fabricated profits.
- Blueprint-copy manufacturing-margin valuation is experimental: the formula is
  `(product value per run - materials per run) × remaining runs`, floored at zero.
  Automatic recipe/run ingestion is not connected yet; missing inputs remain
  unvalued. This is not a guaranteed BPC contract price.
- Regional price histories are processed in batches of 40. Pending histories are
  not missing personal transactions. Refresh trading again to progress the queue;
  ESI cache/rate limits are respected.
- A cancelled sell order can still appear in a cached portfolio snapshot. This
  reported case is not fully resolved; confirm live order status in EVE.
- If SSO reports a token not yet valid (`iat`), synchronise the Windows clock.
  Token signature, audience and validity checks remain strict.

## Source / development

```powershell
git clone https://github.com/mdpwbe-sys/mmd-alpha.git
cd mmd-alpha
python -m venv .venv
.venv\Scripts\python -m pip install -r requirements.txt
.venv\Scripts\python mmd_gui.py
```

## Tests and build

```powershell
python -m unittest discover
python tests_db.py
node --test gui/*.test.js gui/*.test.cjs
python -m pip install pyinstaller==6.22.2
python build_exe.py
```

The build includes an explicit selection of application assets, never the whole
`reference` directory or local runtime state. The full SDE is downloaded after
installation, not embedded. A real EVE login remains a manual release check;
automated tests do not claim to validate a live account's permissions or roles.

## License and disclaimer

MIT License — see [LICENSE](LICENSE). EVE Online and the EVE logo are trademarks
of CCP hf. MMD is an independent community tool, not endorsed by CCP.
Thanks to Elinor and Evernus creators for their inspiration.
