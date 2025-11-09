from flask import Flask, request, jsonify
from flask_sqlalchemy import SQLAlchemy
from werkzeug.security import generate_password_hash, check_password_hash
from flask_cors import CORS, cross_origin
from dotenv import load_dotenv
from functools import wraps
from datetime import datetime, timedelta, timezone
import jwt, os

# GitLab helpers
from gitlab_utils import (
    MODULE_SCHEMAS,
    create_lab_in_gitlab,
    course_dir,
    trigger_destroy_pipeline,
    wait_for_pipeline,
    create_delete_lab_mr,
    GITLAB_PROJECT_ID,
)

# Azure Blob
from azure.storage.blob import (
    BlobServiceClient,
    BlobSasPermissions,
    generate_blob_sas
)

# Azure VM helpers
from azure_client import list_running_labs, start_vm_by_id, stop_vm_by_id

# ---------- Load env ----------
load_dotenv(override=True)
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
    auth = request.headers.get("Authorization", "")
    token = auth.split(" ", 1)[1]
    decoded = jwt.decode(token, app.config["SECRET_KEY"], algorithms=["HS256"])
    user = User.query.get(decoded["user_id"])
    if not user:
        return jsonify({"error": "User not found"}), 404
    return jsonify({
        "id": user.id,
        "email": user.email,
        "first_name": user.first_name,
        "last_name": user.last_name
    }), 200

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
        expires_at   = data.get("expires_at")  # ISO string from UI
        params       = data.get("params") or {}

        if not course or not lab_name or not module_name:
            return jsonify({"error": "Missing course, lab_name or module_name"}), 400

        # add lifecycle timestamps into tf_vars so templates can read them
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

# ---------- Delete lab flow: destroy → delete-files MR ----------
@app.route("/api/labs/delete", methods=["POST", "OPTIONS"])
@cross_origin(
    origins=["http://localhost:8080", "http://127.0.0.1:8080"],
    methods=["POST", "OPTIONS"],
    allow_headers=["Content-Type", "Authorization"]
)
@token_required
def delete_lab():
    # Handle CORS preflight (OPTIONS)
    if request.method == "OPTIONS":
        return ("", 204)

    try:
        data = request.get_json(force=True) or {}
        course = (data.get("course") or "").strip()
        lab_id = (data.get("lab_id") or "").strip()
        destroy = bool(data.get("destroy", True))
        wait = bool(data.get("wait_for_destroy", False))
        delete_state = bool(data.get("delete_state", False))

        if not course or not lab_id:
            return jsonify({"error": "course and lab_id are required"}), 400

        # Trigger destroy pipeline
        destroy_status = None
        pipeline_id = None
        if destroy:
            p = trigger_destroy_pipeline(course, lab_id)
            pipeline_id = p.get("id")
            if wait and pipeline_id:
                destroy_status = wait_for_pipeline(GITLAB_PROJECT_ID, pipeline_id, timeout_s=1800, poll_s=8)
            else:
                destroy_status = "queued"

        # After destroy (or immediately), delete files from GitLab
        mr = create_delete_lab_mr(course, lab_id=lab_id)

        # Delete tfstate blob (optional)
        if delete_state:
            try:
                from gitlab_utils import _delete_state_blob_if_present
                _delete_state_blob_if_present(course, lab_id)
            except Exception as e:
                print("[delete_lab] blob delete:", e)

        return jsonify({
            "status": "delete_requested",
            "destroy": {"triggered": destroy, "pipeline_id": pipeline_id, "final_status": destroy_status},
            "delete_mr": mr,
        }), 200

    except Exception as e:
        print("[/api/labs/delete] Error:", e)
        return jsonify({"error": str(e)}), 500


@app.after_request
def add_cors_headers(resp):
    resp.headers.setdefault("Access-Control-Allow-Origin", "http://localhost:8080")
    resp.headers.setdefault("Access-Control-Allow-Headers", "Content-Type, Authorization")
    resp.headers.setdefault("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
    return resp


@app.route("/api/debug/azure", methods=["GET"])
@token_required
def debug_azure():
    try:
        from azure_client import debug_snapshot
        snap = debug_snapshot(max_vms=15)
        return jsonify(snap), 200
    except Exception as e:
        print("[/api/debug/azure] Error:", e)
        return jsonify({"error": str(e)}), 500

# ---------- Main ----------
if __name__ == "__main__":
    with app.app_context():
        db.create_all()
    app.run(debug=True, host="127.0.0.1", port=5000)
