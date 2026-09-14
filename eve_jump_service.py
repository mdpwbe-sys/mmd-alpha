"""Jump Planner application adapter. No renderer imports or live-intel refresh.

Policy reference: https://developers.eveonline.com/docs/guides/map-data/
Only known classic K-space regions are allowed; unknown space fails closed.
Cyno-skilled means Cynosural Field Theory >= I for ordinary/industrial cynos,
NOT compatible fitted ship/module/fuel or readiness. Covert-only planning is
not modeled. Security uses the existing map's displayed-highsec boundary .45.
"""
from concurrent.futures import ThreadPoolExecutor
from dataclasses import asdict
from decimal import Decimal
import json
import math
from pathlib import Path
import threading
import time
import uuid

import eve_jump_math as jump_math
import eve_jump_router as router
from eve_jump_risk import proximity_risk
from eve_hull_skills import requirements, eligible
from eve_account_groups import AccountGroups
from eve_character_jump_profile import get_character_jump_profile


def classic_space(system):
    try:
        region = int(system['region_id'])
        return 10000001 <= region <= 10000069 and region not in (10000004,10000017,10000019)
    except (KeyError, TypeError, ValueError):
        return False


def is_jump_destination_allowed(system, ship_class):
    try:
        security = float(system['security'])
        return classic_space(system) and math.isfinite(security) and security < .45
    except (KeyError, TypeError, ValueError):
        return False


def json_safe(value):
    if isinstance(value, Decimal):
        return str(value)
    if isinstance(value, dict):
        return {k: json_safe(v) for k,v in value.items()}
    if isinstance(value, (list,tuple)):
        return [json_safe(v) for v in value]
    return value


def position_fresh(row, now):
    try:
        return row.get('source') in ('ESI','LOCAL_CHATLOG') and 0 <= now-float(row['observed_at']) <= 30
    except (TypeError, ValueError, KeyError):
        return False


