# backend/azure_client.py
import os
import time
from typing import Dict, List, Any, Optional, Tuple

from azure.identity import DefaultAzureCredential
from azure.mgmt.compute import ComputeManagementClient
from azure.mgmt.network import NetworkManagementClient

# -------- Lazy clients (avoid failing at import time) --------
_COMPUTE: Optional[ComputeManagementClient] = None
_NETWORK: Optional[NetworkManagementClient] = None
_SUBSCRIPTION_ID: Optional[str] = None


def _ensure_clients() -> None:
    """Create cached Azure SDK clients if not already created."""
    global _COMPUTE, _NETWORK, _SUBSCRIPTION_ID
    if _COMPUTE is not None and _NETWORK is not None:
        return

    sub_id = os.environ.get("AZURE_SUBSCRIPTION_ID")
    if not sub_id:
        raise RuntimeError("Missing AZURE_SUBSCRIPTION_ID in environment")

    # Uses the standard Azure auth chain (env vars, managed identity, etc.)
    cred = DefaultAzureCredential(exclude_interactive_browser_credential=False)
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


# -------- Helpers --------
def _parse_resource_id(resource_id: str) -> Dict[str, str]:
    """
    Parse a standard Azure resource ID into a simple dict of segments.
    Example: /subscriptions/<sub>/resourceGroups/<rg>/providers/.../networkInterfaces/<nic>
    Returns keys like 'subscriptions','resourceGroups','networkInterfaces', etc.
    """
    parts = [p for p in resource_id.strip("/").split("/") if p]
    out: Dict[str, str] = {}
    # iterate in pairs
    for i in range(0, len(parts) - 1, 2):
        out[parts[i]] = parts[i + 1]
    return out


def _primary_ip_config(nic: Any) -> Optional[Any]:
    """Return the primary ip_configuration (or first)."""
    configs = getattr(nic, "ip_configurations", None) or []
    primary = next((c for c in configs if getattr(c, "primary", False)), None)
    return primary or (configs[0] if configs else None)


def _get_private_ip_from_nic(nic: Any) -> Optional[str]:
    cfg = _primary_ip_config(nic)
    if not cfg:
        return None
    return getattr(cfg, "private_ip_address", None)


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
        # public IP might not yet be fully provisioned
        return None


def _resolve_vm_ips(vm: Any, attempts: int = 5, sleep_s: float = 2.0) -> Dict[str, Optional[str]]:
    """
    Try a few times to resolve NIC + IPs — Azure can be eventually consistent
    right after provisioning.
    """
    nic_id: Optional[str] = None
    try:
        nics = getattr(getattr(vm, "network_profile", None), "network_interfaces", None) or []
        primary_ref = next((r for r in nics if getattr(r, "primary", False)), None)
        nic_id = getattr(primary_ref or (nics[0] if nics else None), "id", None)
    except Exception:
        nic_id = None

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
    """
    Query the VM instance view to get the power state (e.g. 'running', 'stopped', 'deallocated').
    """
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


# -------- Public API: listing --------
def list_vms_in_lab(lab_id: str, course: Optional[str] = None) -> List[Dict[str, Any]]:
    """
    Return a list of VMs that have tag LabId == lab_id (and optional LabCourse == course).
    """
    _ensure_clients()
    results: List[Dict[str, Any]] = []

    for vm in _compute().virtual_machines.list_all():
        tags = getattr(vm, "tags", {}) or {}
        if tags.get("LabId") != lab_id:
            continue
        if course and tags.get("LabCourse") != course:
            continue

        size = getattr(getattr(vm, "hardware_profile", None), "vm_size", None)
        ips = _resolve_vm_ips(vm)
        pwr = _get_power_state(vm)

        results.append({
            "id": vm.id,
            "name": vm.name,
            "size": size,
            "private_ip": ips.get("private_ip"),
            "public_ip": ips.get("public_ip"),
            "power_state": pwr,
            "tags": tags,
        })

    return results


def list_running_labs() -> List[Dict[str, Any]]:
    """
    Enumerate ALL VMs in the subscription, group by LabId (+ LabCourse),
    and return a list of lab objects:
      {
        "lab_id": "...",
        "course": "...",
        "created_at": tags.get("CreatedAt") or tags.get("CreatedOnDate"),
        "expires_at": tags.get("ExpiresAt"),
        "vms": [ ... as in list_vms_in_lab ... ]
      }
    """
    _ensure_clients()

    # (lab_id, course) -> { meta..., "vms": [] }
    grouped: Dict[Tuple[str, str], Dict[str, Any]] = {}

    for vm in _compute().virtual_machines.list_all():
        tags = getattr(vm, "tags", {}) or {}
        lab_id = tags.get("LabId")
        if not lab_id:
            continue
        course = tags.get("LabCourse", "") or ""
        key = (lab_id, course)

        if key not in grouped:
            grouped[key] = {
                "lab_id": lab_id,
                "course": course,
                "created_at": tags.get("CreatedAt") or tags.get("CreatedOnDate"),
                "expires_at": tags.get("ExpiresAt"),
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

    labs: List[Dict[str, Any]] = list(grouped.values())
    labs.sort(key=lambda x: (x["course"], x["lab_id"]))
    return labs


# -------- Public API: power controls --------
def start_vm_by_id(vm_id: str) -> str:
    """
    Begin Start (async) for a VM by its resource ID. Returns a quick status string.
    """
    _ensure_clients()
    rid = _parse_resource_id(vm_id)
    rg = rid.get("resourceGroups")
    name = rid.get("virtualMachines")
    if not rg or not name:
        raise ValueError("Invalid VM id")
    _compute().virtual_machines.begin_start(rg, name)  # async
    return "start_requested"


def stop_vm_by_id(vm_id: str, deallocate: bool = True) -> str:
    """
    Begin Stop (async). If deallocate=True, deallocates (no compute billing).
    """
    _ensure_clients()
    rid = _parse_resource_id(vm_id)
    rg = rid.get("resourceGroups")
    name = rid.get("virtualMachines")
    if not rg or not name:
        raise ValueError("Invalid VM id")
    if deallocate:
        _compute().virtual_machines.begin_deallocate(rg, name)  # async
        return "deallocate_requested"
    else:
        _compute().virtual_machines.begin_power_off(rg, name)  # async
        return "poweroff_requested"


__all__ = [
    "list_vms_in_lab",
    "list_running_labs",
    "start_vm_by_id",
    "stop_vm_by_id",
]
