# backend/gitlab_utils.py
import os
import json
import time
import requests
import urllib.parse
import urllib3
from typing import List, Dict, Any, Optional

from jinja2 import Environment, FileSystemLoader, select_autoescape

urllib3.disable_warnings(urllib3.exceptions.InsecureRequestWarning)
REQUESTS_VERIFY = False

GITLAB_HOST = os.getenv("GITLAB_HOST", "https://gitlab.com")
GITLAB_PROJECT_ID = os.getenv("GITLAB_PROJECT_ID")
GITLAB_TOKEN = os.getenv("GITLAB_TOKEN")
GITLAB_API = f"{GITLAB_HOST}/api/v4"

SESSION = requests.Session()
SESSION.verify = REQUESTS_VERIFY
if GITLAB_TOKEN:
    SESSION.headers.update({"PRIVATE-TOKEN": GITLAB_TOKEN})

TEMPLATES_ROOT = os.path.join(os.path.dirname(__file__), "templates")
jinja = Environment(loader=FileSystemLoader(TEMPLATES_ROOT), autoescape=select_autoescape())
jinja.filters["tojson"] = lambda value: json.dumps(value, indent=2)

# -------------------------------------------------------------------
# Optional: kept because you reference it in the UI
# -------------------------------------------------------------------
MODULE_SCHEMAS = {
    "WindowsSnapshot": {
        "title": "Windows VM from Snapshot",
        "fields": [
            {"name": "vm_name", "type": "string", "required": True, "default": "labvm"},
            {"name": "vm_count", "type": "number", "required": True, "default": 1},
            {"name": "vm_size", "type": "string", "required": True, "default": "Standard_D2s_v5"},
            {"name": "resource_group_name", "type": "string", "required": True},
            {"name": "subnet_id", "type": "string", "required": True},
            {"name": "os_snapshot_id", "type": "string", "required": True},
            {
                "name": "data_disks",
                "type": "array<object>",
                "required": False,
                "default": [],
                "objectFields": [
                    {"name": "name", "type": "string"},
                    {"name": "lun", "type": "number"},
                    {"name": "caching", "type": "string", "default": "ReadWrite"},
                    {"name": "disk_size_gb", "type": "number", "default": 128},
                ],
            },
        ],
    }
}

# ---------------- small helpers ----------------
def course_dir(course: str) -> str:
    c = (course or "").strip()
    return c[:1].upper() + c[1:].lower()

def _gl(path: str) -> str:
    return f"{GITLAB_API}{path}"

def _normalize_lab(name: str) -> str:
    """
    Always use the plain Lab ID as the folder name (no .tfstate).
    Strips trailing slashes and a trailing '.tfstate' suffix if present.
    """
    s = (name or "").strip().strip("/")
    if s.lower().endswith(".tfstate"):
        s = s[: -len(".tfstate")]
    return s

# ---------------- Branch / Commit helpers ----------------
def ensure_branch(branch: str, base_branch: str = "main") -> bool:
    """Return True if branch existed, False if created."""
    r = SESSION.get(_gl(f"/projects/{GITLAB_PROJECT_ID}/repository/branches/{urllib.parse.quote(branch, safe='')}"))
    if r.status_code == 200:
        return True
    r = SESSION.post(
        _gl(f"/projects/{GITLAB_PROJECT_ID}/repository/branches"),
        json={"branch": branch, "ref": base_branch},
    )
    if r.status_code not in (200, 201):
        raise RuntimeError(f"Failed to create branch {branch}: {r.status_code} {r.text}")
    return False

def _commit_actions(branch: str, message: str, actions: list):
    payload = {
        "branch": branch,
        "commit_message": message,
        "actions": actions,
    }
    r = SESSION.post(_gl(f"/projects/{GITLAB_PROJECT_ID}/repository/commits"), json=payload)
    if r.status_code not in (200, 201):
        raise RuntimeError(f"Commit failed: {r.status_code} {r.text}")

def _find_open_mr_for_source_branch(source_branch: str) -> Optional[str]:
    params = {"source_branch": source_branch, "state": "opened"}
    r = SESSION.get(_gl(f"/projects/{GITLAB_PROJECT_ID}/merge_requests"), params=params)
    if r.status_code == 200:
        arr = r.json() or []
        if arr:
            return arr[0].get("web_url")
    return None

