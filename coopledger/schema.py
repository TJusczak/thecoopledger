"""Table definitions for the synced, coop-scoped resources.

Anything declared here is served by the generic /api/{resource} CRUD and
/api/sync/{resource} routes -- so nothing server-internal (sessions, invite
codes, push subscriptions, API keys) may ever be added to SCHEMA.
"""

DEFAULT_SETTINGS = {
    "bedding_thresholds": {
        "Coop Floor": {"warn": 120, "danger": 180},
        "Nesting Boxes": {"warn": 60, "danger": 90},
        "Run": {"warn": 120, "danger": 180},
    }
}

SCHEMA = {
    "coops": {
        "name": "TEXT", "notes": "TEXT", "created_date": "TEXT", "settings": "TEXT",
    },
    "birds": {
        "coop_id": "TEXT", "name": "TEXT", "breed": "TEXT", "type": "TEXT", "gender": "TEXT", "hatch_date": "TEXT",
        "acquired_date": "TEXT", "status": "TEXT", "target_harvest_date": "TEXT",
        "harvest_date": "TEXT", "harvest_weight": "REAL", "notes": "TEXT",
        "photo": "TEXT", "photo_pos_x": "REAL", "photo_pos_y": "REAL", "photo_zoom": "REAL", "batch_name": "TEXT", "price_per_lb": "REAL",
        "death_date": "TEXT", "death_cause": "TEXT", "card_color": "TEXT", "border_style": "TEXT", "hatch_id": "TEXT", "card_pattern": "TEXT", "location": "TEXT",
        "main_bird_photo_id": "TEXT", "acquisition_cost": "REAL", "source_expense_id": "TEXT", "sold_date": "TEXT", "retired_date": "TEXT",
        "sold_amount": "REAL", "source_income_id": "TEXT",
    },
    "bird_photos": {
        # A bird's photo history, separate from birds.photo (the single
        # "current" photo shown on cards everywhere, which this doesn't
        # replace). Each entry has its own crop, its own date, and an
        # optional growth-stage label, so a bird's timeline can show it as
        # a chick, then months later as an adult, without losing either shot.
        "coop_id": "TEXT", "bird_id": "TEXT", "photo": "TEXT", "photo_pos_x": "REAL", "photo_pos_y": "REAL", "photo_zoom": "REAL",
        "date_taken": "TEXT", "stage": "TEXT",
    },
    "eggs": {
        "coop_id": "TEXT", "date": "TEXT", "count": "REAL", "notes": "TEXT", "price_per_egg": "REAL",
    },
    "expenses": {
        "coop_id": "TEXT", "date": "TEXT", "category": "TEXT", "description": "TEXT", "amount": "REAL", "for_type": "TEXT",
        "quantity": "REAL", "unit": "TEXT", "entry_type": "TEXT", "washout_unit_price": "REAL", "item_count": "INTEGER",
    },
    "bedding": {
        "coop_id": "TEXT", "date": "TEXT", "area": "TEXT", "material": "TEXT", "entry_type": "TEXT", "notes": "TEXT",
    },
    "bird_logs": {
        "coop_id": "TEXT", "bird_id": "TEXT", "date": "TEXT", "note": "TEXT",
    },
    "notes": {
        "coop_id": "TEXT", "category": "TEXT", "title": "TEXT", "body": "TEXT", "created_date": "TEXT", "color": "TEXT",
    },
    "supplies": {
        "coop_id": "TEXT", "category": "TEXT", "description": "TEXT", "brand": "TEXT", "quantity": "REAL", "unit": "TEXT",
        "status": "TEXT", "date_added": "TEXT", "date_emptied": "TEXT", "source_expense_id": "TEXT", "opened_at": "TEXT",
        "product_id": "TEXT", "cost": "REAL",
    },
    "supply_products": {
        "coop_id": "TEXT", "category": "TEXT", "brand": "TEXT", "photo": "TEXT", "photo_pos_x": "REAL", "photo_pos_y": "REAL", "photo_zoom": "REAL",
        "default_unit": "TEXT", "default_quantity": "REAL", "default_description": "TEXT", "last_used_at": "TEXT",
    },
    "hatches": {
        "coop_id": "TEXT", "breed": "TEXT", "date_started": "TEXT", "egg_count": "REAL",
        "hatched_count": "REAL", "named_count": "REAL", "clear_count": "REAL", "quit_count": "REAL", "failed_count": "REAL",
        "status": "TEXT", "notes": "TEXT",
    },
    "hatch_eggs": {
        # One row per individual egg in a clutch -- position is a stable
        # display order (1, 2, 3...) that doesn't change as status changes.
        # status: Incubating | Hatched | Clear | Quit | Failed to Hatch.
        # bird_id is set once a Hatched egg has been named into the flock;
        # tracked_externally marks one as "handled" without a real flock
        # record (kept separate from bird_id so a null bird_id still means
        # "still needs naming" rather than being ambiguous with this).
        # resolved_date: when the outcome actually happened -- the clutch's
        # own date_started is when it went INTO the incubator, not when any
        # individual egg's fate was decided, so it's the only honest anchor
        # for a month/year-scoped hatching stat. Null on older rows that
        # predate this field.
        "coop_id": "TEXT", "hatch_id": "TEXT", "position": "REAL", "status": "TEXT", "gender": "TEXT", "bird_id": "TEXT", "tracked_externally": "REAL", "resolved_date": "TEXT",
    },
    "activity_log": {
        # Append-only by convention (the app never updates or deletes a log entry) --
        # reuses the same generic create/list/sync endpoints as everything else.
        "coop_id": "TEXT", "resource": "TEXT", "op": "TEXT", "changed_by": "TEXT", "summary": "TEXT",
    },
}
SCOPED = {"birds", "eggs", "expenses", "bedding", "bird_logs", "notes", "supplies", "hatches", "hatch_eggs", "bird_photos", "activity_log", "supply_products"}  # tables siloed by coop_id


SYNC_COLUMNS = {"updated_at": "TEXT", "deleted_at": "TEXT"}
