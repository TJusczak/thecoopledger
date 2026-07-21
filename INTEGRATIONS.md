# Integrations (Home Assistant, Grafana, dashboards)

The Coop Ledger exposes a **read-only** JSON feed for external tools.

## Getting a key

Settings → Connection → Integrations → **Generate key**. It's a long-lived key,
separate from your login session, because a polling client can't complete a
login flow. Rotating it immediately invalidates the old one.

The key only grants access to `/api/integrations/stats`, which runs SELECTs
only — there is no integration route that writes.

## The endpoint

```
GET /api/integrations/stats
GET /api/integrations/stats?coop_id=<id>     # defaults to your oldest coop
```

Pass the key as an `X-API-Key` header, or `?key=` if your client can't set
headers.

```bash
curl -H "X-API-Key: YOUR_KEY" https://your-host/api/integrations/stats
```

Response shape (values are always present, never null):

```json
{
  "coop":   { "id": "...", "name": "Jusczak's Coop" },
  "generated_at": "2026-07-21T05:28:24Z",
  "eggs":   { "today": 12, "this_month": 240, "this_year": 2431,
              "all_time": 8123, "dozen_this_year": 202.58 },
  "flock":  { "active": 18, "layers": 12, "meat_birds": 6,
              "processed_this_year": 14, "active_hatches": 1 },
  "meat":   { "lb_this_year": 64.2 },
  "money":  { "spent_this_month": 42.5, "spent_this_year": 1847.0,
              "income_this_year": 2431.0, "net_this_year": 584.0 },
  "feed":   { "bags_open": 2, "bags_low": 1 },
  "bedding_days_since_cleanout": { "Coop Floor": 42, "Nest Boxes": 8 }
}
```

## Home Assistant

Add to `configuration.yaml`. One REST call feeds many sensors, so poll once and
template the values out — don't create a separate `rest` block per sensor.

```yaml
rest:
  - resource: https://your-host/api/integrations/stats
    scan_interval: 900          # 15 min; the data doesn't change fast
    headers:
      X-API-Key: !secret coop_ledger_key
    sensor:
      - name: "Coop Eggs Today"
        value_template: "{{ value_json.eggs.today }}"
        unit_of_measurement: "eggs"
        state_class: measurement

      - name: "Coop Eggs This Month"
        value_template: "{{ value_json.eggs.this_month }}"
        unit_of_measurement: "eggs"

      - name: "Coop Active Birds"
        value_template: "{{ value_json.flock.active }}"
        unit_of_measurement: "birds"

      - name: "Coop Spent This Month"
        value_template: "{{ value_json.money.spent_this_month }}"
        unit_of_measurement: "USD"
        device_class: monetary

      - name: "Coop Net This Year"
        value_template: "{{ value_json.money.net_this_year }}"
        unit_of_measurement: "USD"
        device_class: monetary

      - name: "Coop Feed Bags Low"
        value_template: "{{ value_json.feed.bags_low }}"

      - name: "Coop Bedding Worst Area Days"
        value_template: >
          {{ value_json.bedding_days_since_cleanout.values() | max | default(0) }}
        unit_of_measurement: "days"
```

Put the key in `secrets.yaml`:

```yaml
coop_ledger_key: "paste-the-key-here"
```

### An automation example

```yaml
automation:
  - alias: "Coop: feed running low"
    trigger:
      - platform: numeric_state
        entity_id: sensor.coop_feed_bags_low
        above: 0
    action:
      - service: notify.mobile_app_phone
        data:
          message: "Feed is running low in the coop."
```

## Notes

- `scan_interval` of 15 minutes is plenty. The endpoint runs a handful of
  aggregate queries, but there's no reason to poll a flock tracker every 30s.
- If your instance is only reachable on your LAN, point Home Assistant at the
  internal address rather than routing back out through Cloudflare.
- Rotating the key in Settings breaks any client still using the old one, so
  update `secrets.yaml` at the same time.
