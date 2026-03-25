---
name: habit-tracker
description: Logs daily activities and habits, queries history, and provides statistics and trends
version: 1.0.0
author: system
tools:
  - log_habit
  - query_habits
  - habit_stats
  - manage_categories
  - delete_habit
dependencies: []
---

# Habit Tracker

Track daily activities and life habits with structured logging. Data is stored in SQLite (not the vector memory DB) for efficient aggregation and long-term retention.

## When to Use

### log_habit
- User says they did something: "filled the truck with gas", "went to Walmart", "took a shower"
- User reports an activity: "went camping at Lake Tahoe", "used outdoor shower", "filled the water tank"
- User logs something with a quantity: "put 15 gallons in the truck", "spent $47 at Walmart"
- Parse natural language into structured fields (category, activity, location, quantity, unit)

### query_habits
- User asks about past activities: "when did I last get gas?", "how many times did I shower this week?"
- User wants history: "show me my outdoor activities this month"
- Filter by category, activity, date range, or location

### habit_stats
- User asks for trends: "how often do I shower?", "gas fill-up frequency"
- User wants summaries: "what did I do this week?", "monthly activity breakdown"
- Streaks, frequencies, category breakdowns

### manage_categories
- User wants to see, add, or customize categories
- Default categories are created automatically on first use

### delete_habit
- User wants to remove an incorrect entry

## Category Mapping Guide
Map natural language to these categories:
- **vehicle** — gas, oil change, car wash, tire rotation, maintenance
- **hygiene** — shower, outdoor shower, laundry, haircut
- **shopping** — Walmart, grocery store, Amazon order, any purchase
- **outdoor** — camping, hiking, fishing, beach, park visit
- **maintenance** — water tank, dump run, repairs, cleaning
- **health** — doctor visit, medication, exercise, workout
- **food** — cooking, eating out, meal prep
- **travel** — road trip, flight, hotel stay
- **social** — visited friends, party, event
- **finance** — paid bills, ATM, bank visit

## Important
- Always set timestamp to when the activity happened (default: now)
- Extract location when mentioned ("at X", "to X", "in X")
- Extract quantities when mentioned ("15 gallons", "$47", "3 miles")
- If unsure about category, use the closest match — user can always correct
