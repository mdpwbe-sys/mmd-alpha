#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
mmd_esi.py - acces direct a l'ESI publique (sans token).

Regles CCP 2026 (developers.eveonline.com/docs/services/esi/rate-limiting):
  - User-Agent OBLIGATOIRE avec contact (sinon risque de ban)
  - ETag / If-None-Match + header Expires -> ne repas repoller un cache frais
  - Cooldown 5 min (cache ESI des order books) -> pas de fetch inutile
  - 429 -> Retry-After ; 420/5xx -> backoff exponentiel + jitter
  - pas de burst : threads limites + throttle par bucket

Endpoints:
  GET /latest/markets/{region}/orders/?type_id=X&order_type=all
"""
import urllib.request, urllib.error, json, sqlite3, os, time, random, threading
from concurrent.futures import ThreadPoolExecutor

LOCAL = os.environ.get("LOCALAPPDATA", os.path.expanduser("~\\AppData\\Local"))
from platform_state import state_path
MAIN_DB = state_path("app_data.db")
REGION_THE_FORGE = 10000002
ESI = "https://esi.evetech.net/latest"

def _load_esi_env():
    cfg = {}
    try:
        env_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), ".env")
        with open(env_path, encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line or line.startswith("#") or "=" not in line:
                    continue
                k, v = line.split("=", 1)
                cfg[k.strip()] = v.strip()
    except Exception:
        pass
    return cfg

_ESI_ENV = _load_esi_env()
# User-Agent CCP: nom + version + contact (obligatoire en pratique)
UA = {"User-Agent": _ESI_ENV.get(
    "ESI_USER_AGENT",
    "MMD-Alpha/0.1 (https://github.com/mdpwbe-sys/mmd-alpha)")}

# X-Compatibility-Date: date a laquelle l'appli a ete testee/revisee.
# CCP peut repondre avec la date demandee OU une date anterieure (selon la
# version interne applicable a la route) -> ce n'est PAS une erreur. On logge
# les deux separement. Le header est envoye des que ESI_VERSION_DATE est present
# dans .env ; on ne le desactive que si la variable est absente.
_COMPAT_DATE = _ESI_ENV.get("ESI_VERSION_DATE")
COMPAT_HEADER = {"X-Compatibility-Date": _COMPAT_DATE} if _COMPAT_DATE else {}

import logging
_log = logging.getLogger("mmd_esi")
if not _log.handlers:
    _log.addHandler(logging.NullHandler())

LIVE = "volume_remaining>0 AND last_seen IS NULL"
_MAX_WORKERS = 4  # conservateur: pas de burst vers le bucket public
_CACHE_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), ".esi_cache.json")
_CACHE_TTL = 300  # 5 min: fraicheur min des order books ESI
_CACHE_STALE_TTL = 24 * 3600  # un livre ancien vaut mieux qu'un faux marche vide
_MAX_RETRIES = 4
_cache = {}
_cache_lock = threading.Lock()


def _load_cache():
    global _cache
    if os.path.exists(_CACHE_FILE):
        try:
            with open(_CACHE_FILE, encoding="utf-8") as f:
                _cache = json.load(f)
        except Exception:
            _cache = {}
    # Garde 24 h de secours : une entree expiree n'est servie que si ESI est
    # temporairement indisponible, jamais a la place d'une reponse live vide.
    now = time.time()
    _cache = {k: v for k, v in _cache.items()
              if v.get("expires", 0) > now - _CACHE_STALE_TTL}


def _save_cache():
    tmp = f"{_CACHE_FILE}.{os.getpid()}.{threading.get_ident()}.tmp"
    try:
        with _cache_lock:
            snapshot = dict(_cache)
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(snapshot, f)
            f.flush()
            os.fsync(f.fileno())
        os.replace(tmp, _CACHE_FILE)
    except Exception:
        pass
    finally:
        try:
            if os.path.exists(tmp):
                os.remove(tmp)
        except Exception:
            pass


def _result(data, state, include_cache_state):
    """Garde le contrat historique booléen, avec un état détaillé à la demande."""
    if include_cache_state:
        return data, state
    return data, state in ("fresh_cache", "validated_cache", "stale_cache")


def _stale_or_unavailable(cached, url, reason, include_cache_state=False):
    """Sert le dernier snapshot connu sur incident transitoire uniquement."""
    if cached and cached.get("data") is not None:
        _log.warning("ESI indisponible (%s), snapshot expire conserve: %s", reason, url)
        return _result(cached.get("data"), "stale_cache", include_cache_state)
    return _result(None, "unavailable", include_cache_state)


def _get(url, timeout=20, attempt=0, include_cache_state=False):
    """GET avec cache ETag/Expires + retry ESI.
    Retourne (data, from_cache) par défaut. Avec include_cache_state=True,
    le second champ distingue live/fresh_cache/validated_cache/stale_cache/
    unavailable sans casser les appelants historiques."""
    import mmd_ratelimit as rl
    now = time.time()
    with _cache_lock:
        cached = _cache.get(url)
    # cache frais (Expires dans le futur ET dans la fenetre 5 min) -> on sert direct
    if cached and cached.get("expires", 0) > now:
        return _result(cached.get("data"), "fresh_cache", include_cache_state)

    headers = dict(UA)
    headers.update(COMPAT_HEADER)  # X-Compatibility-Date fige la version ESI
    if cached and cached.get("etag"):
        headers["If-None-Match"] = cached["etag"]

    req = urllib.request.Request(url, headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            data = json.loads(r.read().decode("utf-8"))
            # met a jour le cache avec ETag + Expires. Last-Modified is kept
            # too so diagnostics can preserve CCP's raw observation metadata.
            etag = r.headers.get("ETag")
            exp = r.headers.get("Expires")
            last_modified = r.headers.get("Last-Modified")
            expires_ts = now + _CACHE_TTL
            if exp:
                try:
                    import email.utils
                    parsed = time.mktime(email.utils.parsedate(exp))
                    # CCP renvoie souvent Expires dans le passe -> on force 5 min mini
                    if parsed > now:
                        expires_ts = parsed
                except Exception:
                    pass
            with _cache_lock:
                _cache[url] = {"data": data, "etag": etag, "expires": expires_ts, "last_modified": last_modified}
            _save_cache()
            # log date compat demandee vs effective (pas une erreur si differente)
            eff = r.headers.get("X-Compatibility-Date")
            if _COMPAT_DATE and eff and eff != _COMPAT_DATE:
                _log.info("ESI compat: demandee=%s, effective=%s (route interne)",
                          _COMPAT_DATE, eff)
            rl.observe("public", r.headers)  # lit X-Ratelimit-* ET X-ESI-Error-Limit-*
            rem = r.headers.get("X-Ratelimit-Remaining")
            lim = r.headers.get("X-Ratelimit-Limit")
            rl.throttle("public", int(rem) if rem else None,
                        int(lim.split("/")[0]) if lim else None)
            return _result(data, "live", include_cache_state)
    except urllib.error.HTTPError as e:
        code = e.code
        error_headers = e.headers
        rl.observe("public", error_headers)  # les erreurs coutent aussi des tokens
        e.close()
        if code == 304:  # Not Modified -> on sert le cache
            if cached:
                return _result(cached.get("data"), "validated_cache",
                               include_cache_state)
            return _result(None, "unavailable", include_cache_state)
        if code == 429:
            # respecte EXACTEMENT Retry-After (coute 0 token de bucket)
            if attempt < _MAX_RETRIES:
                rl.wait_retry_after(error_headers.get("Retry-After", "5"))
                return _get(url, timeout, attempt + 1, include_cache_state)
            return _stale_or_unavailable(
                cached, url, "HTTP 429", include_cache_state)
        if code == 420:
            # error-limit globale atteinte -> backoff
            if attempt < _MAX_RETRIES:
                time.sleep(min(2 ** attempt, 16) + random.uniform(0, 1.5))
                return _get(url, timeout, attempt + 1, include_cache_state)
            return _stale_or_unavailable(
                cached, url, "HTTP 420", include_cache_state)
        if code in (500, 502, 503, 504):
            # 5xx = 0 token de bucket -> backoff + jitter
            if attempt < _MAX_RETRIES:
                time.sleep(min(2 ** attempt, 16) + random.uniform(0, 1.5))
                return _get(url, timeout, attempt + 1, include_cache_state)
            return _stale_or_unavailable(
                cached, url, f"HTTP {code}", include_cache_state)
        # 401/403/404 et autres 4xx: PAS de retry automatique.
        # 4xx coutent 5 tokens -> on n'enchaune pas les requetes pourries.
        # 403 = scope/access insuffisant -> arret net.
        # 404 sur structure = structure absente/access perdu -> arret net.
        return _result(None, "unavailable", include_cache_state)
    except Exception:
        if attempt < 3:
            time.sleep(min(2 ** attempt, 16) + random.uniform(0, 1.5))
            return _get(url, timeout, attempt + 1, include_cache_state)
        return _stale_or_unavailable(
            cached, url, "erreur reseau", include_cache_state)


def live_type_ids():
    """Known active item IDs from MMD snapshots, never the Evernus schema."""
    from repositories.order_repository import get_all_latest_character_orders
    orders = get_all_latest_character_orders()
    return sorted({int(o["type_id"]) for o in orders
                   if o.get("type_id") and int(o.get("volume_remain") or 0) > 0})


class _FetchResult(list):
    def __init__(self, rows=(), valid=True):
        super().__init__(rows)
        self.valid = valid


def _fetch_one(args):
    tid, region = args
    url = (f"{ESI}/markets/{region}/orders/?datasource=tranquility"
           f"&order_type=all&type_id={tid}")
    status = None
    err = None
    try:
        rows, _ = _get(url)
        if rows is None:
            return _FetchResult(valid=False)
        res = []
        for o in rows:
            side = 0 if o.get("is_buy_order") else 1
            res.append({
                "type_id": tid,
                "location_id": int(o["location_id"]),
                "side": side,
                "price": float(o["price"]),
                "issued": o.get("issued", ""),
                "vol": int(o.get("volume_remain", 0)),
                "order_id": str(o.get("order_id", "")),
                # BUY overlap is range-aware.  Keep the ESI enum on public
                # orders so the scanner can compare its real coverage.
                "range": o.get("range"),
            })
        status = 200
        return _FetchResult(res)
    except Exception as e:
        err = str(e)
        return _FetchResult(valid=False)
    finally:
        # journalise le fetch ESI (ne doit jamais casser le fetch)
        try:
            import repositories.snapshot_repository as _sr
            import time as _t
            fid = "esi_" + str(tid) + "_" + _t.strftime("%Y%m%d%H%M%S", _t.gmtime())
            _sr.save_esi_fetch(fid, endpoint=url, requested_at=_t.strftime("%Y-%m-%dT%H:%M:%SZ", _t.gmtime()),
                               completed_at=_t.strftime("%Y-%m-%dT%H:%M:%SZ", _t.gmtime()),
                               http_status=status, coherent=(status == 200), error_message=err)
        except Exception:
            pass


def fetch_public_orders(type_ids, region=REGION_THE_FORGE, max_workers=_MAX_WORKERS):
    """Fetch parallele du livre public pour chaque type_id.
    Retourne une LISTE d'ordres publics (memoire uniquement)."""
    out = []
    tasks = [(tid, region) for tid in type_ids]
    with ThreadPoolExecutor(max_workers=max_workers) as ex:
        for res in ex.map(_fetch_one, tasks):
            out.extend(res)
    return out


