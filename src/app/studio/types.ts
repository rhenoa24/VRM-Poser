/**
 * Public types and zero-value constants shared by the studio engine and the UI.
 */

export type BoneKey = 'head' | 'neck';
export type SlotId = 'A' | 'B';
export type Axis = 'x' | 'y' | 'z';
export type CameraPreset = 'front' | 'threeQuarter' | 'side' | 'back' | 'top';
export type Projection = 'perspective' | 'orthographic';
/** What a single touch drag does on the canvas. */
export type OneFingerMode = 'rotate' | 'pan';
/** What a two-finger gesture does on the canvas. */
export type TwoFingerMode = 'zoomPan' | 'zoomRotate';

export interface BoneAngles {
    /** pitch / nod, degrees */
    x: number;
    /** yaw / turn, degrees */
    y: number;
    /** roll / tilt, degrees */
    z: number;
}
export type Pose = Record<BoneKey, BoneAngles>;
export type PoseMap = Record<SlotId, Pose>;

/** Per-model translation, in head-height units (1 = one head height). */
export interface Offset3 {
    x: number;
    y: number;
    z: number;
}
export type OffsetMap = Record<SlotId, Offset3>;

export const ZERO_OFFSET: Offset3 = { x: 0, y: 0, z: 0 };
export const ZERO_OFFSET_MAP: OffsetMap = {
    A: { ...ZERO_OFFSET },
    B: { ...ZERO_OFFSET },
};
export const MAX_OFFSET = 3;

export interface SlotInfo {
    id: SlotId;
    modelName: string;
    mode: 'empty' | 'vrm' | 'gltf';
    version: string;
    bonesFound: BoneKey[];
    expressions: string[];
    morphs: string[];
}

export interface StudioInfo {
    slots: SlotInfo[];
    activeSlot: SlotId;
    spacingRatio: number;
    offsets: OffsetMap;
    /** World-space size of one offset unit (the taller head's height). */
    layoutUnit: number;
    message: string;
}

export interface StudioCallbacks {
    onInfo(info: StudioInfo): void;
    onStatus(message: string): void;
    onPose(pose: PoseMap): void;
    onSelection(slot: SlotId, bone: BoneKey): void;
}

export const ZERO_POSE: Pose = {
    head: { x: 0, y: 0, z: 0 },
    neck: { x: 0, y: 0, z: 0 },
};

export const ZERO_POSE_MAP: PoseMap = {
    A: structuredClone(ZERO_POSE),
    B: structuredClone(ZERO_POSE),
};