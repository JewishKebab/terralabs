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
from azure.mgmt.compute.models import VirtualMachineUpdate, SnapshotUpdate


# ---------------- Config / Tag keys & RG scope ----------------
TARGET_RESOURCE_GROUP = "Projects-TerraLabs-RG"  # scope for destructive ops

# Hardcoded tag keys (no env vars)
TAG_KEYS_LAB_ID = ["LabId", "lab_id", "LabID", "labId", "TLABS_LAB", "TLABS_LAB_ID"]
TAG_KEYS_COURSE = ["LabCourse", "course", "Course", "TLABS_COURSE"]
TAG_KEYS_CREATED_AT = ["CreatedAt", "CreatedOnDate", "created_at"]
TAG_KEYS_EXPIRES_AT = ["ExpiresAt", "expires_at"]

# Hardcoded “feature” tags
TAG_PUBLISHED = "Published"                  # value: "true" to count as published
TAG_OCCUPIED_BY = "occupiedbystudent"        # student id/email
TAG_OCCUPIED_NAME = "occupiedbystudentname"  # student display name

# Optional RG prefix filter for discovery (kept; if empty matches all)
RG_PREFIX = os.environ.get("TL_RG_PREFIX") or ""

# ---------------- Clients ----------------
_COMPUTE: Optional[ComputeManagementClient] = None
_NETWORK: Optional[NetworkManagementClient] = None
_SUBSCRIPTION_ID: Optional[str] = None


def _build_credential():
    if (os.environ.get("TL_USE_AZCLI") or "").lower() in ("1", "true", "yes"):
        return AzureCliCredential()

    tenant = os.environ.get("AZURE_TENANT_ID")
    client = os.environ.get("AZURE_CLIENT_ID")
    secret = os.environ.get("AZURE_CLIENT_SECRET")
    if tenant and client and secret:
        return ClientSecretCredential(tenant_id=tenant, client_id=client, client_secret=secret)

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


# ---------------- Utilities ----------------
def _parse_resource_id(resource_id: str) -> Dict[str, str]:
    parts = [p for p in resource_id.strip("/").split("/") if p]
    out: Dict[str, str] = {}
    for i in range(0, len(parts) - 1, 2):
        out[parts[i]] = parts[i + 1]
    return out


def _get_tag(tags: Dict[str, str], keys: List[str]) -> Optional[str]:
    for k in keys:
        # case-sensitive keys, but try both common spellings we provide
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


# ---------------- Discovery ----------------
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

# ---- Published/enrollment helpers --------------------

def _vm_matches_lab(vm: Any, lab_id: str, course: Optional[str]) -> bool:
    tags = getattr(vm, "tags", {}) or {}
    tag_lab = _get_tag(tags, TAG_KEYS_LAB_ID)
    tag_course = _get_tag(tags, TAG_KEYS_COURSE) or ""
    if tag_lab != lab_id:
        return False
    if course and tag_course != course:
        return False
    return True


def list_published_labs() -> List[Dict[str, Any]]:
    """
    Returns [{lab_id, course, published: bool}] using VM tags only.
    A lab is 'published' if ANY VM for (lab_id, course) has tag Published in {"true","1","yes"} (case-insensitive).
    """
    _ensure_clients()
    by_key: Dict[Tuple[str, str], Dict[str, Any]] = {}
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
        if key not in by_key:
            by_key[key] = {"lab_id": lab_id, "course": course, "published": False}
        pv = str(tags.get(TAG_PUBLISHED, "")).lower()
        if pv in ("true", "1", "yes"):
            by_key[key]["published"] = True
    out = list(by_key.values())
    out.sort(key=lambda x: (x["course"], x["lab_id"]))
    return out


def set_lab_published(*, lab_id: str, course: Optional[str], published: bool) -> Dict[str, Any]:
    """
    Set tag {Published: "true"} on ALL VMs belonging to the (lab_id, course) lab.
    Remove the tag when unpublishing.
    """
    _ensure_clients()
    updated = 0
    for vm in _compute().virtual_machines.list_all():
        rid = _parse_resource_id(vm.id)
        if not _rg_is_allowed(rid.get("resourceGroups")):
            continue
        if not _vm_matches_lab(vm, lab_id, course):
            continue
        rg = rid.get("resourceGroups")
        name = rid.get("virtualMachines")
        tags = dict(getattr(vm, "tags", {}) or {})
        if published:
            tags[TAG_PUBLISHED] = "true"
        else:
            tags.pop(TAG_PUBLISHED, None)
        update = VirtualMachineUpdate(tags=tags)
        _compute().virtual_machines.begin_update(rg, name, update).result()
        updated += 1
    return {"updated": updated, "published": published, "lab_id": lab_id, "course": course or ""}