def create_merge_request(source_branch: str, target_branch: str = "main", title: Optional[str] = None) -> str:
    payload = {
        "source_branch": source_branch,
        "target_branch": target_branch,
        "title": title or f"[TerraLabs] {source_branch}",
        "remove_source_branch": True,
    }
    res = SESSION.post(_gl(f"/projects/{GITLAB_PROJECT_ID}/merge_requests"), data=payload)
    if res.status_code in (200, 201):
        return res.json().get("web_url")
    if res.status_code == 409:
        url = _find_open_mr_for_source_branch(source_branch)
        if url:
            return url
    raise RuntimeError(f"Failed to create merge request: {res.status_code} {res.text}")

# ---------------- Repo tree helpers ----------------
def _list_repo_tree(path: str, ref="main") -> List[Dict[str, Any]]:
    out = []
    page = 1
    while True:
        resp = SESSION.get(
            _gl(f"/projects/{GITLAB_PROJECT_ID}/repository/tree"),
            params={"ref": ref, "path": path, "recursive": True, "per_page": 100, "page": page},
        )
        resp.raise_for_status()
        items = resp.json()
        out.extend(items)
        if len(items) < 100:
            break
        page += 1
    return out

def _list_repo_tree_under(prefix: str, ref="main") -> List[Dict[str, Any]]:
    out, page = [], 1
    while True:
        resp = SESSION.get(
            _gl(f"/projects/{GITLAB_PROJECT_ID}/repository/tree"),
            params={"ref": ref, "recursive": True, "per_page": 100, "page": page},
        )
        resp.raise_for_status()
        items = resp.json()
        out.extend(items)
        if len(items) < 100:
            break
        page += 1
    prefix = prefix.rstrip("/") + "/"
    return [i for i in out if i.get("path", "").startswith(prefix)]

# ---------------- Create lab (now plain folder name) ----------------
def create_lab_in_gitlab(course: str, lab_name: str, module_name: str, params: dict, base_branch="main"):
    """
    Create lab under Labs/<Course>/<LabId>/ (no .tfstate in folder name).
    """
    if not (GITLAB_PROJECT_ID and GITLAB_TOKEN):
        raise RuntimeError("Missing GitLab configuration")

    lab_id = _normalize_lab(lab_name)
    course_folder = course_dir(course)
    lab_folder = f"Labs/{course_folder}/{lab_id}"
    branch_name = f"labs/{course_folder}/{lab_id}".replace(" ", "-").lower()

    ctx = {"course": course, "lab_name": lab_id, "module_name": module_name, "tf_vars": params}

    ensure_branch(branch_name, base_branch)

    def render_from(module_dir: str, filename: str, context: dict):
        path = f"{module_dir}/{filename}"
        tmpl = jinja.get_template(path)
        return tmpl.render(**context)

    files = {
        f"{lab_folder}/.gitlab-ci.yml": render_from(module_name, ".gitlab-ci.yml", ctx),
        f"{lab_folder}/azurerm-provider-variables.tf": render_from(module_name, "azurerm-provider-variables.tf", ctx),
        f"{lab_folder}/backend.tf": render_from(module_name, "backend.tf.j2", ctx),
        f"{lab_folder}/main.tf": render_from(module_name, "main.tf", ctx),
        f"{lab_folder}/provider.tf": render_from(module_name, "provider.tf", ctx),
        f"{lab_folder}/variables.tf": render_from(module_name, "variables.tf", ctx),
        f"{lab_folder}/terraform.tfvars": render_from(module_name, "terraform.tfvars.j2", ctx),
    }

    for path, content in files.items():
        _commit_actions(branch_name, f"[TerraLabs] Create {course_folder}/{lab_id}", [
            {"action": "create", "file_path": path, "content": content}
        ])

    mr_url = create_merge_request(branch_name, base_branch, f"[TerraLabs] {course_folder}/{lab_id}")
    return {"lab_folder": lab_folder, "branch": branch_name, "merge_request_url": mr_url}

