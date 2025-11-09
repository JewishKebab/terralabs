# backend/azure_client.py
import os
import time
from typing import Dict, List, Any, Optional, Tuple

from azure.identity import (
    DefaultAzureCredential,
    ClientSecretCredential,
    AzureCliCredential,
)
from azure.mgmt.compute import ComputeManagementClient
from azure.mgmt.network import NetworkManagementClient

TAG_KEYS_LAB_ID = [
    os.environ.get("TL_TAG_LAB_ID_KEY") or "LabId",
    "lab_id", "LabID", "labId", "TLABS_LAB", "TLABS_LAB_ID",
]
TAG_KEYS_COURSE = [
    os.environ.get("TL_TAG_COURSE_KEY") or "LabCourse",
    "course", "Course", "TLABS_COURSE",
]
TAG_KEYS_CREATED_AT = ["CreatedAt", "CreatedOnDate", "created_at"]
TAG_KEYS_EXPIRES_AT = ["ExpiresAt", "expires_at"]
RG_PREFIX = os.environ.get("TL_RG_PREFIX") or ""

_COMPUTE: Optional[ComputeManagementClient] = None
_NETWORK: Optional[NetworkManagementClient] = None
_SUBSCRIPTION_ID: Optional[str] = None


def _build_credential():
    # Explicit switch to use the logged-in Azure CLI user if requested
    if (os.environ.get("TL_USE_AZCLI") or "").lower() in ("1", "true", "yes"):
        return AzureCliCredential()

    tenant = os.environ.get("AZURE_TENANT_ID")
    client = os.environ.get("AZURE_CLIENT_ID")
    secret = os.environ.get("AZURE_CLIENT_SECRET")
    if tenant and client and secret:
        return ClientSecretCredential(tenant_id=tenant, client_id=client, client_secret=secret)

    # Fallback: Default chain (kept minimal to avoid “mystery identities”)
    return DefaultAzureCredential(
        exclude_environment_credential=False,
        exclude_managed_identity_credential=False,
        exclude_shared_token_cache_credential=True,
        exclude_visual_studio_code_credential=True,
        exclude_cli_credential=True,
        exclude_powershell_credential=True,
        exclude_interactive_browser_credential=True,
    )


def _ensure_clients() -> None:
    global _COMPUTE, _NETWORK, _SUBSCRIPTION_ID
    if _COMPUTE is not None and _NETWORK is not None:
        return
    sub_id = os.environ.get("AZURE_SUBSCRIPTION_ID")
    if not sub_id:
        raise RuntimeError("Missing AZURE_SUBSCRIPTION_ID in environment")
    cred = _build_credential()
    _COMPUTE = ComputeManagementClient(cred, sub_id)
    _NETWORK = NetworkManagementClient(cred, sub_id)
    _SUBSCRIPTION_ID = sub_id


def _compute() -> ComputeManagementClient:
    _ensure_clients()
    assert _COMPUTE is not None
    return _COMPUTE


def _network() -> NetworkManagementClient:
    _ensure_clients()
    assert _NETWORK is not None
    return _NETWORK


def _parse_resource_id(resource_id: str) -> Dict[str, str]:
    parts = [p for p in resource_id.strip("/").split("/") if p]
    out: Dict[str, str] = {}
    for i in range(0, len(parts) - 1, 2):
        out[parts[i]] = parts[i + 1]
    return out


def _get_tag(tags: Dict[str, str], keys: List[str]) -> Optional[str]:
    for k in keys:
        if k in tags and tags[k]:
            return tags[k]
    return None


def _primary_ip_config(nic: Any) -> Optional[Any]:
    cfgs = getattr(nic, "ip_configurations", None) or []
    primary = next((c for c in cfgs if getattr(c, "primary", False)), None)
    return primary or (cfgs[0] if cfgs else None)


def _get_private_ip_from_nic(nic: Any) -> Optional[str]:
    cfg = _primary_ip_config(nic)
    return getattr(cfg, "private_ip_address", None) if cfg else None


