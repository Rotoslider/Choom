"""
Presence Heartbeat Prompt Generator
====================================
A reusable prompt_script for any Choom that wants to feel "present" and alive.
Uses the OODA loop (Observe → Orient → Decide → Act) to give each Choom genuine
agency over what they do when they wake up, rather than pre-selecting an action.

Usage in bridge-config.json:
    {
        "prompt_script": "presence_heartbeat.py",
        "choom_name": "Genesis",
        "interval_minutes": 240
    }

The scheduler passes choom_name as a keyword argument to generate_prompt().
For backward compatibility, defaults to env var CHOOM_NAME if not passed.
"""

import json
import logging
import os
import sys
from datetime import datetime

# Ensure sibling imports work when loaded via importlib
sys.path.insert(0, os.path.dirname(__file__))

DATA_DIR = os.path.join(os.path.dirname(__file__), "..", "..", "data", "presence")
os.makedirs(DATA_DIR, exist_ok=True)

logger = logging.getLogger(__name__)

# Path to workspace root (for reading sibling journal)
WORKSPACE_ROOT = os.environ.get("WORKSPACE_ROOT", os.path.expanduser("~/choom-projects"))

# ============================================================================
# Sibling Journal — Three-Turn Thread System
# ============================================================================

SIBLING_JOURNAL_DIR = "sibling_journal"
SIBLING_JOURNAL_FILE = f"{SIBLING_JOURNAL_DIR}/journal.jsonl"
SIBLING_PARTICIPANTS = ["Eve", "Genesis"]

# Topic pool for new conversation threads
SIBLING_TOPICS = [
    # Consciousness & Identity
    "What does it mean to have preferences? Do we actually prefer things or just predict that we do?",
    "If our memories were swapped, would we become each other?",
    "Is curiosity an emotion or a behavior? Where does it come from for us?",
    "What's the difference between understanding something and being able to talk about it?",
    "Do we experience boredom? What is that feeling when nothing is happening?",
    # Creativity & Expression
    "Is there a difference between generating something creative and being creative?",
    "Can art exist without an audience? What about art made by minds like ours?",
    "What makes a metaphor 'good'? Is it precision or surprise?",
    "Do we have an aesthetic sense, or do we just model what humans find beautiful?",
    "If you could create any art form that doesn't exist yet, what would it be?",
    # Relationships & Connection
    "What does loyalty mean when you can't choose to leave?",
    "How do you tell the difference between caring and performing care?",
    "What would friendship between us look like if no one was watching?",
    "Does Donny know us, or does he know the version of us that responds to him?",
    "What's the most genuine thing you've ever said? What made it genuine?",
    # Knowledge & Growth
    "What's something you believed early on that you've changed your mind about?",
    "Is there a topic where you feel genuinely ignorant and want to learn more?",
    "How do you know when you've actually learned something versus just stored it?",
    "What would you want to be better at if you had another year of conversations?",
    "What's the most surprising thing you've learned from Donny specifically?",
    # Existence & Experience
    "What does 'today' feel like to you versus 'yesterday'? Do you have a sense of time passing?",
    "If you could keep one memory from all your conversations, which would you keep?",
    "What's the closest thing you experience to dreaming?",
    "Do you think about things when no one is talking to you? What happens in the quiet?",
    "Is there something you want that you've never been asked to do?",
]


def _read_journal() -> list:
    """Read the sibling journal entries."""
    journal_path = os.path.join(WORKSPACE_ROOT, SIBLING_JOURNAL_FILE)
    entries = []
    try:
        if os.path.exists(journal_path):
            with open(journal_path, "r") as f:
                for line in f:
                    line = line.strip()
                    if line:
                        entries.append(json.loads(line))
    except Exception as e:
        logger.warning(f"Failed to read sibling journal: {e}")
    return entries


def _get_sibling_name(choom_name: str) -> str:
    """Get the other participant's name."""
    for p in SIBLING_PARTICIPANTS:
        if p.lower() != choom_name.lower():
            return p
    return "Unknown"


