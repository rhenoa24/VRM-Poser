import { GLTFLoader, type GLTF } from 'three/addons/loaders/GLTFLoader.js';
import {
    MToonMaterialLoaderPlugin,
    VRMLoaderPlugin,
    VRMUtils,
    type VRM,
} from '@pixiv/three-vrm';
import { VRMMaterialsV0CompatPlugin } from '@pixiv/three-vrm-materials-v0compat';
import { HeadNeckBonesPlugin } from './head-neck-plugin';

export interface LoadedModel {
    gltf: GLTF;
    vrm: VRM | null;
    mode: 'vrm' | 'gltf';
}

/**
 * Loads a model with the strict VRM loader first; if that rejects the file
 * (e.g. missing required humanoid bones) it retries with the head/neck-tolerant
 * loader so plain .glb files and partial rigs still work.
 */
export async function loadModel(url: string, onStatus: (message: string) => void): Promise<LoadedModel> {
    try {
        const loader = new GLTFLoader();
        loader.register((parser) => new VRMLoaderPlugin(parser));
        const gltf = await loader.loadAsync(url);
        const vrm = (gltf.userData['vrm'] as VRM | undefined) ?? null;
        if (!vrm) throw new Error('No VRM extension found in this file');

        VRMUtils.rotateVRM0(vrm);
        if (vrm.lookAt) {
            vrm.lookAt.autoUpdate = false;
            vrm.lookAt.target = null;
        }
        return { gltf, vrm, mode: 'vrm' };
    } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        onStatus(
            `Strict VRM loader rejected this file (${reason}). Retrying with the head/neck-tolerant loader…`,
        );
        const loader = new GLTFLoader();
        loader.register((parser) => new VRMMaterialsV0CompatPlugin(parser));
        loader.register((parser) => new MToonMaterialLoaderPlugin(parser));
        loader.register((parser) => new HeadNeckBonesPlugin(parser));
        const gltf = await loader.loadAsync(url);
        return { gltf, vrm: null, mode: 'gltf' };
    }
}