# backend/azure_labs.py
from typing import List, Dict, Any, Optional

from azure_client import (
    _ensure_clients,
    _compute,
    parse_resource_id,
    resolve_vm_ips,
    get_power_state_from_instance_view,
)

def list_running_labs(lab_id: str, course: Optional[str] = None) -> List[Dict[str, Any]]:
    """
    Return a flat list of VMs that have tag LabId == lab_id (and optional LabCourse == course).
    Includes: id, name, size, private_ip, public_ip (if any), power_state, tags.
    """
    _ensure_clients()
    out: List[Dict[str, Any]] = []

    for vm in _compute().virtual_machines.list_all():
        tags = getattr(vm, "tags", {}) or {}
        if tags.get("LabId") != lab_id:
            continue
        if course and tags.get("LabCourse") != course:
            continue

        rid = parse_resource_id(vm.id)
        rg = rid.get("resourceGroups")
        name = rid.get("virtualMachines")

        size = getattr(getattr(vm, "hardware_profile", None), "vm_size", None)
        power_state = get_power_state_from_instance_view(rg, name) if (rg and name) else None
        ips = resolve_vm_ips(vm)

        out.append({
            "id": vm.id,
            "name": vm.name,
            "size": size,
            "power_state": power_state,
            "private_ip": ips.get("private_ip"),
            "public_ip": ips.get("public_ip"),
            "tags": tags,
        })

    return out
