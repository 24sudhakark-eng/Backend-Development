"""StockFlow - Inventory / Product Management System.

Flask backend exposing a RESTful JSON API on top of SQLite.
Run with:  python app.py   ->  http://127.0.0.1:5000
"""

import csv
import io
import os
import re
import secrets
import sqlite3
from contextlib import closing
from datetime import datetime, timedelta, timezone
from decimal import Decimal, InvalidOperation
from functools import wraps
from pathlib import Path

from flask import (
    Flask,
    Response,
    g,
    jsonify,
    redirect,
    render_template,
    request,
    session,
    url_for,
)
from werkzeug.exceptions import HTTPException
from werkzeug.security import check_password_hash, generate_password_hash

BASE_DIR = Path(__file__).resolve().parent

# ---------------------------------------------------------------------------
# Configuration (change defaults here)
# ---------------------------------------------------------------------------
# Default application settings. They are written to the `settings` table the
# first time the database is created and can then be edited on the Settings page.
DEFAULT_SETTINGS = {
    "app_name": "StockFlow",
    "low_stock_threshold": 5,  # quantity 1..threshold = "Low Stock"
    "currency": "INR",
    "admin_name": "Store Admin",
}
ALLOWED_CURRENCIES = ("INR", "USD", "EUR", "GBP")

# Demo authentication. Override with environment variables if you like.
ADMIN_EMAIL = os.environ.get("STOCKFLOW_ADMIN_EMAIL", "admin@stockflow.com").lower()
ADMIN_PASSWORD_HASH = generate_password_hash(
    os.environ.get("STOCKFLOW_ADMIN_PASSWORD", "admin123")
)

# Validation limits
MAX_QUANTITY = 1_000_000
MAX_PRICE = Decimal("10000000")
PRODUCT_ID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_-]{1,19}$")
EMAIL_RE = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")

STATUSES = ("in_stock", "low_stock", "out_of_stock")
STATUS_LABELS = {
    "in_stock": "In Stock",
    "low_stock": "Low Stock",
    "out_of_stock": "Out of Stock",
}

# Whitelist for ORDER BY. User input is only ever used as a lookup key here,
# never concatenated into SQL.
SORT_COLUMNS = {
    "product_id": "product_id COLLATE NOCASE",
    "name": "name COLLATE NOCASE",
    "category": "category COLLATE NOCASE",
    "quantity": "quantity",
    "price": "price",
    "updated_at": "updated_at",
}


def load_secret_key():
    """Use an env var if set, otherwise create and reuse a local key file."""
    env_key = os.environ.get("STOCKFLOW_SECRET_KEY")
    if env_key:
        return env_key
    key_file = BASE_DIR / ".secret_key"
    try:
        if key_file.exists():
            return key_file.read_text().strip()
        key = secrets.token_hex(32)
        key_file.write_text(key)
        return key
    except OSError:  # read-only folder: fall back to a per-process key
        return secrets.token_hex(32)


app = Flask(__name__)
app.config.update(
    DATABASE=str(BASE_DIR / "inventory.db"),
    SECRET_KEY=load_secret_key(),
    SESSION_COOKIE_HTTPONLY=True,
    SESSION_COOKIE_SAMESITE="Lax",
    PERMANENT_SESSION_LIFETIME=timedelta(days=14),
)
app.json.sort_keys = False


# ---------------------------------------------------------------------------
# Database helpers
# ---------------------------------------------------------------------------
SCHEMA = """
CREATE TABLE IF NOT EXISTS products (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    product_id  TEXT    NOT NULL UNIQUE,
    name        TEXT    NOT NULL CHECK (length(trim(name)) > 0),
    category    TEXT    NOT NULL CHECK (length(trim(category)) > 0),
    quantity    INTEGER NOT NULL DEFAULT 0 CHECK (quantity >= 0),
    price       REAL    NOT NULL DEFAULT 0 CHECK (price >= 0),
    created_at  TEXT    NOT NULL,
    updated_at  TEXT    NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_products_name     ON products (name);
CREATE INDEX IF NOT EXISTS idx_products_category ON products (category);

CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
"""


