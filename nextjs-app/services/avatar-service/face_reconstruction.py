"""
Face reconstruction module.

Creates a curved face panel mesh with the input photo mapped directly as texture.
Uses MediaPipe for face detection to properly crop and position the face.
The mesh is a subdivided curved surface (like a curved monitor) — gives 3D
presence without the distortion of wrapping a photo around a sphere.
"""

from abc import ABC, abstractmethod
from dataclasses import dataclass
from pathlib import Path

import numpy as np
from PIL import Image

import config


@dataclass
class ReconstructionResult:
    """Output from face reconstruction."""
    vertices: np.ndarray          # (N, 3) neutral vertex positions
    faces: np.ndarray             # (F, 3) triangle face indices
    texture_map: np.ndarray       # (H, W, 3) UV texture image (uint8)
    uv_coords: np.ndarray         # (N, 2) per-vertex UV coordinates
    expression_basis: np.ndarray  # (50, N, 3) expression basis vectors
    shape_params: np.ndarray      # (300,) identity shape parameters


class FaceReconstructor(ABC):
    @abstractmethod
    def reconstruct(self, image: Image.Image) -> ReconstructionResult:
        ...

    @abstractmethod
    def is_ready(self) -> bool:
        ...


class FacePanelReconstructor(FaceReconstructor):
    """
    Creates a curved face panel — a subdivided surface that faces the camera
    with the photo mapped directly as texture. No UV distortion.

    The panel is curved like a section of a cylinder, giving natural 3D depth
    without the artifacts of wrapping a flat photo around a sphere.
    """

    def __init__(self, device: str = None):
        self.device = device or config.DEVICE
        self._face_landmarker = None
        self._ready = False

    def _ensure_loaded(self):
        if self._ready:
            return

        try:
            from mediapipe.tasks.python import vision
            from mediapipe.tasks.python.vision import FaceLandmarkerOptions
            from mediapipe.tasks import python as mp_tasks

            model_path = str(config.DECA_MODEL_DIR / "face_landmarker.task")
            if Path(model_path).exists():
                options = FaceLandmarkerOptions(
                    base_options=mp_tasks.BaseOptions(model_asset_path=model_path),
                    output_face_blendshapes=False,
                    output_facial_transformation_matrixes=False,
                    num_faces=1,
                )
                self._face_landmarker = vision.FaceLandmarker.create_from_options(options)
                print("[AvatarService] MediaPipe face detector loaded")
        except Exception as e:
            print(f"[AvatarService] MediaPipe unavailable: {e}")

        self._ready = True

    def reconstruct(self, image: Image.Image) -> ReconstructionResult:
        self._ensure_loaded()

        img_np = np.array(image)
        h, w = img_np.shape[:2]

        # Detect face for cropping
        face_bbox = self._detect_face(img_np)

        # Crop face region with margin
        texture = self._crop_face_texture(img_np, face_bbox)

        # Create curved panel mesh
        nx, ny = 48, 64  # subdivisions (width x height)
        vertices, faces, uv_coords = self._create_curved_panel(nx, ny)

        # Expression basis
        expression_basis = self._create_expression_basis(vertices, nx, ny)

        print(f"[AvatarService] Face panel: {len(vertices)} verts, {len(faces)} tris")

        return ReconstructionResult(
            vertices=vertices,
            faces=faces,
            texture_map=texture,
            uv_coords=uv_coords,
            expression_basis=expression_basis,
            shape_params=np.zeros(300, dtype=np.float32),
        )

    def _detect_face(self, img_np: np.ndarray) -> tuple[float, float, float, float]:
        """Returns (cx, cy, w, h) in normalized [0,1] coords."""
        if self._face_landmarker is not None:
            try:
                import mediapipe as mp
                mp_image = mp.Image(image_format=mp.ImageFormat.SRGB, data=img_np)
                results = self._face_landmarker.detect(mp_image)
                if results.face_landmarks:
                    lms = results.face_landmarks[0]
                    xs = [l.x for l in lms]
                    ys = [l.y for l in lms]
                    x0, x1 = min(xs), max(xs)
                    y0, y1 = min(ys), max(ys)
                    fw, fh = x1 - x0, y1 - y0
                    # Add margin (30% on sides, 40% on top for forehead, 20% on bottom)
                    margin_x = fw * 0.3
                    margin_top = fh * 0.4
                    margin_bot = fh * 0.2
                    return (
                        (x0 + x1) / 2,
                        (y0 - margin_top + y1 + margin_bot) / 2,
                        fw + margin_x * 2,
                        fh + margin_top + margin_bot,
                    )
            except Exception as e:
                print(f"[AvatarService] Face detection failed: {e}")

        return (0.5, 0.45, 0.6, 0.75)

    def _crop_face_texture(
        self, img_np: np.ndarray, bbox: tuple[float, float, float, float]
    ) -> np.ndarray:
        """Crop face region and resize to texture size."""
        h, w = img_np.shape[:2]
        cx, cy, bw, bh = bbox

        x0 = max(0, int((cx - bw / 2) * w))
        x1 = min(w, int((cx + bw / 2) * w))
        y0 = max(0, int((cy - bh / 2) * h))
        y1 = min(h, int((cy + bh / 2) * h))

        crop = img_np[y0:y1, x0:x1]
        if crop.size == 0:
            crop = img_np

        tex_size = config.DEFAULT_TEXTURE_SIZE
        return np.array(Image.fromarray(crop).resize((tex_size, tex_size), Image.LANCZOS))

    def _create_curved_panel(
        self, nx: int, ny: int
    ) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
        """
        Create a curved rectangular panel.

        The panel is a section of a cylinder facing +Z (toward camera).
        Width spans ~120 degrees of arc for natural head curvature.
        Aspect ratio ~3:4 (width:height) like a face.
        """
        panel_width = 0.24   # total width in world units
        panel_height = 0.32  # total height
        # Radius of curvature: smaller = more curved
        radius = 0.20  # gives ~73 degree arc for panel_width=0.24

        vertices = []
        uv_coords = []

        for iy in range(ny + 1):
            v = iy / ny  # 0 (top) to 1 (bottom)
            y = (0.5 - v) * panel_height  # centered vertically

            for ix in range(nx + 1):
                u = ix / nx  # 0 (left) to 1 (right)

                # Cylindrical curvature: x = R*sin(angle), z = R*cos(angle)
                # angle spans from -half_arc to +half_arc
                half_arc = np.arcsin(panel_width / (2 * radius))
                angle = (u - 0.5) * 2 * half_arc

                x = radius * np.sin(angle)
                z = radius * np.cos(angle) - radius  # shift so center z=0

                # Vertical curvature: forehead and chin recede
                z -= ((v - 0.5) ** 2) * 0.03

                vertices.append([x, y, z])
                uv_coords.append([u, v])

        vertices = np.array(vertices, dtype=np.float32)
        uv_coords = np.array(uv_coords, dtype=np.float32)

        # Triangulate grid
        faces = []
        for iy in range(ny):
            for ix in range(nx):
                a = iy * (nx + 1) + ix
                b = a + 1
                c = a + (nx + 1)
                d = c + 1
                faces.append([a, c, b])
                faces.append([b, c, d])

        faces = np.array(faces, dtype=np.int32)
        return vertices, faces, uv_coords

    def _create_expression_basis(
        self, vertices: np.ndarray, nx: int, ny: int
    ) -> np.ndarray:
        """
        Create expression basis vectors based on grid position.

        Since the panel is a grid, we can use (ix, iy) to precisely target
        face regions for morph targets.
        """
        num_verts = vertices.shape[0]
        basis = np.zeros((50, num_verts, 3), dtype=np.float32)

        # Grid coordinates for each vertex
        grid_u = np.zeros(num_verts)  # 0-1 horizontal
        grid_v = np.zeros(num_verts)  # 0-1 vertical (0=top, 1=bottom)
        for iy in range(ny + 1):
            for ix in range(nx + 1):
                idx = iy * (nx + 1) + ix
                grid_u[idx] = ix / nx
                grid_v[idx] = iy / ny

        # Helper: create a soft region mask
        def region(u_center, v_center, u_width, v_height):
            du = np.abs(grid_u - u_center) / (u_width / 2 + 1e-8)
            dv = np.abs(grid_v - v_center) / (v_height / 2 + 1e-8)
            return np.clip(1.0 - np.maximum(du, dv), 0, 1) ** 2

        # Mouth region (centered, lower face: v~0.68-0.78)
        mouth = region(0.5, 0.73, 0.30, 0.12)
        mouth_wide = region(0.5, 0.73, 0.40, 0.15)

        # Eyes (v~0.38-0.42)
        left_eye = region(0.35, 0.40, 0.12, 0.06)
        right_eye = region(0.65, 0.40, 0.12, 0.06)
        eyes = left_eye + right_eye

        # Eyebrows (v~0.30-0.34)
        left_brow = region(0.33, 0.32, 0.14, 0.05)
        right_brow = region(0.67, 0.32, 0.14, 0.05)
        brows = left_brow + right_brow

        # Cheeks
        left_cheek = region(0.25, 0.55, 0.15, 0.15)
        right_cheek = region(0.75, 0.55, 0.15, 0.15)
        cheeks = left_cheek + right_cheek

        # Chin
        chin = region(0.5, 0.85, 0.25, 0.12)

        # Sign for left/right movement
        x_sign = np.sign(grid_u - 0.5)

        # === MORPH TARGETS ===
        # Philosophy: LESS IS MORE. A mostly-static face with subtle jaw
        # movement looks far better than aggressive photo deformation.
        # Only the lower face (jaw/chin) moves. Eyes and brows stay static
        # to avoid uncanny valley on a photo texture.

        # Lower face region: jaw + chin pull down when mouth opens
        jaw = region(0.5, 0.80, 0.35, 0.18)  # broad jaw/chin area

        # 0: jaw open — the primary viseme driver, pulls lower face down
        basis[0, :, 1] = -jaw * 0.035

        # 1: lip pucker — slight forward push at mouth center
        basis[1, :, 2] = mouth * 0.015
        basis[1, :, 0] = -mouth * (grid_u - 0.5) * 0.08  # narrow

        # 2: lip stretch — subtle mouth widening
        basis[2, :, 0] = mouth_wide * x_sign * 0.012

        # 3: lip round — narrow + forward
        basis[3, :, 0] = -mouth * (grid_u - 0.5) * 0.10
        basis[3, :, 2] = mouth * 0.010

        # 4-5: minimal upper/lower lip (very subtle)
        upper_lip = region(0.5, 0.70, 0.25, 0.04)
        lower_lip = region(0.5, 0.76, 0.25, 0.04)
        basis[4, :, 1] = -upper_lip * 0.008
        basis[5, :, 1] = lower_lip * 0.012

        # 6-7: mouth corners (for smile-like shapes)
        left_corner = region(0.37, 0.73, 0.06, 0.06)
        right_corner = region(0.63, 0.73, 0.06, 0.06)
        basis[6, :, 1] = -left_corner * 0.008
        basis[7, :, 1] = -right_corner * 0.008

        # 8-11: subtle variants (small)
        basis[8, :, 1] = -jaw * 0.020  # medium jaw open
        basis[9, :, 1] = -jaw * 0.010  # small jaw open
        nose = region(0.5, 0.58, 0.15, 0.10)
        basis[10, :, 2] = nose * 0.005
        basis[11, :, 1] = -chin * 0.015

        # === EXPRESSION TARGETS (12-22) ===
        # Keep these very subtle — they're additive to visemes

        # 12-14: smile — only mouth corners, no cheek deformation
        basis[12, :, 1] = -(left_corner + right_corner) * 0.010
        basis[13, :, 0] = mouth_wide * x_sign * 0.005
        basis[14] = basis[12] * 0.5  # mild smile

        # 15-16: frown — mouth corners down
        basis[15, :, 1] = (left_corner + right_corner) * 0.008
        basis[16] = basis[15] * 0.5

        # 17-18: surprise — just jaw drop, no brow movement
        basis[17, :, 1] = -jaw * 0.030
        basis[18, :, 1] = -jaw * 0.015

        # 19-20: anger — unused (would look bad on photo)
        # basis[19-20] stay at zero

        # 21-22: blink — DISABLED (looks terrible on photo texture)
        # basis[21-22] stay at zero

        return basis

    def is_ready(self) -> bool:
        return self._ready


def create_reconstructor(device: str = None) -> FaceReconstructor:
    return FacePanelReconstructor(device=device)
