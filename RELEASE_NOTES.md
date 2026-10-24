# MMD Public Alpha 0.1

Public alpha for EVE Online market trading, multi-character management and New
Eden tactical planning, with bundled public PKCE authentication.

## 0.1.0-alpha.2

- Startup now checks the official CCP SDE manifest on every launch.
- If a newer build is available, MMD proposes an explicit download (~95 MB);
  nothing is downloaded automatically.
- If the update check fails (network/manifest), MMD shows an alert with Retry
  check or Continue using the installed local data.

## Validated

- 298 Python unittest cases, 83 JavaScript cases and SQLite/migration checks pass
  for the packaged tree.
- Compiled Windows executable: native bridge, first-launch SDE
  download/conversion, per-launch SDE update check and New Eden rendering with
  a fresh isolated profile.
- Source/asset allowlist and compiled archive checked for user databases, token
  caches, private history, personal paths/identities and private credentials.
- SSO protocol tests: PKCE, state rejection, public callback, refresh and JWT checks.

## Alpha limits / manual validation

- Missing valuation contributes zero with a partial-valuation warning; unknown
  purchase basis is not treated as a profit.
- BPC margin formula is tested, but automatic recipes/remaining-runs ingestion
  is not connected. BPCs with missing inputs remain unvalued.
- The reported cancelled-order/cached "En vente" case is not fully resolved.
- Regional histories advance in bounded batches; they are not transaction logs.

- A real EVE account login, granted scopes, corporation roles and in-game waypoint
  submission still require user validation. Automated tests do not prove live permissions.
- No signing certificate is included; the EXE is unsigned.
- No soundtrack is included; music requires user-provided files and Windows audio support.
- Exact integer fuel rounding and actual cyno readiness are not guaranteed.
- Traffic V3 is deliberately excluded. The existing traffic estimate remains active.

No Client Secret, account profile, trade database or personal history is shipped.
The bundled MMD Client ID is intentionally public.