def utc_now():
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def get_db():
    """One SQLite connection per request, closed automatically afterwards."""
    if "db" not in g:
        g.db = sqlite3.connect(app.config["DATABASE"])
        g.db.row_factory = sqlite3.Row
    return g.db


@app.teardown_appcontext
def close_db(_exc):
    db = g.pop("db", None)
    if db is not None:
        db.close()


def init_db():
    """Create tables and default settings. Safe to call repeatedly."""
    with closing(sqlite3.connect(app.config["DATABASE"])) as conn:
        conn.executescript(SCHEMA)
        conn.executemany(
            "INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)",
            [(key, str(value)) for key, value in DEFAULT_SETTINGS.items()],
        )
        conn.commit()


def get_settings(db):
    stored = {
        row["key"]: row["value"]
        for row in db.execute("SELECT key, value FROM settings").fetchall()
    }
    settings = dict(DEFAULT_SETTINGS)
    settings.update({k: v for k, v in stored.items() if k in DEFAULT_SETTINGS})
    try:
        settings["low_stock_threshold"] = int(settings["low_stock_threshold"])
    except (TypeError, ValueError):
        settings["low_stock_threshold"] = DEFAULT_SETTINGS["low_stock_threshold"]
    return settings


def stock_status(quantity, threshold):
    if quantity <= 0:
        return "out_of_stock"
    if quantity <= threshold:
        return "low_stock"
    return "in_stock"


def serialize_product(row, threshold):
    return {
        "id": row["id"],
        "product_id": row["product_id"],
        "name": row["name"],
        "category": row["category"],
        "quantity": row["quantity"],
        "price": row["price"],
        "status": stock_status(row["quantity"], threshold),
        "created_at": row["created_at"],
        "updated_at": row["updated_at"],
    }


# ---------------------------------------------------------------------------
# Errors and auth
# ---------------------------------------------------------------------------
class ApiError(Exception):
    """Raised by routes to return a JSON error with a proper status code."""

    def __init__(self, message, status=400, fields=None):
        super().__init__(message)
        self.message = message
        self.status = status
        self.fields = fields or {}


HTTP_MESSAGES = {
    400: "Bad request.",
    404: "Resource not found.",
    405: "Method not allowed for this endpoint.",
}


@app.errorhandler(ApiError)
def handle_api_error(err):
    body = {"error": err.message}
    if err.fields:
        body["fields"] = err.fields
    return jsonify(body), err.status


@app.errorhandler(HTTPException)
def handle_http_error(err):
    if request.path.startswith("/api/"):
        return jsonify(error=HTTP_MESSAGES.get(err.code, err.name)), err.code
    return err


@app.errorhandler(Exception)
def handle_unexpected_error(err):
    app.logger.exception("Unhandled error: %s", err)
    if request.path.startswith("/api/"):
        return jsonify(error="Something went wrong on the server. Please try again."), 500
    return "Internal server error", 500


def login_required(view):
    @wraps(view)
    def wrapper(*args, **kwargs):
        if not session.get("user"):
            if request.path.startswith("/api/"):
                return jsonify(error="Authentication required."), 401
            return redirect(url_for("login_page"))
        return view(*args, **kwargs)

    return wrapper


@app.after_request
def add_security_headers(response):
    response.headers.setdefault("X-Content-Type-Options", "nosniff")
    response.headers.setdefault("X-Frame-Options", "DENY")
    response.headers.setdefault("Referrer-Policy", "same-origin")
    if request.path.startswith("/api/") or request.path in ("/dashboard", "/login"):
        response.headers["Cache-Control"] = "no-store"
    return response


# ---------------------------------------------------------------------------
# Validation helpers
# ---------------------------------------------------------------------------
def json_body():
    data = request.get_json(silent=True)
    if not isinstance(data, dict):
        raise ApiError("Request body must be a JSON object.", 400)
    return data


def parse_int(value):
    """Return an int for ints / whole floats / integer strings, else None."""
    if isinstance(value, bool):
        return None
    if isinstance(value, int):
        return value
    if isinstance(value, float) and value.is_integer():
        return int(value)
    if isinstance(value, str) and re.fullmatch(r"-?\d+", value.strip()):
        return int(value.strip())
    return None


