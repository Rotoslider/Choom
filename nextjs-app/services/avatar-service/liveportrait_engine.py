"""
LivePortrait engine — real-time avatar animation.

Matches the EXACT code from test_audio_lipsync.py that worked:
- 42fps rendering
- Audio amplitude → lip retargeting
- Head motion from coefficients
- Blinks via retarget_eye at 40% strength
- No compositing — sends 256x256 face frames directly
"""

import os
import sys
import math
import time
import cv2
import numpy as np
import torch
import soundfile as sf

LIVEPORTRAIT_DIR = "/home/nuc1/projects/LivePortrait"
sys.path.insert(0, LIVEPORTRAIT_DIR)


class LivePortraitEngine:

    def __init__(self, device: str = "cuda"):
        self.device = torch.device(device)
        self._loaded = False
        self.wrapper = None
        self.cropper = None
        self.fps = 25
        self._time_offset = 0.0

    def load_models(self):
        if self._loaded:
            return

        print("[LivePortrait] Loading models...")
        t0 = time.time()

        saved_cwd = os.getcwd()
        os.chdir(LIVEPORTRAIT_DIR)

        from src.config.inference_config import InferenceConfig
        from src.config.crop_config import CropConfig
        from src.live_portrait_wrapper import LivePortraitWrapper
        from src.utils.cropper import Cropper

        self.wrapper = LivePortraitWrapper(InferenceConfig())
        self.cropper = Cropper(crop_cfg=CropConfig())

        os.chdir(saved_cwd)
        self._loaded = True
        print(f"[LivePortrait] Models loaded in {time.time() - t0:.1f}s")

    def prepare_reference(self, image) -> dict:
        """One-time setup per identity. Also renders a static idle frame."""
        self.load_models()

        saved_cwd = os.getcwd()
        os.chdir(LIVEPORTRAIT_DIR)

        try:
            from src.config.crop_config import CropConfig
            img_np = np.array(image)
            if img_np.ndim == 2:
                img_np = cv2.cvtColor(img_np, cv2.COLOR_GRAY2RGB)
            elif img_np.shape[2] == 4:
                img_np = img_np[:, :, :3]

            crop_cfg = CropConfig()
            crop_info = self.cropper.crop_source_image(img_np, crop_cfg)
            if crop_info is None:
                raise ValueError("No face detected")

            source_crop = crop_info['img_crop_256x256']
            source_tensor = torch.from_numpy(source_crop).permute(2, 0, 1).unsqueeze(0).float() / 255.0
            source_tensor = source_tensor.to(self.device)

            kp_info = self.wrapper.get_kp_info(source_tensor)
            feature_3d = self.wrapper.extract_feature_3d(source_tensor)
            x_s = self.wrapper.transform_keypoint(kp_info)

            # Render a static idle frame composited into full image
            ret = self.wrapper.warp_decode(feature_3d, x_s, x_s)
            idle_face = ret['out'].squeeze().permute(1, 2, 0).cpu().numpy()
            idle_face = (idle_face * 255).clip(0, 255).astype(np.uint8)
            idle_face_bgr = cv2.cvtColor(idle_face, cv2.COLOR_RGB2BGR)

            # Pre-compute compositing mask for blending face back to full image
            img_bgr = cv2.cvtColor(img_np, cv2.COLOR_RGB2BGR)
            # M_c2o maps from 512x512 crop space → original image
            # Resize face from 256→512 before warping, use M_c2o as-is
            M = crop_info['M_c2o']
            h, w = img_bgr.shape[:2]
            white = np.ones((512, 512), dtype=np.uint8) * 255
            mask = cv2.warpPerspective(white, M, (w, h), flags=cv2.INTER_LANCZOS4, borderValue=0)
            kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (7, 7))
            mask = cv2.erode(mask, kernel, iterations=3)
            mask = cv2.GaussianBlur(mask, (31, 31), 10)
            mask_3 = np.stack([mask.astype(np.float32) / 255.0] * 3, axis=2)

            # Composite idle frame into full image (resize 256→512 first)
            idle_512 = cv2.resize(idle_face_bgr, (512, 512), interpolation=cv2.INTER_LANCZOS4)
            idle_full = cv2.warpPerspective(idle_512, M, (w, h),
                                            flags=cv2.INTER_LANCZOS4, borderValue=(0, 0, 0))
            idle_bgr = (idle_full * mask_3 + img_bgr * (1 - mask_3)).astype(np.uint8)

            print(f"[LivePortrait] Reference prepared: pitch={kp_info['pitch'].item():.1f}° "
                  f"yaw={kp_info['yaw'].item():.1f}°")

            return {
                "kp_info": kp_info,
                "feature_3d": feature_3d,
                "x_s": x_s,
                "idle_frame_bgr": idle_bgr,
                "source_bgr": img_bgr,
                "composite_M": M,
                "composite_mask": mask_3,
            }
        finally:
            os.chdir(saved_cwd)

    def animate(self, audio_path: str, ref_data: dict) -> list[np.ndarray]:
        """
        Generate frames from audio. Returns list of BGR 256x256 frames.
        EXACT same render logic as test_audio_lipsync.py that worked.
        """
        self.load_models()
        t0 = time.time()

        kp_info = ref_data["kp_info"]
        feature_3d = ref_data["feature_3d"]
        x_s = ref_data["x_s"]

        # Extract audio amplitude per frame
        amplitudes = self._extract_audio_amplitudes(audio_path, self.fps)
        num_frames = len(amplitudes)
        if num_frames == 0:
            return []

        # Blink schedule
        np.random.seed(int(time.time()) % 10000)
        duration_sec = num_frames / self.fps
        blink_times = []
        bt = 1.5 + np.random.random() * 2
        while bt < duration_sec:
            blink_times.append(bt)
            bt += 3.0 + np.random.random() * 3.0

        frames = []

        for i in range(num_frames):
            t_sec = i / self.fps + self._time_offset

            # Deep copy kp_info
            driving = {k: v.clone() if isinstance(v, torch.Tensor) else v
                       for k, v in kp_info.items()}

            # Head motion
            driving['pitch'] = kp_info['pitch'] + math.sin(2 * math.pi * t_sec / 6.0) * 2.0
            driving['yaw'] = kp_info['yaw'] + math.sin(2 * math.pi * t_sec / 10.0) * 3.0
            driving['roll'] = kp_info['roll'] + math.sin(2 * math.pi * t_sec / 8.0) * 0.8

            # Mouth opening from audio
            amp = amplitudes[i]
            start = max(0, i - 1)
            end = min(num_frames, i + 2)
            smooth_amp = amplitudes[start:end].mean()

            # sqrt curve: amplifies moderate audio so mouth moves during normal speech
            a = math.sqrt(smooth_amp) if smooth_amp > 0.02 else 0.0

            driving['exp'] = kp_info['exp'].clone()
            if a > 0:
                driving['exp'][0, 14, 1] += a * 0.024
                driving['exp'][0, 3, 1]  -= a * 0.012
                driving['exp'][0, 7, 1]  -= a * 0.012
                driving['exp'][0, 19, 1] += a * 0.019
                driving['exp'][0, 20, 1] -= a * 0.014

            # Transform + stitch (with modified expression)
            x_d = self.wrapper.transform_keypoint(driving)
            x_d = self.wrapper.stitching(x_s, x_d)

            # Blinks (same as test that worked)
            blink_strength = 0.0
            actual_t = i / self.fps
            for bt_sec in blink_times:
                dt = abs(actual_t - bt_sec)
                if dt < 0.08:
                    blink_strength = max(blink_strength, 1.0 - dt / 0.08)

            if blink_strength > 0:
                eye_ratio = torch.tensor(
                    [[blink_strength * 0.4, blink_strength * 0.4, 0.0]],
                    device=self.device, dtype=torch.float32
                )
                eye_delta = self.wrapper.retarget_eye(x_s, eye_ratio)
                x_d = x_d + eye_delta

            # Render face, resize 256→512, composite into full image
            ret = self.wrapper.warp_decode(feature_3d, x_s, x_d)
            face_rgb = ret['out'].squeeze().permute(1, 2, 0).cpu().numpy()
            face_rgb = (face_rgb * 255).clip(0, 255).astype(np.uint8)
            face_bgr = cv2.cvtColor(face_rgb, cv2.COLOR_RGB2BGR)
            face_512 = cv2.resize(face_bgr, (512, 512), interpolation=cv2.INTER_LANCZOS4)

            M = ref_data["composite_M"]
            mask_3 = ref_data["composite_mask"]
            h, w = ref_data["source_bgr"].shape[:2]
            face_full = cv2.warpPerspective(face_512, M, (w, h),
                                            flags=cv2.INTER_LANCZOS4, borderValue=(0, 0, 0))
            output = (face_full * mask_3 + ref_data["source_bgr"] * (1 - mask_3)).astype(np.uint8)
            frames.append(output)

        # Update time offset for smooth continuation
        self._time_offset += num_frames / self.fps

        elapsed = time.time() - t0
        speed = (num_frames / self.fps) / elapsed if elapsed > 0 else 0
        print(f"[LivePortrait] Generated {len(frames)} frames in {elapsed:.2f}s "
              f"({len(frames)/elapsed:.0f}fps, {speed:.1f}x real-time)")

        return frames

    def _extract_audio_amplitudes(self, wav_path: str, fps: int) -> np.ndarray:
        audio, sr = sf.read(wav_path, dtype='float32')
        if audio.ndim > 1:
            audio = audio.mean(axis=1)
        if sr != 16000:
            from scipy.signal import resample
            audio = resample(audio, int(len(audio) * 16000 / sr)).astype(np.float32)
            sr = 16000

        spf = sr // fps
        n = len(audio) // spf
        amps = np.array([np.sqrt(np.mean(audio[i*spf:(i+1)*spf]**2)) for i in range(n)], dtype=np.float32)
        mx = amps.max()
        if mx > 0:
            amps /= mx
        return amps

    @property
    def is_loaded(self) -> bool:
        return self._loaded
