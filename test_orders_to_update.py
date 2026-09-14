"""Non-regressions du compteur Orders to Update multicompte."""
import unittest
from unittest import mock

import mmd_core as core
import mmd_esi as esi
import mmd_esi_orders as esi_orders
import mmd_import as imp
import mmd_price as price
import mmd_stations as stations

try:
    import mmd_gui as gui
except Exception:
    gui = None


STATION_ID = 60003760
JITA_OTHER_STATION_ID = 60003761
JAKANERVA_STATION_ID = 60009999
JITA_SYSTEM_ID = 30000142
JAKANERVA_SYSTEM_ID = 30009999
PERIMETER_STRUCTURE_ID = 990000001
PERIMETER_SYSTEM_ID = 30000144
THE_FORGE = 10000002


def _order(order_id, type_id, char_id, side):
    return {
        "order_id": order_id, "type_id": type_id, "char_id": char_id,
        "char_name": f"Pilot {char_id}", "station_id": STATION_ID,
        "side": side, "price": 100.0, "price_cents": 10_000,
        "vol_remaining": 10, "issued": "2026-08-01T00:00:00Z",
        "range": "station",
    }


def _competitor(order_id, type_id, side):
    return {
        "order_id": order_id, "type_id": type_id,
        "location_id": STATION_ID, "side": side,
        "price": 110.0 if side == 0 else 90.0,
        "vol": 10, "issued": "2026-08-02T00:00:00Z",
        "range": "station",
    }


def _buy(order_id, *, char_id=1, location_id=STATION_ID,
         issued="2026-08-01T00:00:00Z", price_value=100.0):
    row = _order(order_id, 700, char_id, 0)
    row.update(station_id=location_id, issued=issued, price=price_value,
               price_cents=price.to_cents(price_value), range="station")
    return row


def _external_buy(order_id, *, location_id, issued, price_value=100.0):
    return {"order_id": order_id, "type_id": 700, "location_id": location_id,
            "side": 0, "price": price_value, "vol": 1, "range": "station",
            "issued": issued}