class JumpService:
    def __init__(self, *, systems, types, characters, positions, profiles=get_character_jump_profile,
                 accounts=None, now=time.time, gates=lambda:()):
        self._systems_source, self._types_source = systems, types
        self._characters, self._positions, self._profiles = characters, positions, profiles
        self.accounts, self.now = accounts or AccountGroups(), now
        self._gates=gates
        self._lock = threading.RLock()
        self._systems = self._hulls = self._index = None

    def _load(self):
        with self._lock:
            if self._systems is not None:
                return
            systems = {int(s['id']): dict(s) for s in self._systems_source()}
            for system in systems.values():
                if isinstance(system.get('npc_stations'), list):
                    system['npc_station'] = bool(system['npc_stations'])
                elif isinstance(system.get('npc_station_count'), (int, float)):
                    system['npc_station'] = system['npc_station_count'] > 0
            types = self._types_source()
            hulls = {}
            for tid,row in types.items():
                if row.get('category_id') != 6 or not row.get('published'):
                    continue
                try:
                    stats = jump_math.hull_stats_from_sde(row)
                    if stats.base_range_ly <= 0 or stats.base_fuel_per_ly <= 0:
                        continue
                except (KeyError, ValueError, TypeError):
                    continue
                fuel = types.get(str(stats.fuel_type_id),{})
                hulls[int(tid)] = {'id':int(tid),'name':row.get('name',{}).get('en',str(tid)),
                    'ship_class':'JUMP_FREIGHTER' if row.get('group_id') == 902 else 'CAPITAL',
                    'stats':stats,'isotope_type_id':stats.fuel_type_id,
                    'required_skills':requirements(row),
                    'isotope_name':fuel.get('name',{}).get('en',str(stats.fuel_type_id))}
            self._hulls = hulls
            # Unknown/special space never enters the classic jump index.
            self._index = router.JumpNeighborIndex({cid:s for cid,s in systems.items() if classic_space(s)})
            self._systems = systems
            self._adjacency={sid:set() for sid in systems}
            for gate in self._gates():
                if gate.get('kind','STARGATE')!='STARGATE':
                    continue
                a,b=int(gate['source']),int(gate['target'])
                if a in systems and b in systems:
                    self._adjacency[a].add(b);self._adjacency[b].add(a)

    def options(self):
        self._load()
        positions = {int(p['character_id']):p for p in self._positions().get('positions',[])}
        pilots = self.accounts.characters(self._characters())
        for pilot in pilots:
            pos=positions.get(int(pilot['id']))
            pilot['position'] = pos
            pilot['origin_system_id'] = pos['system_id'] if pos and position_fresh(pos,self.now()) else None
        return {'ok':True,'pilots':pilots,
            'ships':[{k:v for k,v in h.items() if k!='stats'} for h in self._hulls.values()],
            'systems':[{'id':s['id'],'name':s['name']} for s in self._systems.values()]}

    def profile(self, character_id):
        cid=int(character_id)
        if cid not in {int(c['id']) for c in self._characters()}:
            raise ValueError('Pilot is not connected')
        result=self._profiles(cid)
        if not result.ok:
            raise ValueError(f'Jump skills unavailable: {result.error.kind}')
        return result.data

    def pilot_ships(self, character_id):
        """Reuses authenticated skills transport/cache; no new endpoint/polling."""
        import mmd_esi_auth as auth
        self._load()
        cid=int(character_id)
        if cid not in {int(c['id']) for c in self._characters()}:
            raise ValueError('Pilot is not connected')
        response=auth.get_json(f'/v4/characters/{cid}/skills/',cid)
        if not response.ok or not isinstance(response.data,dict) or not isinstance(response.data.get('skills'),list):
            raise ValueError('Hull skill eligibility unavailable')
        levels={}
        for skill in response.data['skills']:
            sid=skill.get('skill_id');level=skill.get('active_skill_level')
            if type(sid) is not int or type(level) is not int or not 0<=level<=5 or sid in levels:
                raise ValueError('Invalid active skills')
            levels[sid]=level
        return [{k:v for k,v in hull.items() if k not in ('stats','required_skills')}
                for hull in self._hulls.values() if eligible(hull['required_skills'],levels)]

    def calculate(self, request):
        self._load()
        cid=int(request['pilot_id']); hull=self._hulls[int(request['ship_id'])]
        profile=self.profile(cid)
        positions={int(p['character_id']):p for p in self._positions().get('positions',[])}
        origin=int(request['origin_id']); destination=int(request['destination_id'])
        if request.get('origin_auto'):
            current=positions.get(cid,{})
            if not position_fresh(current,self.now()):
                raise ValueError('Pilot position is stale or unknown; select origin manually')
            origin=int(current['system_id'])
        if origin not in self._systems or destination not in self._systems:
            raise ValueError('Unknown system')
        pilots={int(p['id']):p for p in self.accounts.characters(self._characters())}
        account=pilots[cid]['account_group_id']; candidates=[]
        for other,pilot in pilots.items():
            if other==cid:
                continue
            pos=positions.get(other,{})
            compatible=bool(account and pilot['account_group_id'] and account!=pilot['account_group_id'])
            fresh=position_fresh(pos,self.now())
            skill=None
            if compatible:
                result=self._profiles(other)
                skill=result.data.cynosural_field_theory if result.ok else None
            skilled=skill is not None and skill>=1
            candidates.append({'character_id':other,'name':pilot['name'],
                'account_group_id':pilot['account_group_id'],'system_id':pos.get('system_id'),
                'observed_at':pos.get('observed_at'),'source':pos.get('source'),
                'position_fresh':fresh,'cyno_skilled':skilled,
                'status':'UNAVAILABLE' if not compatible else 'CYNO_POSITIONED' if fresh and skilled else
                         'STALE' if pos and not fresh else 'CYNO_SKILLED' if skilled else 'UNKNOWN'})
        # Skills requests may take time: recheck the position after all fetches.
        for candidate in candidates:
            if candidate['status']=='CYNO_POSITIONED' and not position_fresh(candidate,self.now()):
                candidate.update(status='STALE',position_fresh=False)
        valid=[c for c in candidates if c['status']=='CYNO_POSITIONED']
        max_range=jump_math.max_jump_range(hull['stats'],profile.jump_drive_calibration)
        # UI supplies an immutable snapshot of the map's final liveFor() scores.
        # Unknown is NOT zero danger: conservative search cost, unknown display.
        snapshot=request.get('danger_snapshot') or {}
        danger={}
        for sid, row in snapshot.get('systems',{}).items():
            score=row.get('score')
            if isinstance(score,(int,float)) and not isinstance(score,bool) and math.isfinite(score) and 0<=score<=100:
                danger[int(sid)]={'score':score,'band':row.get('band')}
                for key in ('esi_score','recent_score'):
                    value=row.get(key,0)
                    danger[int(sid)][key]=value if isinstance(value,(int,float)) and not isinstance(value,bool) and math.isfinite(value) and 0<=value<=100 else 0
        exposure={}
        def route_exposure(sid):
            if sid not in exposure:
                exposure[sid]=proximity_risk(sid,self._adjacency,danger)
            return exposure[sid]
        reachable=[]
        if classic_space(self._systems[origin]) and is_jump_destination_allowed(self._systems[destination],hull['ship_class']):
            route=router.find_jump_route(origin,destination,systems=self._index,jump_profile=profile,
                hull_stats=hull['stats'],ship_class=hull['ship_class'],mode=request['mode'],
                destination_policy=is_jump_destination_allowed,pilot_account_group_id=account,cyno_candidates=valid,
                danger_cost=lambda sid:danger.get(sid,{}).get('score',100)+route_exposure(sid)['risk'])
            reachable=[sid for sid,_ in self._index.neighbors(origin,max_range)
                       if is_jump_destination_allowed(self._systems[sid],hull['ship_class'])]
        else:
            route={'reachable':False,'systems':[],'legs':[],'jump_count':0,'total_distance_ly':None,'total_fuel_raw':None}
        midpoints=[]
        for sid in route['systems'][1:-1]:
            midpoints.append({'system_id':sid,'name':self._systems[sid]['name'],
                'npc_station':self._systems[sid].get('npc_station'),
                'cyno_candidates':[c for c in valid if c['system_id']==sid]})
        route_cynos=[c for c in valid if c['system_id'] in route['systems'][1:]]
        for leg in route['legs']:
            leg['source_name']=self._systems[leg['source_id']]['name']
            leg['target_name']=self._systems[leg['target_id']]['name']
            row=danger.get(leg['target_id'])
            leg['danger']={key:row[key] for key in ('score','band')} if row else None
            leg['npc_station']=self._systems[leg['target_id']].get('npc_station')
            leg['proximity_risk']=route_exposure(leg['target_id'])
        for candidate in candidates:
            if candidate['status']=='CYNO_POSITIONED' and not position_fresh(candidate,self.now()):
                candidate.update(status='STALE',position_fresh=False)
        route_cynos=[c for c in route_cynos if c['status']=='CYNO_POSITIONED']
        for midpoint in midpoints:
            midpoint['cyno_candidates']=[c for c in midpoint['cyno_candidates'] if c['status']=='CYNO_POSITIONED']
        landing_scores=[danger.get(sid) for sid in route['systems'][1:]]
        complete=bool(landing_scores) and all(row is not None for row in landing_scores)
        known_scores=[row for row in landing_scores if row is not None]
        peak=max(known_scores,key=lambda row:row['score']) if known_scores else None
        if peak is not None:
            peak={key:peak[key] for key in ('score','band')}
        payload={'ok':True,'route':route,'reachableSystemIds':reachable,'midpoints':midpoints,
            'mode':request['mode'], 'danger_summary':{
                'peak':peak, 'total':sum(row['score'] for row in known_scores)+sum(leg['proximity_risk']['risk'] for leg in route['legs']) if known_scores else None,
                'partial':bool(known_scores) and not complete,
                'known_systems':len(known_scores), 'landing_systems':len(landing_scores),
                'proximity_total':sum(leg['proximity_risk']['risk'] for leg in route['legs']),
                'unknown_systems':sum(row is None for row in landing_scores),
                'observed_at':snapshot.get('observed_at'), 'state':snapshot.get('state','unavailable'),
                'unknown_cost':100},
            'cynos':route_cynos,'cyno_candidates':candidates,'profile':asdict(profile),
            'max_jump_range':max_range,'isotope_type_id':hull['isotope_type_id'],
            'isotope_name':hull['isotope_name'],'origin_id':origin,
            'range_m':max_range*jump_math.METERS_PER_LY,
            'positions_m':{str(sid):self._systems[sid]['position_m'] for sid in set(route['systems']+[origin])},
            'cyno_coverage':{'positioned':len({c['system_id'] for c in route_cynos}), 'required':len(route['legs'])},
            'calculated_at':self.now()}
        return json_safe(payload)


