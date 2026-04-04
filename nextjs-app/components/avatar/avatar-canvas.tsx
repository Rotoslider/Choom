'use client';

import React, { useRef, useEffect, useMemo } from 'react';
import { Canvas, useFrame, useThree } from '@react-three/fiber';
import { useGLTF, Environment } from '@react-three/drei';
import * as THREE from 'three';
import type { VisemeTimeline } from '@/lib/types';
import { interpolateVisemes } from '@/lib/audio-viseme-analyzer';
import {
  computeBlink,
  computeBreathing,
  computeHeadMovement,
  computeMicroSaccades,
  resetIdleAnimations,
} from '@/lib/idle-animations';

interface AvatarCanvasProps {
  choomId: string;
  visemeRef: React.RefObject<{
    timeline: VisemeTimeline;
    audio: HTMLAudioElement;
  } | null>;
  idleIntensity?: number; // 0-1, default 0.5
}

/**
 * The inner 3D scene rendered inside a React Three Fiber Canvas.
 */
function AvatarScene({
  choomId,
  visemeRef,
  idleIntensity = 0.5,
}: AvatarCanvasProps) {
  const meshRef = useRef<THREE.Mesh>(null);
  const groupRef = useRef<THREE.Group>(null);
  const clockRef = useRef(0);
  const prevDeltaRef = useRef(0);

  // Load the GLB model
  const { scene } = useGLTF(`/api/avatar/${choomId}/model`);

  // Find the mesh with morph targets
  const headMesh = useMemo((): THREE.Mesh | null => {
    let found: THREE.Mesh | null = null;
    scene.traverse((child) => {
      if ((child as THREE.Mesh).isMesh && (child as THREE.Mesh).morphTargetInfluences) {
        found = child as THREE.Mesh;
      }
    });
    return found;
  }, [scene]);

  // Get morph target name → index mapping
  const morphTargetMap = useMemo((): Record<string, number> => {
    if (!headMesh) return {};

    // Three.js GLTFLoader should populate this, but build manually if missing
    if (headMesh.morphTargetDictionary && Object.keys(headMesh.morphTargetDictionary).length > 0) {
      return headMesh.morphTargetDictionary;
    }

    // Fallback: read targetNames from mesh userData (GLTFLoader puts extras there)
    const dict: Record<string, number> = {};
    const names: string[] =
      headMesh.userData?.targetNames ||
      (headMesh.parent as any)?.userData?.targetNames ||
      [];
    names.forEach((name: string, i: number) => {
      dict[name] = i;
    });

    if (Object.keys(dict).length > 0) {
      headMesh.morphTargetDictionary = dict;
      console.log('[Avatar] Built morphTargetDictionary from extras:', Object.keys(dict).length, 'targets');
    }

    return dict;
  }, [headMesh]);

  // Reset idle animations and log morph target status
  useEffect(() => {
    resetIdleAnimations();
    if (headMesh) {
      console.log('[Avatar] Mesh found:', headMesh.name);
      console.log('[Avatar] Morph influences:', headMesh.morphTargetInfluences?.length ?? 'none');
      console.log('[Avatar] Morph dict:', headMesh.morphTargetDictionary);
      console.log('[Avatar] userData:', headMesh.userData);
    }
  }, [choomId, headMesh]);

  // Apply PBR skin material
  useEffect(() => {
    if (!headMesh) return;

    const existingMat = headMesh.material as THREE.MeshStandardMaterial;
    const map = existingMat?.map ?? null;

    // Keep the original material from GLB (has the texture properly assigned)
    // Just tweak properties for better rendering
    const mat = headMesh.material as THREE.MeshStandardMaterial;
    if (mat) {
      mat.roughness = 0.6;
      mat.metalness = 0.0;
      mat.side = THREE.FrontSide;
      mat.needsUpdate = true;
    }
  }, [headMesh]);

  // Animation loop
  useFrame((state, delta) => {
    clockRef.current += delta;
    prevDeltaRef.current = delta;
    const time = clockRef.current;

    if (!headMesh || !headMesh.morphTargetInfluences) return;

    const influences = headMesh.morphTargetInfluences;

    // Layer 1: Viseme animation (from TTS audio)
    const visemeData = visemeRef.current;
    let visemeWeights: Record<string, number> = {};

    if (visemeData?.audio && !visemeData.audio.paused && visemeData.timeline.length > 0) {
      visemeWeights = interpolateVisemes(visemeData.timeline, visemeData.audio.currentTime);
    }

    // Layer 2: Idle animations (no blink — looks bad on photo texture)
    const breathingOffset = computeBreathing(time);
    const headMovement = computeHeadMovement(time, idleIntensity);

    // Apply morph targets — only viseme weights, no expression overrides
    for (const [name, idx] of Object.entries(morphTargetMap)) {
      const weight = visemeWeights[name] || 0;
      influences[idx] = Math.max(0, Math.min(1, weight));
    }

    // Apply head movement to group
    if (groupRef.current) {
      groupRef.current.rotation.x = headMovement.x;
      groupRef.current.rotation.y = headMovement.y;
      groupRef.current.rotation.z = headMovement.z;
      groupRef.current.position.y = breathingOffset;
    }
  });

  return (
    <group ref={groupRef}>
      <primitive ref={meshRef} object={scene} scale={1} position={[0, 0, 0]} />
    </group>
  );
}

/**
 * Lighting setup for realistic head rendering.
 */
function AvatarLighting() {
  return (
    <>
      {/* Key light — main illumination from upper-right */}
      <directionalLight
        position={[2, 3, 4]}
        intensity={1.2}
        color="#fff5eb"
        castShadow
      />

      {/* Fill light — softer from left */}
      <directionalLight
        position={[-3, 1, 2]}
        intensity={0.4}
        color="#e8eaff"
      />

      {/* Rim light — from behind for edge separation */}
      <spotLight
        position={[0, 2, -3]}
        intensity={0.6}
        angle={0.5}
        penumbra={0.8}
        color="#c8b8ff"
      />

      {/* Hemisphere for ambient fill */}
      <hemisphereLight
        color="#ffeedd"
        groundColor="#332244"
        intensity={0.3}
      />

      {/* Subtle ambient */}
      <ambientLight intensity={0.15} />
    </>
  );
}

/**
 * Camera positioning for head framing.
 */
function CameraSetup() {
  const { camera } = useThree();

  useEffect(() => {
    camera.position.set(0, 0, 0.5);
    camera.lookAt(0, 0, 0);
  }, [camera]);

  return null;
}

/**
 * Main avatar canvas component.
 * Renders a Three.js scene with the Choom's 3D head model.
 */
export function AvatarCanvas({
  choomId,
  visemeRef,
  idleIntensity = 0.5,
}: AvatarCanvasProps) {
  return (
    <Canvas
      gl={{
        antialias: true,
        toneMapping: THREE.ACESFilmicToneMapping,
        toneMappingExposure: 1.0,
      }}
      camera={{
        fov: 35,
        near: 0.01,
        far: 10,
        position: [0, 0, 0.5],
      }}
      style={{ background: 'transparent' }}
    >
      <CameraSetup />
      <AvatarLighting />
      <AvatarScene
        choomId={choomId}
        visemeRef={visemeRef}
        idleIntensity={idleIntensity}
      />
    </Canvas>
  );
}
