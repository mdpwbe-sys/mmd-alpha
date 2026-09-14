"""Offline jump routing over an immutable CCP position snapshot.

Pass systems as {system_id: system_row}, or reuse JumpNeighborIndex across calls.
Policy signature: destination_policy(system_row, ship_class) -> bool. Only jump
destinations are checked (the initial origin may be forbidden as a destination).
ship_class == 'JUMP_FREIGHTER' selects the existing math module's JF bonus.

Cyno input rows: character_id, account_group_id, system_id, cyno_skilled=True,
position_fresh=True. Freshness/skill compatibility are caller-validated facts,
not inferred here. These indicate positioned candidates, never CYNO_READY.
Unknown accounts cannot receive a tie-break advantage. No account file access.

Ties minimize unsupported midpoints, then midpoints without an NPC station,
then fuel/distance. Nonnegative penalties keep Dijkstra valid even at zero fuel
and avoid rewarding cycles merely for visiting more cyno characters.
"""
from collections import OrderedDict
from copy import deepcopy
from decimal import Decimal
import heapq
from threading import RLock

import eve_jump_math as math

FEWEST_JUMPS = 'FEWEST_JUMPS'
LEAST_FUEL = 'LEAST_FUEL'
SAFEST = 'SAFEST'
SAFER = 'SAFER'
SAFER_MAX_EXTRA_JUMPS = 3
ZERO = Decimal(0)


class JumpNeighborIndex:
    """Balanced 3D kd-tree + bounded LRU of exact neighbors by (ID, range).

    Construct a new index when CCP data changes. Policy and pilot information
    are deliberately not cached. Worst-case dense neighborhoods remain O(N).
    """
    def __init__(self, systems, max_cached_neighborhoods=512):
        if max_cached_neighborhoods < 1:
            raise ValueError('Positive cache limit required')
        self._systems = {int(cid): deepcopy(row) for cid, row in systems.items()}
        if len(self._systems) != len(systems):
            raise ValueError('Duplicate system IDs')
        self._positions = {}
        for cid, row in self._systems.items():
            if cid <= 0:
                raise ValueError('Invalid system ID')
            # Validation and all exact distance/range decisions belong to math.
            math.distance_ly(row, row)
            self._positions[cid] = tuple(Decimal(str(row['position_m'][a])) for a in ('x','y','z'))
        def build(ids, depth=0):
            if not ids:
                return None
            axis = depth % 3
            ids.sort(key=lambda cid: (self._positions[cid][axis], cid))
            mid = len(ids)//2
            return (ids[mid], axis, build(ids[:mid], depth+1), build(ids[mid+1:], depth+1))
        self._tree = build(list(self._systems))
        self._cache = OrderedDict()
        self._limit = max_cached_neighborhoods
        self._lock = RLock()

    def neighbors(self, system_id, effective_range):
        cid = int(system_id)
        radius = Decimal(str(effective_range))
        math.is_reachable(0, radius)  # Validate finite, nonnegative range.
        key = (cid, radius)
        with self._lock:
            if key in self._cache:
                self._cache.move_to_end(key)
                return self._cache[key]
            center = self._positions[cid]
            # Bounding box only. Never substitute this for exact distance_ly.
            extent = radius * math.METERS_PER_LY
            result = []
            def visit(tree):
                if tree is None:
                    return
                other, axis, left, right = tree
                point = self._positions[other]
                if other != cid and all(abs(point[i]-center[i]) <= extent for i in range(3)):
                    distance = math.distance_ly(self._systems[cid], self._systems[other])
                    if math.is_reachable(distance, radius):
                        result.append((other, distance))
                if center[axis]-extent <= point[axis]:
                    visit(left)
                if center[axis]+extent >= point[axis]:
                    visit(right)
            visit(self._tree)
            value = tuple(sorted(result))
            self._cache[key] = value
            if len(self._cache) > self._limit:
                self._cache.popitem(last=False)
            return value


def _route(origin, legs, reachable=True):
    return {'reachable': reachable, 'systems': [origin]+[leg['target_id'] for leg in legs] if reachable else [],
            'legs': legs, 'jump_count': len(legs),
            'total_distance_ly': sum((leg['distance_ly'] for leg in legs), ZERO) if reachable else None,
            'total_fuel_raw': sum((leg['fuel_raw'] for leg in legs), ZERO) if reachable else None}


def find_direct_jump(origin_system_id, destination_system_id, *, systems, jump_profile,
                     hull_stats, ship_class, destination_policy):
    """Same route result shape, but never searches for a midpoint."""
    return _find(origin_system_id, destination_system_id, systems=systems,
                 jump_profile=jump_profile, hull_stats=hull_stats, ship_class=ship_class,
                 destination_policy=destination_policy, direct=True)


def find_jump_route(origin_system_id, destination_system_id, *, systems, jump_profile,
                    hull_stats, ship_class, destination_policy, mode=FEWEST_JUMPS,
                    waypoints=(), pilot_account_group_id=None, cyno_candidates=(), danger_cost=None):
    return _find(origin_system_id, destination_system_id, systems=systems,
                 jump_profile=jump_profile, hull_stats=hull_stats, ship_class=ship_class,
                 destination_policy=destination_policy, mode=mode, waypoints=waypoints,
                 pilot_account_group_id=pilot_account_group_id, cyno_candidates=cyno_candidates, danger_cost=danger_cost)


