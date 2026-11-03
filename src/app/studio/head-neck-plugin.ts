import type * as THREE from 'three';
import type { GLTF, GLTFLoaderPlugin, GLTFParser } from 'three/addons/loaders/GLTFLoader.js';
import { KEYS } from './constants';
import type { BoneKey } from './types';

export interface HeadNeckData {
    bones: Partial<Record<BoneKey, THREE.Object3D>>;
    isVRM0: boolean;
    version: string;
}

interface GlbJson {
    extensions?: Record<string, any>;
}

/**
 * Fallback plugin. three-vrm THROWS when a file lacks any of the ~15 required
 * humanoid bones (hips, spine, arms, legs…). This plugin instead reads the
 * humanoid map straight from glTF JSON (VRM 1.0 `VRMC_vrm` / VRM 0.x `VRM`),
 * resolves only `head` / `neck`, and name-matches for plain .glb files.
 */
export class HeadNeckBonesPlugin implements GLTFLoaderPlugin {
    readonly name = 'HeadNeckBonesPlugin';

    constructor(private readonly parser: GLTFParser) { }

    async afterRoot(gltf: GLTF): Promise<void> {
        const json = (this.parser as unknown as { json: GlbJson }).json;
        const nodeIndex: Partial<Record<BoneKey, number>> = {};

        const v1 = json.extensions?.['VRMC_vrm']?.humanoid?.humanBones as
            | Record<string, { node: number }>
            | undefined;
        if (v1) {
            if (typeof v1['head']?.node === 'number') nodeIndex.head = v1['head'].node;
            if (typeof v1['neck']?.node === 'number') nodeIndex.neck = v1['neck'].node;
        }

        const v0 = json.extensions?.['VRM']?.humanoid?.humanBones as
            | Array<{ bone: string; node: number }>
            | undefined;
        if (Array.isArray(v0)) {
            for (const entry of v0) {
                if (entry.bone === 'head' && nodeIndex.head == null) nodeIndex.head = entry.node;
                if (entry.bone === 'neck' && nodeIndex.neck == null) nodeIndex.neck = entry.node;
            }
        }

        const bones: Partial<Record<BoneKey, THREE.Object3D>> = {};
        for (const key of KEYS) {
            const index = nodeIndex[key];
            if (index == null) continue;
            try {
                const node = (await this.parser.getDependency('node', index)) as THREE.Object3D | null;
                if (node) bones[key] = node;
            } catch {
                // name-based pass below may still find something
            }
        }

        if (!bones.head || !bones.neck) {
            gltf.scene.traverse((obj) => {
                const n = obj.name.toLowerCase();
                if (!bones.head && /(head|atama|頭)/.test(n)) bones.head = obj;
                if (!bones.neck && /(neck|kubi|首)/.test(n)) bones.neck = obj;
            });
        }

        const isVRM0 = !!json.extensions?.['VRM'] && !json.extensions?.['VRMC_vrm'];
        const version = json.extensions?.['VRMC_vrm']?.specVersion
            ? 'VRM 1.0'
            : isVRM0
                ? 'VRM 0.x'
                : 'glTF / GLB';

        gltf.userData['headNeck'] = { bones, isVRM0, version } satisfies HeadNeckData;
    }
}