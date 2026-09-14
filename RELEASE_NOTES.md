# MMD Public Alpha 0.1

First public alpha combining the current local trading/New Eden work with the
public PKCE authentication. The existing public and private repositories are
preserved; this repository starts with clean, release-only history.

## Validated

- 294 Python unittest cases, 79 JavaScript cases and 28 SQLite/migration checks pass.
- Compiled Windows executable: native bridge, first-launch SDE download/conversion
  and New Eden rendering with a fresh isolated profile.
- Static lookup conversion: 52,999 types, 8,490 systems, 6,989 gate pairs,
  5,210 NPC stations for the tested CCP build.
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
- SDE is cached after first setup; automatic background SDE updates are not yet implemented.

No Client Secret, account profile, trade database or personal history is shipped.
The bundled MMD Client ID is intentionally public.