def parse_decimal(value):
    """Return a finite Decimal for numbers / numeric strings, else None."""
    if isinstance(value, bool) or not isinstance(value, (int, float, str)):
        return None
    try:
        number = Decimal(str(value).strip())
    except InvalidOperation:
        return None
    return number if number.is_finite() else None


def clean_text(data, field, label, max_len, errors, clean):
    raw = data.get(field)
    if raw is None:
        errors[field] = f"{label} is required."
        return
    if not isinstance(raw, str):
        errors[field] = f"{label} must be text."
        return
    text = " ".join(raw.split())  # trim and collapse inner whitespace
    if not text:
        errors[field] = f"{label} cannot be empty."
    elif len(text) > max_len:
        errors[field] = f"{label} cannot be longer than {max_len} characters."
    else:
        clean[field] = text


def validate_product(data, creating):
    """Validate a product payload. On update only supplied fields are checked."""
    errors, clean = {}, {}

    if creating:
        raw_id = data.get("product_id")
        product_id = raw_id.strip() if isinstance(raw_id, str) else ""
        if not product_id:
            errors["product_id"] = "Product ID is required."
        elif not PRODUCT_ID_RE.match(product_id):
            errors["product_id"] = (
                "Product ID must be 2-20 characters: letters, numbers, hyphen or underscore."
            )
        else:
            clean["product_id"] = product_id.upper()

    if creating or "name" in data:
        clean_text(data, "name", "Product name", 100, errors, clean)
    if creating or "category" in data:
        clean_text(data, "category", "Category", 50, errors, clean)

    if creating or "quantity" in data:
        raw = data.get("quantity")
        if raw is None or (isinstance(raw, str) and not raw.strip()):
            errors["quantity"] = "Quantity is required."
        else:
            quantity = parse_int(raw)
            if quantity is None:
                errors["quantity"] = "Quantity must be a whole number."
            elif quantity < 0:
                errors["quantity"] = "Quantity cannot be negative."
            elif quantity > MAX_QUANTITY:
                errors["quantity"] = f"Quantity cannot exceed {MAX_QUANTITY:,}."
            else:
                clean["quantity"] = quantity

    if creating or "price" in data:
        raw = data.get("price")
        if raw is None or (isinstance(raw, str) and not raw.strip()):
            errors["price"] = "Price is required."
        else:
            price = parse_decimal(raw)
            if price is None:
                errors["price"] = "Price must be a valid number."
            elif price < 0:
                errors["price"] = "Price cannot be negative."
            elif price > MAX_PRICE:
                errors["price"] = f"Price cannot exceed {MAX_PRICE:,}."
            elif price.as_tuple().exponent < -2:
                errors["price"] = "Price can have at most 2 decimal places."
            else:
                clean["price"] = float(price)

    return clean, errors


def canonical_category(db, category):
    """Reuse the existing spelling of a category (case-insensitive match)."""
    row = db.execute(
        "SELECT category FROM products WHERE category = ? COLLATE NOCASE LIMIT 1",
        (category,),
    ).fetchone()
    return row["category"] if row else category


def escape_like(text):
    return text.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")


# ---------------------------------------------------------------------------
# Pages
# ---------------------------------------------------------------------------
@app.get("/")
def index():
    return redirect(url_for("dashboard" if session.get("user") else "login_page"))


@app.get("/login")
def login_page():
    if session.get("user"):
        return redirect(url_for("dashboard"))
    return render_template("login.html", app_name=get_settings(get_db())["app_name"])


@app.get("/dashboard")
@login_required
def dashboard():
    return render_template("index.html", app_name=get_settings(get_db())["app_name"])


@app.get("/logout")
def logout():
    session.clear()
    return redirect(url_for("login_page"))


