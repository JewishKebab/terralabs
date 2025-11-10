from flask import Flask, request, jsonify
from flask_sqlalchemy import SQLAlchemy
from werkzeug.security import generate_password_hash, check_password_hash
from flask_cors import CORS, cross_origin
from dotenv import load_dotenv
from functools import wraps
from datetime import datetime, timedelta, timezone
import jwt, os, re, time
from azure.core.exceptions import ResourceNotFoundError, HttpResponseError

load_dotenv(override=True)

# Template VM logic (no LabId/LabCourse in this flow)
from template_vm import (
    create_template_vm,               # create_template_vm(user_id, image_id, image_version, os_type, vm_size, admin_username, admin_password)
    get_template_vm_status,           # get_template_vm_status(user_id) -> dict or None
    snapshot_and_delete_template_vm,  # snapshot_and_delete_template_vm(user_id, snapshot_name)
    delete_template_vm,               # delete_template_vm(user_id)
)

# GitLab helpers (unchanged)
from gitlab_utils import (
    MODULE_SCHEMAS,
    create_lab_in_gitlab,
    course_dir,
    delete_lab as delete_lab_flow,
)

# Azure Blob (unchanged)
from azure.storage.blob import (
    BlobServiceClient,
    BlobSasPermissions,
    generate_blob_sas
)

# Azure VM helpers (unchanged)
from azure_client import list_running_labs, start_vm_by_id, stop_vm_by_id, list_snapshots_in_rg
from azure_client import _ensure_clients as _az_ensure, _compute as _az_compute

# ---------- Flask / CORS ----------
app = Flask(__name__)
CORS(
    app,
    resources={r"/api/*": {"origins": ["http://localhost:8080", "http://127.0.0.1:8080"]}},
    supports_credentials=False,
    allow_headers=["Content-Type", "Authorization"],
    expose_headers=["Content-Type"],
    methods=["GET", "POST", "OPTIONS"],
)

# ---------- Config ----------
app.config["SECRET_KEY"] = os.environ.get("JWT_SECRET", "fallback-secret")

# Postgres (Azure)
host = os.environ.get("AZURE_SQL_HOST")
user = os.environ.get("AZURE_SQL_USER")
password = os.environ.get("AZURE_SQL_PASSWORD")
db_name = os.environ.get("AZURE_SQL_DB")
app.config["SQLALCHEMY_DATABASE_URI"] = f"postgresql://{user}:{password}@{host}/{db_name}"
app.config["SQLALCHEMY_TRACK_MODIFICATIONS"] = False

# Azure Storage env
AZURE_STORAGE_ACCOUNT_NAME = os.environ.get("AZURE_STORAGE_ACCOUNT_NAME")
AZURE_BLOB_KEY = os.environ.get("AZURE_BLOB_KEY")
AZURE_CONTAINER_NAME = os.environ.get("AZURE_CONTAINER_NAME")
if not (AZURE_STORAGE_ACCOUNT_NAME and AZURE_BLOB_KEY and AZURE_CONTAINER_NAME):
    raise RuntimeError("Missing Azure Storage env vars: AZURE_STORAGE_ACCOUNT_NAME, AZURE_BLOB_KEY, AZURE_CONTAINER_NAME")
AZURE_ACCOUNT_URL = f"https://{AZURE_STORAGE_ACCOUNT_NAME}.blob.core.windows.net"

# ---------- DB ----------
db = SQLAlchemy(app)

class User(db.Model):
    __tablename__ = "users"
    id          = db.Column(db.Integer, primary_key=True)
    email       = db.Column(db.String(120), unique=True, nullable=False)
    password    = db.Column(db.String(255), nullable=False)
    first_name  = db.Column(db.String(80),  nullable=True)
    last_name   = db.Column(db.String(80),  nullable=True)

# ---------- Helpers ----------
def make_token(user_id: int) -> str:
    return jwt.encode(
        {"user_id": user_id, "exp": datetime.now(timezone.utc) + timedelta(hours=24)},
        app.config["SECRET_KEY"],
        algorithm="HS256",
    )

def token_required(fn):
    @wraps(fn)
    def wrapper(*args, **kwargs):
        auth = request.headers.get("Authorization", "")
        if not auth.startswith("Bearer "):
            return jsonify({"error": "Missing or invalid Authorization header"}), 401
        token = auth.split(" ", 1)[1]
        try:
            jwt.decode(token, app.config["SECRET_KEY"], algorithms=["HS256"])
        except jwt.ExpiredSignatureError:
            return jsonify({"error": "Token expired"}), 401
        except Exception:
            return jsonify({"error": "Invalid token"}), 401
        return fn(*args, **kwargs)
    return wrapper