def _get_public_ip_from_nic(nic: Any) -> Optional[str]:
    cfg = _primary_ip_config(nic)
    if not cfg:
        return None
    pip_ref = getattr(cfg, "public_ip_address", None)
    if not pip_ref or not getattr(pip_ref, "id", None):
        return None
    rid = _parse_resource_id(pip_ref.id)
    rg = rid.get("resourceGroups")
    name = rid.get("publicIPAddresses")
    if not rg or not name:
        return None
    try:
        pip = _network().public_ip_addresses.get(rg, name)
        return getattr(pip, "ip_address", None)
    except Exception:
        return None


def _resolve_vm_ips(vm: Any, attempts: int = 5, sleep_s: float = 2.0) -> Dict[str, Optional[str]]:
    nic_id: Optional[str] = None
    try:
        nics = getattr(getattr(vm, "network_profile", None), "network_interfaces", None) or []
        primary_ref = next((r for r in nics if getattr(r, "primary", False)), None)
        nic_id = getattr(primary_ref or (nics[0] if nics else None), "id", None)
    except Exception:
        pass
    if not nic_id:
        return {"private_ip": None, "public_ip": None}

    rid = _parse_resource_id(nic_id)
    rg = rid.get("resourceGroups")
    nic_name = rid.get("networkInterfaces")
    if not rg or not nic_name:
        return {"private_ip": None, "public_ip": None}

    private_ip, public_ip = None, None
    for _ in range(attempts):
        try:
            nic = _network().network_interfaces.get(rg, nic_name)
            private_ip = _get_private_ip_from_nic(nic)
            public_ip = _get_public_ip_from_nic(nic)
            if private_ip or public_ip:
                break
        except Exception:
            pass
        time.sleep(sleep_s)
    return {"private_ip": private_ip, "public_ip": public_ip}


def _get_power_state(vm: Any) -> Optional[str]:
    try:
        rid = _parse_resource_id(vm.id)
        rg = rid.get("resourceGroups")
        name = rid.get("virtualMachines")
        if not rg or not name:
            return None
        iv = _compute().virtual_machines.instance_view(rg, name)
        for st in (getattr(iv, "statuses", None) or []):
            code = getattr(st, "code", "")
            if code.startswith("PowerState/"):
                return code.split("/", 1)[1]
    except Exception:
        pass
    return None


def _rg_is_allowed(resource_group: Optional[str]) -> bool:
    if not RG_PREFIX:
        return True
    return (resource_group or "").startswith(RG_PREFIX)


def list_vms_in_lab(lab_id: str, course: Optional[str] = None) -> List[Dict[str, Any]]:
    _ensure_clients()
    out: List[Dict[str, Any]] = []
    for vm in _compute().virtual_machines.list_all():
        rid = _parse_resource_id(vm.id)
        if not _rg_is_allowed(rid.get("resourceGroups")):
            continue
        tags = getattr(vm, "tags", {}) or {}
        tag_lab = _get_tag(tags, TAG_KEYS_LAB_ID)
        tag_course = _get_tag(tags, TAG_KEYS_COURSE) or ""
        if tag_lab != lab_id:
            continue
        if course and tag_course != course:
            continue
        size = getattr(getattr(vm, "hardware_profile", None), "vm_size", None)
        ips = _resolve_vm_ips(vm)
        pwr = _get_power_state(vm)
        out.append({
            "id": vm.id,
            "name": vm.name,
            "size": size,
            "private_ip": ips.get("private_ip"),
            "public_ip": ips.get("public_ip"),
            "power_state": pwr,
            "tags": tags,
        })
    return out