class OrdersToUpdateTests(unittest.TestCase):
    def setUp(self):
        from tests_sde_fixture import install
        install(self)
        self._sys_cache = dict(stations._sys_cache)
        self._runtime_structures = dict(getattr(stations, "_runtime_structures", {}))
        stations._sys_cache.clear()
        getattr(stations, "_runtime_structures", {}).clear()

    def tearDown(self):
        stations._sys_cache.clear()
        stations._sys_cache.update(self._sys_cache)
        if hasattr(stations, "_runtime_structures"):
            stations._runtime_structures.clear()
            stations._runtime_structures.update(self._runtime_structures)

    def _buy_scan(self, mine, external):
        def resolve(location_id):
            if int(location_id) in (STATION_ID, PERIMETER_STRUCTURE_ID):
                return (PERIMETER_SYSTEM_ID, THE_FORGE, str(location_id))
            return (None, None, str(location_id))

        def hub_priority(location_id):
            return {STATION_ID: 2, PERIMETER_STRUCTURE_ID: 1}.get(int(location_id), 0)

        with mock.patch.object(stations, "resolve", side_effect=resolve), \
                mock.patch.object(stations, "covers", return_value=True), \
                mock.patch.object(stations, "buy_hub_priority", side_effect=hub_priority):
            return core._scan_core([mine], [external], "buy priority")["orders_full"][0]

    def test_buy_jita_old_beats_perimeter_new_at_same_price(self):
        row = self._buy_scan(
            _buy("mine", location_id=STATION_ID),
            _external_buy("perimeter", location_id=PERIMETER_STRUCTURE_ID,
                          issued="2026-08-02T00:00:00Z"),
        )
        self.assertFalse(row["needs_update"])
        self.assertFalse(row["fifo_overtaken"])

    def test_buy_jita_new_beats_perimeter_old_at_same_price(self):
        row = self._buy_scan(
            _buy("mine", location_id=PERIMETER_STRUCTURE_ID),
            _external_buy("jita", location_id=STATION_ID,
                          issued="2026-08-02T00:00:00Z"),
        )
        self.assertTrue(row["needs_update"])
        self.assertFalse(row["fifo_overtaken"])

    def test_buy_newer_jita_same_price_is_fifo_overtake(self):
        row = self._buy_scan(
            _buy("mine", location_id=STATION_ID),
            _external_buy("jita", location_id=STATION_ID,
                          issued="2026-08-02T00:00:00Z"),
        )
        self.assertTrue(row["needs_update"])
        self.assertTrue(row["fifo_overtaken"])

    def test_buy_newer_perimeter_same_price_is_fifo_overtake(self):
        row = self._buy_scan(
            _buy("mine", location_id=PERIMETER_STRUCTURE_ID),
            _external_buy("perimeter", location_id=PERIMETER_STRUCTURE_ID,
                          issued="2026-08-02T00:00:00Z"),
        )
        self.assertTrue(row["needs_update"])
        self.assertTrue(row["fifo_overtaken"])

    def test_perimeter_structure_competitor_is_detected_and_fast_copy_ticks(self):
        mine = _buy("mine", location_id=PERIMETER_STRUCTURE_ID)
        external = _external_buy("external", location_id=PERIMETER_STRUCTURE_ID,
                                 issued="2026-08-02T00:00:00Z")
        snapshot = {"external": dict(external, station_id=PERIMETER_STRUCTURE_ID)}
        with mock.patch.object(esi_orders, "fetch_all_orders",
                               return_value=([mine], [], [1])), \
                mock.patch.object(esi_orders.sso, "connected_chars",
                                  return_value=[{"id": 1, "name": "Pilot 1"}]), \
                mock.patch.object(esi_orders, "_env_structure_ids",
                                  return_value={PERIMETER_STRUCTURE_ID}), \
                mock.patch.object(esi_orders, "fetch_structure_orders",
                                  return_value=(snapshot, "accessible")), \
                mock.patch.object(esi_orders, "fetch_structure_info",
                                  return_value={"solarSystemID": PERIMETER_SYSTEM_ID,
                                                "name": "Perimeter test structure"}), \
                mock.patch.object(stations, "_region_for_system", return_value=THE_FORGE):
            data = esi_orders.scan_authed(order_books=[])
        row = data["orders_full"][0]
        self.assertTrue(row["needs_update"])
        self.assertEqual(price.to_cents(price.next_price(100.0, 0)),
                         row["new_price_cents"])
        self.assertEqual((PERIMETER_SYSTEM_ID, THE_FORGE,
                          "Perimeter test structure"),
                         stations.resolve(PERIMETER_STRUCTURE_ID))

    def test_only_our_alts_do_not_change_fast_copy_price(self):
        mine = _buy("mine", char_id=1)
        alt = _buy("alt", char_id=2, issued="2026-08-02T00:00:00Z",
                   price_value=101.0)
        data = core._scan_core([mine, alt], [], "alts only")
        row = next(row for row in data["orders_full"] if row["order_id"] == "mine")
        self.assertEqual("COMPETING_ALT", row["status"])
        self.assertEqual(mine["price_cents"], row["new_price_cents"])

    def test_runtime_structure_resolution_keeps_system_and_region(self):
        with mock.patch.object(stations, "_region_for_system", return_value=THE_FORGE):
            stations.register_structure(PERIMETER_STRUCTURE_ID, PERIMETER_SYSTEM_ID,
                                        name="Perimeter test structure")
        self.assertEqual(
            (PERIMETER_SYSTEM_ID, THE_FORGE, "Perimeter test structure"),
            stations.resolve(PERIMETER_STRUCTURE_ID),
        )

    def test_buy_range_one_does_not_make_a_remote_station_order_regional(self):
        """Exact regression: Jita 1 jump must ignore Jakanerva Station at 6 jumps."""
        mine = _buy("mine", location_id=STATION_ID, price_value=8.02)
        mine["range"] = "1"
        external = _external_buy("jakanerva", location_id=JAKANERVA_STATION_ID,
                                 issued="2026-08-02T00:00:00Z", price_value=22.41)
        def resolve(location_id):
            locations = {
                STATION_ID: (JITA_SYSTEM_ID, THE_FORGE, "Jita IV - Moon 4"),
                JAKANERVA_STATION_ID: (JAKANERVA_SYSTEM_ID, THE_FORGE, "Jakanerva"),
            }
            return locations[int(location_id)]
        with mock.patch.object(stations, "resolve", side_effect=resolve), \
                mock.patch.object(stations, "jumps_bfs", return_value={JITA_SYSTEM_ID, PERIMETER_SYSTEM_ID}):
            row = core._scan_core([mine], [external], "range regression")["orders_full"][0]
        self.assertFalse(row["needs_update"])
        self.assertEqual(mine["price_cents"], row["new_price_cents"])

    def test_station_range_covers_only_its_exact_location(self):
        with mock.patch.object(stations, "resolve", return_value=(JITA_SYSTEM_ID, THE_FORGE, "Jita")):
            self.assertTrue(stations.covers(STATION_ID, "station", JITA_SYSTEM_ID, THE_FORGE, STATION_ID))
            self.assertFalse(stations.covers(JITA_OTHER_STATION_ID, "station", JITA_SYSTEM_ID, THE_FORGE, STATION_ID))

    def test_normalize_buy_range_is_conservative_for_missing_and_unknown_values(self):
        self.assertEqual(("STATION", None), stations.normalize_buy_range("station"))
        self.assertEqual(("SYSTEM", None), stations.normalize_buy_range("solar_system"))
        self.assertEqual(("SYSTEM", None), stations.normalize_buy_range("solarsystem"))
        self.assertEqual(("REGION", None), stations.normalize_buy_range("region"))
        self.assertEqual(("JUMPS", 2), stations.normalize_buy_range("2"))
        self.assertIsNone(stations.normalize_buy_range(None))
        self.assertIsNone(stations.normalize_buy_range("mystery-range"))
        with mock.patch.object(stations, "resolve", return_value=(JITA_SYSTEM_ID, THE_FORGE, "Jita")):
            self.assertFalse(stations.covers(STATION_ID, None, JITA_SYSTEM_ID, THE_FORGE, STATION_ID))
            self.assertFalse(stations.covers(STATION_ID, "mystery-range", JITA_SYSTEM_ID, THE_FORGE, STATION_ID))

    def test_buy_range_overlap_respects_station_system_and_jump_topology(self):
        locations = {
            STATION_ID: (JITA_SYSTEM_ID, THE_FORGE, "Jita IV - Moon 4"),
            JITA_OTHER_STATION_ID: (JITA_SYSTEM_ID, THE_FORGE, "Jita other station"),
            PERIMETER_STRUCTURE_ID: (PERIMETER_SYSTEM_ID, THE_FORGE, "Perimeter"),
        }
        def resolve(location_id): return locations[int(location_id)]
        mine = {"station_id": STATION_ID, "range": "station"}
        same_station = {"location_id": STATION_ID, "range": "station"}
        other_jita_station = {"location_id": JITA_OTHER_STATION_ID, "range": "station"}
        jita_system = {"location_id": JITA_OTHER_STATION_ID, "range": "solarsystem"}
        perimeter_one_jump = {"location_id": PERIMETER_STRUCTURE_ID, "range": 1}
        with mock.patch.object(stations, "resolve", side_effect=resolve), \
                mock.patch.object(stations, "jumps_bfs", side_effect=lambda start, depth: {JITA_SYSTEM_ID, PERIMETER_SYSTEM_ID} if depth >= 1 else {start}):
            self.assertTrue(stations.buy_ranges_overlap(mine, same_station))
            self.assertFalse(stations.buy_ranges_overlap(mine, other_jita_station))
            self.assertTrue(stations.buy_ranges_overlap({**mine, "range": "solarsystem"}, other_jita_station))
            self.assertTrue(stations.buy_ranges_overlap({**mine, "range": 1}, perimeter_one_jump))

    def test_buy_fast_copy_matches_when_hub_priority_wins_and_ticks_only_when_it_loses(self):
        def scan(mine_location, external_location, external_price, issued="2026-08-02T00:00:00Z"):
            mine = _buy("mine", location_id=mine_location, price_value=300_000_000.0)
            external = _external_buy("external", location_id=external_location, issued=issued, price_value=external_price)
            return self._buy_scan(mine, external)
        jita_jita = scan(STATION_ID, STATION_ID, 300_200_000.0)
        jita_perimeter = scan(STATION_ID, PERIMETER_STRUCTURE_ID, 300_200_000.0)
        perimeter_jita = scan(PERIMETER_STRUCTURE_ID, STATION_ID, 300_200_000.0)
        self.assertEqual(price.to_cents(300_200_000.0), jita_jita["new_price_cents"])
        self.assertEqual(price.to_cents(300_200_000.0), jita_perimeter["new_price_cents"])
        self.assertEqual(price.to_cents(price.next_price(300_200_000.0, 0)), perimeter_jita["new_price_cents"])

    def test_buy_price_stays_above_hub_priority(self):
        mine = _buy("mine", location_id=PERIMETER_STRUCTURE_ID, price_value=300_200_000.0)
        lower_jita = _external_buy("jita", location_id=STATION_ID,
                                   issued="2026-08-02T00:00:00Z", price_value=300_000_000.0)
        row = self._buy_scan(mine, lower_jita)
        self.assertFalse(row["needs_update"])
        self.assertEqual(mine["price_cents"], row["new_price_cents"])

    def test_missing_esi_range_stays_missing_not_regional(self):
        row = {
            "order_id": 1, "type_id": 34, "location_id": STATION_ID,
            "is_buy_order": True, "price": 100.0, "volume_remain": 1,
            "issued": "2026-08-01T00:00:00Z",
        }
        with mock.patch.object(esi_orders.sso, "_chars", return_value={}), \
                mock.patch.object(esi_orders, "_get", return_value=([row], {})):
            orders = esi_orders.fetch_character_orders(1)
        self.assertIsNone(orders[0]["range"])

    def test_public_market_order_preserves_buy_range_for_overlap(self):
        row = {"location_id": STATION_ID, "is_buy_order": True, "price": 100.0,
               "volume_remain": 1, "issued": "2026-08-01T00:00:00Z",
               "order_id": 1, "range": "region"}
        with mock.patch.object(esi, "_get", return_value=([row], {})):
            orders = esi._fetch_one((700, THE_FORGE))
        self.assertEqual("region", orders[0]["range"])

    def test_two_identical_scans_keep_per_character_sum_stable(self):
        orders = [
            _order("mine-1", 34, 1, 0),
            _order("mine-2", 35, 2, 1),
            _order("mine-3", 36, 2, 1),
        ]
        public = [
            _competitor("ext-1", 34, 0),
            _competitor("ext-2", 35, 1),
            _competitor("ext-3", 36, 1),
        ]

        first = core._scan_core(orders, public, "sync 1")
        second = core._scan_core(orders, public, "sync 2")
        expected = {
            "1": {"total": 1, "buy": 1, "sell": 0},
            "2": {"total": 2, "buy": 0, "sell": 2},
        }

        self.assertEqual(first["orders_to_update_by_char"], expected)
        self.assertEqual(second["orders_to_update_by_char"], expected)
        self.assertEqual(first["orders_to_update"], 3)
        self.assertEqual(
            first["orders_to_update"],
            sum(item["total"] for item in expected.values()))
        self.assertTrue(all(row["needs_update"] for row in first["orders_full"]))

    def test_character_pagination_is_atomic(self):
        row = {
            "order_id": 1, "type_id": 34, "location_id": STATION_ID,
            "is_buy_order": True, "price": 100.0, "volume_remain": 1,
            "issued": "2026-08-01T00:00:00Z",
        }
        with mock.patch.object(esi_orders.sso, "_chars", return_value={}), \
                mock.patch.object(
                    esi_orders, "_get",
                    side_effect=[([row], {"X-Pages": "2"}), (None, None)]):
            self.assertIsNone(esi_orders.fetch_character_orders(1))

    def test_zero_orders_is_a_successful_character_sync(self):
        chars = [{"id": 1, "name": "One"}, {"id": 2, "name": "Two"}]
        with mock.patch.object(esi_orders.sso, "connected_chars", return_value=chars), \
                mock.patch.object(
                    esi_orders, "fetch_character_orders", side_effect=[[], None]):
            orders, errors, synced = esi_orders.fetch_all_orders()
        self.assertEqual(orders, [])
        self.assertEqual(errors, [("Two", "token/inaccessible")])
        self.assertEqual(synced, [1])

    def test_all_zero_snapshot_keeps_explicit_character_buckets(self):
        chars = [{"id": 1, "name": "One"}, {"id": 2, "name": "Two"}]
        with mock.patch.object(
                esi_orders, "fetch_all_orders", return_value=([], [], [1, 2])), \
                mock.patch.object(esi_orders.sso, "connected_chars", return_value=chars), \
                mock.patch.object(esi_orders, "_env_structure_ids", return_value=set()):
            data = esi_orders.scan_authed(order_books=[])
        zero = {"total": 0, "buy": 0, "sell": 0}
        self.assertTrue(data["ok"])
        self.assertEqual(data["synced_char_ids"], ["1", "2"])
        self.assertEqual(data["orders_to_update_by_char"], {"1": zero, "2": zero})

    def test_total_private_failure_is_not_published_as_zero(self):
        with mock.patch.object(
                esi_orders, "fetch_all_orders",
                return_value=([], [("One", "token/inaccessible")], [])):
            data = esi_orders.scan_authed(order_books=[])
        self.assertFalse(data["ok"])
        self.assertEqual(data["synced_char_ids"], [])

    def test_fifo_marker_and_count_are_preserved(self):
        mine = _order("mine-fifo", 37, 3, 1)
        newer = _competitor("ext-fifo", 37, 1)
        newer["price"] = 100.0
        data = core._scan_core([mine], [newer], "fifo")
        row = data["orders_full"][0]
        self.assertTrue(row["needs_update"])
        self.assertTrue(row["fifo_overtaken"])
        self.assertEqual(row["gap_cents"], 0)
        self.assertEqual(data["orders_to_update_by_char"]["3"]["total"], 1)

    def test_none_and_valid_empty_public_books_stay_distinct(self):
        orders = [_order("mine-offline", 38, 4, 0)]
        with mock.patch.object(core, "_scan_core", wraps=core._scan_core) as scan:
            offline = imp.build_payload(orders, None, None)
            scan.assert_not_called()
        with mock.patch.object(core, "_scan_core", wraps=core._scan_core) as scan:
            empty_book = imp.build_payload(orders, None, [])
            scan.assert_called_once()
        self.assertFalse(offline["orders_full"][0]["needs_update"])
        self.assertEqual(offline["orders_to_update_by_char"]["4"]["total"], 0)
        self.assertEqual(empty_book["orders_to_update_by_char"]["4"]["total"], 0)


@unittest.skipIf(gui is None, "pywebview absent de cet environnement")
class CountReliabilityMetadataTests(unittest.TestCase):
    def test_never_requested_type_is_not_marked_reliable(self):
        data = core._scan_core([_order("new-type", 999, 7, 1)], [], "new")
        gui._set_count_sync_metadata(
            data, failed_type_ids=[], public_orders=[], requested_type_ids=[34])
        self.assertEqual(data["synced_char_ids"], [])
        self.assertEqual(data["counts_unavailable_type_ids"], [999])

    def test_failed_type_with_fallback_remains_reliable(self):
        public = [_competitor("fallback", 34, 1)]
        data = core._scan_core([_order("mine", 34, 7, 1)], public, "fallback")
        gui._set_count_sync_metadata(
            data, failed_type_ids=[34], public_orders=public,
            requested_type_ids=[34])
        self.assertEqual(data["synced_char_ids"], ["7"])
        self.assertNotIn("counts_unavailable_type_ids", data)


if __name__ == "__main__":
    unittest.main(verbosity=2)
