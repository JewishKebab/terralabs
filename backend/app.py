from flask import Flask, request, jsonify
from flask_sqlalchemy import SQLAlchemy
from werkzeug.security import generate_password_hash, check_password_hash
from flask_cors import CORS, cross_origin
from dotenv import load_dotenv
from functools import wraps
from datetime import datetime, timedelta, timezone
import jwt, os, re
from azure.core.exceptions import ResourceNotFoundError, HttpResponseError
from aad_groups import resolve_group_names_from_ids, derive_role_scope

load_dotenv(override=True)

# ---------------- Azure AD (NEW) ----------------
from jwt import PyJWKClient, decode as pyjwt_decode

AAD_TENANT_ID = os.getenv("AAD_TENANT_ID")
AAD_CLIENT_ID = os.getenv("AAD_CLIENT_ID")
AAD_ISSUER = f"https://login.microsoftonline.com/{AAD_TENANT_ID}/v2.0" if AAD_TENANT_ID else None
AAD_JWKS_URI = f"{AAD_ISSUER}/discovery/v2.0/keys" if AAD_TENANT_ID else None


def _validate_aad_id_token(id_token: str) -> dict:
    if not (AAD_TENANT_ID and AAD_CLIENT_ID):
        raise RuntimeError("AAD_TENANT_ID and AAD_CLIENT_ID must be set")
    jwks_client = PyJWKClient(AAD_JWKS_URI)
    signing_key = jwks_client.get_signing_key_from_jwt(id_token).key
    claims = pyjwt_decode(
        id_token,
        signing_key,
        algorithms=["RS256"],
        audience=AAD_CLIENT_ID,
        issuer=AAD_ISSUER,
        options={"verify_at_hash": False},
    )
    return claims
# ------------------------------------------------

from template_vm import (
    create_template_vm,
    get_template_vm_status,
    snapshot_and_delete_template_vm,
    delete_template_vm,
)

from gitlab_utils import (
    MODULE_SCHEMAS,
    create_lab_in_gitlab,
    course_dir,
    delete_lab as delete_lab_flow,
)

from azure.storage.blob import (
    BlobServiceClient,
    BlobSasPermissions,
    generate_blob_sas
)

from azure_client import (
    list_running_labs,
    start_vm_by_id,
    stop_vm_by_id,
    list_snapshots_in_rg,
    # publish/enroll helpers
    list_published_labs,
    set_lab_published,
    enroll_student_in_lab,
    find_vm_for_student,
)
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
    password    = db.Column(db.String(255), nullable=True)
    first_name  = db.Column(db.String(80),  nullable=True)
    last_name   = db.Column(db.String(80),  nullable=True)

# ---------- Helpers ----------
def make_token(user_id: int, role: str = None, course: str = None, section: str = None, groups: list[str] = None) -> str:
    payload = {
        "user_id": user_id,
        "exp": datetime.now(timezone.utc) + timedelta(hours=24),
    }
    if role:
        payload["role"] = role
    if course is not None:
        payload["course"] = course
    if section is not None:
        payload["section"] = section
    if groups:
        payload["groups"] = groups
    return jwt.encode(payload, app.config["SECRET_KEY"], algorithm="HS256")

def _current_claims():
    auth = request.headers.get("Authorization", "")
    token = auth.split(" ", 1)[1] if " " in auth else auth
    return jwt.decode(token, app.config["SECRET_KEY"], algorithms=["HS256"])

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

_SNAP_MAX = 80
def _format_snapshot_name_from_base(base: str) -> str:
    mid = re.sub(r"[^A-Za-z0-9-]+", "", (base or "").strip().replace(" ", "-"))
    if not mid:
        mid = "Snapshot"
    name = f"Projects-{mid}-Snapshot"
    return name[:_SNAP_MAX]

def require_role(*allowed):
    def deco(fn):
        @wraps(fn)
        def inner(*args, **kwargs):
            try:
                claims = _current_claims()
            except Exception:
                return jsonify({"error": "Invalid token"}), 401
            role = (claims.get("role") or "").lower()
            if role not in [a.lower() for a in allowed]:
                return jsonify({"error": "forbidden"}), 403
            return fn(*args, **kwargs)
        return inner
    return deco

