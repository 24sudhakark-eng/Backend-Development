# StockFlow – Inventory / Product Management System

A full-stack web application for tracking products and stock levels. It has a
sign-in page, an admin dashboard with live statistics and charts, low-stock
alerts, reports with CSV export, and a settings page. The browser talks to a
Flask REST API over the Fetch API, so every change appears on screen without a
page reload.

Built as a Web Development mini project (Aim 6 – Inventory / Product
Management System).

## Aim

To design and develop an Inventory Management System web application that
enables users to add, search, update stock and price, and delete product
records, using HTML, CSS and JavaScript on the client side, Python Flask as the
backend server, and SQLite as the database, demonstrating full-stack CRUD
operations relevant to inventory tracking.

## Objectives

- Design a responsive interface for entering and viewing product details (Product ID, Name, Category, Quantity, Price).
- Build Flask REST API endpoints to add, list, search, update and delete products.
- Design an SQLite schema that stores product data and application settings.
- Connect the frontend and backend with HTTP requests (GET, POST, PUT, DELETE) and JSON.
- Validate inputs on both the client and the server: required fields, unique Product ID, non-negative quantity and price.
- Show low-stock alerts, statistics, charts and search results dynamically with the Fetch API, without reloading the page.
- Test edge cases such as searching for a product that does not exist and reducing stock below zero.

## Features

- **Login** with a demo account, show/hide password and "Remember me".
- **Dashboard** with four live statistics cards (Total Products, Total Units, Inventory Value, Low Stock Items) calculated by SQL queries.
- **Stock overview** doughnut chart (In Stock / Low Stock / Out of Stock) fed by `/api/stats`.
- **Stock alerts** panel and page; updates automatically after every change. Sidebar and bell badges show how many products need attention.
- **Products table** with status badges, stock meter, sortable columns, category and status filters.
- **Search** by Product ID, name or category (type in the top search box or press `/`).
- **Add / edit product** in a modal with inline validation. The Product ID is fixed after creation.
- **Delete product** with a confirmation dialog.
- **Quick restock** button on every alert.
- **Reports** page: inventory value, product counts, low/out-of-stock counts, products-by-category chart and table, **Export CSV**.
- **Settings**: application name, low-stock threshold (default 5), currency (INR, USD, EUR, GBP), admin display name.
- Toast notifications, loading skeletons, empty states, error states with retry, modal animations (reduced-motion friendly).
- Responsive layout: the sidebar becomes a slide-in drawer on tablets and phones, and the product table becomes stacked cards on small screens.

### Stock status rules

| Quantity | Status |
|---|---|
| greater than the threshold (default 5) | In Stock |
| 1 up to the threshold | Low Stock |
| 0 | Out of Stock |

## Technology stack

| Layer | Technology |
|---|---|
| Frontend | HTML5, CSS3, JavaScript (ES2020), Fetch API, Chart.js (CDN) |
| Backend | Python 3, Flask, RESTful JSON API |
| Database | SQLite (Python `sqlite3`, parameterized queries) |
| Testing | Python `unittest` (standard library) |

The frontend needs no build step, so Node.js is not required to run the project.

## System requirements

- Python 3.9 or newer
- pip
- A modern browser (Chrome, Edge, Firefox, Safari)
- Internet access for the first page load is recommended: it loads Chart.js and the IBM Plex Sans font from a CDN. Without internet the app still works, but charts are hidden and the system font is used.

## Project structure

```
StockFlow/
├── app.py                  Flask app: pages, REST API, validation, SQLite access
├── sample_data.py          Loads 12 demo products
├── requirements.txt        Python dependency (Flask)
├── README.md
├── inventory.db            SQLite database (created automatically if missing)
├── templates/
│   ├── login.html          Sign-in page
│   └── index.html          Dashboard (all views, dialogs, icon sprite)
├── static/
│   ├── css/style.css       All styling, tokens and responsive rules
│   ├── js/script.js        Dashboard logic (Fetch API, rendering, charts, dialogs)
│   ├── js/login.js         Login page logic
│   └── assets/logo.svg     Logo and favicon
└── tests/test_api.py       API tests
```

## Database schema

```sql
CREATE TABLE products (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    product_id  TEXT    NOT NULL UNIQUE,
    name        TEXT    NOT NULL CHECK (length(trim(name)) > 0),
    category    TEXT    NOT NULL CHECK (length(trim(category)) > 0),
    quantity    INTEGER NOT NULL DEFAULT 0 CHECK (quantity >= 0),
    price       REAL    NOT NULL DEFAULT 0 CHECK (price >= 0),
    created_at  TEXT    NOT NULL,
    updated_at  TEXT    NOT NULL
);

CREATE TABLE settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
);   -- app_name, low_stock_threshold, currency, admin_name
```

The database enforces the main rules a second time: unique `product_id`, and
`CHECK` constraints that reject negative quantity or price.

## API endpoints

All `/api/*` endpoints except `POST /api/login` require a signed-in session and return JSON
(`401` when signed out). Errors look like `{"error": "message", "fields": {"quantity": "..."}}`.

