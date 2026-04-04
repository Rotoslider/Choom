"""
GLB Exporter — converts face reconstruction output into a GLB file
with PBR materials and morph targets for visemes and expressions.
"""

from io import BytesIO
from pathlib import Path

import numpy as np
from PIL import Image
from pygltflib import (
    GLTF2,
    Accessor,
    Asset,
    Attributes,
    Buffer,
    BufferView,
    Image as GLTFImage,
    Material,
    Mesh,
    Primitive,
    Node,
    PbrMetallicRoughness,
    Scene,
    Texture,
    TextureInfo,
)

from face_reconstruction import ReconstructionResult
from viseme_targets import ALL_MORPH_TARGETS, compute_morph_target_displacements


# glTF component types
FLOAT = 5126
UNSIGNED_INT = 5125

# glTF buffer view targets
ARRAY_BUFFER = 34962
ELEMENT_ARRAY_BUFFER = 34963


def export_avatar_glb(
    result: ReconstructionResult,
    output_path: Path,
    texture_size: int = 2048,
) -> Path:
    """
    Export reconstruction result as a GLB file with morph targets.
    Uses pygltflib's native binary blob + save_binary for correct GLB output.
    """
    output_path.parent.mkdir(parents=True, exist_ok=True)

    vertices = result.vertices.astype(np.float32)
    faces = result.faces.astype(np.uint32)
    uv_coords = result.uv_coords.astype(np.float32)
    texture = result.texture_map

    num_vertices = vertices.shape[0]

    # Compute normals
    normals = _compute_normals(vertices, faces)

    # Compute morph target displacements
    morph_displacements = compute_morph_target_displacements(
        result.expression_basis, vertices
    )

    # Resize texture
    if texture.shape[0] != texture_size or texture.shape[1] != texture_size:
        tex_img = Image.fromarray(texture)
        tex_img = tex_img.resize((texture_size, texture_size), Image.LANCZOS)
        texture = np.array(tex_img)

    # Encode texture as PNG
    tex_png_buf = BytesIO()
    Image.fromarray(texture).save(tex_png_buf, format="PNG")
    tex_png_bytes = tex_png_buf.getvalue()

    # =========================================================================
    # Build binary buffer — all data concatenated with 4-byte alignment
    # =========================================================================
    binary_data = bytearray()
    buffer_views = []
    accessors = []

    def _align():
        padding = (4 - len(binary_data) % 4) % 4
        binary_data.extend(b"\x00" * padding)

    def add_buffer_view(data_bytes: bytes, target: int = None) -> int:
        _align()
        offset = len(binary_data)
        binary_data.extend(data_bytes)
        bv = BufferView(buffer=0, byteOffset=offset, byteLength=len(data_bytes))
        if target:
            bv.target = target
        idx = len(buffer_views)
        buffer_views.append(bv)
        return idx

    def add_accessor(
        bv_idx: int, component_type: int, count: int,
        accessor_type: str, min_vals=None, max_vals=None,
    ) -> int:
        acc = Accessor(
            bufferView=bv_idx, componentType=component_type,
            count=count, type=accessor_type,
        )
        if min_vals is not None:
            acc.min = min_vals
        if max_vals is not None:
            acc.max = max_vals
        idx = len(accessors)
        accessors.append(acc)
        return idx

    # Position
    pos_bv = add_buffer_view(vertices.tobytes(), ARRAY_BUFFER)
    pos_acc = add_accessor(
        pos_bv, FLOAT, num_vertices, "VEC3",
        vertices.min(axis=0).tolist(), vertices.max(axis=0).tolist(),
    )

    # Normals
    norm_bv = add_buffer_view(normals.tobytes(), ARRAY_BUFFER)
    norm_acc = add_accessor(norm_bv, FLOAT, num_vertices, "VEC3")

    # UVs
    uv_bv = add_buffer_view(uv_coords.tobytes(), ARRAY_BUFFER)
    uv_acc = add_accessor(uv_bv, FLOAT, num_vertices, "VEC2")

    # Indices
    idx_bv = add_buffer_view(faces.tobytes(), ELEMENT_ARRAY_BUFFER)
    idx_acc = add_accessor(idx_bv, UNSIGNED_INT, faces.size, "SCALAR")

    # Morph targets
    morph_targets = []
    for target_name in ALL_MORPH_TARGETS:
        disp = morph_displacements.get(target_name, np.zeros_like(vertices))
        disp = disp.astype(np.float32)
        disp_bv = add_buffer_view(disp.tobytes(), ARRAY_BUFFER)
        disp_acc = add_accessor(
            disp_bv, FLOAT, num_vertices, "VEC3",
            disp.min(axis=0).tolist(), disp.max(axis=0).tolist(),
        )
        morph_targets.append({"POSITION": disp_acc})

    # Texture image (stored in binary buffer, referenced by bufferView)
    tex_bv = add_buffer_view(tex_png_bytes)

    # =========================================================================
    # Build glTF structure
    # =========================================================================
    gltf = GLTF2(
        asset=Asset(version="2.0", generator="ChoomAvatarService"),
        scene=0,
        scenes=[Scene(nodes=[0])],
        nodes=[Node(mesh=0, name="AvatarHead")],
        meshes=[
            Mesh(
                name="HeadMesh",
                primitives=[
                    Primitive(
                        attributes=Attributes(
                            POSITION=pos_acc,
                            NORMAL=norm_acc,
                            TEXCOORD_0=uv_acc,
                        ),
                        indices=idx_acc,
                        material=0,
                        targets=morph_targets,
                    )
                ],
                extras={"targetNames": ALL_MORPH_TARGETS},
            )
        ],
        materials=[
            Material(
                name="SkinMaterial",
                pbrMetallicRoughness=PbrMetallicRoughness(
                    baseColorTexture=TextureInfo(index=0),
                    metallicFactor=0.0,
                    roughnessFactor=0.6,
                ),
                doubleSided=False,
            )
        ],
        textures=[Texture(source=0, name="AlbedoTexture")],
        images=[
            GLTFImage(
                bufferView=tex_bv,
                mimeType="image/png",
                name="AlbedoImage",
            ),
        ],
        accessors=accessors,
        bufferViews=buffer_views,
        buffers=[Buffer(byteLength=len(binary_data))],
    )

    # Set the binary blob and save as GLB
    gltf.set_binary_blob(bytes(binary_data))
    gltf.save_binary(str(output_path))

    file_size = output_path.stat().st_size
    print(f"[GLBExporter] Written {output_path} ({file_size / 1024:.1f} KB)")
    return output_path


def _compute_normals(vertices: np.ndarray, faces: np.ndarray) -> np.ndarray:
    """Compute per-vertex normals from mesh geometry."""
    normals = np.zeros_like(vertices)

    v0 = vertices[faces[:, 0]]
    v1 = vertices[faces[:, 1]]
    v2 = vertices[faces[:, 2]]
    face_normals = np.cross(v1 - v0, v2 - v0)

    for i in range(3):
        np.add.at(normals, faces[:, i], face_normals)

    norms = np.linalg.norm(normals, axis=1, keepdims=True)

    # Pole vertices get zero normals because all their faces are degenerate.
    # Fall back to the normalised vertex position (points outward from origin),
    # which is correct for any convex mesh centered at the origin.
    zero_mask = (norms < 1e-8).squeeze()
    if zero_mask.any():
        fallback = vertices[zero_mask].copy()
        fb_norms = np.linalg.norm(fallback, axis=1, keepdims=True)
        fb_norms[fb_norms == 0] = 1.0
        fallback /= fb_norms
        normals[zero_mask] = fallback

    norms = np.linalg.norm(normals, axis=1, keepdims=True)
    norms[norms == 0] = 1.0
    normals /= norms

    return normals.astype(np.float32)