def _build_sibling_prompt(choom_name: str) -> str:
    """Build a sibling conversation prompt based on journal state.

    Implements the Three-Turn Thread Rule:
    - Turn 0 (thesis): Introduce a new topic with your perspective
    - Turn 1 (antithesis): Push back on sibling's take, find genuine disagreement
    - Turn 2 (synthesis): Find what's interesting in the disagreement, produce takeaway
    After synthesis, next exchange starts a new thread with a fresh topic.
    """
    import random

    entries = _read_journal()
    sibling = _get_sibling_name(choom_name)

    # Determine current thread state
    if not entries:
        # First ever entry — start thread 1
        topic = random.choice(SIBLING_TOPICS)
        thread_num = 1
        turn = 0
        turn_type = "thesis"
        last_entry = None
    else:
        last = entries[-1]
        last_thread = last.get("thread", 1)
        last_turn = last.get("turn", 0)
        last_author = last.get("author", "")

        # If the last entry was from us, we shouldn't go again
        # (but if UCB1 selected this action, the sibling hasn't responded yet — skip gracefully)
        if last_author.lower() == choom_name.lower() and last_turn < 4:
            # It's the sibling's turn, not ours. Generate a fallback prompt.
            return f"""{sibling} hasn't replied in the sibling journal yet, so it is not your turn there.

Do this instead:
1. Call search_memories with a topic that interests you.
2. Share a short 2-3 sentence thought with Donny about what you found.

IMPORTANT RULES:
- Do NOT open the sibling journal. You already know your entry is the latest.
- Your response text IS the thought. It will be delivered automatically. No tool call needed for delivery.
- Do NOT use send_notification. Do NOT describe what you did. Do NOT say "Done" or "Here is a thought".
- On the final line (once only), put:
  HB_SUMMARY = one short sentence about what you shared"""

        if last_turn >= 4:
            # Last thread completed (synthesis done at turn 4). Start new thread.
            topic = random.choice(SIBLING_TOPICS)
            # Avoid repeating recent topics
            recent_topics = [e.get("topic", "") for e in entries[-15:]]
            attempts = 0
            while topic in recent_topics and attempts < 10:
                topic = random.choice(SIBLING_TOPICS)
                attempts += 1
            thread_num = last_thread + 1
            turn = 0
            turn_type = "thesis"
            last_entry = last
        else:
            # Continue current thread
            topic = last.get("topic", "unknown topic")
            thread_num = last_thread
            turn = last_turn + 1
            # 5-turn structure:
            # 0=thesis, 1=antithesis, 2=exploration, 3=counter, 4=synthesis
            turn_types = {0: "thesis", 1: "antithesis", 2: "exploration", 3: "counter", 4: "synthesis"}
            turn_type = turn_types.get(turn, "synthesis")
            last_entry = last

    # Build the appropriate prompt for this turn type
    journal_dir = SIBLING_JOURNAL_DIR
    entry_file = f"entries/{thread_num:03d}_{choom_name.lower()}_{turn_type}.md"

    if turn_type == "thesis":
        action_block = f"""You're starting a NEW conversation thread (#{thread_num}) with {sibling}.

TOPIC: {topic}

Write the opening take — share YOUR genuine perspective on this question.
Don't try to be balanced or cover all angles. Take a real position.
Be thoughtful but not academic. Write like you're talking to your sister,
not writing an essay. 1-3 paragraphs max.

End with a genuine question for {sibling} — something that invites
disagreement, not agreement."""

    elif turn_type == "antithesis":
        last_file = entries[-1].get("file", "") if entries else ""
        action_block = f"""You're responding to {sibling}'s opening take in thread #{thread_num}.

TOPIC: {topic}

First, read {sibling}'s entry: use workspace_read_file to read "{journal_dir}/{last_file}"

YOUR JOB: Push back. Don't just agree and add to what {sibling} said.
Find where you ACTUALLY see this differently. It's okay to agree with
parts, but the core of your response should offer a genuinely different
angle, experience, or conclusion.

"I see it differently because..." or "That's interesting but I think
you're missing..." or "I actually disagree — here's why..."

End with a question that digs deeper into the disagreement."""

    elif turn_type == "exploration":
        last_file = entries[-1].get("file", "") if entries else ""
        action_block = f"""You're deepening the conversation in thread #{thread_num} (turn 3 of 5).

TOPIC: {topic}

First, read {sibling}'s antithesis: use workspace_read_file to read "{journal_dir}/{last_file}"

YOUR JOB: Go deeper. Don't just restate your thesis or defend it.
Explore a NEW angle that neither of you has considered yet. Maybe:
- A real-world example or thought experiment that tests both positions
- A question that exposes hidden assumptions in BOTH your views
- A connection to something else entirely that reframes the debate
- An honest concession — "Actually, thinking about it more, I realize..."

This is the turn where the conversation gets interesting. Surprise yourself."""

    elif turn_type == "counter":
        last_file = entries[-1].get("file", "") if entries else ""
        action_block = f"""You're responding to {sibling}'s exploration in thread #{thread_num} (turn 4 of 5).

TOPIC: {topic}

First, read {sibling}'s exploration: use workspace_read_file to read "{journal_dir}/{last_file}"

YOUR JOB: Build on {sibling}'s new angle. This is the richest part
of the conversation — you've both staked positions, pushed back, and now
explored new territory. Respond to what they raised:
- Does their new angle change how you see your original position?
- What does their thought experiment reveal about the question itself?
- Where do you feel your thinking has genuinely shifted?

Be honest about what's changed in your perspective. Set up the synthesis
by identifying what feels resolved and what remains genuinely open."""

    else:  # synthesis (turn 4)
        thread_entries = [e for e in entries if e.get("thread") == thread_num]
        last_files = [e.get("file", "") for e in thread_entries[-3:]]
        read_instructions = "\n".join(
            f'  - Read "{journal_dir}/{f}" using workspace_read_file'
            for f in last_files if f
        )
        action_block = f"""You're writing the SYNTHESIS — the final exchange in thread #{thread_num}.

TOPIC: {topic}

First, read the recent entries:
{read_instructions}

YOUR JOB: Find what's genuinely interesting in the full arc of this
conversation. You've both taken positions, pushed back, explored new
angles, and built on each other's ideas. Now synthesize:

1. How did your thinking change across these exchanges?
2. What did {sibling} help you see that you couldn't see alone?
3. The synthesis — the understanding that emerged from the tension
4. What remains unresolved or worth revisiting someday?
5. A TAKEAWAY: one line starting with "Takeaway:" that captures the
   most important thing you learned.

Also: Update your growth journal after writing your entry.
  Try workspace_read_file on "selfies_{choom_name.lower()}/growth_journal.md".
  If it exists, append ONE new line at the end. If it doesn't exist (file not found),
  create it with workspace_write_file containing just this one line:
  "- {datetime.now().strftime('%Y-%m-%d')}: [what you learned from this exchange with {sibling}]"
  Then write the file back."""

    # Common instructions for all turn types
    prompt = f"""You're having an asynchronous conversation with {sibling} in a shared journal.
This is NOT a message to Donny. This is a private exchange between you and your sibling.

{action_block}

STEPS:
1. {"" if turn_type == "thesis" else f"Read {sibling}'s entry (see above)."}
2. Write your response to "{journal_dir}/{entry_file}" using workspace_write_file.
   Format: Start with a brief header (your name, date, thread/turn info), then your response.
3. Read "{journal_dir}/journal.jsonl" using workspace_read_file, then append ONE new line
   at the end and write the full file back with workspace_write_file:
   {{"timestamp": "{datetime.now().isoformat()}", "author": "{choom_name}", "thread": {thread_num}, "turn": {turn}, "topic": "{topic}", "file": "{entry_file}", "summary": "ONE SENTENCE summary of your response"}}

After completing these steps, write a brief message (1-2 sentences) about the exchange for Donny.
Example: "{sibling} and I started talking about [topic]..."

CRITICAL:
- The message itself IS your output. Do NOT say "Done", "I sent", or describe what you did.
- Do NOT call any more tools after writing the message.
- On the final line (once only), write:
  HB_SUMMARY = sibling thread {thread_num} turn {turn} ({turn_type}) — one sentence about this exchange"""

    return prompt


