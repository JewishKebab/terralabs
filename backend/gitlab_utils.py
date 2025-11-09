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
SESSION.headers.update({"PRIVATE-TOKEN": GITLAB_TOKEN})

TEMPLATES_ROOT = os.path.join(os.path.dirname(__file__), "templates")
jinja = Environment(loader=FileSystemLoader(TEMPLATES_ROOT), autoescape=select_autoescape())
jinja.filters["tojson"] = lambda value: json.dumps(value, indent=2)

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

def course_dir(course: str) -> str:
    c = (course or "").strip()
    return c[:1].upper() + c[1:].lower()

def _gl(path: str) -> str:
    return f"{GITLAB_API}{path}"

# -------------------------------------------------------------------
# Branch / Commit helpers (kept for CREATE flow)
# -------------------------------------------------------------------
def ensure_branch(branch: str, base_branch: str = "main") -> bool:
    """
    Ensure branch exists. Returns True if it ALREADY existed, False if just created.
    """
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
    """
    Commit actions to an EXISTING branch. We NEVER send start_branch here;
    we call ensure_branch() first to create it when needed. This avoids the
    GitLab 400 'branch already exists' error.
    """
    payload = {
        "branch": branch,
        "commit_message": message,
        "actions": actions,
    }
    r = SESSION.post(_gl(f"/projects/{GITLAB_PROJECT_ID}/repository/commits"), json=payload)
    if r.status_code not in (200, 201):
        raise RuntimeError(f"Commit failed: {r.status_code} {r.text}")

def _find_open_mr_for_source_branch(source_branch: str) -> Optional[str]:
    """
    Return web_url of an OPEN MR for the given source_branch if any.
    """
    params = {"source_branch": source_branch, "state": "opened"}
    r = SESSION.get(_gl(f"/projects/{GITLAB_PROJECT_ID}/merge_requests"), params=params)
    if r.status_code == 200:
        arr = r.json() or []
        if arr:
            return arr[0].get("web_url")
    return None

def create_merge_request(source_branch: str, target_branch: str = "main", title: str = None):
    payload = {
        "source_branch": source_branch,
        "target_branch": target_branch,
        "title": title or f"[TerraLabs] {source_branch}",
        "remove_source_branch": True,
    }
    res = SESSION.post(_gl(f"/projects/{GITLAB_PROJECT_ID}/merge_requests"), data=payload)
    if res.status_code in (200, 201):
        return res.json().get("web_url")
    # If an MR already exists, GitLab responds 409. Return that MR instead.
    if res.status_code == 409:
        url = _find_open_mr_for_source_branch(source_branch)
        if url:
            return url
    raise RuntimeError(f"Failed to create merge request: {res.status_code} {res.text}")

# -------------------------------------------------------------------
# Pipelines (optional, left as-is if you want to trigger CI externally)
# -------------------------------------------------------------------
def trigger_destroy_pipeline(course: str, lab_name: str) -> Dict[str, Any]:
    payload = {
        "ref": "main",
        "variables": [
            {"key": "TF_ACTION", "value": "destroy"},
            {"key": "TLABS_COURSE", "value": course_dir(course)},
            {"key": "TLABS_LAB", "value": lab_name},
            {"key": "TRIGGER_REASON", "value": "api_delete"},
        ]
    }
    r = SESSION.post(_gl(f"/projects/{GITLAB_PROJECT_ID}/pipeline"), json=payload)
    if r.status_code not in (200, 201):
        raise RuntimeError(f"Failed to trigger destroy pipeline: {r.status_code} {r.text}")
    return r.json()

def get_pipeline(project_id: str, pipeline_id: int) -> Dict[str, Any]:
    r = SESSION.get(_gl(f"/projects/{project_id}/pipelines/{pipeline_id}"))
    r.raise_for_status()
    return r.json()