def _current_user():
    auth = request.headers.get("Authorization", "")
    token = auth.split(" ", 1)[1]
    decoded = jwt.decode(token, app.config["SECRET_KEY"], algorithms=["HS256"])
    user = User.query.get(decoded["user_id"])
    return user

def get_blob_service() -> BlobServiceClient:
    return BlobServiceClient(account_url=AZURE_ACCOUNT_URL, credential=AZURE_BLOB_KEY)

def _parse_iso8601_utc(s: str):
    if not s:
        return None
    s = s.strip()
    if s.endswith("Z"):
        s = s[:-1] + "+00:00"
    try:
        dt = datetime.fromisoformat(s)
    except Exception:
        return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(timezone.utc)

# Enforce snapshot name "Projects-<Base>-Snapshot"
_SNAP_MAX = 80
def _format_snapshot_name_from_base(base: str) -> str:
    mid = re.sub(r"[^A-Za-z0-9-]+", "", (base or "").strip().replace(" ", "-"))
    if not mid:
        mid = "Snapshot"
    name = f"Projects-{mid}-Snapshot"
    return name[:_SNAP_MAX]

# ---------- Auth ----------
@app.route("/api/signup", methods=["POST"])
def signup():
    data = request.get_json(force=True) or {}
    email        = (data.get("email") or "").strip()
    password_raw = data.get("password") or ""
    first_name   = (data.get("first_name") or "").strip()
    last_name    = (data.get("last_name")  or "").strip()

    if not email or not password_raw or not first_name or not last_name:
        return jsonify({"error": "Email, password, first_name and last_name are required"}), 400

    if User.query.filter_by(email=email).first():
        return jsonify({"error": "User already exists"}), 400

    hashed = generate_password_hash(password_raw)
    user = User(email=email, password=hashed, first_name=first_name, last_name=last_name)

    try:
        db.session.add(user)
        db.session.commit()
    except Exception:
        db.session.rollback()
        return jsonify({"error": "Database error"}), 500

    token = make_token(user.id)
    return jsonify({
        "token": token,
        "redirect_url": "/dashboard",
        "user": {"id": user.id, "email": user.email, "first_name": user.first_name, "last_name": user.last_name}
    }), 200

@app.route("/api/login", methods=["POST"])
def login():
    data = request.get_json(force=True) or {}
    email        = (data.get("email") or "").strip()
    password_raw = data.get("password") or ""

    if not email or not password_raw:
        return jsonify({"error": "Email and password required"}), 400

    user = User.query.filter_by(email=email).first()
    if not user or not check_password_hash(user.password, password_raw):
        return jsonify({"error": "Invalid credentials"}), 401

    token = make_token(user.id)
    return jsonify({"token": token, "redirect_url": "/dashboard"}), 200

# ---------- User info ----------
@app.route("/api/me", methods=["GET"])
@token_required
def me():
    user = _current_user()
    if not user:
        return jsonify({"error": "User not found"}), 404
    return jsonify({
        "id": user.id,
        "email": user.email,
        "first_name": user.first_name,
        "last_name": user.last_name
    }), 200

# ------------- Snapshots ---------------
@app.route("/api/snapshots", methods=["GET", "OPTIONS"])
@cross_origin(
    origins=["http://localhost:8080", "http://127.0.0.1:8080"],
    methods=["GET", "OPTIONS"],
    headers=["Content-Type", "Authorization"]
)
@token_required
def api_list_snapshots():
    # Preflight
    if request.method == "OPTIONS":
        return ("", 204)

    try:
        # Ensure Azure clients
        _az_ensure()
        compute = _az_compute()

        # RG to read from
        snapshot_rg = os.environ.get("TL_SNAPSHOT_RG")
        if not snapshot_rg:
            return jsonify({"error": "TL_SNAPSHOT_RG is not set"}), 500

        # Optional filter: ?q=foo (case-insensitive contains)
        q = (request.args.get("q") or "").strip().lower()

        # Get snapshots in that RG
        snaps = list(compute.snapshots.list_by_resource_group(snapshot_rg))
        items = []
        for s in snaps:
            name = getattr(s, "name", "")
            if q and q not in name.lower():
                continue
            items.append({
                "name": name,
                "id": getattr(s, "id", None),
                "time_created": getattr(s, "time_created", None).isoformat() if getattr(s, "time_created", None) else None,
                "sku": getattr(getattr(s, "sku", None), "name", None),
                "provisioning_state": getattr(s, "provisioning_state", None),
            })

        # Sort newest first if time_created available
        items.sort(key=lambda x: x["time_created"] or "", reverse=True)
        return jsonify({"snapshots": items}), 200

    except Exception as e:
        print("[/api/snapshots] Error:", e)
        return jsonify({"error": str(e)}), 500
