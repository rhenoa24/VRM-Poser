import type { BoneKey, CameraPreset, SlotId } from './studio';

export type ControlSection = 'models' | 'pose' | 'face' | 'position' | 'camera';

export const SAVED_MODELS = [
  { fileName: 'Ren 2026.vrm', name: 'Ren 2026' },
  { fileName: 'Tobio 2025 (C).vrm', name: 'Tobio 2025 (C)' },
  { fileName: 'Tobio 2025 (CS).vrm', name: 'Tobio 2025 (CS)' },
  { fileName: 'Tobio 2026 (ver.R).vrm', name: 'Tobio 2026 (ver.R)' },
] as const;

export const DEFAULT_MODELS: Record<SlotId, string> = {
  A: 'Ren 2026.vrm',
  B: 'Tobio 2025 (C).vrm',
};

export const DEFAULT_MODEL_SCALES: Record<SlotId, number> = { A: 0.9, B: 1 };
export const MIN_MODEL_SCALE = 0.25;
export const MAX_MODEL_SCALE = 2.5;

export const BONES: ReadonlyArray<{ id: BoneKey; label: string }> = [
  { id: 'head', label: 'Head' },
  { id: 'neck', label: 'Neck' },
];

export const CAMERA_PRESETS: ReadonlyArray<{ id: CameraPreset; label: string }> = [
  { id: 'front', label: 'Front' },
  { id: 'threeQuarter', label: '3/4' },
  { id: 'side', label: 'Side' },
  { id: 'back', label: 'Back' },
  { id: 'top', label: 'Top' },
];