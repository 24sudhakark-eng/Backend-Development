"""Load demo inventory into StockFlow.

Usage:
    python sample_data.py            # add sample products (existing IDs are skipped)
    python sample_data.py --reset    # delete ALL products first, then add samples
"""

import argparse
import sqlite3
from contextlib import closing

from app import app, init_db, utc_now

# (product_id, name, category, quantity, price)
SAMPLE_PRODUCTS = [
    ("P1001", "HP Laptop", "Computers", 18, 54999.00),
    ("P1002", "Logitech Keyboard", "Accessories", 42, 1899.00),
    ("P1003", "Dell Monitor", "Monitors", 4, 12499.00),            # low stock
    ("P1004", "Wireless Mouse", "Accessories", 0, 799.00),         # out of stock
    ("P1005", "Samsung SSD", "Storage", 27, 6299.00),
    ("P1006", "Canon Printer", "Printers", 3, 8999.00),            # low stock
    ("P1007", "USB Hub", "Accessories", 56, 649.00),
    ("P1008", "Mechanical Keyboard", "Accessories", 14, 3499.00),
    ("P1009", "Webcam", "Accessories", 5, 2299.00),                # low stock (boundary)
    ("P1010", "External Hard Drive", "Storage", 9, 4799.00),
    ("P1011", "Network Router", "Networking", 11, 2199.00),
    ("P1012", "Printer Ink Cartridge", "Printers", 0, 1299.00),    # out of stock
]


def main():
    parser = argparse.ArgumentParser(description="Load sample StockFlow data.")
    parser.add_argument("--reset", action="store_true", help="delete all products first")
    args = parser.parse_args()

    init_db()  # make sure the tables exist
    now = utc_now()
    with closing(sqlite3.connect(app.config["DATABASE"])) as conn:
        if args.reset:
            conn.execute("DELETE FROM products")
            print("Removed existing products.")
        added = 0
        for product_id, name, category, quantity, price in SAMPLE_PRODUCTS:
            cursor = conn.execute(
                "INSERT OR IGNORE INTO products "
                "(product_id, name, category, quantity, price, created_at, updated_at) "
                "VALUES (?, ?, ?, ?, ?, ?, ?)",
                (product_id, name, category, quantity, price, now, now),
            )
            added += cursor.rowcount
        conn.commit()
    skipped = len(SAMPLE_PRODUCTS) - added
    print(f"Added {added} sample products ({skipped} already existed).")
    print(f"Database: {app.config['DATABASE']}")


if __name__ == "__main__":
    main()
