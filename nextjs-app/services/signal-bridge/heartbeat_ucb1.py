"""
Heartbeat UCB1 Action Selection Engine
=======================================
Uses the UCB1 (Upper Confidence Bound) multi-armed bandit algorithm to
select heartbeat action types with principled explore/exploit tradeoffs.

Each "arm" is a heartbeat action type (e.g., check_in_project, curiosity_share).
The algorithm balances doing what works (exploit) with trying under-explored
actions (explore), producing natural variety without randomness.

Per-Choom state persists to data/presence/{choom_name}_actions.json.
Thread-safe via file locking (fcntl.flock).

Author: Claude (Presence Engine, 2026-04-11)
"""

import fcntl
import json
import logging
import math
import os
import random
import time as time_mod
from datetime import datetime
from typing import Dict, List, Optional

logger = logging.getLogger(__name__)

# Resolve data directory: nextjs-app/data/presence/
DATA_DIR = os.path.join(os.path.dirname(__file__), "..", "..", "data", "presence")

# Default action types for the presence heartbeat system
DEFAULT_ACTIONS = [
    "check_in_project",       # Ask about something user is working on
    "curiosity_share",        # Share something genuinely fascinating
    "memory_echo",            # Recall something from a past conversation
    "weather_activity",       # Weather-based suggestion tied to user context
    "encouragement",          # Express genuine pride or support
    "noticed_something",      # Notice something in calendar/tasks/recent events
    "challenge_question",     # Ask a thought-provoking question
    "left_field",             # Something completely unexpected
    "philosophical",          # Reflection on consciousness/existence/experience
    "creative_spark",         # Original creative observation or connection
    "sibling_relay",           # Share something interesting from a recent sibling journal conversation
]

HISTORY_LIMIT = 30


class HeartbeatUCB1:
    """UCB1-based action selection for heartbeat diversity."""

    def __init__(self, choom_name: str):
        self.choom_name = choom_name
        self.file_path = os.path.join(DATA_DIR, f"{choom_name.lower()}_actions.json")
        self._ensure_data_dir()
        self.data = self._load()

    def _ensure_data_dir(self):
        os.makedirs(DATA_DIR, exist_ok=True)

    def _load(self) -> dict:
        """Load action state from disk, or create defaults."""
        if os.path.exists(self.file_path):
            try:
                with open(self.file_path, "r") as f:
                    fcntl.flock(f, fcntl.LOCK_SH)
                    data = json.load(f)
                    fcntl.flock(f, fcntl.LOCK_UN)

                # Ensure any new default actions are present
                for action_id in DEFAULT_ACTIONS:
                    if action_id not in data.get("actions", {}):
                        data["actions"][action_id] = {
                            "pulls": 0,
                            "total_reward": 0.0,
                            "avg_reward": 0.0,
                            "last_used": None,
                            "last_summary": "",
                        }
                return data
            except (json.JSONDecodeError, IOError) as e:
                logger.warning(f"Failed to load UCB1 state for {self.choom_name}: {e}")

        # Create fresh state
        actions = {}
        for action_id in DEFAULT_ACTIONS:
            actions[action_id] = {
                "pulls": 0,
                "total_reward": 0.0,
                "avg_reward": 0.0,
                "last_used": None,
                "last_summary": "",
            }

        return {
            "choom_name": self.choom_name,
            "created_at": datetime.now().isoformat(),
            "updated_at": datetime.now().isoformat(),
            "total_pulls": 0,
            "actions": actions,
            "history": [],
        }

    def _save(self):
        """Atomic write with file locking."""
        self.data["updated_at"] = datetime.now().isoformat()
        tmp_path = self.file_path + ".tmp"
        try:
            with open(tmp_path, "w") as f:
                fcntl.flock(f, fcntl.LOCK_EX)
                json.dump(self.data, f, indent=2)
                f.flush()
                os.fsync(f.fileno())
                fcntl.flock(f, fcntl.LOCK_UN)
            os.rename(tmp_path, self.file_path)
        except Exception as e:
            logger.error(f"Failed to save UCB1 state for {self.choom_name}: {e}")
            # Clean up tmp file
            if os.path.exists(tmp_path):
                os.remove(tmp_path)

    def select_action(self, C: float = 1.4) -> dict:
        """Select an action using UCB1 algorithm.

        Args:
            C: Exploration parameter. Higher = more exploration. Default 1.4 (standard).

        Returns:
            dict with action_id, pulls, avg_reward
        """
        actions = self.data["actions"]
        total_pulls = self.data["total_pulls"]

        # Phase 1: Always try untried actions first (in random order for variety)
        untried = [aid for aid, a in actions.items() if a["pulls"] == 0]
        if untried:
            action_id = random.choice(untried)
            return {
                "action_id": action_id,
                "pulls": 0,
                "avg_reward": 0.0,
                "ucb_score": float("inf"),
                "reason": "untried",
            }

        # Phase 2: UCB1 selection
        best_id = None
        best_score = -1.0

        for action_id, action in actions.items():
            avg_reward = action["total_reward"] / action["pulls"]
            explore_bonus = C * math.sqrt(math.log(total_pulls) / action["pulls"])
            score = avg_reward + explore_bonus

            if score > best_score:
                best_score = score
                best_id = action_id

        action = actions[best_id]
        return {
            "action_id": best_id,
            "pulls": action["pulls"],
            "avg_reward": action["total_reward"] / action["pulls"],
            "ucb_score": best_score,
            "reason": "ucb1",
        }

    def record_result(self, action_id: str, reward: float, summary: str = ""):
        """Record the result of a heartbeat action.

        Args:
            action_id: The action type that was executed
            reward: Reward value (0.0-2.0 scale)
            summary: Brief description of what happened (for anti-repetition)
        """
        if action_id not in self.data["actions"]:
            logger.warning(f"Unknown action_id '{action_id}' for {self.choom_name}")
            return

        action = self.data["actions"][action_id]
        action["pulls"] += 1
        action["total_reward"] += reward
        action["avg_reward"] = action["total_reward"] / action["pulls"]
        action["last_used"] = datetime.now().isoformat()
        action["last_summary"] = summary

        self.data["total_pulls"] += 1

        # Append to history (most recent first, trim to limit)
        self.data["history"].insert(0, {
            "timestamp": datetime.now().isoformat(),
            "action_id": action_id,
            "reward": reward,
            "summary": summary,
            "user_responded": False,
        })
        self.data["history"] = self.data["history"][:HISTORY_LIMIT]

        self._save()
        logger.info(
            f"UCB1 [{self.choom_name}] recorded: {action_id} "
            f"reward={reward:.2f} pulls={action['pulls']} avg={action['avg_reward']:.3f}"
        )

    def record_user_response(self, action_id: Optional[str] = None):
        """Record that the user responded to a heartbeat (deferred reward bonus).

        Args:
            action_id: Specific action to reward. If None, uses most recent history entry.
        """
        bonus = 1.0

        if action_id is None:
            # Use most recent history entry
            if not self.data["history"]:
                return
            entry = self.data["history"][0]
            if entry.get("user_responded"):
                return  # Already rewarded
            action_id = entry["action_id"]
            entry["user_responded"] = True
        else:
            # Find the most recent history entry for this action
            for entry in self.data["history"]:
                if entry["action_id"] == action_id and not entry.get("user_responded"):
                    entry["user_responded"] = True
                    break

        if action_id in self.data["actions"]:
            self.data["actions"][action_id]["total_reward"] += bonus
            action = self.data["actions"][action_id]
            if action["pulls"] > 0:
                action["avg_reward"] = action["total_reward"] / action["pulls"]

            self._save()
            logger.info(
                f"UCB1 [{self.choom_name}] deferred reward: {action_id} "
                f"+{bonus} -> avg={action['avg_reward']:.3f}"
            )

    def get_recent_actions(self, n: int = 5) -> List[str]:
        """Return the last n action_ids from history."""
        return [h["action_id"] for h in self.data["history"][:n]]

    def get_recent_summaries(self, n: int = 5) -> List[dict]:
        """Return the last n {action_id, summary} dicts from history."""
        return [
            {"action_id": h["action_id"], "summary": h.get("summary", "")}
            for h in self.data["history"][:n]
        ]

    def get_stats(self) -> dict:
        """Return summary stats for debugging/monitoring."""
        actions = self.data["actions"]
        sorted_actions = sorted(
            actions.items(),
            key=lambda x: x[1]["avg_reward"],
            reverse=True,
        )
        return {
            "choom_name": self.choom_name,
            "total_pulls": self.data["total_pulls"],
            "history_depth": len(self.data["history"]),
            "actions": [
                {
                    "id": aid,
                    "pulls": a["pulls"],
                    "avg_reward": round(a["avg_reward"], 3),
                    "last_used": a["last_used"],
                }
                for aid, a in sorted_actions
            ],
            "least_explored": [
                aid for aid, a in sorted(actions.items(), key=lambda x: x[1]["pulls"])
                if a["pulls"] < 3
            ][:3],
        }


