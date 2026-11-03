import * as THREE from 'three';
import type { BoneKey, SlotId } from './types';

export const DEG = THREE.MathUtils.DEG2RAD;
export const RAD = THREE.MathUtils.RAD2DEG;
export const KEYS: BoneKey[] = ['head', 'neck'];
export const SLOTS: SlotId[] = ['A', 'B'];