# ---------------------------------------------------------------------------
# Auth API
# ---------------------------------------------------------------------------
@app.post("/api/login")
def api_login():
    data = json_body()
    email = str(data.get("email") or "").strip().lower()
    password = str(data.get("password") or "")

    errors = {}
    if not email:
        errors["email"] = "Enter your email address."
    elif not EMAIL_RE.match(email):
        errors["email"] = "Enter a valid email address."
    if not password:
        errors["password"] = "Enter your password."
    if errors:
        raise ApiError("Please fix the highlighted fields.", 400, errors)

    email_ok = secrets.compare_digest(email, ADMIN_EMAIL)
    password_ok = check_password_hash(ADMIN_PASSWORD_HASH, password)
    if not (email_ok and password_ok):
        raise ApiError("Incorrect email or password.", 401)

    session.clear()
    session["user"] = ADMIN_EMAIL
    session.permanent = bool(data.get("remember"))  # "Remember me"
    return jsonify(message="Signed in.", redirect=url_for("dashboard"))


# ---------------------------------------------------------------------------
# Products API
# ---------------------------------------------------------------------------
@app.get("/api/products")
@login_required
def list_products():
    """List products. Query: q, category, status, sort, order."""
    db = get_db()
    threshold = get_settings(db)["low_stock_threshold"]

    q = request.args.get("q", "").strip()
    category = request.args.get("category", "").strip()
    status = request.args.get("status", "").strip()
    sort = request.args.get("sort", "product_id")
    order = request.args.get("order", "asc").lower()

    if sort not in SORT_COLUMNS:
        raise ApiError(f"Cannot sort by '{sort}'.", 400)
    if order not in ("asc", "desc"):
        raise ApiError("Order must be 'asc' or 'desc'.", 400)
    if status and status not in STATUSES:
        raise ApiError(f"Status must be one of: {', '.join(STATUSES)}.", 400)

    clauses, params = [], []
    if q:
        pattern = f"%{escape_like(q)}%"
        clauses.append(
            "(product_id LIKE ? ESCAPE '\\' OR name LIKE ? ESCAPE '\\' "
            "OR category LIKE ? ESCAPE '\\')"
        )
        params.extend([pattern] * 3)
    if category:
        clauses.append("category = ? COLLATE NOCASE")
        params.append(category)
    if status == "in_stock":
        clauses.append("quantity > ?")
        params.append(threshold)
    elif status == "low_stock":
        clauses.append("quantity BETWEEN 1 AND ?")
        params.append(threshold)
    elif status == "out_of_stock":
        clauses.append("quantity = 0")

    where = f" WHERE {' AND '.join(clauses)}" if clauses else ""
    # `where` is built from fixed fragments above and `ORDER BY` from the
    # whitelist; every user-supplied value is passed as a bound parameter.
    sql = (
        f"SELECT * FROM products{where} "
        f"ORDER BY {SORT_COLUMNS[sort]} {order.upper()}, id ASC"
    )
    rows = db.execute(sql, params).fetchall()
    products = [serialize_product(row, threshold) for row in rows]
    return jsonify(count=len(products), threshold=threshold, products=products)


@app.get("/api/products/<int:pk>")
@login_required
def get_product(pk):
    db = get_db()
    row = db.execute("SELECT * FROM products WHERE id = ?", (pk,)).fetchone()
    if row is None:
        raise ApiError("Product not found.", 404)
    return jsonify(product=serialize_product(row, get_settings(db)["low_stock_threshold"]))


@app.post("/api/products")
@login_required
def create_product():
    data = json_body()
    clean, errors = validate_product(data, creating=True)
    if errors:
        raise ApiError("Please fix the highlighted fields.", 400, errors)

    db = get_db()
    duplicate_msg = f"Product ID '{clean['product_id']}' already exists."
    exists = db.execute(
        "SELECT 1 FROM products WHERE product_id = ? COLLATE NOCASE",
        (clean["product_id"],),
    ).fetchone()
    if exists:
        raise ApiError(duplicate_msg, 409, {"product_id": duplicate_msg})

    clean["category"] = canonical_category(db, clean["category"])
    now = utc_now()
    try:
        cursor = db.execute(
            "INSERT INTO products (product_id, name, category, quantity, price, created_at, updated_at) "
            "VALUES (?, ?, ?, ?, ?, ?, ?)",
            (
                clean["product_id"],
                clean["name"],
                clean["category"],
                clean["quantity"],
                clean["price"],
                now,
                now,
            ),
        )
        db.commit()
    except sqlite3.IntegrityError:  # race condition safety net (UNIQUE constraint)
        raise ApiError(duplicate_msg, 409, {"product_id": duplicate_msg})

    row = db.execute("SELECT * FROM products WHERE id = ?", (cursor.lastrowid,)).fetchone()
    product = serialize_product(row, get_settings(db)["low_stock_threshold"])
    response = jsonify(message=f"{product['name']} was added.", product=product)
    response.status_code = 201
    response.headers["Location"] = url_for("get_product", pk=product["id"])
    return response


