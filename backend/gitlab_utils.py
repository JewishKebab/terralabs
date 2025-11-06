import os
import json
import time
import requests
import urllib.parse
import urllib3
from typing import List, Dict, Any, Optional

from jinja2 import Environment, FileSystemLoader, select_autoescape

# --- Disable SSL warnings & verification ---
urllib3.disable_warnings(urllib3.exceptions.InsecureRequestWarning)
REQUESTS_VERIFY = False

# --- GitLab env vars ---
GITLAB_HOST = os.getenv("GITLAB_HOST", "https://gitlab.com")
GITLAB_PROJECT_ID = os.getenv("GITLAB_PROJECT_ID")
GITLAB_TOKEN = os.getenv("GITLAB_TOKEN")
GITLAB_API = f"{GITLAB_HOST}/api/v4"

# one session
SESSION = requests.Session()
SESSION.verify = REQUESTS_VERIFY
SESSION.headers.update({"PRIVATE-TOKEN": GITLAB_TOKEN})

# --- Jinja setup ---
TEMPLATES_ROOT = os.path.join(os.path.dirname(__file__), "templates")
jinja = Environment(
    loader=FileSystemLoader(TEMPLATES_ROOT),
    autoescape=select_autoescape()
)
jinja.filters["tojson"] = lambda value: json.dumps(value, indent=2)

# --- Schema registry ---
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

# -----------------------
# Helpers (naming/paths)
# -----------------------
def course_dir(course: str) -> str:
    """Title-case convention for course folder to avoid Devops/devops duplicates."""
    c = (course or "").strip()
    return c[:1].upper() + c[1:].lower()


def _gl(path: str) -> str:
    return f"{GITLAB_API}{path}"


# -----------------------
# Branch / Commit helpers
# -----------------------
def ensure_branch(branch: str, base_branch: str = "main"):
    """Create a branch if it doesn’t exist."""
    r = SESSION.get(
        _gl(f"/projects/{GITLAB_PROJECT_ID}/repository/branches/{urllib.parse.quote(branch, safe='')}")
    )
    if r.status_code == 200:
        return
    r = SESSION.post(
        _gl(f"/projects/{GITLAB_PROJECT_ID}/repository/branches"),
        json={"branch": branch, "ref": base_branch},
    )
    if r.status_code not in (200, 201):
        raise RuntimeError(f"Failed to create branch {branch}: {r.status_code} {r.text}")


def gitlab_upsert_file(path: str, content: str, commit_message: str, branch: str):
    """Create or update a file in GitLab in a given branch."""
    if not (GITLAB_PROJECT_ID and GITLAB_TOKEN):
        raise RuntimeError("Missing GitLab configuration")

    file_url = _gl(f"/projects/{GITLAB_PROJECT_ID}/repository/files/{urllib.parse.quote(path, safe='')}")
    data = {"branch": branch, "content": content, "commit_message": commit_message, "encoding": "text"}

    exists = SESSION.get(file_url, params={"ref": branch})
    if exists.status_code == 200:
        res = SESSION.put(file_url, data=data)
    else:
        res = SESSION.post(file_url, data=data)

    if res.status_code not in (200, 201):
        raise RuntimeError(f"GitLab upsert failed for {path}: {res.status_code} {res.text}")


def _commit_actions(branch: str, message: str, actions: list, start_branch="main"):
    payload = {
        "branch": branch,
        "start_branch": start_branch,
        "commit_message": message,
        "actions": actions,
    }
    r = SESSION.post(_gl(f"/projects/{GITLAB_PROJECT_ID}/repository/commits"), json=payload)
    if r.status_code not in (200, 201):
        raise RuntimeError(f"Commit failed: {r.status_code} {r.text}")


def create_merge_request(source_branch: str, target_branch: str = "main", title: str = None):
    """Create a merge request for the new branch."""
    payload = {
        "source_branch": source_branch,
        "target_branch": target_branch,
        "title": title or f"[TerraLabs] {source_branch}",
        "remove_source_branch": True,
    }
    res = SESSION.post(_gl(f"/projects/{GITLAB_PROJECT_ID}/merge_requests"), data=payload)
    if res.status_code not in (200, 201):
        raise RuntimeError(f"Failed to create merge request: {res.status_code} {res.text}")
    return res.json().get("web_url")


# -----------------------
# Repo tree helpers
# -----------------------
def _list_repo_tree(path: str, ref="main") -> List[Dict[str, Any]]:
    """List files (recursively) under a path."""
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