_service=None
_service_lock=threading.Lock()
_executor=ThreadPoolExecutor(max_workers=1,thread_name_prefix='jump-planner')
_jobs={}
_job_lock=threading.Lock()


def default_service():
    global _service
    with _service_lock:
        if _service is None:
            import eve_map_service
            import eve_map_intel_service
            import mmd_sso
            def types():
                from eve_sde import data_path
                path=data_path('types.json', Path(__file__).parent/'reference'/'sde'/'types.json')
                if not path.is_file():
                    raise ValueError('Local SDE types.json unavailable; no hull stats can be inferred')
                return json.loads(path.read_text(encoding='utf-8'),parse_float=Decimal)
            _service=JumpService(systems=lambda:eve_map_service.get_map_data()['systems'],types=types,
                gates=lambda:eve_map_service.get_map_data()['gates'],
                characters=mmd_sso.connected_chars,
                positions=lambda:eve_map_intel_service._default_service.position_store().snapshot())
        return _service


def start_calculation(request):
    with _job_lock:
        if any(not job.done() for job in _jobs.values()):
            return {'ok':False,'error':'A jump calculation is already running'}
        while len(_jobs)>=8:
            _jobs.pop(next(iter(_jobs)))
        key=uuid.uuid4().hex
        _jobs[key]=_executor.submit(default_service().calculate,dict(request))
        return {'ok':True,'job_id':key}


def calculation_result(job_id):
    with _job_lock:
        job=_jobs.get(str(job_id))
    if job is None:
        return {'ok':False,'error':'Unknown jump calculation'}
    if not job.done():
        return {'ok':True,'pending':True}
    try:
        return job.result()
    except Exception as exc:
        return {'ok':False,'error':str(exc)}
