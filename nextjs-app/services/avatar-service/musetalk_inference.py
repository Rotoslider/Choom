"""
MuseTalk inference wrapper — follows the official inference.py pipeline exactly.

API:
  - load_models(): one-time model loading
  - prepare_reference(image): save image, run get_landmark_and_bbox, encode latents
  - animate(audio_path, ref_data): generate video frames from audio
"""

import os
import sys
import copy
import time
import tempfile
from pathlib import Path

import cv2
import numpy as np
import torch
from PIL import Image

# Add MuseTalk to path
MUSETALK_DIR = Path("/home/nuc1/projects/MuseTalk")
sys.path.insert(0, str(MUSETALK_DIR))

import config as avatar_config


class MuseTalkEngine:

    def __init__(self, device: str = None):
        self.device = torch.device(device or avatar_config.DEVICE)
        self.weight_dtype = torch.float16
        self.vae = None
        self.unet = None
        self.pe = None
        self.whisper = None
        self.audio_processor = None
        self.fp = None
        self._get_image = None
        self._loaded = False
        self.fps = 25
        self.batch_size = 16

    def load_models(self):
        if self._loaded:
            return

        print("[MuseTalk] Loading models...")
        t0 = time.time()

        # CWD must be MuseTalk root for relative model paths
        saved_cwd = os.getcwd()
        os.chdir(str(MUSETALK_DIR))

        from musetalk.utils.utils import load_all_model
        self.vae, self.unet, self.pe = load_all_model(
            unet_model_path="./models/musetalkV15/unet.pth",
            vae_type="sd-vae",
            unet_config="./models/musetalkV15/musetalk.json",
            device=self.device,
        )
        self.pe = self.pe.half().to(self.device)
        self.vae.vae = self.vae.vae.half().to(self.device)
        self.unet.model = self.unet.model.half().to(self.device)

        from transformers import WhisperModel
        self.whisper = WhisperModel.from_pretrained("./models/whisper")
        self.whisper = self.whisper.to(device=self.device, dtype=self.weight_dtype).eval()
        self.whisper.requires_grad_(False)

        from musetalk.utils.audio_processor import AudioProcessor
        self.audio_processor = AudioProcessor(feature_extractor_path="./models/whisper")

        # Face parsing for blending — exactly as official inference.py
        try:
            from musetalk.utils.blending import get_image
            from musetalk.utils.face_parsing import FaceParsing
            self._get_image = get_image
            self.fp = FaceParsing(left_cheek_width=90, right_cheek_width=90)
            print("[MuseTalk] Face parsing loaded")
        except Exception as e:
            print(f"[MuseTalk] Face parsing unavailable: {e}")
            self._get_image = None
            self.fp = None

        os.chdir(saved_cwd)
        self._loaded = True
        print(f"[MuseTalk] Models loaded in {time.time() - t0:.1f}s")

    def prepare_reference(self, image: Image.Image, video_path: str = None) -> dict:
        """
        Prepare reference — supports both single image and video input.

        With video: extracts frames, gets per-frame bboxes/latents for head movement.
        With image only: uses single frame (no head movement).
        """
        self.load_models()

        saved_cwd = os.getcwd()
        os.chdir(str(MUSETALK_DIR))

        from musetalk.utils.preprocessing import get_landmark_and_bbox, coord_placeholder

        # If video provided, extract frames from it
        if video_path and os.path.exists(video_path):
            import glob
            tmp_dir = tempfile.mkdtemp()
            cmd = f"ffmpeg -v fatal -i {video_path} -start_number 0 {tmp_dir}/%08d.png"
            os.system(cmd)
            input_img_list = sorted(glob.glob(os.path.join(tmp_dir, "*.png")))
            print(f"[MuseTalk] Extracted {len(input_img_list)} frames from video")
        else:
            # Single image
            img_np = np.array(image)
            if img_np.ndim == 2:
                img_np = cv2.cvtColor(img_np, cv2.COLOR_GRAY2RGB)
            elif img_np.shape[2] == 4:
                img_np = img_np[:, :, :3]
            img_bgr = cv2.cvtColor(img_np, cv2.COLOR_RGB2BGR)
            tmp_dir = tempfile.mkdtemp()
            tmp_path = os.path.join(tmp_dir, "00000000.png")
            cv2.imwrite(tmp_path, img_bgr)
            input_img_list = [tmp_path]

        # Get landmarks and bboxes for all frames
        coord_list, frame_list = get_landmark_and_bbox(input_img_list, upperbondrange=0)

        # Encode latents for each frame — exactly as official inference.py
        extra_margin = 10
        input_latent_list = []
        valid_coords = []
        valid_frames = []

        for bbox, frame in zip(coord_list, frame_list):
            if bbox == coord_placeholder:
                continue
            x1, y1, x2, y2 = [int(c) for c in bbox]
            y2 = min(y2 + extra_margin, frame.shape[0])
            crop_frame = frame[y1:y2, x1:x2]
            crop_frame = cv2.resize(crop_frame, (256, 256), interpolation=cv2.INTER_LANCZOS4)
            latent = self.vae.get_latents_for_unet(crop_frame)
            input_latent_list.append(latent)
            valid_coords.append((x1, y1, x2, y2))
            valid_frames.append(frame)

        # Clean up temp files
        import shutil
        shutil.rmtree(tmp_dir, ignore_errors=True)

        os.chdir(saved_cwd)

        if not input_latent_list:
            raise ValueError("No face detected in reference")

        # Smooth cycling: forward + reverse (same as official)
        latent_cycle = input_latent_list + input_latent_list[::-1]
        coord_cycle = valid_coords + valid_coords[::-1]
        frame_cycle = valid_frames + valid_frames[::-1]

        print(f"[MuseTalk] Prepared {len(input_latent_list)} reference frames "
              f"(cycle: {len(latent_cycle)})")

        return {
            "latent_cycle": latent_cycle,
            "coord_cycle": coord_cycle,
            "frame_cycle": frame_cycle,
        }

    def animate(self, audio_path: str, ref_data: dict) -> list[np.ndarray]:
        """
        Generate talking head frames — matches official inference.py pipeline.
        Returns list of BGR numpy arrays (full image with face blended in).
        """
        self.load_models()
        t0 = time.time()

        saved_cwd = os.getcwd()
        os.chdir(str(MUSETALK_DIR))

        try:
            # Audio features — exactly as official
            whisper_features, librosa_length = self.audio_processor.get_audio_feature(
                audio_path
            )
            whisper_chunks = self.audio_processor.get_whisper_chunk(
                whisper_features,
                self.device,
                self.weight_dtype,
                self.whisper,
                librosa_length,
                fps=self.fps,
                audio_padding_length_left=2,
                audio_padding_length_right=2,
            )

            if whisper_chunks is None or (hasattr(whisper_chunks, '__len__') and len(whisper_chunks) == 0):
                return []

            # Use pre-computed latent cycle (supports multi-frame references)
            input_latent_list_cycle = ref_data["latent_cycle"]

            # Batch inference — exactly as official
            from musetalk.utils.utils import datagen
            timesteps = torch.tensor([0], device=self.device)
            num_frames = len(whisper_chunks)

            gen = datagen(
                whisper_chunks=whisper_chunks,
                vae_encode_latents=input_latent_list_cycle,
                batch_size=self.batch_size,
                delay_frame=0,
                device=self.device,
            )

            res_frame_list = []
            for whisper_batch, latent_batch in gen:
                audio_feature_batch = self.pe(whisper_batch)
                latent_batch = latent_batch.to(dtype=self.weight_dtype)

                with torch.no_grad():
                    pred_latents = self.unet.model(
                        latent_batch, timesteps,
                        encoder_hidden_states=audio_feature_batch
                    ).sample
                    recon = self.vae.decode_latents(pred_latents)

                for res_frame in recon:
                    res_frame_list.append(res_frame)

            # Blend faces back — cycling through reference frames (for head motion)
            coord_cycle = ref_data["coord_cycle"]
            frame_cycle = ref_data["frame_cycle"]

            output_frames = []
            for i, res_frame in enumerate(res_frame_list):
                ref_idx = i % len(frame_cycle)
                ori_frame = copy.deepcopy(frame_cycle[ref_idx])
                x1, y1, x2, y2 = coord_cycle[ref_idx]

                try:
                    res_frame = cv2.resize(res_frame.astype(np.uint8), (x2 - x1, y2 - y1))
                except Exception:
                    continue

                if self._get_image is not None and self.fp is not None:
                    combined = self._get_image(
                        ori_frame, res_frame, [x1, y1, x2, y2],
                        upper_boundary_ratio=0.5,
                        expand=1.35,
                        mode="jaw", fp=self.fp
                    )
                else:
                    combined = ori_frame
                    combined[y1:y2, x1:x2] = res_frame

                output_frames.append(combined)  # BGR

        finally:
            os.chdir(saved_cwd)

        elapsed = time.time() - t0
        duration = num_frames / self.fps
        speed = duration / elapsed if elapsed > 0 else 0
        print(f"[MuseTalk] Generated {len(output_frames)} frames in {elapsed:.2f}s "
              f"({speed:.1f}x real-time)")

        return output_frames

    @property
    def is_loaded(self) -> bool:
        return self._loaded


def create_engine(device: str = None) -> MuseTalkEngine:
    return MuseTalkEngine(device=device)
