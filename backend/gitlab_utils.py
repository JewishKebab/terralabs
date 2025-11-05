import os, json, requests, urllib.parse, urllib3
from jinja2 import Environment, FileSystemLoader, select_autoescape

# --- Disable SSL warnings & verification ---
urllib3.disable_warnings(urllib3.exceptions.InsecureRequestWarning)
REQUESTS_VERIFY = False

# --- GitLab env vars ---
GITLAB_HOST = os.getenv("GITLAB_HOST", "https://gitlab.com")
GITLAB_PROJECT_ID = os.getenv("GITLAB_PROJECT_ID")
GITLAB_TOKEN = os.getenv("GITLAB_TOKEN")
GITLAB_API = f"{GITLAB_HOST}/api/v4"

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


# --- GitLab helper ---
def ensure_branch(branch: str, base_branch: str = "main"):
    """Create a branch if it doesn’t exist."""
    headers = {"PRIVATE-TOKEN": GITLAB_TOKEN}
    branch_url = f"{GITLAB_API}/projects/{GITLAB_PROJECT_ID}/repository/branches/{urllib.parse.quote(branch, safe='')}"

    exists = requests.get(branch_url, headers=headers, verify=REQUESTS_VERIFY)
    if exists.status_code == 200:
        return  # already exists

    # Create new branch from base_branch
    create_url = f"{GITLAB_API}/projects/{GITLAB_PROJECT_ID}/repository/branches"
    res = requests.post(
        create_url,
        headers=headers,
        json={"branch": branch, "ref": base_branch},
        verify=REQUESTS_VERIFY,
    )
    if res.status_code not in (200, 201):
        raise RuntimeError(f"Failed to create branch {branch}: {res.status_code} {res.text}")


def gitlab_upsert_file(path: str, content: str, commit_message: str, branch: str):
    """Create or update a file in GitLab in a given branch."""
    if not (GITLAB_PROJECT_ID and GITLAB_TOKEN):
        raise RuntimeError("Missing GitLab configuration")

    url = f"{GITLAB_API}/projects/{GITLAB_PROJECT_ID}/repository/files/{urllib.parse.quote(path, safe='')}"
    headers = {"PRIVATE-TOKEN": GITLAB_TOKEN}
    data = {
        "branch": branch,
        "content": content,
        "commit_message": commit_message,
        "encoding": "text"
    }

    exists = requests.get(url, headers=headers, params={"ref": branch}, verify=REQUESTS_VERIFY)
    if exists.status_code == 200:
        res = requests.put(url, headers=headers, data=data, verify=REQUESTS_VERIFY)
    else:
        res = requests.post(url, headers=headers, data=data, verify=REQUESTS_VERIFY)

    if res.status_code not in (200, 201):
        raise RuntimeError(f"GitLab upsert failed for {path}: {res.status_code} {res.text}")


def create_merge_request(source_branch: str, target_branch: str = "main", title: str = None):
    """Create a merge request for the new branch."""
    headers = {"PRIVATE-TOKEN": GITLAB_TOKEN}
    url = f"{GITLAB_API}/projects/{GITLAB_PROJECT_ID}/merge_requests"

    payload = {
        "source_branch": source_branch,
        "target_branch": target_branch,
        "title": title or f"[TerraLabs] {source_branch}",
        "remove_source_branch": True,
    }

    res = requests.post(url, headers=headers, json=payload, verify=REQUESTS_VERIFY)
    if res.status_code not in (200, 201):
        raise RuntimeError(f"Failed to create merge request: {res.status_code} {res.text}")

    return res.json().get("web_url")


# --- Main lab creation ---
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
    lab_folder = f"Labs/{course}/{lab_name}"
    branch_name = f"labs/{course}/{lab_name}".replace(" ", "-").lower()

    # --- ensure new branch exists ---
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
        gitlab_upsert_file(path, content, f"[TerraLabs] Create {course}/{lab_name}", branch_name)

    # --- Create MR automatically ---
    mr_url = create_merge_request(branch_name, base_branch, f"[TerraLabs] {course}/{lab_name}")

    return {
        "lab_folder": lab_folder,
        "branch": branch_name,
        "merge_request_url": mr_url,
    }
