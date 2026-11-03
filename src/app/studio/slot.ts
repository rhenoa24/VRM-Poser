import * as THREE from 'three';
import type { VRM } from '@pixiv/three-vrm';
import {
    ZERO_OFFSET,
    ZERO_POSE,
    type BoneKey,
    type Offset3,
    type Pose,
    type SlotId,
    type SlotInfo,
} from './types';

export interface BoneHandle {
    node: THREE.Object3D;
    restLocal: THREE.Quaternion;
    /** World quaternion of the parent at rest; lets slider angles stay in
     *  predictable world axes regardless of how the exporter authored bones. */
    restParentWorld: THREE.Quaternion;
}

export interface MorphTarget {
    mesh: THREE.Mesh;
    index: number;
}

export type SlotSource =
    | { kind: 'file'; file: File }
    | { kind: 'url'; url: string; name: string }
    | null;

export interface Slot {
    id: SlotId;
    wrapper: THREE.Group;
    root: THREE.Object3D | null;
    vrm: VRM | null;
    bones: Partial<Record<BoneKey, BoneHandle>>;
    pose: Pose;
    /** Independent world offset from the shared layout, in head-height units. */
    offset: Offset3;
    modelScale: number;
    morphTargets: Map<string, MorphTarget[]>;
    expressionNames: string[];
    source: SlotSource;
    objectUrl: string | null;
    /** translation that brought the neck joint to world Y = 0 */
    neckOffsetY: number;
    headBoneY: number;
    headTopY: number;
    headCenterY: number;
    headHeight: number;
    info: SlotInfo;
}

export function emptySlotInfo(id: SlotId): SlotInfo {
    return {
        id,
        modelName: 'empty',
        mode: 'empty',
        version: '—',
        bonesFound: [],
        expressions: [],
        morphs: [],
    };
}

export function makeSlot(id: SlotId): Slot {
    return {
        id,
        wrapper: new THREE.Group(),
        root: null,
        vrm: null,
        bones: {},
        pose: structuredClone(ZERO_POSE),
        offset: { ...ZERO_OFFSET },
        modelScale: 1,
        morphTargets: new Map(),
        expressionNames: [],
        source: null,
        objectUrl: null,
        neckOffsetY: 0,
        headBoneY: 0,
        headTopY: 0.2,
        headCenterY: 0.1,
        headHeight: 0.2,
        info: emptySlotInfo(id),
    };
}