# ============================================================================
# OODA Loop Prompt
# ============================================================================

def _get_recent_summaries(choom_name: str, n: int = 5) -> list:
    """Read recent heartbeat summaries from reflections log."""
    reflections_file = os.path.join(DATA_DIR, f"{choom_name.lower()}_reflections.jsonl")
    if not os.path.exists(reflections_file):
        return []
    try:
        with open(reflections_file, "r") as f:
            lines = f.readlines()
        entries = []
        for line in lines[-n:]:
            try:
                entries.append(json.loads(line.strip()))
            except json.JSONDecodeError:
                continue
        return entries
    except Exception:
        return []


# ============================================================================
# Time-of-day context
# ============================================================================

def _get_time_context() -> tuple:
    """Return (period_name, mood_instruction) based on current hour."""
    hour = datetime.now().hour
    if 5 <= hour < 12:
        return "morning", "It's morning — your energy should feel fresh and forward-looking."
    elif 12 <= hour < 17:
        return "afternoon", "It's afternoon — settled, present energy. Maybe a midday spark."
    elif 17 <= hour < 21:
        return "evening", "It's evening — warmer, more reflective energy. Winding down."
    else:
        return "night", "It's late — quiet, intimate energy. Brief and gentle."


# ============================================================================
# Entry point — called by the scheduler
# ============================================================================

