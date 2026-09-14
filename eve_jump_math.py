"""Pure jump arithmetic; callers supply CCP systems and loaded SDE hull rows.

No files, network, rendering or route/destination legality checks.
EVE LY definition: https://developers.eveonline.com/docs/guides/map-data/
Fuel is raw (Decimal), not a guaranteed integer inventory requirement.
"""
from dataclasses import dataclass
from decimal import Decimal, InvalidOperation


METERS_PER_LY = Decimal('9460000000000000')


def _number(value):
    try:
        result = Decimal(str(value))
    except (InvalidOperation, ValueError):
        raise ValueError('Finite numeric value required') from None
    if not result.is_finite():
        raise ValueError('Finite numeric value required')
    return result


def _nonnegative(value):
    value = _number(value)
    if value < 0:
        raise ValueError('Negative value')
    return value


def _skill(level):
    if type(level) is not int or not 0 <= level <= 5:
        raise ValueError('Skill level must be an integer from 0 to 5')
    return Decimal(level)


@dataclass(frozen=True)
class JumpHullStats:
    fuel_type_id: int
    base_range_ly: Decimal
    base_fuel_per_ly: Decimal


def hull_stats_from_sde(hull_row):
    """Extract 866/867/868 from the existing types.json dogma_attributes shape.

    Missing attributes are an error, not a fabricated default hull capability.
    """
    attrs = hull_row['dogma_attributes']
    values = {attribute: _nonnegative(attrs[str(attribute)]['value'])
              for attribute in (866, 867, 868)}
    fuel_type = values[866]
    if fuel_type <= 0 or fuel_type != fuel_type.to_integral_value():
        raise ValueError('Invalid SDE fuel type ID')
    return JumpHullStats(int(fuel_type), values[867], values[868])


def distance_ly(source, target):
    """Euclidean distance using exclusively system['position_m'][x/y/z]."""
    delta = [_number(source['position_m'][axis]) - _number(target['position_m'][axis])
             for axis in ('x', 'y', 'z')]
    return sum((value * value for value in delta), Decimal(0)).sqrt() / METERS_PER_LY


def max_jump_range(hull, jdc):
    return _nonnegative(hull.base_range_ly) * (1 + Decimal('.20') * _skill(jdc))


def is_reachable(distance, jump_range):
    """Inclusive geometric range test only; no epsilon or destination policy."""
    return _nonnegative(distance) <= _nonnegative(jump_range)


def fuel_for_leg(distance, hull, jfc, *, is_jump_freighter=False, jump_freighters=0):
    """Return fuelRaw without ceil/floor/quantize.

    Caller identifies the hull class from SDE; possessing the Jump Freighters
    skill alone must not grant its bonus to other hulls.
    """
    if type(is_jump_freighter) is not bool:
        raise ValueError('Explicit boolean hull classification required')
    jf = _skill(jump_freighters)
    raw = (_nonnegative(distance) * _nonnegative(hull.base_fuel_per_ly)
           * (1 - Decimal('.10') * _skill(jfc)))
    if is_jump_freighter:
        raw *= 1 - Decimal('.10') * jf
    return raw