# ---------- Azure Blob (states) ----------
@app.route("/api/states", methods=["GET"])
@token_required
def list_state_files():
    try:
        blob_service = get_blob_service()
        container_client = blob_service.get_container_client(AZURE_CONTAINER_NAME)

        items = []
        for blob in container_client.list_blobs():
            if not blob.name.endswith(".tfstate"):
                continue
            items.append({
                "name": blob.name,
                "size": getattr(blob, "size", None),
                "last_modified": blob.last_modified.isoformat() if getattr(blob, "last_modified", None) else None
            })

        items.sort(key=lambda x: x["last_modified"] or "", reverse=True)
        return jsonify({"states": items}), 200
    except Exception as e:
        print(f"[list_state_files] Error: {e}")
        return jsonify({"error": "Failed to list state files"}), 500

@app.route("/api/states/<path:blob_name>/url", methods=["GET"])
@token_required
def get_state_sas_url(blob_name: str):
    try:
        sas_token = generate_blob_sas(
            account_name=AZURE_STORAGE_ACCOUNT_NAME,
            container_name=AZURE_CONTAINER_NAME,
            blob_name=blob_name,
            account_key=AZURE_BLOB_KEY,
            permission=BlobSasPermissions(read=True),
            expiry=datetime.now(timezone.utc) + timedelta(minutes=10)
        )
        url = f"{AZURE_ACCOUNT_URL}/{AZURE_CONTAINER_NAME}/{blob_name}?{sas_token}"
        return jsonify({"url": url, "expires_in_minutes": 10}), 200
    except Exception as e:
        print(f"[get_state_sas_url] Error: {e}")
        return jsonify({"error": "Failed to generate SAS URL"}), 500

# ---------- Create lab in GitLab ----------
@app.route("/api/labs/create", methods=["POST"])
def create_lab():
    try:
        data = request.get_json(force=True) or {}

        course       = (data.get("course") or "").strip()
        lab_name     = (data.get("lab_name") or "").strip()
        module_name  = (data.get("module_name") or "").strip()
        expires_at   = data.get("expires_at")
        params       = data.get("params") or {}

        if not course or not lab_name or not module_name:
            return jsonify({"error": "Missing course, lab_name or module_name"}), 400

        params = dict(params)
        params.setdefault("created_at", datetime.now(timezone.utc).isoformat())
        if expires_at:
            params["expires_at"] = expires_at

        result = create_lab_in_gitlab(course, lab_name, module_name, params)
        return jsonify(result), 200
    except Exception as e:
        print("[/api/labs/create] Error:", e)
        return jsonify({"error": str(e)}), 500

# ---------- Running labs (VMs + IPs) ----------
@app.route("/api/labs/running", methods=["GET"])
@token_required
def labs_running():
    try:
        labs = list_running_labs()
        return jsonify({"labs": labs}), 200
    except Exception as e:
        print(f"[labs_running] Error: {e}")
        return jsonify({"error": "Failed to fetch running labs"}), 500

# ---------- VM power ops ----------
@app.route("/api/vm/start", methods=["POST", "OPTIONS"])
@cross_origin(origins=["http://localhost:8080", "http://127.0.0.1:8080"],
              methods=["POST", "OPTIONS"],
              headers=["Content-Type", "Authorization"])
def api_vm_start():
    if request.method == "OPTIONS":
        return ("", 204)
    data = request.get_json(force=True) or {}
    vm_id = data.get("vm_id")
    if not vm_id:
        return jsonify({"error": "vm_id required"}), 400
    try:
        start_vm_by_id(vm_id)
        return jsonify({"status": "start_requested"}), 200
    except Exception as e:
        print("[vm_start] Error:", e)
        return jsonify({"error": "Failed to request start"}), 500

@app.route("/api/vm/stop", methods=["POST", "OPTIONS"])
@cross_origin(origins=["http://localhost:8080", "http://127.0.0.1:8080"],
              methods=["POST", "OPTIONS"],
              headers=["Content-Type", "Authorization"])
def api_vm_stop():
    if request.method == "OPTIONS":
        return ("", 204)
    data = request.get_json(force=True) or {}
    vm_id = data.get("vm_id")
    deallocate = bool(data.get("deallocate", True))
    if not vm_id:
        return jsonify({"error": "vm_id required"}), 400
    try:
        stop_vm_by_id(vm_id, deallocate=deallocate)
        return jsonify({"status": "deallocate_requested" if deallocate else "poweroff_requested"}), 200
    except Exception as e:
        print("[vm_stop] Error:", e)
        return jsonify({"error": "Failed to request stop"}), 500

