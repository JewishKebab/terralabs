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

# -------------------------------------------------------------------
# Module schemas (used by UI)
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

def course_dir(course: str) -> str:
    c = (course or "").strip()
    return c[:1].upper() + c[1:].lower()

def _gl(path: str) -> str:
    return f"{GITLAB_API}{path}"

# -------------------------------------------------------------------
# Resilient GitLab HTTP helper (timeouts, retries, backoff)
# -------------------------------------------------------------------
def _gl_request(method: str, path: str, *,
                retries: int = 3,
                timeout: int = 15,
                backoff: float = 1.5,
                **kwargs):
    """
    Wrapper for GitLab API calls with retry on timeouts, connection errors,
    and transient 429/5xx responses. Uses the global SESSION.
    """
    url = _gl(path)
    delay = backoff
    last_err = None
    for attempt in range(1, retries + 1):
        try:
            resp = SESSION.request(method, url, timeout=timeout, **kwargs)
            # Retry on rate limit / transient server errors
            if resp.status_code in (429, 500, 502, 503, 504):
                last_err = RuntimeError(f"{resp.status_code} {resp.text[:300]}")
                raise last_err
            return resp
        except (requests.Timeout, requests.ConnectionError) as e:
            last_err = e
        except requests.RequestException as e:
            last_err = e

        if attempt < retries:
            time.sleep(delay)
            delay *= 2

    # Exhausted retries
    if isinstance(last_err, requests.Response):
        last_err.raise_for_status()
    raise last_err

# -------------------------------------------------------------------
# Branch / Commit helpers
# -------------------------------------------------------------------
def ensure_branch(branch: str, base_branch: str = "main") -> bool:
    """
    Ensure branch exists. Returns True if it already existed, False if created.
    """
    r = _gl_request("GET", f"/projects/{GITLAB_PROJECT_ID}/repository/branches/{urllib.parse.quote(branch, safe='')}")
    if r.status_code == 200:
        return True
    r = _gl_request(
        "POST",
        f"/projects/{GITLAB_PROJECT_ID}/repository/branches",
        json={"branch": branch, "ref": base_branch},
    )
    if r.status_code not in (200, 201):
        raise RuntimeError(f"Failed to create branch {branch}: {r.status_code} {r.text}")
    return False

def _commit_actions(branch: str, message: str, actions: list):
    """
    Commit actions to an EXISTING branch. Call ensure_branch() first if needed.
    """
    payload = {
        "branch": branch,
        "commit_message": message,
        "actions": actions,
    }
    r = _gl_request("POST", f"/projects/{GITLAB_PROJECT_ID}/repository/commits", json=payload)
    if r.status_code not in (200, 201):
        raise RuntimeError(f"Commit failed: {r.status_code} {r.text}")

def _find_open_mr_for_source_branch(source_branch: str) -> Optional[Dict[str, Any]]:
    """
    Return the MR JSON of an OPEN MR for the given source_branch if any.
    """
    params = {"source_branch": source_branch, "state": "opened"}
    r = _gl_request("GET", f"/projects/{GITLAB_PROJECT_ID}/merge_requests", params=params)
    if r.status_code == 200:
        arr = r.json() or []
        if arr:
            return arr[0]
    return None

def create_merge_request(source_branch: str, target_branch: str = "main", title: str = None):
    payload = {
        "source_branch": source_branch,
        "target_branch": target_branch,
        "title": title or f"[TerraLabs] {source_branch}",
        "remove_source_branch": True,
    }
    res = _gl_request("POST", f"/projects/{GITLAB_PROJECT_ID}/merge_requests", data=payload)
    if res.status_code in (200, 201):
        return res.json().get("web_url")
    if res.status_code == 409:
        mr = _find_open_mr_for_source_branch(source_branch)
        if mr:
            return mr.get("web_url")
    raise RuntimeError(f"Failed to create merge request: {res.status_code} {res.text}")

# -------------------------------------------------------------------
# Repo tree helpers
# -------------------------------------------------------------------
def _list_repo_tree(path: str, ref="main") -> List[Dict[str, Any]]:
    out = []
    page = 1
    while True:
        resp = _gl_request(
            "GET",
            f"/projects/{GITLAB_PROJECT_ID}/repository/tree",
            params={"ref": ref, "path": path, "recursive": True, "per_page": 100, "page": page},
        )
        if resp.status_code != 200:
            break
        items = resp.json() or []
        out.extend(items)
        if len(items) < 100:
            break
        page += 1
    return out

def _list_repo_tree_under(prefix: str, ref="main") -> List[Dict[str, Any]]:
    """Fallback: fetch all recursively and filter by prefix."""
    out, page = [], 1
    while True:
        resp = _gl_request(
            "GET",
            f"/projects/{GITLAB_PROJECT_ID}/repository/tree",
            params={"ref": ref, "recursive": True, "per_page": 100, "page": page},
        )
        if resp.status_code != 200:
            break
        items = resp.json() or []
        out.extend(items)
        if len(items) < 100:
            break
        page += 1
    prefix = prefix.rstrip("/") + "/"
    return [i for i in out if i.get("path", "").startswith(prefix)]

