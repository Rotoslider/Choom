"""
Create a subtle motion loop video from a static portrait photo.

Generates smooth, looping head movements using affine transforms:
- Gentle head rotation (±1.5°)
- Subtle horizontal/vertical sway (±2-3px)
- Minimal breathing zoom (±0.5%)

Output: MP4 video at 25fps, suitable as MuseTalk reference input.
"""

import sys
import math
import cv2
import numpy as np
from pathlib import Path


def create_motion_video(
    image_path: str,
    output_path: str,
    duration: float = 4.0,
    fps: int = 25,
    rotation_amplitude: float = 1.5,    # degrees
    sway_x_amplitude: float = 3.0,      # pixels
    sway_y_amplitude: float = 2.0,      # pixels
    zoom_amplitude: float = 0.005,       # fraction (0.5%)
    face_center: tuple[float, float] | None = None,  # (cx, cy) normalized 0-1
):
    """
    Create a looping motion video from a static image.

    Args:
        image_path: Path to the source portrait image
        output_path: Where to save the MP4
        duration: Length in seconds (loop period)
        fps: Frames per second
        rotation_amplitude: Max rotation in degrees
        sway_x_amplitude: Max horizontal sway in pixels
        sway_y_amplitude: Max vertical sway in pixels
        zoom_amplitude: Max zoom variation as fraction
        face_center: Optional face center (normalized). Auto-detected if None.
    """
    img = cv2.imread(image_path)
    if img is None:
        raise FileNotFoundError(f"Could not read image: {image_path}")

    h, w = img.shape[:2]
    num_frames = int(duration * fps)

    # Detect face center if not provided
    if face_center is None:
        cx, cy = _detect_face_center(img)
    else:
        cx = int(face_center[0] * w)
        cy = int(face_center[1] * h)

    print(f"[MotionVideo] Image: {w}x{h}, face center: ({cx},{cy})")
    print(f"[MotionVideo] Generating {num_frames} frames ({duration}s at {fps}fps)")

    # Set up video writer
    fourcc = cv2.VideoWriter_fourcc(*'mp4v')
    writer = cv2.VideoWriter(output_path, fourcc, fps, (w, h))

    for i in range(num_frames):
        t = i / num_frames  # 0 to 1, wraps cleanly for looping

        # Sinusoidal motion — different frequencies for natural feel
        angle = rotation_amplitude * math.sin(2 * math.pi * t)
        dx = sway_x_amplitude * math.sin(2 * math.pi * t + 0.7)
        dy = sway_y_amplitude * math.cos(2 * math.pi * t)
        scale = 1.0 + zoom_amplitude * math.sin(4 * math.pi * t)

        # Build affine transform centered on face
        M = cv2.getRotationMatrix2D((cx, cy), angle, scale)
        M[0, 2] += dx
        M[1, 2] += dy

        # Apply transform with border replication (no black edges)
        warped = cv2.warpAffine(
            img, M, (w, h),
            flags=cv2.INTER_LANCZOS4,
            borderMode=cv2.BORDER_REPLICATE,
        )

        writer.write(warped)

    writer.release()

    file_size = Path(output_path).stat().st_size / 1024
    print(f"[MotionVideo] Saved: {output_path} ({file_size:.0f} KB, {num_frames} frames)")
    return output_path


def _detect_face_center(img_bgr: np.ndarray) -> tuple[int, int]:
    """Detect face center using MediaPipe."""
    try:
        import mediapipe as mp
        from mediapipe.tasks.python import vision
        from mediapipe.tasks.python.vision import FaceLandmarkerOptions
        from mediapipe.tasks import python as mp_tasks

        model_paths = [
            './models/face_landmarker.task',
            '/home/nuc1/projects/MuseTalk/models/face_landmarker.task',
            '/home/nuc1/projects/Choom/nextjs-app/services/avatar-service/models/face_landmarker.task',
        ]
        model_path = None
        for p in model_paths:
            if Path(p).exists():
                model_path = p
                break

        if model_path:
            options = FaceLandmarkerOptions(
                base_options=mp_tasks.BaseOptions(model_asset_path=model_path),
                num_faces=1,
            )
            detector = vision.FaceLandmarker.create_from_options(options)
            img_rgb = cv2.cvtColor(img_bgr, cv2.COLOR_BGR2RGB)
            mp_image = mp.Image(image_format=mp.ImageFormat.SRGB, data=img_rgb)
            results = detector.detect(mp_image)
            detector.close()

            if results.face_landmarks:
                lms = results.face_landmarks[0]
                h, w = img_bgr.shape[:2]
                xs = [l.x * w for l in lms]
                ys = [l.y * h for l in lms]
                return int(sum(xs) / len(xs)), int(sum(ys) / len(ys))
    except Exception as e:
        print(f"[MotionVideo] Face detection failed: {e}")

    # Fallback: assume face is in upper-center
    h, w = img_bgr.shape[:2]
    return w // 2, int(h * 0.4)


if __name__ == "__main__":
    if len(sys.argv) < 3:
        print("Usage: python create_motion_video.py <input_image> <output_video> [duration_seconds]")
        sys.exit(1)

    image_path = sys.argv[1]
    output_path = sys.argv[2]
    duration = float(sys.argv[3]) if len(sys.argv) > 3 else 4.0

    create_motion_video(image_path, output_path, duration=duration)
