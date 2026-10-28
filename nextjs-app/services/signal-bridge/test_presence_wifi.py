"""Donny's phone on the home Wi-Fi means he's home, whatever its GPS says (2026-10-28).

On the nightstand all night, on the home Wi-Fi, the phone placed itself at an RV park 6 km away
twice, and the wake notes said he was AWAY. Run: venv/bin/python -m unittest test_presence_wifi -v
"""
import unittest

from presence_heartbeat import _wifi_presence

HA = {"phoneWifiSensor": "sensor.phone_wi_fi_connection",
      "homeWifi": {"HouseNet": "", "ShopNet": "the shop"},
      "truckWifi": ["TruckNet"],
      "truckSensor": "binary_sensor.phone_android_auto"}


def states(ssid, gps="1 Lazy K Ln, Animas", truck="off"):
    return [{"entity_id": "sensor.phone_wi_fi_connection", "state": ssid},
            {"entity_id": "sensor.phone_geocoded_location", "state": gps},
            {"entity_id": "binary_sensor.phone_android_auto", "state": truck}]


class WifiFirst(unittest.TestCase):
    def test_home_wifi_beats_a_far_off_gps_fix(self):
        line = _wifi_presence(states("HouseNet", gps="12 Faraway Rd, Elsewhere"), HA)
        self.assertTrue(line.startswith("Donny is HOME. (His phone is on the home Wi-Fi, HouseNet.)"))
        self.assertIn('"12 Faraway Rd, Elsewhere", a bad fix', line)

    def test_home_wifi_with_the_home_address_says_nothing_more(self):
        self.assertEqual(_wifi_presence(states("HouseNet"), HA),
                         "Donny is HOME. (His phone is on the home Wi-Fi, HouseNet.)")

    def test_another_building_on_the_property(self):
        self.assertEqual(_wifi_presence(states("ShopNet"), HA),
                         "Donny is HOME — at the shop. (His phone is on the Wi-Fi there, ShopNet.)")

    def test_truck_by_its_wifi_or_android_auto(self):
        self.assertEqual(_wifi_presence(states("TruckNet", gps="Main St, Animas"), HA),
                         "Donny is in his truck. (GPS: Main St, Animas)")
        self.assertEqual(_wifi_presence(states("<not connected>", gps="Main St, Animas", truck="on"), HA),
                         "Donny is in his truck. (GPS: Main St, Animas)")

    def test_off_the_wifi_or_unset_falls_back_to_gps(self):
        self.assertEqual(_wifi_presence(states("<not connected>"), HA), "")
        self.assertEqual(_wifi_presence(states("unavailable"), HA), "")
        self.assertEqual(_wifi_presence(states("SomeHotel"), HA), "")
        self.assertEqual(_wifi_presence(states("HouseNet"), {}), "")


if __name__ == "__main__":
    unittest.main()
