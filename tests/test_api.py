"""API tests (standard library only).  Run from the project root:

    python -m unittest discover -s tests -v
"""

import os
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from app import ADMIN_EMAIL, app, init_db  # noqa: E402

PRODUCT = {
    "product_id": "P2001",
    "name": "Dell Monitor",
    "category": "Monitors",
    "quantity": 4,
    "price": 12499,
}


class ApiTestCase(unittest.TestCase):
    def setUp(self):
        handle, self.db_path = tempfile.mkstemp(suffix=".db")
        os.close(handle)
        app.config.update(TESTING=True, DATABASE=self.db_path)
        init_db()
        self.client = app.test_client()
        response = self.client.post(
            "/api/login", json={"email": ADMIN_EMAIL, "password": "admin123"}
        )
        self.assertEqual(response.status_code, 200)

    def tearDown(self):
        os.remove(self.db_path)

    def add(self, **overrides):
        return self.client.post("/api/products", json={**PRODUCT, **overrides})

    # --- authentication -------------------------------------------------
    def test_api_requires_login(self):
        anonymous = app.test_client()
        self.assertEqual(anonymous.get("/api/products").status_code, 401)
        self.assertEqual(anonymous.get("/dashboard").status_code, 302)

    def test_wrong_password_rejected(self):
        response = app.test_client().post(
            "/api/login", json={"email": ADMIN_EMAIL, "password": "nope"}
        )
        self.assertEqual(response.status_code, 401)

    # --- create ---------------------------------------------------------
    def test_create_product(self):
        response = self.add()
        self.assertEqual(response.status_code, 201)
        product = response.get_json()["product"]
        self.assertEqual(product["status"], "low_stock")
        self.assertEqual(product["product_id"], "P2001")

    def test_duplicate_product_id_rejected(self):
        self.add()
        response = self.add(product_id="p2001", name="Other")
        self.assertEqual(response.status_code, 409)
        self.assertIn("product_id", response.get_json()["fields"])

    def test_negative_quantity_and_price_rejected(self):
        bad_qty = self.add(quantity=-1)
        bad_price = self.add(price=-0.5)
        self.assertEqual(bad_qty.status_code, 400)
        self.assertIn("quantity", bad_qty.get_json()["fields"])
        self.assertEqual(bad_price.status_code, 400)
        self.assertIn("price", bad_price.get_json()["fields"])

    def test_required_fields_and_types(self):
        response = self.client.post("/api/products", json={})
        self.assertEqual(response.status_code, 400)
        self.assertEqual(
            set(response.get_json()["fields"]),
            {"product_id", "name", "category", "quantity", "price"},
        )
        self.assertEqual(self.add(quantity=2.5).status_code, 400)
        self.assertEqual(self.add(name="   ").status_code, 400)
        self.assertEqual(self.add(price="abc").status_code, 400)

    def test_invalid_json_body(self):
        response = self.client.post(
            "/api/products", data="not json", content_type="application/json"
        )
        self.assertEqual(response.status_code, 400)

    # --- update / delete ------------------------------------------------
    def test_update_stock_and_price(self):
        pk = self.add().get_json()["product"]["id"]
        response = self.client.put(f"/api/products/{pk}", json={"quantity": 0, "price": 99.5})
        self.assertEqual(response.status_code, 200)
        product = response.get_json()["product"]
        self.assertEqual((product["quantity"], product["price"]), (0, 99.5))
        self.assertEqual(product["status"], "out_of_stock")

    def test_cannot_reduce_stock_below_zero(self):
        pk = self.add().get_json()["product"]["id"]
        response = self.client.put(f"/api/products/{pk}", json={"quantity": -3})
        self.assertEqual(response.status_code, 400)

    def test_product_id_is_immutable(self):
        pk = self.add().get_json()["product"]["id"]
        response = self.client.put(f"/api/products/{pk}", json={"product_id": "P9999"})
        self.assertEqual(response.status_code, 400)

    def test_update_and_delete_missing_product(self):
        self.assertEqual(self.client.put("/api/products/999", json={"quantity": 1}).status_code, 404)
        self.assertEqual(self.client.delete("/api/products/999").status_code, 404)

    def test_delete_product(self):
        pk = self.add().get_json()["product"]["id"]
        self.assertEqual(self.client.delete(f"/api/products/{pk}").status_code, 200)
        self.assertEqual(self.client.get(f"/api/products/{pk}").status_code, 404)

    # --- search ---------------------------------------------------------
    def test_search_by_id_name_and_category(self):
        self.add()
        self.add(product_id="P2002", name="Wireless Mouse", category="Accessories", quantity=20)
        for query, expected in (("p2002", 1), ("monitor", 1), ("accessor", 1), ("P20", 2)):
            data = self.client.get(f"/api/products?q={query}").get_json()
            self.assertEqual(data["count"], expected, query)

    def test_search_no_match_and_special_characters(self):
        self.add()
        self.assertEqual(self.client.get("/api/products?q=zzz").get_json()["count"], 0)
        for tricky in ("%", "_", "' OR 1=1 --", "\\"):
            response = self.client.get("/api/products", query_string={"q": tricky})
            self.assertEqual(response.status_code, 200)
            self.assertEqual(response.get_json()["count"], 0, tricky)

    def test_status_filter_and_bad_params(self):
        self.add()
        self.add(product_id="P2002", name="Mouse", quantity=0)
        low = self.client.get("/api/products?status=low_stock").get_json()
        self.assertEqual([p["product_id"] for p in low["products"]], ["P2001"])
        self.assertEqual(self.client.get("/api/products?status=bogus").status_code, 400)
        self.assertEqual(self.client.get("/api/products?sort=id;DROP").status_code, 400)

    # --- statistics and alerts ------------------------------------------
    def test_stats_and_alerts(self):
        self.add(quantity=4, price=100)                                   # low
        self.add(product_id="P2002", name="Mouse", quantity=0, price=50)  # out
        self.add(product_id="P2003", name="Laptop", quantity=10, price=1000)
        stats = self.client.get("/api/stats").get_json()
        self.assertEqual(stats["total_products"], 3)
        self.assertEqual(stats["total_units"], 14)
        self.assertEqual(stats["inventory_value"], 10400.0)
        self.assertEqual((stats["low_stock"], stats["out_of_stock"], stats["in_stock"]), (1, 1, 1))

        alerts = self.client.get("/api/alerts").get_json()
        self.assertEqual([a["status"] for a in alerts["alerts"]], ["out_of_stock", "low_stock"])

    def test_threshold_setting_changes_status(self):
        self.add(quantity=8)
        self.assertEqual(self.client.get("/api/alerts").get_json()["count"], 0)
        response = self.client.put("/api/settings", json={"low_stock_threshold": 10})
        self.assertEqual(response.status_code, 200)
        self.assertEqual(self.client.get("/api/alerts").get_json()["count"], 1)
        self.assertEqual(
            self.client.put("/api/settings", json={"low_stock_threshold": 0}).status_code, 400
        )

    # --- export ---------------------------------------------------------
    def test_csv_export(self):
        self.add(name="=HYPERLINK(1)")
        response = self.client.get("/api/export.csv")
        self.assertEqual(response.status_code, 200)
        text = response.data.decode("utf-8-sig")
        self.assertTrue(text.startswith("Product ID,Product Name,Category,Quantity,Price,Status"))
        self.assertIn("'=HYPERLINK(1)", text)
        self.assertIn("Low Stock", text)


if __name__ == "__main__":
    unittest.main()