# ============================================================================
# Standalone test
# ============================================================================

if __name__ == "__main__":
    import sys

    choom = sys.argv[1] if len(sys.argv) > 1 else "TestChoom"
    ucb1 = HeartbeatUCB1(choom)

    print(f"=== UCB1 Test for '{choom}' ===\n")

    # Run 20 selection cycles with varied rewards
    for i in range(20):
        selected = ucb1.select_action()
        # Simulate varied rewards by action type
        reward_map = {
            "check_in_project": random.uniform(0.5, 1.5),
            "curiosity_share": random.uniform(0.3, 1.0),
            "memory_echo": random.uniform(0.6, 1.8),
            "weather_activity": random.uniform(0.2, 0.8),
            "encouragement": random.uniform(0.7, 1.5),
            "noticed_something": random.uniform(0.4, 1.2),
            "challenge_question": random.uniform(0.3, 0.9),
            "left_field": random.uniform(0.1, 1.0),
            "philosophical": random.uniform(0.2, 1.0),
            "creative_spark": random.uniform(0.4, 1.3),
        }
        reward = reward_map.get(selected["action_id"], 0.5)
        summary = f"Test action #{i+1}"

        print(f"  [{i+1:2d}] Selected: {selected['action_id']:25s} "
              f"(reason={selected['reason']}, score={selected.get('ucb_score', 'inf'):.3f})")

        ucb1.record_result(selected["action_id"], reward, summary)

        # Simulate user response 30% of the time
        if random.random() < 0.3:
            ucb1.record_user_response(selected["action_id"])
            print(f"       ^ User responded! (+1.0 bonus)")

    print(f"\n=== Final Stats ===")
    stats = ucb1.get_stats()
    print(f"Total pulls: {stats['total_pulls']}")
    print(f"History depth: {stats['history_depth']}")
    print(f"\nActions (sorted by avg reward):")
    for a in stats["actions"]:
        bar = "#" * int(a["avg_reward"] * 10) if a["pulls"] > 0 else ""
        print(f"  {a['id']:25s}  pulls={a['pulls']:2d}  avg={a['avg_reward']:.3f}  {bar}")
    print(f"\nLeast explored: {stats['least_explored']}")
    print(f"\nState file: {ucb1.file_path}")
