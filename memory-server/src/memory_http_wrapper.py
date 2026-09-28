"""
HTTP API wrapper for the Choom Memory System.
Exposes the memory functionality via FastAPI endpoints.
"""

import os
from typing import Optional, List, Dict, Any
from datetime import datetime, timezone
from contextlib import asynccontextmanager

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

# Import the shared memory configuration and implementation.
from .memory_mcp import DATA_FOLDER, RobustMemorySystem

# Initialize memory system
memory_system: Optional[RobustMemorySystem] = None

# Conversation index (memories + private chats + rooms, ForgeRAG-style
# retrieval). Built and tailed in a background thread; CHOOM_CONVERSATION_INDEX=0
# turns it off. Nothing depends on it yet — search_memories still uses the
# memory store above.
conversation_index = None


# ============================================================================
# Pydantic Models
# ============================================================================

class RememberRequest(BaseModel):
    title: str
    content: str
    tags: str = ""
    importance: int = Field(default=5, ge=1, le=10)
    memory_type: str = "conversation"
    companion_id: str = "default"


class SearchRequest(BaseModel):
    query: str
    limit: int = 10
    companion_id: Optional[str] = None
    # False for automatic per-turn recall: skips reinforcement + last_accessed
    # bump so background retrieval doesn't inflate importance or block decay.
    reinforce: bool = True


class SearchByTypeRequest(BaseModel):
    memory_type: str
    limit: int = 20
    companion_id: Optional[str] = None


class SearchByTagsRequest(BaseModel):
    tags: str
    limit: int = 20
    companion_id: Optional[str] = None


class SearchByDateRangeRequest(BaseModel):
    date_from: str
    date_to: Optional[str] = None
    limit: int = 50
    companion_id: Optional[str] = None


class RecentRequest(BaseModel):
    limit: int = 20
    companion_id: Optional[str] = None


class UpdateMemoryRequest(BaseModel):
    title: Optional[str] = None
    content: Optional[str] = None
    tags: Optional[str] = None
    importance: Optional[int] = Field(default=None, ge=1, le=10)
    memory_type: Optional[str] = None


class ConversationSearchRequest(BaseModel):
    query: str
    choom_id: str
    companion_id: Optional[str] = None
    # A group-room turn never sees private chats.
    room_turn: bool = False
    sources: Optional[List[str]] = None  # memory | chat | room
    limit: int = Field(default=5, ge=1, le=20)
    # Epoch seconds: only items written before this (benchmarks).
    as_of: Optional[float] = None


class MemoryResult(BaseModel):
    success: bool
    reason: Optional[str] = None
    data: Optional[List[Dict[str, Any]]] = None


# ============================================================================
# FastAPI App
# ============================================================================

@asynccontextmanager
async def lifespan(app: FastAPI):
    """Initialize and cleanup memory system."""
    global memory_system
    print(f"Initializing memory system from: {DATA_FOLDER}")
    memory_system = RobustMemorySystem(data_folder=DATA_FOLDER)
    global conversation_index
    if os.environ.get("CHOOM_CONVERSATION_INDEX", "1") != "0":
        try:
            from .conversation_index import ConversationIndex
            conversation_index = ConversationIndex(DATA_FOLDER)
            conversation_index.start()
            print(f"Conversation index: {conversation_index.path} (ingesting in background)")
        except Exception as e:  # the memory server must come up regardless
            conversation_index = None
            print(f"Conversation index disabled: {e}")
    yield
    if conversation_index:
        conversation_index.stop()
    if memory_system:
        memory_system.close()
        print("Memory system closed")


app = FastAPI(
    title="Choom Memory Server",
    description="HTTP API for the Choom AI Companion memory system",
    version="0.1.0",
    lifespan=lifespan,
)

# CORS middleware
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


def result_to_dict(result) -> dict:
    """Convert Result object to dictionary."""
    out = {"success": result.success}
    if result.reason is not None:
        out["reason"] = result.reason
    if result.data is not None:
        data = []
        for item in result.data:
            obj = dict(item)
            # Normalize timestamp fields
            ts = obj.get("timestamp")
            if isinstance(ts, datetime):
                obj["timestamp"] = ts.isoformat()
            data.append(obj)
        out["data"] = data
    return out


# ============================================================================
# API Endpoints
# ============================================================================

@app.get("/")
async def root():
    """Health check endpoint."""
    return {"status": "ok", "service": "choom-memory-server"}


@app.post("/memory/remember", response_model=MemoryResult)
async def remember(request: RememberRequest):
    """Store a new memory."""
    if not memory_system:
        raise HTTPException(status_code=503, detail="Memory system not initialized")

    tag_list = [t.strip() for t in request.tags.split(",") if t.strip()] if request.tags else []

    result = memory_system.remember(
        title=request.title,
        content=request.content,
        tags=tag_list,
        importance=request.importance,
        memory_type=request.memory_type,
        companion_id=request.companion_id,
    )

    return result_to_dict(result)


@app.post("/memory/search", response_model=MemoryResult)
async def search_memories(request: SearchRequest):
    """Semantic search for memories."""
    if not memory_system:
        raise HTTPException(status_code=503, detail="Memory system not initialized")

    result = memory_system.search_semantic(
        query=request.query,
        limit=request.limit,
        companion_id=request.companion_id,
        reinforce=request.reinforce,
    )

    return result_to_dict(result)


