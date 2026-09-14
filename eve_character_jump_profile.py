"""Effective jump skills only; no range, fuel, routing or UI calculations.

Requires the existing esi-skills.read_skills.v1 scope. Authentication errors
remain EsiResult errors, never an all-zero profile. Transport owns caching,
token refresh and rate limiting.
"""
from dataclasses import dataclass, replace

import mmd_esi_auth as auth


SKILL_FIELDS = {
    3456: "jump_drive_operation",
    21611: "jump_drive_calibration",
    21610: "jump_fuel_conservation",
    21603: "cynosural_field_theory",
    29029: "jump_freighters",
}


@dataclass(frozen=True)
class CharacterJumpProfile:
    character_id: int
    jump_drive_operation: int = 0
    jump_drive_calibration: int = 0
    jump_fuel_conservation: int = 0
    cynosural_field_theory: int = 0
    jump_freighters: int = 0


def get_character_jump_profile(character_id):
    """Return EsiResult with CharacterJumpProfile data and transport metadata."""
    try:
        cid = int(character_id)
        if cid <= 0:
            raise ValueError
    except (TypeError, ValueError):
        return auth.failure("", "invalid_character", "Character ID invalide")
    path = f"/v4/characters/{cid}/skills/"
    result = auth.get_json(path, cid)
    if not result.ok:
        return result
    payload = result.data
    if not isinstance(payload, dict) or not isinstance(payload.get("skills"), list):
        return auth.failure(path, "invalid_payload", "Liste de skills ESI attendue")
    levels = {}
    for skill in payload["skills"]:
        if not isinstance(skill, dict) or type(skill.get("skill_id")) is not int:
            return auth.failure(path, "invalid_payload", "Skill ESI invalide")
        field = SKILL_FIELDS.get(skill["skill_id"])
        if field is None:
            continue
        level = skill.get("active_skill_level")
        if type(level) is not int or not 0 <= level <= 5 or field in levels:
            return auth.failure(path, "invalid_payload", "Niveau actif ESI invalide")
        levels[field] = level
    return replace(result, data=CharacterJumpProfile(cid, **levels))