# ---------- Delete lab: Azure deletion → MR remove folder → delete tfstate ----------
@app.route("/api/labs/delete", methods=["POST", "OPTIONS"])
@cross_origin(
    origins=["http://localhost:8080", "http://127.0.0.1:8080"],
    methods=["POST", "OPTIONS"],
    allow_headers=["Content-Type", "Authorization"]
)
@token_required
def delete_lab():
    if request.method == "OPTIONS":
        return ("", 204)
    try:
        data = request.get_json(force=True) or {}
        course = (data.get("course") or "").strip()
        lab_id = (data.get("lab_id") or "").strip()

        if not course or not lab_id:
            return jsonify({"error": "course and lab_id are required"}), 400

        result = delete_lab_flow(
            course,
            lab_id=lab_id,
            azure_dry_run=False,
            wait_for_azure=True,
            delete_state=True,
        )

        return jsonify({"status": "delete_requested", **result}), 200

    except Exception as e:
        print("[/api/labs/delete] Error:", e)
        return jsonify({"error": str(e)}), 500

# ---------- Template VM API (per-user; no LabId/Course) ----------
@app.route("/api/template-vm/create", methods=["POST"])
@token_required
def api_template_vm_create():
    u = _current_user()
    data = request.get_json(force=True) or {}
    body = {
        "user_id": u.email,  # TerraLabsUser tag in template_vm.py
        "image_id": data.get("image_id"),
        "image_version": data.get("image_version") or "latest",
        "os_type": data.get("os_type") or "windows",
        "vm_size": data.get("vm_size") or "Standard_B2s",
        "admin_username": data.get("admin_username"),
        "admin_password": data.get("admin_password"),
    }
    try:
        res = create_template_vm(**body)
        return jsonify(res), 200
    except Exception as e:
        print("[/api/template-vm/create] Error:", e)
        return jsonify({"error": str(e)}), 500

@app.route("/api/template-vm/status", methods=["GET"])
@token_required
def api_template_vm_status():
    """
    Returns the caller's template VM status.
    Always resolves by TerraLabsUser tag.
    If nothing found, returns 200 {"exists": False}.
    """
    u = _current_user()
    try:
        payload, code = get_template_vm_status(user_id=u.email, vm_id=None, soft_not_found=True)
        # Force 200 for soft-not-found semantics
        if code == 404:
            return jsonify({"exists": False}), 200
        return jsonify(payload), 200
    except (ResourceNotFoundError, HttpResponseError):
        # Treat Azure 'not found' as soft miss
        return jsonify({"exists": False}), 200
    except Exception as e:
        print("[/api/template-vm/status] Error:", e)
        return jsonify({"error": str(e)}), 500

@app.route("/api/template-vm/snapshot", methods=["POST"])
@token_required
def api_template_vm_snapshot():
    u = _current_user()
    data = request.get_json(force=True) or {}
    try:
        raw = (data.get("snapshot_name") or "").strip()
        # Accept either raw mid or a full Projects-<x>-Snapshot and normalize
        if raw.startswith("Projects-") and raw.endswith("-Snapshot"):
            mid = raw[len("Projects-"):-len("-Snapshot")]
            snapshot_name = _format_snapshot_name_from_base(mid)
        else:
            snapshot_name = _format_snapshot_name_from_base(raw)

        res = snapshot_and_delete_template_vm(user_id=u.email, snapshot_name=snapshot_name)
        return jsonify(res), 200
    except Exception as e:
        print("[/api/template-vm/snapshot] Error:", e)
        return jsonify({"error": str(e)}), 500

@app.route("/api/template-vm/discard", methods=["POST"])
@token_required
def api_template_vm_discard():
    u = _current_user()
    try:
        res = delete_template_vm(user_id=u.email)
        return jsonify(res), 200
    except Exception as e:
        print("[/api/template-vm/discard] Error:", e)
        return jsonify({"error": str(e)}), 500

# ---------- CORS headers ----------
@app.after_request
def add_cors_headers(resp):
    resp.headers.setdefault("Access-Control-Allow-Origin", "http://localhost:8080")
    resp.headers.setdefault("Access-Control-Allow-Headers", "Content-Type, Authorization")
    resp.headers.setdefault("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
    return resp

# ---------- Main ----------
if __name__ == "__main__":
    with app.app_context():
        db.create_all()
    app.run(debug=True, host="127.0.0.1", port=5000)