def _find(origin_system_id, destination_system_id, *, systems, jump_profile, hull_stats,
          ship_class, destination_policy, mode=FEWEST_JUMPS, waypoints=(),
          pilot_account_group_id=None, cyno_candidates=(), direct=False, danger_cost=None):
    if mode not in (FEWEST_JUMPS, LEAST_FUEL, SAFEST, SAFER):
        raise ValueError('Unknown jump route mode')
    if mode in (SAFEST, SAFER) and not callable(danger_cost):
        raise ValueError('SAFEST requires an external danger cost provider')
    risks = {}
    def risk(cid):
        if cid not in risks:
            value = Decimal(str(danger_cost(cid)))
            if not value.is_finite() or value < 0:
                raise ValueError('Danger cost must be finite and nonnegative')
            risks[cid] = value
        return risks[cid]
    if not callable(destination_policy):
        raise ValueError('Destination policy required')
    index = systems if isinstance(systems, JumpNeighborIndex) else JumpNeighborIndex(systems)
    stops = [int(origin_system_id), *(int(cid) for cid in waypoints), int(destination_system_id)]
    if any(cid not in index._systems for cid in stops):
        raise ValueError('Unknown origin, waypoint or destination')
    effective_range = math.max_jump_range(hull_stats, jump_profile.jump_drive_calibration)
    def fuel(distance):
        return math.fuel_for_leg(distance, hull_stats, jump_profile.jump_fuel_conservation,
                                 is_jump_freighter=ship_class == 'JUMP_FREIGHTER',
                                 jump_freighters=jump_profile.jump_freighters)
    fuel(ZERO)  # Reject invalid skill levels even for empty/impossible routes.
    allowed = {}
    def permits(cid):
        if cid not in allowed:
            allowed[cid] = bool(destination_policy(deepcopy(index._systems[cid]), ship_class))
        return allowed[cid]
    def group(value):
        return str(int(value)) if not isinstance(value, bool) and str(value).isdigit() and int(value)>0 else None
    pilot_group = group(pilot_account_group_id)
    positioned = set()
    for candidate in cyno_candidates:
        account = group(candidate.get('account_group_id'))
        if (pilot_group and account and account != pilot_group
                and str(candidate.get('character_id')) != str(jump_profile.character_id)
                and group(candidate.get('character_id'))
                and candidate.get('cyno_skilled') is True and candidate.get('position_fresh') is True):
            positioned.add(int(candidate['system_id']))

    def leg(source, target, distance):
        return {'source_id': source, 'target_id': target, 'distance_ly': distance,
                'fuel_raw': fuel(distance), 'kind': 'JUMP'}

    def segment(start, goal, search_mode=mode, max_legs=None):
        if start == goal:
            return []
        if not permits(goal):
            return None
        if direct:
            distance = math.distance_ly(index._systems[start], index._systems[goal])
            return [leg(start, goal, distance)] if math.is_reachable(distance, effective_range) else None
        if search_mode == SAFER and max_legs is None:
            baseline = segment(start, goal, FEWEST_JUMPS)
            if baseline is None:
                return None
            max_legs = len(baseline) + min(SAFER_MAX_EXTRA_JUMPS, (len(baseline)+3)//4)
        initial = (ZERO, 0, 0, ZERO, ZERO)
        start_key = (start, 0) if search_mode == SAFER else start
        best, previous, queue = {start_key: initial}, {}, [(initial, start_key)]
        while queue:
            cost, current_key = heapq.heappop(queue)
            current = current_key[0] if search_mode == SAFER else current_key
            if cost != best[current_key]:
                continue
            if current == goal:
                legs = []
                while current_key != start_key:
                    previous_key, value = previous[current_key]
                    legs.append(value)
                    current_key = previous_key
                return list(reversed(legs))
            if search_mode == SAFER and current_key[1] >= max_legs:
                continue
            for target, distance in index.neighbors(current, effective_range):
                if not permits(target):
                    continue
                value = leg(current, target, distance)
                midpoint = target != goal
                missing_cyno = int(midpoint and target not in positioned)
                missing_station = int(midpoint and index._systems[target].get('npc_station') is not True)
                step = ((1, missing_cyno, missing_station, value['fuel_raw'], distance)
                        if search_mode == FEWEST_JUMPS else
                        (risk(target), 1, missing_cyno, missing_station, value['fuel_raw'])
                        if search_mode in (SAFEST, SAFER) else
                        (value['fuel_raw'], missing_cyno, missing_station, distance, 1))
                candidate_cost = tuple(a+b for a,b in zip(cost, step))
                target_key = (target, current_key[1]+1) if search_mode == SAFER else target
                if target_key not in best or candidate_cost < best[target_key]:
                    best[target_key] = candidate_cost
                    previous[target_key] = (current_key, value)
                    heapq.heappush(queue, (candidate_cost, target_key))
        return None

    legs = []
    for start, goal in zip(stops, stops[1:]):
        part = segment(start, goal)
        if part is None:
            return _route(stops[0], [], reachable=False)
        legs.extend(part)
    return _route(stops[0], legs)
