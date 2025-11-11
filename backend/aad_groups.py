# aad_groups.py
import os, json

def load_group_map():
    raw = os.getenv("AAD_GROUP_MAP", "{}")
    try:
        data = json.loads(raw)
        # env maps GUID -> friendly name
        # normalize keys to lowercase for case-insensitive lookup
        return {k.lower(): v for k, v in data.items()}
    except Exception:
        print("[aad_groups] Invalid AAD_GROUP_MAP JSON")
        return {}

def resolve_group_names_from_ids(group_ids):
    """Convert a list of GUIDs from the token into friendly names using env map."""
    mapping = load_group_map()
    names = []
    for gid in (group_ids or []):
        names.append(mapping.get(str(gid).lower(), str(gid)))
    return names

def derive_role_scope(group_names):
    """
    From friendly group names, derive (role, course, section).
    Rules:
      - If any group contains 'asgard' (case-insensitive) => role 'asgard'
      - 'segel-<course>[-<section>]' => role 'segel'
      - 'students-<course>[-<section>]' => role 'student'
      - otherwise 'unknown'
    """
    if not group_names:
        return ("unknown", None, None)

    # asgard override
    for g in group_names:
        if "asgard" in g.lower():
            return ("asgard", None, None)

    # teachers
    for g in group_names:
        gl = g.lower()
        if gl.startswith("segel"):
            parts = g.split("-", 2)
            role = "segel"
            course = parts[1] if len(parts) > 1 else None
            section = parts[2] if len(parts) > 2 else None
            return (role, course, section)

    # students
    for g in group_names:
        gl = g.lower()
        if gl.startswith("students"):
            parts = g.split("-", 2)
            role = "student"
            course = parts[1] if len(parts) > 1 else None
            section = parts[2] if len(parts) > 2 else None
            return (role, course, section)

    return ("unknown", None, None)
