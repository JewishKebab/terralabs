"""
Template-VM lifecycle helpers (Azure SDK)

Env required:
  TL_TEMPLATE_LOCATION   - "westeurope" (default)
  TL_TEMPLATE_RG         - target RG for VM/NIC
  TL_TEMPLATE_SUBNET_ID  - subnet id (no NSG)
  TL_SNAPSHOT_RG         - RG for snapshots
  AZURE_SUBSCRIPTION_ID  - subscription id

Constraints:
  - No Public IP, no NSG
  - Standard_LRS OS disk
  - One VM per TerraLabsUser (email)
  - Tags: LabId, LabCourse, TerraLabsUser, TemplateVM=true
"""

from __future__ import annotations
import os
import time
from typing import Any, Dict, Optional

from azure.identity import DefaultAzureCredential, AzureCliCredential, ClientSecretCredential
from azure.mgmt.compute import ComputeManagementClient
from azure.mgmt.compute.models import (
    VirtualMachine,
    HardwareProfile,
    NetworkProfile,
    OSProfile,
    WindowsConfiguration,
    LinuxConfiguration,
    Sku,
    StorageProfile,
    OSDisk,
    ManagedDiskParameters,
    ImageReference,
    DiskCreateOption,
    Snapshot,
    CreationData,
)
from azure.mgmt.network import NetworkManagementClient

# ---------------- env / clients ----------------

def _load_env():
    return (
        os.getenv("TL_TEMPLATE_LOCATION", "westeurope"),
        os.getenv("TL_TEMPLATE_RG"),
        os.getenv("TL_TEMPLATE_SUBNET_ID"),
        os.getenv("TL_SNAPSHOT_RG"),
        os.getenv("AZURE_SUBSCRIPTION_ID"),
    )

def _require_env():
    loc, rg, subnet_id, snap_rg, sub = _load_env()
    missing = []
    if not rg: missing.append("TL_TEMPLATE_RG")
    if not subnet_id: missing.append("TL_TEMPLATE_SUBNET_ID")
    if not snap_rg: missing.append("TL_SNAPSHOT_RG")
    if not sub: missing.append("AZURE_SUBSCRIPTION_ID")
    if missing:
        raise RuntimeError("Missing env: " + ", ".join(missing))
    return loc, rg, subnet_id, snap_rg, sub

def _credential():
    if (os.getenv("TL_USE_AZCLI") or "").lower() in ("1", "true", "yes"):
        return AzureCliCredential()
    t = os.getenv("AZURE_TENANT_ID")
    c = os.getenv("AZURE_CLIENT_ID")
    s = os.getenv("AZURE_CLIENT_SECRET")
    if t and c and s:
        return ClientSecretCredential(tenant_id=t, client_id=c, client_secret=s)
    return DefaultAzureCredential(
        exclude_shared_token_cache_credential=True,
        exclude_visual_studio_code_credential=True,
        exclude_cli_credential=True,
        exclude_powershell_credential=True,
        exclude_interactive_browser_credential=True,
    )

_COMPUTE: Optional[ComputeManagementClient] = None
_NETWORK: Optional[NetworkManagementClient] = None
_SUBSCRIPTION_ID: Optional[str] = None

def _ensure_clients():
    global _COMPUTE, _NETWORK, _SUBSCRIPTION_ID
    if _COMPUTE and _NETWORK:
        return
    loc, rg, subnet, snap_rg, sub = _require_env()
    cred = _credential()
    _COMPUTE = ComputeManagementClient(cred, sub)
    _NETWORK = NetworkManagementClient(cred, sub)
    _SUBSCRIPTION_ID = sub

# ---------------- helpers ----------------

def _sanitize(s: str) -> str:
    s = (s or "").strip()
    return "".join(ch if ch.isalnum() or ch in ("-", "_") else "-" for ch in s)[:80] or "user"

def _parse_id(resource_id: str) -> Dict[str, str]:
    parts = [p for p in (resource_id or "").strip("/").split("/") if p]
    out: Dict[str, str] = {}
    for i in range(0, len(parts) - 1, 2):
        out[parts[i].lower()] = parts[i + 1]
    return out

def _image_version_id(image_id: str, version: str) -> str:
    version = version or "latest"
    if "/versions/" in image_id.lower():
        return image_id
    return image_id.rstrip("/") + "/versions/" + version