# -------------------------------------------------------------------
# Pipelines (optional)
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
    r = _gl_request("POST", f"/projects/{GITLAB_PROJECT_ID}/pipeline", json=payload)
    if r.status_code not in (200, 201):
        raise RuntimeError(f"Failed to trigger destroy pipeline: {r.status_code} {r.text}")
    return r.json()

def get_pipeline(project_id: str, pipeline_id: int) -> Dict[str, Any]:
    r = _gl_request("GET", f"/projects/{project_id}/pipelines/{pipeline_id}")
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
# Create lab (templates)
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
# Sanitize lab name utility
# -------------------------------------------------------------------
def _sanitize_lab_name(name: str) -> str:
    """
    Normalize a lab name to a safe folder name:
      - Removes trailing '.tfstate'
      - Replaces slashes and backslashes with '-'
      - Trims whitespace
    """
    n = (name or "").strip()
    if n.lower().endswith(".tfstate"):
        n = n[: -len(".tfstate")]
    n = n.replace("\\", "-").replace("/", "-").strip()
    return n

# -------------------------------------------------------------------
# Delete lab (Azure ➜ MR ➜ optional tfstate) with auto-merge support
# -------------------------------------------------------------------
def create_delete_lab_mr(
    course: str,
    lab_name: Optional[str] = None,
    *,
    lab_id: Optional[str] = None,
    base_branch: str = "main",
    auto_merge: bool = True,
    require_pipeline: bool = True,     # keep True if project requires CI
    auto_approve: bool = True,         # try to approve MR before accepting
) -> Dict[str, Any]:
    """
    Create a branch + MR that removes all files for the lab; ensure an MR pipeline exists;
    approve (optional); then queue auto-merge with the MR's head SHA.
    """
    actual_lab = _sanitize_lab_name(lab_name or lab_id or "")
    if not actual_lab:
        raise ValueError("create_delete_lab_mr: require lab_name or lab_id")

    course_folder = course_dir(course)
    lab_folder = f"Labs/{course_folder}/{actual_lab}"

    # --- discover files to delete (also handle legacy '<lab>.tfstate' folder) ---
    candidate_prefixes = [lab_folder, f"Labs/{course_folder}/{actual_lab}.tfstate"]
    candidate_files = [
        f"{lab_folder}.tfstate",
        f"Labs/{course_folder}/{actual_lab}.tfstate",
        f"{actual_lab}.tfstate",
    ]
    paths_to_delete: List[str] = []
    for prefix in candidate_prefixes:
        items = _list_repo_tree(prefix, ref=base_branch) or _list_repo_tree_under(prefix, ref=base_branch)
        for it in items or []:
            if it.get("type") == "blob" and it.get("path"):
                paths_to_delete.append(it["path"])
    for fpath in candidate_files:
        r = _gl_request(
            "GET",
            f"/projects/{GITLAB_PROJECT_ID}/repository/files/"
            f"{urllib.parse.quote(fpath, safe='')}?ref={urllib.parse.quote(base_branch, safe='')}",
        )
        if r.status_code == 200:
            paths_to_delete.append(fpath)
    paths_to_delete = sorted(set(paths_to_delete))

    # --- fresh branch for deletion ---
    unique = str(int(time.time()))
    branch = f"tlabs/delete-{course_folder}-{actual_lab}-{unique}".replace(" ", "-").lower()
    ensure_branch(branch, base_branch)

    # --- ensure a root CI file exists on this branch so the MR gets a pipeline ---
    root_ci_path = ".gitlab-ci.yml"
    root_ci_exists_on_base = _gl_request(
        "GET",
        f"/projects/{GITLAB_PROJECT_ID}/repository/files/{urllib.parse.quote(root_ci_path, safe='')}?ref={urllib.parse.quote(base_branch, safe='')}",
    ).status_code == 200
    if require_pipeline and not root_ci_exists_on_base:
        noop_ci = (
            "stages: [cleanup]\n"
            "noop:\n"
            "  stage: cleanup\n"
            "  script: [\"echo tlabs-delete\"]\n"
            "  rules:\n"
            "    - if: '$CI_PIPELINE_SOURCE == \"merge_request_event\"'\n"
        )
        try:
            _commit_actions(
                branch,
                f"[TerraLabs] Add minimal CI for delete branch {actual_lab}",
                [{"action": "create", "file_path": root_ci_path, "content": noop_ci}],
            )
        except Exception:
            pass

    # --- commit deletions ---
    if not paths_to_delete:
        _commit_actions(branch, f"[TerraLabs] Remove {course_folder}/{actual_lab} (no files found)", [])
    else:
        BATCH = 80
        failed_paths: List[str] = []
        for i in range(0, len(paths_to_delete), BATCH):
            batch = paths_to_delete[i:i+BATCH]
            try:
                _commit_actions(
                    branch,
                    f"[TerraLabs] Remove {course_folder}/{actual_lab} ({i+1}-{i+len(batch)} of {len(paths_to_delete)})",
                    [{"action": "delete", "file_path": p} for p in batch],
                )
            except Exception:
                for p in batch:
                    try:
                        _commit_actions(
                            branch,
                            f"[TerraLabs] Remove {course_folder}/{actual_lab} ({p})",
                            [{"action": "delete", "file_path": p}],
                        )
                    except Exception:
                        failed_paths.append(p)
        if failed_paths:
            marker_path = f"{lab_folder}/.delete_failed.json"
            content = json.dumps({"failed": failed_paths}, indent=2)
            _commit_actions(branch, f"[TerraLabs] Note delete failures for {course_folder}/{actual_lab}", [
                {"action": "create", "file_path": marker_path, "content": content}
            ])

    # --- create MR (must NOT be draft/WIP) ---
    res = _gl_request(
        "POST",
        f"/projects/{GITLAB_PROJECT_ID}/merge_requests",
        data={
            "source_branch": branch,
            "target_branch": base_branch,
            "title": f"[TerraLabs] Delete lab {course_folder}/{actual_lab}",
            "remove_source_branch": True,
        },
    )
    if res.status_code in (200, 201):
        mr = res.json()
    elif res.status_code == 409:
        mr = _find_open_mr_for_source_branch(branch)
        if not mr:
            raise RuntimeError(f"Failed to create merge request: {res.status_code} {res.text}")
    else:
        raise RuntimeError(f"Failed to create merge request: {res.status_code} {res.text}")

    mr_url = mr.get("web_url")
    mr_iid = mr.get("iid")

    # --- optional: auto-approve MR (for projects requiring approvals) ---
    approval_result = None
    if auto_approve and mr_iid is not None:
        appr = _gl_request("POST", f"/projects/{GITLAB_PROJECT_ID}/merge_requests/{mr_iid}/approve")
        approval_result = {"status_code": appr.status_code, "text": appr.text[:400]}

    # --- auto-merge: fetch head SHA, then accept with 'merge_when_pipeline_succeeds' and 'sha' ---
    auto_merge_result = None
    if auto_merge and mr_iid is not None:
        # refresh MR to get head SHA (prefer diff_refs.head_sha, else sha)
        mr_detail = _gl_request("GET", f"/projects/{GITLAB_PROJECT_ID}/merge_requests/{mr_iid}").json()
        head_sha = (
            (mr_detail.get("diff_refs") or {}).get("head_sha")
            or mr_detail.get("sha")
            or ""
        )

        # Optionally trigger a pipeline (usually MR pipeline is created automatically)
        pipeline_hint = None
        if require_pipeline:
            trig = _gl_request("POST", f"/projects/{GITLAB_PROJECT_ID}/pipeline", json={"ref": branch})
            pipeline_hint = {"status_code": trig.status_code, "text": trig.text[:200]}

        accept = _gl_request(
            "PUT",
            f"/projects/{GITLAB_PROJECT_ID}/merge_requests/{mr_iid}/merge",
            data={
                "sha": head_sha,                         # <-- important for some policies
                "merge_when_pipeline_succeeds": True,    # queue auto-merge
                "should_remove_source_branch": True,
            },
        )
        auto_merge_result = {
            "accept_status_code": accept.status_code,
            "accept_text": accept.text[:400],
            "head_sha": head_sha,
            "pipeline_trigger": pipeline_hint,
        }

    return {
        "branch": branch,
        "merge_request_url": mr_url,
        "merge_request_iid": mr_iid,
        "deleted_paths": paths_to_delete,
        "auto_merge": auto_merge,
        "require_pipeline": require_pipeline,
        "auto_approve": auto_approve,
        "approval_result": approval_result,
        "auto_merge_result": auto_merge_result,
    }

def delete_lab(
    course: str,
    *,
    lab_id: str,
    azure_dry_run: bool = False,
    wait_for_azure: bool = True,   # kept for API compatibility
    delete_state: bool = True,
) -> Dict[str, Any]:
    """
    High-level delete flow:
      1) Delete Azure resources by tags (LabId + LabCourse) via azure_client.
      2) Open MR to remove repo files; optionally auto-merge.
      3) Optionally delete tfstate blob from Azure Storage.
    """
    from azure_client import delete_lab_resources  # lazy import to avoid cycles

    # 1) Azure deletion via SDK
    azure_summary = delete_lab_resources(lab_id=lab_id, course=course, dry_run=azure_dry_run)

    # 2) MR (auto-merge enabled; change require_pipeline as needed)
    mr = create_delete_lab_mr(course, lab_id=lab_id, auto_merge=True, require_pipeline=True)

    # 3) Optional tfstate blob cleanup
    state_deleted = False
    if delete_state and not azure_dry_run:
        state_deleted = _delete_state_blob_if_present(course, lab_id)

    return {
        "azure": azure_summary,
        "delete_mr": mr,
        "tfstate_deleted": state_deleted,
    }