def _display_name(user: User) -> str:
    full = " ".join([p for p in [user.first_name, user.last_name] if p]).strip()
    return full or user.email

# ---------- Auth (local) ----------
@app.route("/api/signup", methods=["POST"])
def signup():
    data = request.get_json(force=True) or {}
    email        = (data.get("email") or "").strip()
    password_raw = data.get("password") or ""
    first_name   = (data.get("first_name") or "").strip()
    last_name    = (data.get("last_name")  or "").strip()

    if not email or not password_raw or not first_name or not last_name:
        return jsonify({"error": "Email, password, first_name and last_name are required"}), 400

    if User.query.filter_by(email=email.lower()).first():
        return jsonify({"error": "User already exists"}), 400

    hashed = generate_password_hash(password_raw)
    user = User(email=email.lower(), password=hashed, first_name=first_name, last_name=last_name)

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

    user = User.query.filter_by(email=email.lower()).first()
    if not user or not user.password or not check_password_hash(user.password, password_raw):
        return jsonify({"error": "Invalid credentials"}), 401

    token = make_token(user.id)
    return jsonify({"token": token, "redirect_url": "/dashboard"}), 200

# ---------- Azure AD login ----------
@app.route("/api/aad/login", methods=["POST", "OPTIONS"])
@cross_origin(
    origins=["http://localhost:8080", "http://127.0.0.1:8080"],
    methods=["POST", "OPTIONS"],
    headers=["Content-Type", "Authorization"]
)
def aad_login():
    if request.method == "OPTIONS":
        return ("", 204)

    if not AAD_TENANT_ID or not AAD_CLIENT_ID:
        return jsonify({"error": "AAD_TENANT_ID and AAD_CLIENT_ID must be set"}), 400

    data = request.get_json(force=True) or {}
    id_token = (data.get("id_token") or "").strip()
    if not id_token:
        return jsonify({"error": "id_token is required"}), 400

    try:
        decoded = jwt.decode(id_token, options={"verify_signature": False, "verify_exp": False})
    except Exception as e:
        return jsonify({"error": f"Failed to parse id_token: {str(e)}"}), 400

    full_name = (decoded.get("name") or "").strip()
    first = (decoded.get("given_name") or "").strip()
    last = (decoded.get("family_name") or "").strip()

    if not (first or last) and full_name:
        parts = full_name.split()
        if len(parts) == 1:
            first = parts[0]
            last = None
        else:
            first = parts[0]
            last = " ".join(parts[1:])

    email = (
        (decoded.get("preferred_username") or "").lower()
        or (decoded.get("email") or "").lower()
        or (decoded.get("unique_name") or "").lower()
    )

    if not email:
        print("[/api/aad/login] Missing email-like claim. Claims:", {
            k: decoded.get(k)
            for k in ["preferred_username", "email", "unique_name", "tid", "oid", "name"]
        })
        return jsonify({"error": "AAD token missing email/UPN claim"}), 400

    group_ids = decoded.get("groups", []) or []
    group_names = resolve_group_names_from_ids(group_ids)
    role, course, section = derive_role_scope(group_names)

    user = User.query.filter_by(email=email).first()
    if not user:
        user = User(
            email=email,
            password=generate_password_hash(os.urandom(8).hex()),
            first_name=first or None,
            last_name=last or None,
        )
        db.session.add(user)
        try:
            db.session.commit()
        except Exception as e:
            db.session.rollback()
            user = User.query.filter_by(email=email).first()
            if not user:
                print("[/api/aad/login] Database error:", e)
                return jsonify({"error": "Database error creating AAD user"}), 500
    else:
        updated = False
        if first and user.first_name != first:
            user.first_name = first
            updated = True
        if last and user.last_name != last:
            user.last_name = last
            updated = True
        if updated:
            db.session.commit()

    token = make_token(user.id, role=role, course=course, section=section, groups=group_names)
    if isinstance(token, bytes):
        token = token.decode("utf-8")

    return jsonify({
        "token": token,
        "redirect_url": "/dashboard",
        "user": {
            "id": user.id,
            "email": user.email,
            "first_name": user.first_name,
            "last_name": user.last_name,
            "full_name": full_name or " ".join(
                [p for p in [user.first_name, user.last_name] if p]
            ) or None,
        },
        "role": role,
        "course": course,
        "section": section,
        "groups": group_names,
    }), 200