def _tags(user_id: str) -> Dict[str, str]:
    return {
        "TerraLabsUser": user_id,
        "TemplateVM": "true",
        "GeneratedWith": "API",
        "CreatedOnDate": time.strftime("%d/%m/%Y"),
    }


def _find_existing_template_vm(user_id: str) -> Optional[Dict[str, Any]]:
    _ensure_clients()
    target = (user_id or "").strip().lower()
    for vm in _COMPUTE.virtual_machines.list_all():
        tags = (getattr(vm, "tags", {}) or {})
        if tags.get("TemplateVM", "").lower() == "true":
            user_tag = (tags.get("TerraLabsUser") or "").strip().lower()
            if user_tag == target:
                rid = _parse_id(vm.id)
                return {"rg": rid.get("resourcegroups"), "name": vm.name, "id": vm.id}
    return None
def _assert_ownership(vm_id: str, user_id: str) -> Dict[str, str]:
    _ensure_clients()
    rid = _parse_id(vm_id)
    rg = rid.get("resourcegroups")
    name = rid.get("virtualmachines")
    if not (rg and name):
        raise ValueError("Invalid vm_id")
    vm = _COMPUTE.virtual_machines.get(rg, name)
    t = getattr(vm, "tags", {}) or {}
    if (t.get("TerraLabsUser") or "").strip().lower() != (user_id or "").strip().lower():
        raise PermissionError("Not your template VM.")
    return {"rg": rg, "name": name}

def _nic_for_vm(rg: str, vm_name: str, subnet_id: str, location: str, tags: Dict[str, str]) -> str:
    _ensure_clients()
    nic_name = f"{vm_name}-nic"
    ipconf_name = f"{vm_name}-ipconf"
    poller = _NETWORK.network_interfaces.begin_create_or_update(
        rg,
        nic_name,
        {
            "location": location,
            "ip_configurations": [
                {
                    "name": ipconf_name,
                    "subnet": {"id": subnet_id},
                    "private_ip_allocation_method": "Dynamic",
                }
            ],
            "tags": tags,  # no NSG, no public IP
        },
    )
    nic = poller.result()
    return nic.id

def _delete_nic_if_exists(rg: str, name: str) -> None:
    try:
        _NETWORK.network_interfaces.begin_delete(rg, name).result()
    except Exception:
        pass

def _power_state(rg: str, name: str) -> Optional[str]:
    try:
        iv = _COMPUTE.virtual_machines.instance_view(rg, name)
        for st in iv.statuses or []:
            if st.code and st.code.startswith("PowerState/"):
                return st.code.split("/", 1)[1]
    except Exception:
        pass
    return None

# ---------------- public API (plain dicts) ----------------