@app.put("/api/products/<int:pk>")
@login_required
def update_product(pk):
    data = json_body()
    db = get_db()
    row = db.execute("SELECT * FROM products WHERE id = ?", (pk,)).fetchone()
    if row is None:
        raise ApiError("Product not found.", 404)

    # The Product ID is fixed after creation.
    if "product_id" in data and str(data["product_id"]).strip().upper() != row["product_id"]:
        msg = "Product ID cannot be changed after creation."
        raise ApiError(msg, 400, {"product_id": msg})

    clean, errors = validate_product(data, creating=False)
    if errors:
        raise ApiError("Please fix the highlighted fields.", 400, errors)
    if not clean:
        raise ApiError("Provide at least one of: name, category, quantity, price.", 400)

    if "category" in clean:
        clean["category"] = canonical_category(db, clean["category"])

    # Column names come from validate_product (fixed set), values are bound.
    assignments = ", ".join(f"{column} = ?" for column in clean)
    db.execute(
        f"UPDATE products SET {assignments}, updated_at = ? WHERE id = ?",
        [*clean.values(), utc_now(), pk],
    )
    db.commit()

    row = db.execute("SELECT * FROM products WHERE id = ?", (pk,)).fetchone()
    product = serialize_product(row, get_settings(db)["low_stock_threshold"])
    return jsonify(message=f"{product['name']} was updated.", product=product)


@app.delete("/api/products/<int:pk>")
@login_required
def delete_product(pk):
    db = get_db()
    row = db.execute("SELECT * FROM products WHERE id = ?", (pk,)).fetchone()
    if row is None:
        raise ApiError("Product not found.", 404)
    product = serialize_product(row, get_settings(db)["low_stock_threshold"])
    db.execute("DELETE FROM products WHERE id = ?", (pk,))
    db.commit()
    return jsonify(message=f"{product['name']} was deleted.", product=product)


# ---------------------------------------------------------------------------
# Statistics, alerts, export
# ---------------------------------------------------------------------------
@app.get("/api/stats")
@login_required
def get_stats():
    db = get_db()
    threshold = get_settings(db)["low_stock_threshold"]
    totals = db.execute(
        """
        SELECT COUNT(*)                                              AS total_products,
               COALESCE(SUM(quantity), 0)                            AS total_units,
               COALESCE(SUM(quantity * price), 0)                    AS inventory_value,
               COALESCE(SUM(quantity BETWEEN 1 AND ?), 0)            AS low_stock,
               COALESCE(SUM(quantity = 0), 0)                        AS out_of_stock
        FROM products
        """,
        (threshold,),
    ).fetchone()
    categories = db.execute(
        """
        SELECT category,
               COUNT(*)                          AS count,
               COALESCE(SUM(quantity), 0)        AS units,
               COALESCE(SUM(quantity * price), 0) AS value
        FROM products
        GROUP BY category COLLATE NOCASE
        ORDER BY count DESC, category COLLATE NOCASE
        """
    ).fetchall()

    total = totals["total_products"]
    low, out = totals["low_stock"], totals["out_of_stock"]
    return jsonify(
        total_products=total,
        total_units=totals["total_units"],
        inventory_value=round(totals["inventory_value"], 2),
        low_stock=low,
        out_of_stock=out,
        in_stock=total - low - out,
        threshold=threshold,
        categories=[
            {
                "category": row["category"],
                "count": row["count"],
                "units": row["units"],
                "value": round(row["value"], 2),
            }
            for row in categories
        ],
    )