# ---------------- Delete lab (MR removing folder; supports legacy) ----------------
def create_delete_lab_mr(
    course: str,
    lab_name: Optional[str] = None,
    *,
    lab_id: Optional[str] = None,
    base_branch: str = "main",
) -> Dict[str, Any]:
    """
    Create a branch + MR that deletes all files for a lab under Labs/<Course>/<LabId>/.
    Also removes legacy locations:
      - Labs/<Course>/<LabId>.tfstate/
      - Labs/<Course>/<LabId>.tfstate
    """
    if not (GITLAB_PROJECT_ID and GITLAB_TOKEN):
        raise RuntimeError("Missing GitLab configuration")

    actual_lab = _normalize_lab(lab_name or lab_id or "")
    if not actual_lab:
        raise ValueError("create_delete_lab_mr: require lab_name or lab_id")

    course_folder = course_dir(course)
    base_prefix = f"Labs/{course_folder}"
    # Pull everything under the course folder and filter ourselves
    tree = _list_repo_tree(base_prefix, ref=base_branch) or _list_repo_tree_under(base_prefix, ref=base_branch)

    # Primary (new) folder
    prefix_primary = f"{base_prefix}/{actual_lab}/"
    # Legacy shapes
    prefix_legacy = f"{base_prefix}/{actual_lab}.tfstate/"
    exact_legacy_file = f"{base_prefix}/{actual_lab}.tfstate"

    files: List[str] = []
    for item in tree:
        if item.get("type") != "blob":
            continue
        path = item.get("path") or ""
        if path.startswith(prefix_primary) or path.startswith(prefix_legacy) or path == exact_legacy_file:
            files.append(path)

    branch = f"tlabs/delete-{course_folder}-{actual_lab}".replace(" ", "-").lower()
    ensure_branch(branch, base_branch)

    if files:
        actions = [{"action": "delete", "file_path": p} for p in sorted(set(files))]
        message = f"[TerraLabs] Remove {course_folder}/{actual_lab}"
        _commit_actions(branch, message, actions)
    else:
        _commit_actions(branch, f"[TerraLabs] Remove {course_folder}/{actual_lab} (no files found)", [])

    mr_title = f"[TerraLabs] Delete lab {course_folder}/{actual_lab}"
    mr_url = create_merge_request(branch, base_branch, mr_title)
    return {"branch": branch, "merge_request_url": mr_url, "lab_folder_base": base_prefix}

# ---------------- Optional tfstate cleanup helper ----------------
def _delete_state_blob_if_present(course: str, lab_name: str) -> bool:
    """
    If you still store .tfstate blobs in Azure Storage, this removes common locations.
    Not used by Git, but kept here for your /api flow.
    """
    try:
        from azure.storage.blob import BlobServiceClient
        acct = os.getenv("AZURE_STORAGE_ACCOUNT_NAME")
        key = os.getenv("AZURE_BLOB_KEY")
        container = os.getenv("AZURE_CONTAINER_NAME")
        if not (acct and key and container):
            return False

        blob_service = BlobServiceClient(
            account_url=f"https://{acct}.blob.core.windows.net",
            credential=key,
        )
        container_client = blob_service.get_container_client(container)

        lab_id = _normalize_lab(lab_name)
        candidates = [
            f"{course_dir(course)}/{lab_id}.tfstate",                      # legacy flat
            f"Labs/{course_dir(course)}/{lab_id}.tfstate",                 # legacy under Labs
            f"Labs/{course_dir(course)}/{lab_id}/{lab_id}.tfstate",        # if someone wrote it inside the new folder
        ]
        done = False
        for blob_name in candidates:
            try:
                container_client.delete_blob(blob_name)
                done = True
            except Exception:
                pass
        return done
    except Exception:
        return False

# ---------------- High-level delete flow (Azure ➜ MR ➜ tfstate) ----------------
def delete_lab(
    course: str,
    *,
    lab_id: str,
    azure_dry_run: bool = False,
    wait_for_azure: bool = True,
    delete_state: bool = True,
) -> Dict[str, Any]:
    """
    Delete Azure resources by tags AND open an MR that removes the lab folder.
    Also optionally deletes tfstate blob(s) if present.
    """
    if not (GITLAB_PROJECT_ID and GITLAB_TOKEN):
        raise RuntimeError("Missing GitLab configuration")

    from azure_client import delete_lab_resources  # lazy import to avoid cycles

    course_folder = course_dir(course)
    azure_summary = delete_lab_resources(lab_id=lab_id, course=course_folder, dry_run=azure_dry_run)
    mr = create_delete_lab_mr(course, lab_id=lab_id)

    state_deleted = False
    if delete_state and not azure_dry_run:
        state_deleted = _delete_state_blob_if_present(course, lab_id)

    return {
        "azure": azure_summary,
        "delete_mr": mr,
        "tfstate_deleted": state_deleted,
    }