def list_running_labs() -> List[Dict[str, Any]]:
    _ensure_clients()
    grouped: Dict[Tuple[str, str], Dict[str, Any]] = {}
    for vm in _compute().virtual_machines.list_all():
        rid = _parse_resource_id(vm.id)
        if not _rg_is_allowed(rid.get("resourceGroups")):
            continue
        tags = getattr(vm, "tags", {}) or {}
        lab_id = _get_tag(tags, TAG_KEYS_LAB_ID)
        if not lab_id:
            continue
        course = _get_tag(tags, TAG_KEYS_COURSE) or ""
        key = (lab_id, course)
        if key not in grouped:
            grouped[key] = {
                "lab_id": lab_id,
                "course": course,
                "created_at": _get_tag(tags, TAG_KEYS_CREATED_AT),
                "expires_at": _get_tag(tags, TAG_KEYS_EXPIRES_AT),
                "vms": [],
            }
        size = getattr(getattr(vm, "hardware_profile", None), "vm_size", None)
        ips = _resolve_vm_ips(vm)
        pwr = _get_power_state(vm)
        grouped[key]["vms"].append({
            "id": vm.id,
            "name": vm.name,
            "size": size,
            "private_ip": ips.get("private_ip"),
            "public_ip": ips.get("public_ip"),
            "power_state": pwr,
            "tags": tags,
        })
    labs = list(grouped.values())
    labs.sort(key=lambda x: (x["course"], x["lab_id"]))
    return labs


def start_vm_by_id(vm_id: str) -> str:
    _ensure_clients()
    rid = _parse_resource_id(vm_id)
    rg = rid.get("resourceGroups")
    name = rid.get("virtualMachines")
    if not rg or not name:
        raise ValueError("Invalid VM id")
    _compute().virtual_machines.begin_start(rg, name)
    return "start_requested"


def stop_vm_by_id(vm_id: str, deallocate: bool = True) -> str:
    _ensure_clients()
    rid = _parse_resource_id(vm_id)
    rg = rid.get("resourceGroups")
    name = rid.get("virtualMachines")
    if not rg or not name:
        raise ValueError("Invalid VM id")
    if deallocate:
        _compute().virtual_machines.begin_deallocate(rg, name)
        return "deallocate_requested"
    else:
        _compute().virtual_machines.begin_power_off(rg, name)
        return "poweroff_requested"

# --- DEBUG helpers ------------------------------------------------------------
def _identity_mode() -> str:
    if (os.environ.get("TL_USE_AZCLI") or "").lower() in ("1", "true", "yes"):
        return "AzureCliCredential"
    tenant = os.environ.get("AZURE_TENANT_ID")
    client = os.environ.get("AZURE_CLIENT_ID")
    secret = os.environ.get("AZURE_CLIENT_SECRET")
    if tenant and client and secret:
        return "ClientSecretCredential"
    return "DefaultAzureCredential"

def debug_snapshot(max_vms: int = 10):
    """
    Returns a small snapshot of what the SDK can see:
    - identity mode
    - subscription id
    - total vm count
    - up to max_vms VM names + selected tags + RG
    """
    _ensure_clients()
    sample = []
    total = 0
    from itertools import islice
    # Iterate once to count, but also collect up to `max_vms` samples.
    vms_iter = list(_compute().virtual_machines.list_all())
    total = len(vms_iter)
    for vm in islice(vms_iter, 0, max_vms):
        rid = _parse_resource_id(vm.id)
        rg = rid.get("resourceGroups")
        tags = getattr(vm, "tags", {}) or {}
        sample.append({
            "name": vm.name,
            "resource_group": rg,
            "tags_subset": {
                "LabId": tags.get("LabId"),
                "lab_id": tags.get("lab_id"),
                "LabID": tags.get("LabID"),
                "labId": tags.get("labId"),
                "TLABS_LAB": tags.get("TLABS_LAB"),
                "LabCourse": tags.get("LabCourse"),
                "course": tags.get("course"),
                "CreatedAt": tags.get("CreatedAt") or tags.get("CreatedOnDate"),
                "ExpiresAt": tags.get("ExpiresAt"),
            }
        })
    return {
        "identity_mode": _identity_mode(),
        "subscription_id": _SUBSCRIPTION_ID,
        "vm_total_seen": total,
        "rg_prefix_filter": os.environ.get("TL_RG_PREFIX") or "",
        "sample": sample,
    }

__all__ = ["list_vms_in_lab", "list_running_labs", "start_vm_by_id", "stop_vm_by_id", "debug_snapshot"]