| Method | Endpoint | Description | Success | Errors |
|---|---|---|---|---|
| POST | `/api/login` | Sign in `{email, password, remember}` | 200 | 400, 401 |
| GET | `/api/products` | List products. Optional `q`, `category`, `status`, `sort`, `order` | 200 | 400 |
| GET | `/api/products?q=monitor` | Search by Product ID, name or category | 200 | |
| GET | `/api/products/<id>` | One product | 200 | 404 |
| POST | `/api/products` | Add `{product_id, name, category, quantity, price}` | 201 | 400, 409 |
| PUT | `/api/products/<id>` | Update name, category, quantity and/or price | 200 | 400, 404 |
| DELETE | `/api/products/<id>` | Delete a product | 200 | 404 |
| GET | `/api/stats` | Totals, units, inventory value, low/out of stock, category breakdown | 200 | |
| GET | `/api/alerts` | Low-stock and out-of-stock products | 200 | |
| GET | `/api/export.csv` | CSV: Product ID, Product Name, Category, Quantity, Price, Status | 200 | |
| GET | `/api/settings` | Read settings | 200 | |
| PUT | `/api/settings` | Update settings | 200 | 400 |

`<id>` is the numeric database `id`. Unexpected server problems return `500` with a generic JSON message.

Example:

```bash
# After signing in with a browser session, or using curl with a cookie jar:
curl -c jar.txt -H "Content-Type: application/json" \
     -d '{"email":"admin@stockflow.com","password":"admin123"}' http://127.0.0.1:5000/api/login
curl -b jar.txt "http://127.0.0.1:5000/api/products?q=monitor"
```

## Installation

Open a terminal in the `StockFlow` folder.

```bash
python -m venv venv
```

Activate the virtual environment:

- Windows: `venv\Scripts\activate`
- macOS / Linux: `source venv/bin/activate`

Install the dependency and start the server:

```bash
pip install -r requirements.txt
python app.py
```

Then open **http://127.0.0.1:5000** in your browser.

The SQLite database and tables are created automatically on first start.

## How to run in VS Code

1. Install the **Python** extension in VS Code.
2. Choose **File → Open Folder…** and select the `StockFlow` folder.
3. Open a terminal with **Terminal → New Terminal**.
4. Run the commands from the Installation section.
5. If VS Code asks, select the interpreter inside `venv` (**Ctrl+Shift+P → Python: Select Interpreter**).
6. Hold **Ctrl** and click the `http://127.0.0.1:5000` link in the terminal.

Stop the server with **Ctrl+C**.

## Demo login credentials

| Field | Value |
|---|---|
| Email | `admin@stockflow.com` |
| Password | `admin123` |

These are for classroom demonstration only. To use different values, set the
environment variables `STOCKFLOW_ADMIN_EMAIL` and `STOCKFLOW_ADMIN_PASSWORD`
before starting the server. The password is compared using a hash and is never sent back to the browser.

## Sample data

```bash
python sample_data.py            # add 12 demo products (existing Product IDs are skipped)
python sample_data.py --reset    # delete all products first, then add the demo products
```

The sample set includes products that are in stock, low stock (Dell Monitor, Canon Printer, Webcam) and
out of stock (Wireless Mouse, Printer Ink Cartridge), so the alerts and charts have something to show.

## Running the tests

```bash
python -m unittest discover -s tests -v
```

The tests use a temporary database and cover login, validation, duplicate Product IDs, negative values,
search (including special characters), updates, deletion, statistics, alerts, the threshold setting and CSV export.

## How the main features work

- **Dynamic updates:** `script.js` calls the API with `fetch()`, then re-renders only the affected parts of the page. After add, edit, delete or a settings change it runs `refreshAll()`, which reloads statistics, alerts and the product list together, so the cards, chart, alerts and table always agree.
- **Search:** typing in the top search box (debounced by 250 ms) calls `GET /api/products?q=...`. The server matches Product ID, name and category with a parameterized `LIKE` query. A newer search cancels the older request.
- **Validation:** the same rules run in the browser (instant messages) and in Flask (`validate_product`), and SQLite `CHECK`/`UNIQUE` constraints act as a final guard.
- **Low-stock alerts:** the server computes each product's status from its quantity and the saved threshold, so the table, alerts, statistics and CSV always use the same rule.
- **Charts:** Chart.js draws the doughnut and bar charts from `/api/stats`; no chart values are hard-coded.

## Configuration

- Default threshold, currency and names: `DEFAULT_SETTINGS` in `app.py` (used when the database is first created) and `CONFIG` at the top of `static/js/script.js` (used until settings load). After that, change the threshold on the **Settings** page.
- Secret key: set `STOCKFLOW_SECRET_KEY`, or a `.secret_key` file is generated automatically next to `app.py`.
- Turn off debug mode with `FLASK_DEBUG=0`.

## Screenshots

_Add screenshots here before submission._

| Screen | File |
|---|---|
| Login page | `docs/login.png` |
| Dashboard | `docs/dashboard.png` |
| Products | `docs/products.png` |
| Add Product dialog | `docs/add-product.png` |
| Reports | `docs/reports.png` |
| Mobile view | `docs/mobile.png` |

## Future scope

- Multiple users with roles and password hashing in the database
- Stock movement history (stock in / stock out log) and an audit trail
- Suppliers and purchase orders
- Barcode scanning and product images
- Pagination for very large catalogues
- Email notifications for low stock
- Deployment with a production server (Gunicorn / Waitress) and a larger database such as PostgreSQL
