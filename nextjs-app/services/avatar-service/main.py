"""
Avatar Service — FastAPI microservice for 3D face reconstruction and GLB export.

Endpoints:
  GET  /health           → service status
  POST /generate         → start avatar generation job
  GET  /status/{job_id}  → job progress
"""

import base64
import time
import traceback
import uuid
from io import BytesIO
from pathlib import Path
from threading import Thread

import torch
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from PIL import Image

import config
from face_reconstruction import create_reconstructor, FaceReconstructor
from glb_exporter import export_avatar_glb
from musetalk_inference import MuseTalkEngine


app = FastAPI(title="Choom Avatar Service", version="1.0.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

# Global state
reconstructor: FaceReconstructor | None = None
musetalk: MuseTalkEngine | None = None
musetalk_refs: dict[str, dict] = {}  # choom_id → prepared reference data
jobs: dict[str, dict] = {}


# ============================================================================
# Startup
# ============================================================================

@app.on_event("startup")
async def startup():
    global reconstructor
    print(f"[AvatarService] Starting on port {config.PORT}")
    print(f"[AvatarService] CUDA available: {torch.cuda.is_available()}")
    if torch.cuda.is_available():
        print(f"[AvatarService] GPU: {torch.cuda.get_device_name(0)}")
        print(f"[AvatarService] VRAM: {torch.cuda.get_device_properties(0).total_memory / 1e9:.1f} GB")

    config.AVATAR_MODEL_DIR.mkdir(parents=True, exist_ok=True)

    # Pre-load the reconstructor
    reconstructor = create_reconstructor(config.DEVICE)

    # Initialize MuseTalk engine (models loaded lazily on first use)
    musetalk = MuseTalkEngine(config.DEVICE)
    print("[AvatarService] Ready")


# ============================================================================
# Models
# ============================================================================

class GenerateRequest(BaseModel):
    choom_id: str
    image_base64: str  # base64 data URI or raw base64
    texture_size: int = config.DEFAULT_TEXTURE_SIZE


class GenerateResponse(BaseModel):
    job_id: str


class JobStatus(BaseModel):
    status: str  # 'queued' | 'running' | 'completed' | 'failed'
    step: str = ""
    percent: int = 0
    error: str | None = None
    output_path: str | None = None


# ============================================================================
# Endpoints
# ============================================================================

@app.get("/health")
async def health():
    gpu_available = torch.cuda.is_available()
    return {
        "status": "ok",
        "gpu_available": gpu_available,
        "gpu_name": torch.cuda.get_device_name(0) if gpu_available else None,
        "model_loaded": reconstructor is not None and reconstructor.is_ready(),
    }


@app.post("/generate", response_model=GenerateResponse)
async def generate(req: GenerateRequest):
    job_id = str(uuid.uuid4())[:8]

    jobs[job_id] = {
        "status": "queued",
        "step": "Waiting...",
        "percent": 0,
        "error": None,
        "output_path": None,
    }

    # Run in background thread (GPU work is synchronous)
    thread = Thread(
        target=_run_generation,
        args=(job_id, req.choom_id, req.image_base64, req.texture_size),
        daemon=True,
    )
    thread.start()

    return GenerateResponse(job_id=job_id)


@app.get("/status/{job_id}", response_model=JobStatus)
async def status(job_id: str):
    if job_id not in jobs:
        raise HTTPException(status_code=404, detail="Job not found")
    return JobStatus(**jobs[job_id])


@app.post("/regenerate")
async def regenerate(req: GenerateRequest):
    """Delete existing model and regenerate."""
    output_dir = config.AVATAR_MODEL_DIR / req.choom_id
    if output_dir.exists():
        import shutil
        shutil.rmtree(output_dir)
        print(f"[AvatarService] Deleted existing model for {req.choom_id}")

    return await generate(req)


# ============================================================================
# MuseTalk Animation Endpoint
# ============================================================================

class AnimateRequest(BaseModel):
    choom_id: str
    image_base64: str       # reference photo (data URI or raw base64)
    audio_base64: str       # WAV audio (raw base64)


@app.post("/animate")
async def animate(req: AnimateRequest):
    """
    Generate talking head video frames from audio + reference image.
    Returns base64-encoded JPEG frames as a JSON array.
    """
    global musetalk

    if musetalk is None:
        musetalk = MuseTalkEngine(config.DEVICE)

    try:
        # Prepare reference if not cached
        if req.choom_id not in musetalk_refs:
            image = _decode_image(req.image_base64)

            # Check for idle video config
            video_path = None
            config_path = config.AVATAR_MODEL_DIR / "idle-video-config.json"
            if config_path.exists():
                import json as json_mod
                try:
                    idle_config = json_mod.loads(config_path.read_text())
                    video_name = idle_config.get(req.choom_id)
                    if video_name:
                        vp = config.AVATAR_MODEL_DIR / video_name
                        if vp.exists():
                            video_path = str(vp)
                except Exception:
                    pass

            # Fallback: scan for any matching idle video
            if not video_path:
                import glob
                for pattern in [f"{req.choom_id}_idle*.mp4", "eve_idle*.mp4"]:
                    matches = sorted(glob.glob(str(config.AVATAR_MODEL_DIR / pattern)))
                    if matches:
                        video_path = matches[0]
                        break

            if video_path:
                print(f"[AvatarService] Using idle video: {video_path}")
            ref_data = musetalk.prepare_reference(image, video_path=video_path)
            musetalk_refs[req.choom_id] = ref_data
            print(f"[AvatarService] Prepared MuseTalk reference for {req.choom_id}")

        ref_data = musetalk_refs[req.choom_id]

        # Decode audio and save to temp file
        import tempfile
        audio_bytes = base64.b64decode(req.audio_base64)
        with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as f:
            f.write(audio_bytes)
            audio_path = f.name

        # Generate frames
        frames = musetalk.animate(audio_path, ref_data)

        # Clean up temp file
        import os
        os.unlink(audio_path)

        # Encode frames as base64 JPEGs
        # Frames are BGR (from MuseTalk pipeline), cv2.imencode expects BGR
        import cv2
        frame_data = []
        for frame in frames:
            _, buf = cv2.imencode(".jpg", frame, [cv2.IMWRITE_JPEG_QUALITY, 95])
            frame_data.append(base64.b64encode(buf.tobytes()).decode())

        return {
            "frames": frame_data,
            "fps": musetalk.fps,
            "count": len(frame_data),
        }

    except Exception as e:
        import traceback
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/animate/clear-cache")
async def clear_animate_cache(choom_id: str = None):
    """Clear cached reference data."""
    if choom_id and choom_id in musetalk_refs:
        del musetalk_refs[choom_id]
    elif not choom_id:
        musetalk_refs.clear()
    return {"cleared": True}


# ============================================================================
# Generation Worker
# ============================================================================

def _run_generation(
    job_id: str,
    choom_id: str,
    image_base64: str,
    texture_size: int,
):
    """Background worker that runs the full generation pipeline."""
    global reconstructor

    try:
        jobs[job_id]["status"] = "running"

        # Step 1: Decode image
        _update_job(job_id, "Decoding image...", 5)
        image = _decode_image(image_base64)
        print(f"[AvatarService] Image decoded: {image.size}")

        # Step 2: Face reconstruction
        _update_job(job_id, "Reconstructing 3D face...", 15)
        if reconstructor is None:
            reconstructor = create_reconstructor(config.DEVICE)

        result = reconstructor.reconstruct(image)
        print(f"[AvatarService] Reconstruction complete: {result.vertices.shape[0]} vertices")
        _update_job(job_id, "Reconstruction complete", 60)

        # Step 3: Generate morph targets
        _update_job(job_id, "Generating morph targets...", 65)
        # Morph targets are computed inside export_avatar_glb

        # Step 4: Export GLB
        _update_job(job_id, "Exporting GLB model...", 75)
        output_dir = config.AVATAR_MODEL_DIR / choom_id
        output_path = output_dir / "avatar.glb"

        export_avatar_glb(
            result=result,
            output_path=output_path,
            texture_size=texture_size,
        )

        # Step 5: Verify
        _update_job(job_id, "Verifying output...", 95)
        if not output_path.exists():
            raise RuntimeError("GLB file was not written")

        file_size = output_path.stat().st_size
        print(f"[AvatarService] GLB exported: {file_size / 1024:.1f} KB")

        # Done
        rel_path = f"avatar-models/{choom_id}/avatar.glb"
        jobs[job_id].update({
            "status": "completed",
            "step": "Done",
            "percent": 100,
            "output_path": rel_path,
        })
        print(f"[AvatarService] Generation complete for {choom_id}: {rel_path}")

    except Exception as e:
        error_msg = str(e)
        print(f"[AvatarService] Generation failed for {choom_id}: {error_msg}")
        traceback.print_exc()
        jobs[job_id].update({
            "status": "failed",
            "step": "Failed",
            "error": error_msg,
        })

    finally:
        # Clean up GPU memory
        if torch.cuda.is_available():
            torch.cuda.empty_cache()


def _update_job(job_id: str, step: str, percent: int):
    """Update job progress."""
    jobs[job_id]["step"] = step
    jobs[job_id]["percent"] = percent
    print(f"[AvatarService] [{job_id}] {percent}% — {step}")


def _decode_image(image_base64: str) -> Image.Image:
    """Decode a base64 image (data URI or raw base64)."""
    # Strip data URI prefix if present
    if "," in image_base64:
        image_base64 = image_base64.split(",", 1)[1]

    image_bytes = base64.b64decode(image_base64)
    return Image.open(BytesIO(image_bytes)).convert("RGB")


# ============================================================================
# Entry Point
# ============================================================================

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host=config.HOST, port=config.PORT)
