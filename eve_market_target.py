"""Market-window targeting; SSO membership alone is not online evidence."""
def choose(preferred, characters, online_status, local_ids=()):
    ids = [str(c['id']) for c in characters]
    preferred = str(preferred) if preferred is not None else None
    statuses = {}
    def status(cid):
        if cid not in statuses:
            statuses[cid] = online_status(cid)
        return statuses[cid]
    if preferred in ids and status(preferred) is not False:
        return preferred
    for cid in ids:
        if status(cid) is True:
            return cid
    for cid in map(str, local_ids):
        if cid in ids and status(cid) is not False:
            return cid
    return next((cid for cid in ids if status(cid) is not False), None)

def resolve(preferred):
    import mmd_sso as sso
    import mmd_esi_auth as auth
    import eve_map_intel_service as intel
    def online(cid):
        if not sso.character_capabilities(cid).get('character_online'):
            return None
        response = auth.request_json('GET', f'/latest/characters/{cid}/online/', cid,
                                     timeout=5, max_attempts=1)
        if response.ok and isinstance(response.data, dict):
            value = response.data.get('online')
            return value if isinstance(value, bool) else None
        return None
    snapshot = intel._default_service.position_store().snapshot()
    local = [row['character_id'] for row in snapshot.get('positions', []) if row.get('local_confirmed')]
    return choose(preferred, sso.connected_chars(), online, local)