def enroll_student_in_lab(*, lab_id: str, course: Optional[str], who: str, who_name: Optional[str] = None) -> Optional[Dict[str, Any]]:
    """
    Find a VM in the lab that does NOT have occupiedbystudent set; claim it by tagging.
    Returns VM details or None if none free (or not published).
    """
    _ensure_clients()
    # Require published lab
    pub_list = list_published_labs()
    if not any(pl["lab_id"] == lab_id and pl["course"] == (course or "") and pl["published"] for pl in pub_list):
        return None

    for vm in _compute().virtual_machines.list_all():
        rid = _parse_resource_id(vm.id)
        if not _rg_is_allowed(rid.get("resourceGroups")):
            continue
        if not _vm_matches_lab(vm, lab_id, course):
            continue
        tags = dict(getattr(vm, "tags", {}) or {})
        if tags.get(TAG_OCCUPIED_BY):
            continue  # already taken

        # claim it
        tags[TAG_OCCUPIED_BY] = who
        if who_name:
            tags[TAG_OCCUPIED_NAME] = who_name
        rg = rid.get("resourceGroups")
        name = rid.get("virtualMachines")
        update = VirtualMachineUpdate(tags=tags)
        _compute().virtual_machines.begin_update(rg, name, update).result()

        # info
        size = getattr(getattr(vm, "hardware_profile", None), "vm_size", None)
        ips = _resolve_vm_ips(vm)
        pwr = _get_power_state(vm)
        return {
            "id": vm.id,
            "name": vm.name,
            "size": size,
            "private_ip": ips.get("private_ip"),
            "public_ip": ips.get("public_ip"),
            "power_state": pwr,
            "tags": tags,
            "lab_id": lab_id,
            "course": course or "",
        }

    return None


def find_vm_for_student(who: str) -> Optional[Dict[str, Any]]:
    """Return the VM tagged with occupiedbystudent == who (case-insensitive), or None."""
    _ensure_clients()
    wl = (who or "").strip().lower()
    if not wl:
        return None
    for vm in _compute().virtual_machines.list_all():
        rid = _parse_resource_id(vm.id)
        if not _rg_is_allowed(rid.get("resourceGroups")):
            continue
        tags = getattr(vm, "tags", {}) or {}
        val = (tags.get(TAG_OCCUPIED_BY) or "").strip().lower()
        if val and val == wl:
            size = getattr(getattr(vm, "hardware_profile", None), "vm_size", None)
            ips = _resolve_vm_ips(vm)
            pwr = _get_power_state(vm)
            lab_id = _get_tag(tags, TAG_KEYS_LAB_ID) or ""
            course = _get_tag(tags, TAG_KEYS_COURSE) or ""
            return {
                "id": vm.id,
                "name": vm.name,
                "size": size,
                "private_ip": ips.get("private_ip"),
                "public_ip": ips.get("public_ip"),
                "power_state": pwr,
                "tags": tags,
                "lab_id": lab_id,
                "course": course,
            }
    return None

# ---------------- Power ops ----------------
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

# ---------------- Delete utilities & snapshots ----------------
def _both_tags_match(tags: Dict[str, str], lab_id: str, course: str) -> bool:
    if not tags:
        return False
    val_lab = (_get_tag(tags, TAG_KEYS_LAB_ID) or "").strip().lower()
    val_course = (_get_tag(tags, TAG_KEYS_COURSE) or "").strip().lower()
    return val_lab == lab_id.strip().lower() and val_course == course.strip().lower()