@app.post("/memory/search_by_type", response_model=MemoryResult)
async def search_by_type(request: SearchByTypeRequest):
    """Search memories by type."""
    if not memory_system:
        raise HTTPException(status_code=503, detail="Memory system not initialized")

    result = memory_system.search_structured(
        memory_type=request.memory_type,
        limit=request.limit,
        companion_id=request.companion_id,
    )

    return result_to_dict(result)


@app.post("/memory/search_by_tags", response_model=MemoryResult)
async def search_by_tags(request: SearchByTagsRequest):
    """Search memories by tags."""
    if not memory_system:
        raise HTTPException(status_code=503, detail="Memory system not initialized")

    tag_list = [t.strip() for t in request.tags.split(",") if t.strip()]

    result = memory_system.search_structured(
        tags=tag_list,
        limit=request.limit,
        companion_id=request.companion_id,
    )

    return result_to_dict(result)


@app.post("/memory/search_by_date_range", response_model=MemoryResult)
async def search_by_date_range(request: SearchByDateRangeRequest):
    """Search memories by date range."""
    if not memory_system:
        raise HTTPException(status_code=503, detail="Memory system not initialized")

    date_to = request.date_to or datetime.now(timezone.utc).isoformat()

    result = memory_system.search_structured(
        date_from=request.date_from,
        date_to=date_to,
        limit=request.limit,
        companion_id=request.companion_id,
    )

    return result_to_dict(result)


@app.post("/memory/recent", response_model=MemoryResult)
async def get_recent(request: RecentRequest):
    """Get recent memories."""
    if not memory_system:
        raise HTTPException(status_code=503, detail="Memory system not initialized")

    result = memory_system.get_recent(
        limit=request.limit,
        companion_id=request.companion_id,
    )

    return result_to_dict(result)


@app.put("/memory/{memory_id}", response_model=MemoryResult)
async def update_memory(memory_id: str, request: UpdateMemoryRequest):
    """Update an existing memory."""
    if not memory_system:
        raise HTTPException(status_code=503, detail="Memory system not initialized")

    tag_list = None
    if request.tags is not None:
        tag_list = [t.strip() for t in request.tags.split(",") if t.strip()]

    result = memory_system.update_memory(
        memory_id=memory_id,
        title=request.title,
        content=request.content,
        tags=tag_list,
        importance=request.importance,
        memory_type=request.memory_type,
    )

    return result_to_dict(result)


@app.delete("/memory/{memory_id}", response_model=MemoryResult)
async def delete_memory(memory_id: str):
    """Delete a memory."""
    if not memory_system:
        raise HTTPException(status_code=503, detail="Memory system not initialized")

    result = memory_system.delete_memory(memory_id)
    return result_to_dict(result)


class StatsRequest(BaseModel):
    companion_id: Optional[str] = None


@app.get("/memory/stats", response_model=MemoryResult)
async def get_stats(companion_id: Optional[str] = None):
    """Get memory system statistics, optionally filtered by companion_id."""
    if not memory_system:
        raise HTTPException(status_code=503, detail="Memory system not initialized")

    result = memory_system.get_statistics(companion_id=companion_id)
    return result_to_dict(result)


@app.post("/memory/stats", response_model=MemoryResult)
async def get_stats_post(request: StatsRequest):
    """Get memory system statistics (POST method for companion_id in body)."""
    if not memory_system:
        raise HTTPException(status_code=503, detail="Memory system not initialized")

    result = memory_system.get_statistics(companion_id=request.companion_id)
    return result_to_dict(result)


@app.post("/memory/backup", response_model=MemoryResult)
async def create_backup():
    """Create a memory backup."""
    if not memory_system:
        raise HTTPException(status_code=503, detail="Memory system not initialized")

    result = memory_system.create_backup()
    return result_to_dict(result)


@app.post("/memory/rebuild_vectors", response_model=MemoryResult)
async def rebuild_vectors():
    """Rebuild the vector index."""
    if not memory_system:
        raise HTTPException(status_code=503, detail="Memory system not initialized")

    result = memory_system.rebuild_vector_index()
    return result_to_dict(result)


# ============================================================================
# Conversation index
# ============================================================================

@app.get("/conversations/status")
def conversations_status():
    if not conversation_index:
        return {"enabled": False}
    return {"enabled": True, **conversation_index.stats()}


# Plain `def`: the rerank takes ~0.5-0.8 s, so FastAPI runs this on a worker
# thread instead of stalling every other memory request on the event loop.
@app.post("/conversations/search")
def conversations_search(request: ConversationSearchRequest):
    if not conversation_index:
        raise HTTPException(status_code=503, detail="Conversation index is disabled")
    try:
        data = conversation_index.search(
            request.query, request.choom_id, request.companion_id,
            room_turn=request.room_turn, as_of=request.as_of,
            sources=request.sources, k=request.limit,
        )
        return {"success": True, "data": data}
    except Exception as e:
        return {"success": False, "reason": f"Conversation search failed: {e}"}


# ============================================================================
# Main entry point
# ============================================================================

if __name__ == "__main__":
    import uvicorn

    port = int(os.environ.get("MEMORY_SERVER_PORT", "8100"))
    print(f"Starting memory server on port {port}")
    print(f"Data folder: {DATA_FOLDER}")

    uvicorn.run(app, host="0.0.0.0", port=port)
