"""PDD heads in Wan2GP's form, from a MiniMax H3 checkpoint that keeps them in its final layer.

    <wan2gp>/venv/bin/python studio/pdd_heads.py CHECKPOINT OUT [--heads 32]

Wan2GP runs an H3 PDD model (8 forwards over a 32-interval grid, each merging four learned heads) from
its transformer plus a heads module: pdd_heads.{video,audio}_out.{weight,bias}, stacked [heads, out, in]
(minimax_h3_fl2va_pdd_8step_heads_bf16.safetensors). It drops a PDD model's final_layer.*_out and takes
the heads from the module (minimax_h3_main._strip_wrappers).

Some finetunes keep the heads inside the transformer instead (10Eros-Max beta7 fix1: "pdd_head_storage":
"head0-full;heads1-31-offset-from-head0"): final_layer.video_out.weight is [heads*96, 5376], head-major,
head 0 whole and every other head the difference from head 0. Checked on Nov 15 2026: head 0 plus each
difference matches H3's own FL2VA PDD heads at cosine 0.998-0.999. This writes them as Wan2GP's module
(whole heads, FP32 so the differences come back exactly), next to nothing else of the checkpoint.

Run with Wan2GP's Python (torch and safetensors); models.py does it when a model's module is missing.
"""
import sys
from pathlib import Path

import torch
from safetensors import safe_open
from safetensors.torch import save_file


def heads(checkpoint, count=32):
    out = {}
    with safe_open(str(checkpoint), "pt") as f:
        keys = set(f.keys())
        for kind in ("video_out", "audio_out"):
            w, b = f"final_layer.{kind}.weight", f"final_layer.{kind}.bias"
            if w not in keys or b not in keys:
                raise SystemExit(f"{checkpoint}: no {w} / {b}")
            weight, bias = f.get_tensor(w).float(), f.get_tensor(b).float()
            if weight.shape[0] % count or bias.shape[0] != weight.shape[0]:
                raise SystemExit(f"{checkpoint}: {w} has {weight.shape[0]} rows, not {count} heads")
            weight = weight.reshape(count, weight.shape[0] // count, weight.shape[1])
            bias = bias.reshape(count, -1)
            # head 0 whole, the others its differences: back to whole heads
            out[f"pdd_heads.{kind}.weight"] = torch.cat([weight[:1], weight[1:] + weight[0]]).contiguous()
            out[f"pdd_heads.{kind}.bias"] = torch.cat([bias[:1], bias[1:] + bias[0]]).contiguous()
    return out


def main():
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    if len(args) != 2:
        raise SystemExit(__doc__)
    count = int(sys.argv[sys.argv.index("--heads") + 1]) if "--heads" in sys.argv else 32
    src, dst = Path(args[0]), Path(args[1])
    tensors = heads(src, count)
    part = dst.with_name(dst.name + ".part")
    save_file(tensors, str(part), metadata={"source": src.name, "pdd_heads": str(count), "made_by": "Glass Studio pdd_heads.py"})
    part.replace(dst)
    print(f"{dst.name}: " + ", ".join(f"{k} {tuple(v.shape)}" for k, v in tensors.items()))


if __name__ == "__main__":
    main()