# -----------------------
# Pipelines (destroy)
# -----------------------
def trigger_destroy_pipeline(course: str, lab_name: str) -> Dict[str, Any]:
    """
    Triggers a pipeline that should destroy the lab (your CI must read these variables).
    """
    payload = {
        "ref": "main",
        "variables": [
            {"key": "TF_ACTION", "value": "destroy"},
            {"key": "TLABS_COURSE", "value": course_dir(course)},
            {"key": "TLABS_LAB", "value": lab_name},
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
    """
    Polls the pipeline until it finishes or times out.
    Returns the final pipeline status string (e.g. 'success', 'failed').
    """
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


# -----------------------
# Create lab (templates)
# -----------------------
def create_lab_in_gitlab(course: str, lab_name: str, module_name: str, params: dict, base_branch="main"):
    """Renders templates and commits them to a new branch in GitLab."""
    if not (GITLAB_PROJECT_ID and GITLAB_TOKEN):
        raise RuntimeError("Missing GitLab configuration")

    ctx = {
        "course": course,
        "lab_name": lab_name,
        "module_name": module_name,
        "tf_vars": params,
    }

    module_path = os.path.join(module_name)
    course_folder = course_dir(course)
    lab_folder = f"Labs/{course_folder}/{lab_name}"
    branch_name = f"labs/{course_folder}/{lab_name}".replace(" ", "-").lower()

    # ensure new branch exists
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
        gitlab_upsert_file(path, content, f"[TerraLabs] Create {course_folder}/{lab_name}", branch_name)

    mr_url = create_merge_request(branch_name, base_branch, f"[TerraLabs] {course_folder}/{lab_name}")
    return {"lab_folder": lab_folder, "branch": branch_name, "merge_request_url": mr_url}


# -----------------------
# Delete lab (open MR) — accepts lab_name OR lab_id
# -----------------------
def create_delete_lab_mr(
    course: str,
    lab_name: Optional[str] = None,
    *,
    lab_id: Optional[str] = None,
    base_branch: str = "main",
) -> Dict[str, Any]:
    """
    Creates a branch + commit that deletes all files under Labs/<Course>/<lab>, then opens an MR.
    You may pass either lab_name or lab_id (they are treated the same).
    """
    actual_lab = (lab_name or lab_id or "").strip()
    if not actual_lab:
        raise ValueError("create_delete_lab_mr: require lab_name or lab_id")

    course_folder = course_dir(course)
    lab_folder = f"Labs/{course_folder}/{actual_lab}"

    # list files
    tree = _list_repo_tree(lab_folder, ref=base_branch)
    files = [t["path"] for t in tree if t.get("type") == "blob"]

    # create branch
    branch = f"tlabs/delete-{course_folder}-{actual_lab}".replace(" ", "-").lower()
    ensure_branch(branch, base_branch)

    if files:
        actions = [{"action": "delete", "file_path": p} for p in files]
        message = f"[TerraLabs] Remove {course_folder}/{actual_lab}"
        _commit_actions(branch, message, actions, start_branch=base_branch)

    mr_url = create_merge_request(branch, base_branch, f"[TerraLabs] Delete lab {course_folder}/{actual_lab}")
    return {"branch": branch, "merge_request_url": mr_url, "lab_folder": lab_folder}


# -----------------------
# Delete lab: destroy (+ optional wait) -> delete MR -> optional tfstate cleanup
# -----------------------
def _delete_state_blob_if_present(course: str, lab_name: str) -> bool:
    """
    Best-effort delete of 'Labs/<Course>/<lab>.tfstate' (or '<course>/<lab>.tfstate') in Azure Blob.
    Returns True if delete call was made and did not raise, False otherwise.
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

        # try both name styles (depends how you stored it)
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


# -----------------------
# Delete lab: destroy (+ optional wait) -> delete MR -> optional tfstate cleanup
# accepts lab_name OR lab_id
# -----------------------
def delete_lab(
    course: str,
    lab_name: Optional[str] = None,
    *,
    lab_id: Optional[str] = None,
    destroy: bool = True,
    wait_for_destroy: bool = False,
    delete_state: bool = False,
    base_branch: str = "main",
) -> Dict[str, Any]:
    """
    High-level delete workflow:
      1) (optional) Trigger a destroy pipeline (your CI must support TF_ACTION=destroy)
      2) (optional) Wait for pipeline
      3) Open MR that deletes Labs/<Course>/<lab>
      4) (optional) Delete tfstate blob
    """
    actual_lab = (lab_name or lab_id or "").strip()
    if not actual_lab:
        raise ValueError("delete_lab: require lab_name or lab_id")

    result: Dict[str, Any] = {}

    # 1) Destroy
    if destroy:
        try:
            trig = trigger_destroy_pipeline(course, actual_lab)
            destroy_info = {
                "triggered": True,
                "pipeline_id": trig.get("id"),
                "web_url": trig.get("web_url"),
                "final_status": None,
            }
            if wait_for_destroy and trig.get("id"):
                status = wait_for_pipeline(
                    project_id=str(GITLAB_PROJECT_ID),
                    pipeline_id=int(trig["id"]),
                    timeout_s=900,
                    poll_s=6,
                )
                destroy_info["final_status"] = status
            result["destroy"] = destroy_info
        except Exception as e:
            result["destroy"] = {"triggered": False, "error": str(e)}

    # 2) Delete lab folder via MR
    try:
        delete_info = create_delete_lab_mr(course, lab_name=actual_lab, base_branch=base_branch)
        result["delete_mr"] = delete_info
    except Exception as e:
        result["delete_mr"] = {"error": str(e)}

    # 3) Optional state cleanup
    result["state_deleted"] = False
    if delete_state:
        result["state_deleted"] = _delete_state_blob_if_present(course, actual_lab)

    return result