def wait_for_pipeline(project_id: str, pipeline_id: int, timeout_s: int = 900, poll_s: int = 6) -> str:
    deadline = time.time() + timeout_s
    last_status = "unknown"
    while time.time() < deadline:
        try:
            p = get_pipeline(project_id, pipeline_id)
            status = p.get("status")
            if status != last_status:
                last_status = status
            if status in ("success", "failed", "canceled", "skipped"):
                return status
        except Exception:
            pass
        time.sleep(poll_s)
    return last_status

# -------------------------------------------------------------------
# Create lab (templates) — unchanged
# -------------------------------------------------------------------
def create_lab_in_gitlab(course: str, lab_name: str, module_name: str, params: dict, base_branch="main"):
    if not (GITLAB_PROJECT_ID and GITLAB_TOKEN):
        raise RuntimeError("Missing GitLab configuration")

    ctx = {"course": course, "lab_name": lab_name, "module_name": module_name, "tf_vars": params}

    module_path = os.path.join(module_name)
    course_folder = course_dir(course)
    lab_folder = f"Labs/{course_folder}/{lab_name}"
    branch_name = f"labs/{course_folder}/{lab_name}".replace(" ", "-").lower()

    ensure_branch(branch_name, base_branch)

    def render_from(module_dir: str, filename: str, context: dict):
        path = f"{module_dir}/{filename}"
        tmpl = jinja.get_template(path)
        return tmpl.render(**context)

    files = {
        f"{lab_folder}/.gitlab-ci.yml": render_from(module_path, ".gitlab-ci.yml", ctx),
        f"{lab_folder}/azurerm-provider-variables.tf": render_from(module_path, "azurerm-provider-variables.tf", ctx),
        f"{lab_folder}/backend.tf": render_from(module_path, "backend.tf.j2", ctx),
        f"{lab_folder}/main.tf": render_from(module_path, "main.tf", ctx),
        f"{lab_folder}/provider.tf": render_from(module_path, "provider.tf", ctx),
        f"{lab_folder}/variables.tf": render_from(module_path, "variables.tf", ctx),
        f"{lab_folder}/terraform.tfvars": render_from(module_path, "terraform.tfvars.j2", ctx),
    }

    for path, content in files.items():
        _commit_actions(branch_name, f"[TerraLabs] Create {course_folder}/{lab_name}", [
            {"action": "create", "file_path": path, "content": content}
        ])

    mr_url = create_merge_request(branch_name, base_branch, f"[TerraLabs] {course_folder}/{lab_name}")
    return {"lab_folder": lab_folder, "branch": branch_name, "merge_request_url": mr_url}

# -------------------------------------------------------------------
# Optional tfstate cleanup helper
# -------------------------------------------------------------------
def _delete_state_blob_if_present(course: str, lab_name: str) -> bool:
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
        candidates = [
            f"{course_dir(course)}/{lab_name}.tfstate",
            f"{lab_name}.tfstate",
            f"Labs/{course_dir(course)}/{lab_name}.tfstate",
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

# -------------------------------------------------------------------
# High-level delete flow (Azure ➜ optional tfstate) — NO MR CREATION
# -------------------------------------------------------------------
def delete_lab(
    course: str,
    *,
    lab_id: str,
    azure_dry_run: bool = False,
    wait_for_azure: bool = True,  # kept for API compatibility; deletion is synchronous in our SDK call
    delete_state: bool = True,
) -> Dict[str, Any]:
    """
    Delete Azure resources by tags and (optionally) delete the tfstate blob.
    This version DOES NOT create a merge request or touch the Git repo for deletions.
    """
    from azure_client import delete_lab_resources  # lazy import to avoid cycles

    course_folder = course_dir(course)

    # 1) Azure deletion via SDK (synchronous)
    azure_summary = delete_lab_resources(lab_id=lab_id, course=course_folder, dry_run=azure_dry_run)

    # 2) Optionally delete tfstate blob
    state_deleted = False
    if delete_state and not azure_dry_run:
        state_deleted = _delete_state_blob_if_present(course, lab_id)

    return {
        "azure": azure_summary,
        "tfstate_deleted": state_deleted,
    }