def get_live_public(region=REGION_THE_FORGE):
    """Raccourci: renvoie (ids, liste_ordres_publics, duree_sec).
    Lit les ids 'live' depuis le db Evernus (verrouille potentiellement).
    Preferer get_live_public_for() si on connait deja les type_ids."""
    _load_cache()
    t0 = time.time()
    ids = live_type_ids()
    pub = fetch_public_orders(ids, region)
    return ids, pub, round(time.time() - t0, 1)


def get_live_public_for(type_ids, region=REGION_THE_FORGE, progress=None, include_failures=False):
    """Comme get_live_public mais pour un SOUS-ENSEMBLE de type_ids donne.
    Ne lit PAS le db Evernus (pas de verrou). Sert pour l'Import: on ne
    recupere le livre public QUE pour les items qu'on a reellement en ordre.
    progress(processe, total) optionnel pour suivre l'avancement."""
    _load_cache()
    t0 = time.time()
    ids = sorted(set(int(t) for t in type_ids))
    out = []
    failed = []
    total = len(ids)
    done = 0
    # limite le parallele pour respecter le bucket public (4 threads ok)
    with ThreadPoolExecutor(max_workers=_MAX_WORKERS) as ex:
        for tid, res in zip(ids, ex.map(_fetch_one, [(tid, region) for tid in ids])):
            out.extend(res)
            if not res.valid:
                failed.append(tid)
            done += 1
            if progress and total:
                progress(done, total)
    result = (ids, out, round(time.time() - t0, 1))
    return (*result, failed) if include_failures else result


if __name__ == "__main__":
    import sys
    if len(sys.argv) > 1 and sys.argv[1] == "test":
        ids, pub, sec = get_live_public()
        print(f"ESI parallel: {len(ids)} items, {len(pub)} ordres publics, {sec}s")