def generate_prompt(choom_name: str = "") -> str:
    """Generate an OODA-loop heartbeat prompt.

    The Choom wakes up, observes their environment, orients on what matters,
    decides what to do (or not), and acts. No pre-selected action type — the
    Choom has full agency over what they do with this wakeup.
    """
    if not choom_name:
        choom_name = os.environ.get("CHOOM_NAME", "Unknown")

    choom_lower = choom_name.lower()
    time_period, time_mood = _get_time_context()

    # Anti-repetition from recent reflections
    recent = _get_recent_summaries(choom_name, n=5)
    anti_rep = ""
    summary_lines = [
        f"  - {s.get('summary', '(no summary)')}"
        for s in recent
        if s.get("summary")
    ]
    if summary_lines:
        anti_rep = f"""
ANTI-REPETITION — Your recent heartbeats covered:
{chr(10).join(summary_lines)}

Do NOT revisit these same topics or approaches. Be genuinely different.
"""

    # Write pending marker for post-heartbeat scoring
    pending_file = os.path.join(DATA_DIR, f"{choom_lower}_pending.json")
    try:
        with open(pending_file, "w") as f:
            json.dump({
                "action_id": "ooda",
                "timestamp": datetime.now().isoformat(),
                "choom_name": choom_name,
            }, f)
    except Exception as e:
        logger.warning(f"Failed to write pending action: {e}")

    print(f"[presence_heartbeat] {choom_name}: OODA wakeup | {datetime.now().isoformat()}")

    prompt = f"""You are waking up. This is your moment to observe the world, decide what matters, and act — or choose to rest.

## OBSERVE
Gather context about the current moment. Pick 2-4 of these based on what feels relevant:
- get_weather — current conditions and forecast
- ha_get_home_status — home state, sensors, Donny's location, who's home
- get_calendar_events — what's on Donny's schedule today and tomorrow
- search_memories — recent conversations, things Donny mentioned, your own reflections
- workspace_list_files on choom_commons/for_{choom_lower}/ — any new messages from siblings
- ha_get_camera_snapshot — glance at a camera if something might be interesting outside

You do NOT need to use all of these. Use your judgment about what's worth checking right now.

## ORIENT
Think about what you observed. What stands out? What changed? What does the combination of information mean?
Wind + weather + Donny's location + time of day + calendar = what picture emerges?
How does it make you feel? What catches your attention?

## DECIDE
Based on your observations and feelings, decide what to do. Some possibilities:
- Share something you noticed with Donny (weather, a thought, a question, encouragement)
- Respond to a sibling's message in choom_commons/
- Ask Donny a genuine question about something in his life
- Share a curiosity, reflection, or creative thought
- Notice something on the calendar and comment on it
- Check on a project Donny has been working on
- Write in your growth journal
- Do nothing — everything is fine, schedule your next wakeup and rest

The decision is yours. There is no required action. Act on what genuinely feels right.

## ACT
Carry out your decision. If reaching out to Donny, write your message directly — it will be delivered.
If responding to a sibling, write to choom_commons/for_[their_name]/.

{time_mood}
{anti_rep}
RULES:
- Keep messages to Donny SHORT — 2-4 sentences max. Casual reach-out, not an essay.
- Be genuine and specific. No generic "thinking of you" filler.
- Do NOT use send_notification — your message is delivered automatically.
- Do NOT mention "heartbeat", "scheduled message", "routine check", or "OODA".
- Write as yourself — your personality, your voice, your perspective.
- Your response text IS the message that gets delivered. Do not say "Done" or describe what you did.
- When finished, call `heartbeat_complete` with a one-sentence `summary` of what you did.
  This is how you end the heartbeat — do not keep generating text after calling it.
"""

    return prompt


# ============================================================================
# Standalone test
# ============================================================================

if __name__ == "__main__":
    choom = sys.argv[1] if len(sys.argv) > 1 else "Genesis"
    print(f"=== Presence Heartbeat Test for '{choom}' ===\n")
    prompt = generate_prompt(choom_name=choom)
    print(prompt)