@app.get("/api/alerts")
@login_required
def get_alerts():
    """Products that are low on stock or sold out (out of stock first)."""
    db = get_db()
    threshold = get_settings(db)["low_stock_threshold"]
    rows = db.execute(
        "SELECT * FROM products WHERE quantity <= ? "
        "ORDER BY quantity ASC, name COLLATE NOCASE ASC",
        (threshold,),
    ).fetchall()
    alerts = [serialize_product(row, threshold) for row in rows]
    return jsonify(
        threshold=threshold,
        count=len(alerts),
        out_of_stock=sum(1 for a in alerts if a["status"] == "out_of_stock"),
        low_stock=sum(1 for a in alerts if a["status"] == "low_stock"),
        alerts=alerts,
    )


def csv_safe(value):
    """Neutralise spreadsheet formulas (CSV injection) in text cells."""
    if isinstance(value, str) and value[:1] in ("=", "+", "-", "@", "\t", "\r"):
        return "'" + value
    return value


@app.get("/api/export.csv")
@login_required
def export_csv():
    db = get_db()
    threshold = get_settings(db)["low_stock_threshold"]
    rows = db.execute("SELECT * FROM products ORDER BY product_id COLLATE NOCASE").fetchall()

    buffer = io.StringIO()
    writer = csv.writer(buffer)
    writer.writerow(["Product ID", "Product Name", "Category", "Quantity", "Price", "Status"])
    for row in rows:
        status = STATUS_LABELS[stock_status(row["quantity"], threshold)]
        writer.writerow(
            [
                csv_safe(row["product_id"]),
                csv_safe(row["name"]),
                csv_safe(row["category"]),
                row["quantity"],
                f"{row['price']:.2f}",
                status,
            ]
        )

    filename = f"stockflow_inventory_{datetime.now().strftime('%Y%m%d')}.csv"
    # BOM so Excel opens UTF-8 text correctly.
    payload = ("\ufeff" + buffer.getvalue()).encode("utf-8")
    return Response(
        payload,
        mimetype="text/csv",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


# ---------------------------------------------------------------------------
# Settings API
# ---------------------------------------------------------------------------
@app.get("/api/settings")
@login_required
def read_settings():
    settings = get_settings(get_db())
    settings["admin_email"] = session.get("user", ADMIN_EMAIL)
    settings["currencies"] = list(ALLOWED_CURRENCIES)
    return jsonify(settings)


@app.put("/api/settings")
@login_required
def update_settings():
    data = json_body()
    errors, clean = {}, {}

    if "app_name" in data:
        clean_text(data, "app_name", "Application name", 40, errors, clean)
    if "admin_name" in data:
        clean_text(data, "admin_name", "Admin name", 60, errors, clean)
    if "currency" in data:
        if data["currency"] in ALLOWED_CURRENCIES:
            clean["currency"] = data["currency"]
        else:
            errors["currency"] = f"Currency must be one of: {', '.join(ALLOWED_CURRENCIES)}."
    if "low_stock_threshold" in data:
        threshold = parse_int(data["low_stock_threshold"])
        if threshold is None:
            errors["low_stock_threshold"] = "Threshold must be a whole number."
        elif not 1 <= threshold <= 1000:
            errors["low_stock_threshold"] = "Threshold must be between 1 and 1000."
        else:
            clean["low_stock_threshold"] = threshold

    if errors:
        raise ApiError("Please fix the highlighted fields.", 400, errors)
    if not clean:
        raise ApiError("No valid settings were provided.", 400)

    db = get_db()
    db.executemany(
        "INSERT INTO settings (key, value) VALUES (?, ?) "
        "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        [(key, str(value)) for key, value in clean.items()],
    )
    db.commit()

    settings = get_settings(db)
    settings["admin_email"] = session.get("user", ADMIN_EMAIL)
    settings["currencies"] = list(ALLOWED_CURRENCIES)
    return jsonify(message="Settings saved.", **settings)


# Create the database and tables automatically on first start.
init_db()

if __name__ == "__main__":
    # Debug mode gives auto-reload while developing. It only listens on
    # localhost; set FLASK_DEBUG=0 to turn it off.
    app.run(
        host="127.0.0.1",
        port=5000,
        debug=os.environ.get("FLASK_DEBUG", "1") == "1",
    )