def create_template_vm(
    *,
    user_id: str,
    image_id: str,
    image_version: str,
    os_type: str,
    vm_size: str,
    admin_username: str,
    admin_password: str,
) -> Dict[str, Any]:
    """
    Creates a per-user private-only Template VM (no NSG, no public IP).
    """
    location, template_rg, subnet_id, snapshot_rg, sub = _require_env()
    _ensure_clients()

    existing = _find_existing_template_vm(user_id)
    if existing:
        rg = existing["rg"]
        name = existing["name"]
        vm = _COMPUTE.virtual_machines.get(rg, name)
        tags = _tags(user_id)
        try:
            _COMPUTE.virtual_machines.update(rg, name, {"tags": tags})
        except Exception:
            pass

        try:
            nic_id = vm.network_profile.network_interfaces[0].id
            nic_r = _parse_id(nic_id)
            nic = _NETWORK.network_interfaces.get(nic_r["resourcegroups"], nic_r["networkinterfaces"])
            pip = getattr(nic.ip_configurations[0], "private_ip_address", None)
        except Exception:
            pip = None
        return {
            "vm_id": vm.id,
            "name": vm.name,
            "resource_group": rg,
            "private_ip": pip,
            "power_state": _power_state(rg, vm.name),
            "provisioning_state": getattr(vm, "provisioning_state", None),
        }

    # Generate Windows-safe name
    base = _sanitize(user_id).lower()
    short_user = "".join(ch for ch in base if ch.isalnum())[:6]
    vm_name = f"tl{short_user}{int(time.time())}"[:15]

    # Create NIC (private only)
    nic_id = _nic_for_vm(template_rg, vm_name, subnet_id, location, _tags(user_id))

    version_id = _image_version_id(image_id, image_version)

    if os_type.lower() == "windows":
        os_profile = OSProfile(
            computer_name=vm_name,
            admin_username=admin_username,
            admin_password=admin_password,
            windows_configuration=WindowsConfiguration(),
        )
        disk_os_type = "Windows"
    else:
        os_profile = OSProfile(
            computer_name=vm_name,
            admin_username=admin_username,
            admin_password=admin_password,
            linux_configuration=LinuxConfiguration(disable_password_authentication=False),
        )
        disk_os_type = "Linux"

    storage_profile = StorageProfile(
        image_reference=ImageReference(id=version_id),
        os_disk=OSDisk(
            name=f"{vm_name}-osdisk",
            create_option=DiskCreateOption.FROM_IMAGE,
            caching="ReadWrite",
            managed_disk=ManagedDiskParameters(storage_account_type="Standard_LRS"),
            os_type=disk_os_type,
            delete_option="Delete",
        ),
    )

    vm_params = VirtualMachine(
        location=location,
        tags=_tags(user_id),
        hardware_profile=HardwareProfile(vm_size=vm_size),
        storage_profile=storage_profile,
        os_profile=os_profile,
        network_profile=NetworkProfile(network_interfaces=[{"id": nic_id, "primary": True}]),
    )

    poller = _COMPUTE.virtual_machines.begin_create_or_update(template_rg, vm_name, vm_params)
    vm = poller.result()

    try:
        nic_r = _parse_id(nic_id)
        nic = _NETWORK.network_interfaces.get(nic_r["resourcegroups"], nic_r["networkinterfaces"])
        private_ip = getattr(nic.ip_configurations[0], "private_ip_address", None)
    except Exception:
        private_ip = None

    return {
        "vm_id": vm.id,
        "name": vm.name,
        "resource_group": template_rg,
        "private_ip": private_ip,
        "power_state": _power_state(template_rg, vm_name),
        "provisioning_state": getattr(vm, "provisioning_state", None),
    }


def get_template_vm_status(*, user_id: str, vm_id: Optional[str] = None, soft_not_found: bool = True):
    """
    If vm_id provided -> return status for that VM only (after ownership check).
    Else -> return the first VM owned by the user (or exists:false).
    """
    _ensure_clients()

    if vm_id:
        try:
            info = _assert_ownership(vm_id, user_id)
        except PermissionError:
            return {"exists": False}, 200 if soft_not_found else 404
        rg, name = info["rg"], info["name"]
        try:
            vm = _COMPUTE.virtual_machines.get(rg, name)
        except Exception:
            return {"exists": False}, 200 if soft_not_found else 404
        # private IP
        try:
            nic_id = vm.network_profile.network_interfaces[0].id
            nic_r = _parse_id(nic_id)
            nic = _NETWORK.network_interfaces.get(nic_r["resourcegroups"], nic_r["networkinterfaces"])
            private_ip = getattr(nic.ip_configurations[0], "private_ip_address", None)
        except Exception:
            private_ip = None
        return {
            "exists": True,
            "vm_id": vm.id,
            "name": vm.name,
            "resource_group": rg,
            "private_ip": private_ip,
            "public_ip": None,
            "power_state": _power_state(rg, name),
            "provisioning_state": getattr(vm, "provisioning_state", None),
            "tags": getattr(vm, "tags", {}) or {},
        }, 200

    # No vm_id -> pick first VM for this user (or none)
    owned = _list_user_template_vms(user_id)
    if not owned:
        return {"exists": False}, 200 if soft_not_found else 404

    rg, name, vm_id0 = owned[0]["rg"], owned[0]["name"], owned[0]["id"]
    try:
        vm = _COMPUTE.virtual_machines.get(rg, name)
    except Exception:
        return {"exists": False}, 200 if soft_not_found else 404

    try:
        nic_id = vm.network_profile.network_interfaces[0].id
        nic_r = _parse_id(nic_id)
        nic = _NETWORK.network_interfaces.get(nic_r["resourcegroups"], nic_r["networkinterfaces"])
        private_ip = getattr(nic.ip_configurations[0], "private_ip_address", None)
    except Exception:
        private_ip = None

    return {
        "exists": True,
        "vm_id": vm_id0,
        "name": vm.name,
        "resource_group": rg,
        "private_ip": private_ip,
        "public_ip": None,
        "power_state": _power_state(rg, name),
        "provisioning_state": getattr(vm, "provisioning_state", None),
        "tags": getattr(vm, "tags", {}) or {},
    }, 200


