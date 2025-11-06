from flask import Flask, request, jsonify
from flask_sqlalchemy import SQLAlchemy
from werkzeug.security import generate_password_hash, check_password_hash
from flask_cors import CORS
from dotenv import load_dotenv
from functools import wraps
from datetime import datetime, timedelta, timezone
import jwt, os

# GitLab helpers
from gitlab_utils import MODULE_SCHEMAS, create_lab_in_gitlab

# Azure Blob
from azure.storage.blob import (
    BlobServiceClient,
    BlobSasPermissions,
    generate_blob_sas
)

# ---------- Load env ----------
load_dotenv()

# ---------- Flask / CORS ----------
app = Flask(__name__)
CORS(
    app,
    resources={r"/api/*": {"origins": ["http://localhost:8080", "http://127.0.0.1:8080"]}},
    supports_credentials=False,
    allow_headers=["Content-Type", "Authorization"],
    methods=["GET", "POST", "OPTIONS"]
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
    id = db.Column(db.Integer, primary_key=True)
    email = db.Column(db.String(120), unique=True, nullable=False)
    password = db.Column(db.String(255), nullable=False)
    first_name = db.Column(db.String(80), nullable=True)
    last_name = db.Column(db.String(80), nullable=True)

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
    """
    Accepts ISO8601 strings like '2025-11-05T17:30:00Z' or with offsets.
    Returns an aware UTC datetime.
    """
    if not s:
        return None
    s = s.strip()
    # Replace trailing 'Z' with +00:00 for fromisoformat()
    if s.endswith("Z"):
        s = s[:-1] + "+00:00"
    try:
        dt = datetime.fromisoformat(s)
    except Exception:
        return None
    if dt.tzinfo is None:
        # treat naive as UTC, but we prefer aware inputs
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(timezone.utc)

# ---------- Auth ----------
@app.route("/api/signup", methods=["POST"])
def signup():
    data = request.get_json(force=True) or {}
    email = (data.get("email") or "").strip()
    password_plain = data.get("password") or ""
    first_name = (data.get("first_name") or "").strip()
    last_name = (data.get("last_name") or "").strip()

    if not email or not password_plain or not first_name or not last_name:
        return jsonify({"error": "Email, password, first_name and last_name are required"}), 400

    if User.query.filter_by(email=email).first():
        return jsonify({"error": "User already exists"}), 400

    hashed_password = generate_password_hash(password_plain)
    user = User(email=email, password=hashed_password, first_name=first_name, last_name=last_name)
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
    email = (data.get("email") or "").strip()
    password_plain = data.get("password") or ""

    if not email or not password_plain:
        return jsonify({"error": "Email and password required"}), 400

    user = User.query.filter_by(email=email).first()
    if not user or not check_password_hash(user.password, password_plain):
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

# ---------- Create lab in GitLab (supports expires_at) ----------
@app.route("/api/labs/create", methods=["POST"])
@token_required
def create_lab():
    try:
        data = request.get_json() or {}
        course = data.get("course")
        lab_name = data.get("lab_name")              # e.g. "step1.tfstate"
        module_name = data.get("module_name")        # e.g. "WindowsSnapshot"
        params = data.get("params", {})
        expires_at_str = (data.get("expires_at") or "").strip()  # ISO 8601 string from UI

        if not all([course, lab_name, module_name]):
            return jsonify({"error": "Missing required fields: course, lab_name, module_name"}), 400

        # parse/validate expires_at
        if not expires_at_str:
            return jsonify({"error": "expires_at is required (ISO 8601)"}), 400
        expires_at_dt = _parse_iso8601_utc(expires_at_str)
        if not expires_at_dt:
            return jsonify({"error": "expires_at must be ISO 8601 (e.g. 2025-11-05T18:30:00Z)"}), 400

        now_utc = datetime.now(timezone.utc)
        if expires_at_dt <= now_utc:
            return jsonify({"error": "expires_at must be in the future"}), 400

        created_at_iso = now_utc.isoformat().replace("+00:00", "Z")
        expires_at_iso = expires_at_dt.isoformat().replace("+00:00", "Z")

        # inject lifecycle fields used by terraform templates (terraform.tfvars.j2)
        params.update({
            "created_at": created_at_iso,
            "expires_at": expires_at_iso,
        })

        result = create_lab_in_gitlab(course, lab_name, module_name, params)

        return jsonify({
            "message": f"Lab {lab_name} created",
            "lab_folder": result.get("lab_folder"),
            "branch": result.get("branch"),
            "merge_request_url": result.get("merge_request_url"),
        }), 200

    except Exception as e:
        import traceback; traceback.print_exc()
        return jsonify({"error": str(e)}), 500

# ---------- Main ----------
if __name__ == "__main__":
    with app.app_context():
        db.create_all()
    app.run(debug=True, host="127.0.0.1", port=5000)