# ---------- User info ----------
@app.route("/api/me", methods=["GET"])
@token_required
def me():
    user = _current_user()
    if not user:
        return jsonify({"error": "User not found"}), 404

    claims = {}
    try:
        claims = _current_claims()
    except Exception:
        pass

    return jsonify({
        "id": user.id,
        "email": user.email,
        "first_name": user.first_name,
        "last_name": user.last_name,
        "role": claims.get("role", "unknown"),
        "course": claims.get("course"),
        "section": claims.get("section"),
        "groups": claims.get("groups", []),
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
    if request.method == "OPTIONS":
        return ("", 204)

    try:
        _az_ensure()
        compute = _az_compute()

        snapshot_rg = os.environ.get("TL_SNAPSHOT_RG")
        if not snapshot_rg:
            return jsonify({"error": "TL_SNAPSHOT_RG is not set"}), 500

        q = (request.args.get("q") or "").strip().lower()

        # course can come explicitly (query) or implicitly from the token
        course_param = (request.args.get("course") or "").strip()
        try:
            claims = _current_claims()
        except Exception:
            claims = {}
        course_claim = (claims.get("course") or "").strip()
        course = (course_param or course_claim).lower()

        def tag_val(tags: dict, *keys) -> str:
            for k in keys:
                for tk, tv in (tags or {}).items():
                    if (tk or "").lower() == k.lower():
                        return (tv or "")
            return ""

        snaps = list(compute.snapshots.list_by_resource_group(snapshot_rg))
        items = []
        for s in snaps:
            name = getattr(s, "name", "")
            if q and q not in name.lower():
                continue

            tags = getattr(s, "tags", {}) or {}
            snap_course = (tag_val(tags, "LabCourse", "course", "TLABS_COURSE") or "").lower()
            if course and snap_course != course:
                continue

            items.append({
                "name": name,
                "id": getattr(s, "id", None),
                "time_created": getattr(s, "time_created", None).isoformat() if getattr(s, "time_created", None) else None,
                "sku": getattr(getattr(s, "sku", None), "name", None),
                "provisioning_state": getattr(s, "provisioning_state", None),
                "tags": tags,
            })

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

# ---------- Published labs (student view) ----------
@app.route("/api/labs/published", methods=["GET"])
@token_required
def api_labs_published():
    try:
        labs = list_published_labs()
        return jsonify({"labs": labs}), 200
    except Exception as e:
        print("[/api/labs/published] Error:", e)
        return jsonify({"error": "Failed to list published labs"}), 500

# ---------- Publish / Unpublish (supports both URL styles) ----------
@app.route("/api/labs/publish", methods=["POST"])
@token_required
@require_role("segel", "asgard")
def api_lab_publish_body():
    data = request.get_json(force=True) or {}
    course = (data.get("course") or "").strip()
    lab_id = (data.get("lab_id") or "").strip()
    if not course or not lab_id:
        return jsonify({"error": "course and lab_id are required"}), 400
    try:
        res = set_lab_published(lab_id=lab_id, course=course, published=True)
        return jsonify(res), 200
    except Exception as e:
        print("[/api/labs/publish] Error:", e)
        return jsonify({"error": str(e)}), 500

@app.route("/api/labs/<course>/<lab_id>/publish", methods=["POST"])
@token_required
@require_role("segel", "asgard")
def api_lab_publish(course, lab_id):
    try:
        res = set_lab_published(lab_id=lab_id, course=course, published=True)
        return jsonify(res), 200
    except Exception as e:
        print("[/api/labs/:course/:lab_id/publish] Error:", e)
        return jsonify({"error": str(e)}), 500

@app.route("/api/labs/<course>/<lab_id>/unpublish", methods=["POST"])
@token_required
@require_role("segel", "asgard")
def api_lab_unpublish(course, lab_id):
    try:
        res = set_lab_published(lab_id=lab_id, course=course, published=False)
        return jsonify(res), 200
    except Exception as e:
        print("[/api/labs/:course/:lab_id/unpublish] Error:", e)
        return jsonify({"error": str(e)}), 500

# ---------- Enroll (supports both URL styles) ----------
@app.route("/api/labs/enroll", methods=["POST"])
@token_required
def api_lab_enroll_body():
    data = request.get_json(force=True) or {}
    course = (data.get("course") or "").strip()
    lab_id = (data.get("lab_id") or "").strip()
    if not course or not lab_id:
        return jsonify({"error": "course and lab_id are required"}), 400
    try:
        u = _current_user()
        who = (u.email or "").lower()
        who_name = _display_name(u)
        vm = enroll_student_in_lab(lab_id=lab_id, course=course, who=who, who_name=who_name)
        if not vm:
            return jsonify({"error": "No free VM available or lab not published"}), 409
        return jsonify({"assigned_vm": vm}), 200
    except Exception as e:
        print("[/api/labs/enroll] Error:", e)
        return jsonify({"error": str(e)}), 500

@app.route("/api/labs/<course>/<lab_id>/enroll", methods=["POST"])
@token_required
def api_lab_enroll(course, lab_id):
    try:
        u = _current_user()
        who = (u.email or "").lower()
        who_name = _display_name(u)
        vm = enroll_student_in_lab(lab_id=lab_id, course=course, who=who, who_name=who_name)
        if not vm:
            return jsonify({"error": "No free VM available or lab not published"}), 409
        return jsonify({"assigned_vm": vm}), 200
    except Exception as e:
        print("[/api/labs/:course/:lab_id/enroll] Error:", e)
        return jsonify({"error": str(e)}), 500

@app.route("/api/labs/my-enrollment", methods=["GET"])
@token_required
def api_my_enrollment():
    try:
        u = _current_user()
        who = (u.email or "").lower()
        vm = find_vm_for_student(who)
        return jsonify({"vm": vm}), 200
    except Exception as e:
        print("[/api/labs/my-enrollment] Error:", e)
        return jsonify({"error": str(e)}), 500

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

# ---------- Delete lab ----------
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

# ---------- Template VM API ----------
@app.route("/api/template-vm/create", methods=["POST"])
@token_required
def api_template_vm_create():
    u = _current_user()
    data = request.get_json(force=True) or {}
    body = {
        "user_id": u.email,
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
    u = _current_user()
    try:
        payload, code = get_template_vm_status(user_id=u.email, vm_id=None, soft_not_found=True)
        if code == 404:
            return jsonify({"exists": False}), 200
        return jsonify(payload), 200
    except (ResourceNotFoundError, HttpResponseError):
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
        if raw.startswith("Projects-") and raw.endswith("-Snapshot"):
            mid = raw[len("Projects-"):-len("-Snapshot")]
            snapshot_name = _format_snapshot_name_from_base(mid)
        else:
            snapshot_name = _format_snapshot_name_from_base(raw)

        res = snapshot_and_delete_template_vm(user_id=u.email, snapshot_name=snapshot_name)

        # --------  tag snapshot with course so it can be filtered later -------
        try:
            claims = _current_claims()
            course = (claims.get("course") or "").strip()
            snapshot_rg = os.environ.get("TL_SNAPSHOT_RG")
            if course and snapshot_rg:
                from azure_client import set_snapshot_tags  # lazy import to avoid cycles
                set_snapshot_tags(snapshot_rg, snapshot_name, {"LabCourse": course})
        except Exception as e:
            print("[/api/template-vm/snapshot] tagging failed:", e)

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