def delete_lab_resources(*, lab_id: str, course: Optional[str] = None, dry_run: bool = False) -> Dict[str, Any]:
    _ensure_clients()
    if not course:
        raise ValueError("delete_lab_resources: 'course' is required for strict two-tag match")

    summary = {
        "target_rg": TARGET_RESOURCE_GROUP,
        "lab_id": lab_id,
        "course": course,
        "dry_run": dry_run,
        "vms": {"matched": [], "deleted": []},
        "nics": {"matched": [], "deleted": []},
        "public_ips": {"matched": [], "deleted": []},
        "disks": {"matched": [], "deleted": []},
    }

    for vm in _compute().virtual_machines.list(TARGET_RESOURCE_GROUP):
        tags = getattr(vm, "tags", {}) or {}
        if not _both_tags_match(tags, lab_id, course):
            continue
        summary["vms"]["matched"].append({"rg": TARGET_RESOURCE_GROUP, "name": vm.name})
        if not dry_run:
            poller = _compute().virtual_machines.begin_delete(TARGET_RESOURCE_GROUP, vm.name, force_deletion=True)
            poller.result()
            summary["vms"]["deleted"].append({"rg": TARGET_RESOURCE_GROUP, "name": vm.name})

    for nic in _network().network_interfaces.list(TARGET_RESOURCE_GROUP):
        tags = getattr(nic, "tags", {}) or {}
        if not _both_tags_match(tags, lab_id, course):
            continue
        summary["nics"]["matched"].append({"rg": TARGET_RESOURCE_GROUP, "name": nic.name})
        if not dry_run:
            poller = _network().network_interfaces.begin_delete(TARGET_RESOURCE_GROUP, nic.name)
            poller.result()
            summary["nics"]["deleted"].append({"rg": TARGET_RESOURCE_GROUP, "name": nic.name})

    for pip in _network().public_ip_addresses.list(TARGET_RESOURCE_GROUP):
        tags = getattr(pip, "tags", {}) or {}
        if not _both_tags_match(tags, lab_id, course):
            continue
        summary["public_ips"]["matched"].append({"rg": TARGET_RESOURCE_GROUP, "name": pip.name})
        if not dry_run:
            poller = _network().public_ip_addresses.begin_delete(TARGET_RESOURCE_GROUP, pip.name)
            poller.result()
            summary["public_ips"]["deleted"].append({"rg": TARGET_RESOURCE_GROUP, "name": pip.name})

    for disk in _compute().disks.list_by_resource_group(TARGET_RESOURCE_GROUP):
        tags = getattr(disk, "tags", {}) or {}
        if not _both_tags_match(tags, lab_id, course):
            continue
        summary["disks"]["matched"].append({"rg": TARGET_RESOURCE_GROUP, "name": disk.name})
        if not dry_run:
            poller = _compute().disks.begin_delete(TARGET_RESOURCE_GROUP, disk.name)
            poller.result()
            summary["disks"]["deleted"].append({"rg": TARGET_RESOURCE_GROUP, "name": disk.name})

    return summary

def list_snapshots_in_rg(resource_group: str) -> list[dict]:
    """
    Return snapshots in the given resource group as a list of dicts:
      [{ "name": ..., "id": ..., "time_created": ..., "tags": {...} }, ...]
    Sorted newest first.
    """
    _ensure_clients()
    compute = _compute()
    items = []

    try:
        for snap in compute.snapshots.list_by_resource_group(resource_group):
            items.append({
                "name": getattr(snap, "name", None),
                "id": getattr(snap, "id", None),
                "time_created": getattr(snap, "time_created", None).isoformat()
                    if getattr(snap, "time_created", None) else None,
                "sku": getattr(getattr(snap, "sku", None), "name", None),
                "provisioning_state": getattr(snap, "provisioning_state", None),
                "tags": getattr(snap, "tags", {}) or {},
            })
    except Exception as e:
        print(f"[list_snapshots_in_rg] Error: {e}")

    items.sort(key=lambda x: x["time_created"] or "", reverse=True)
    return items

# add this new function somewhere near the other snapshot helpers
def set_snapshot_tags(resource_group: str, snapshot_name: str, tags: dict) -> dict:
    """
    Merge the given tags onto an existing managed snapshot.
    """
    _ensure_clients()
    compute = _compute()
    # read current tags then merge
    snap = compute.snapshots.get(resource_group, snapshot_name)
    new_tags = dict(getattr(snap, "tags", {}) or {})
    new_tags.update(tags or {})

    update = SnapshotUpdate(tags=new_tags)
    poller = compute.snapshots.begin_update(resource_group, snapshot_name, update)
    poller.result()
    return {"name": snapshot_name, "tags": new_tags}

def debug_snapshot(max_vms: int = 20):
    _ensure_clients()
    rg = TARGET_RESOURCE_GROUP
    vms = list(_compute().virtual_machines.list(rg))
    sample = []
    for vm in vms[:max_vms]:
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
                "TLABS_COURSE": tags.get("TLABS_COURSE"),
                "CreatedAt": tags.get("CreatedAt") or tags.get("CreatedOnDate"),
                "ExpiresAt": tags.get("ExpiresAt"),
                TAG_PUBLISHED: tags.get(TAG_PUBLISHED),
                TAG_OCCUPIED_BY: tags.get(TAG_OCCUPIED_BY),
                TAG_OCCUPIED_NAME: tags.get(TAG_OCCUPIED_NAME),
            }
        })
    return {
        "resource_group": rg,
        "vm_count": len(vms),
        "sample": sample,
    }


__all__ = [
    "list_vms_in_lab",
    "list_running_labs",
    "list_published_labs",
    "set_lab_published",
    "enroll_student_in_lab",
    "find_vm_for_student",
    "start_vm_by_id",
    "stop_vm_by_id",
    "delete_lab_resources",
    "debug_snapshot",
    "list_snapshots_in_rg"
]