def snapshot_and_delete_template_vm(*, user_id: str, snapshot_name: str) -> Dict[str, Any]:
    location, template_rg, subnet_id, snapshot_rg, sub = _require_env()
    _ensure_clients()

    found = _find_existing_template_vm(user_id)
    if not found:
        return {"ok": False, "error": "No template VM for user"}
    rg, name, vm_id = found["rg"], found["name"], found["id"]

    _assert_ownership(vm_id, user_id)

    vm = _COMPUTE.virtual_machines.get(rg, name)
    os_disk_id = vm.storage_profile.os_disk.managed_disk.id  # type: ignore

    # Snapshot (Standard_LRS)
    spoller = _COMPUTE.snapshots.begin_create_or_update(
        snapshot_rg,
        snapshot_name,
        Snapshot(
            location=location,
            sku=Sku(name="Standard_LRS"),
            creation_data=CreationData(create_option="Copy", source_resource_id=os_disk_id),
        ),
    )
    snap = spoller.result()

    # Delete VM
    _COMPUTE.virtual_machines.begin_delete(rg, name).result()

    # Delete NIC
    try:
        nic_id = vm.network_profile.network_interfaces[0].id
        nic_r = _parse_id(nic_id)
        _delete_nic_if_exists(nic_r["resourcegroups"], nic_r["networkinterfaces"])
    except Exception:
        pass

    # Delete OS disk
    try:
        d = _parse_id(os_disk_id)
        _COMPUTE.disks.begin_delete(d["resourcegroups"], d["disks"]).result()
    except Exception:
        pass

    return {"ok": True, "snapshot_id": snap.id, "snapshot_name": snapshot_name, "snapshot_rg": snapshot_rg}

def delete_template_vm(*, user_id: str) -> Dict[str, Any]:
    _ensure_clients()
    found = _find_existing_template_vm(user_id)
    if not found:
        return {"ok": True, "message": "No template VM found"}

    rg, name, vm_id = found["rg"], found["name"], found["id"]
    try:
        vm = _COMPUTE.virtual_machines.get(rg, name)
    except Exception as e:
        return {"ok": False, "error": f"VM not found: {e}"}

    try:
        _assert_ownership(vm_id, user_id)
    except PermissionError:
        return {"ok": False, "error": "VM not owned by this user"}

    nic_ids = [n.id for n in vm.network_profile.network_interfaces] if vm.network_profile else []
    os_disk_id = vm.storage_profile.os_disk.managed_disk.id if vm.storage_profile else None

    results: Dict[str, Any] = {"deleted": []}

    try:
        _COMPUTE.virtual_machines.begin_delete(rg, name).result()
        results["deleted"].append("vm")
    except Exception as e:
        results["vm_error"] = str(e)

    for nic_id in nic_ids:
        try:
            nic_r = _parse_id(nic_id)
            _NETWORK.network_interfaces.begin_delete(nic_r["resourcegroups"], nic_r["networkinterfaces"]).result()
            results["deleted"].append(f"nic:{nic_r['networkinterfaces']}")
        except Exception as e:
            results["nic_error"] = str(e)

    if os_disk_id:
        try:
            d = _parse_id(os_disk_id)
            _COMPUTE.disks.begin_delete(d["resourcegroups"], d["disks"]).result()
            results["deleted"].append(f"disk:{d['disks']}")
        except Exception as e:
            results["disk_error"] = str(e)

    try:
        _COMPUTE.virtual_machines.get(rg, name)
        results["still_exists"] = True
        results["ok"] = False
    except Exception:
        results["ok"] = True

    return results


# template_vm.py (add this helper near the other helpers)

def _list_user_template_vms(user_id: str) -> list[dict]:
    """
    Return ALL template VMs owned by user_id (TerraLabsUser tag match), as dicts:
    { "rg": ..., "name": ..., "id": ... }
    """
    _ensure_clients()
    target = (user_id or "").strip().lower()
    out = []
    for vm in _COMPUTE.virtual_machines.list_all():
        tags = (getattr(vm, "tags", {}) or {})
        if tags.get("TemplateVM", "").lower() == "true":
            user_tag = (tags.get("TerraLabsUser") or "").strip().lower()
            if user_tag == target:
                rid = _parse_id(vm.id)
                out.append({"rg": rid.get("resourcegroups"), "name": vm.name, "id": vm.id})
    return out

