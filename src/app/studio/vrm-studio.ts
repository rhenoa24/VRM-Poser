/**
 * studio/vrm-studio.ts
 * ---------------------------------------------------------------------------
 * Framework-agnostic Three.js engine for a TWO-HEAD VRM reference viewer.
 * No Angular imports here — reusable from React/Vue/vanilla TS.
 *
 *  - Slot A / Slot B: independent .vrm (0.x or 1.0), .glb or .gltf files
 *  - Each slot has its own head + neck pose, expressions and morph targets
 *  - Only `head` and `neck` bones are ever registered (no body gizmos)
 *  - Heads are aligned to a common neck height and spaced side by side
 *  - One shared camera: perspective / orthographic, presets, head framing
 *  - One shared clipping plane hides both bodies at once
 *  - PNG export (gizmos/markers hidden), pose JSON save/load
 * ---------------------------------------------------------------------------
 */

import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { TransformControls } from "three/addons/controls/TransformControls.js";
import { VRMHumanBoneName, VRMUtils } from "@pixiv/three-vrm";
import { DEG, KEYS, RAD, SLOTS } from "./constants";
import type { HeadNeckData } from "./head-neck-plugin";
import { loadModel, type LoadedModel } from "./model-loader";
import { emptySlotInfo, makeSlot, type BoneHandle, type Slot } from "./slot";
import {
  MAX_OFFSET,
  ZERO_OFFSET,
  ZERO_POSE,
  type Axis,
  type BoneKey,
  type CameraPreset,
  type OneFingerMode,
  type Pose,
  type PoseMap,
  type Projection,
  type SlotId,
  type StudioCallbacks,
  type TwoFingerMode,
} from "./types";

export class VrmStudio {
  private readonly host: HTMLElement;
  private readonly callbacks: StudioCallbacks;

  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene = new THREE.Scene();
  private readonly modelsRoot = new THREE.Group();
  private readonly perspectiveCamera = new THREE.PerspectiveCamera(
    35,
    1,
    0.01,
    100,
  );
  private readonly orthoCamera = new THREE.OrthographicCamera(
    -1,
    1,
    1,
    -1,
    -100,
    100,
  );
  private activeCamera: THREE.Camera = this.perspectiveCamera;

  private readonly orbit: OrbitControls;
  private readonly gizmo: TransformControls;
  private readonly gizmoHelper: THREE.Object3D;
  /** Translate gizmo for the Position menu. It drags an invisible proxy that
   *  sits at the active head; the proxy's movement is converted to offsets. */
  private readonly moveGizmo: TransformControls;
  private readonly moveGizmoHelper: THREE.Object3D;
  private readonly moveProxy = new THREE.Object3D();
  private readonly markerGroup = new THREE.Group();
  /** One LOCAL clipping plane per slot, so the shared head-only crop follows
   *  each head when it is moved up/down independently. */
  private readonly clipPlanes: Record<SlotId, THREE.Plane> = {
    A: new THREE.Plane(new THREE.Vector3(0, 1, 0), 1e6),
    B: new THREE.Plane(new THREE.Vector3(0, 1, 0), 1e6),
  };
  private readonly raycaster = new THREE.Raycaster();
  private readonly pointer = new THREE.Vector2();
  private readonly clock = new THREE.Clock();
  private readonly resizeObserver: ResizeObserver;

  private readonly coarsePointer: boolean;
  private oneFingerMode: OneFingerMode = "rotate";
  private twoFingerMode: TwoFingerMode = "zoomPan";

  private readonly slots: Record<SlotId, Slot> = {
    A: makeSlot("A"),
    B: makeSlot("B"),
  };
  private activeSlot: SlotId = "A";
  private selectedBone: BoneKey = "head";

  private gizmoEnabled = false;
  private moveGizmoEnabled = false;
  private projection: Projection = "perspective";
  private transparent = false;
  private bgColor = "#20242f";
  private headOnlyEnabled = false;
  private cropOffsetRatio = 0.03;
  private spacingRatio = 1.8;
  private readonly lookAtCameraSlots: Record<SlotId, boolean> = {
    A: false,
    B: false,
  };

  private center = new THREE.Vector3(0, 0.1, 0);
  private radius = 0.4;
  private width = 1;
  private height = 1;
  private frameId = 0;
  private disposed = false;

  constructor(host: HTMLElement, callbacks: StudioCallbacks) {
    this.host = host;
    this.callbacks = callbacks;
    this.coarsePointer =
      typeof window !== "undefined" &&
      typeof window.matchMedia === "function" &&
      window.matchMedia("(pointer: coarse)").matches;

    this.renderer = new THREE.WebGLRenderer({
      antialias: true,
      alpha: true,
      preserveDrawingBuffer: true,
    });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.setClearColor(new THREE.Color(this.bgColor), 1);
    this.renderer.domElement.style.display = "block";
    this.renderer.domElement.style.width = "100%";
    this.renderer.domElement.style.height = "100%";
    this.renderer.domElement.style.touchAction = "none";
    // Per-slot clipping planes need local clipping enabled globally.
    this.renderer.localClippingEnabled = true;
    this.host.appendChild(this.renderer.domElement);

    const key = new THREE.DirectionalLight(0xffffff, 2.0);
    key.position.set(2, 3, 4);
    const fill = new THREE.DirectionalLight(0xd9e4ff, 0.8);
    fill.position.set(-3, 1, 2);
    const rim = new THREE.DirectionalLight(0xffffff, 0.6);
    rim.position.set(0, 2, -4);
    this.scene.add(new THREE.AmbientLight(0xffffff, 0.9), key, fill, rim);

    this.scene.add(this.modelsRoot);
    for (const id of SLOTS) this.modelsRoot.add(this.slots[id].wrapper);

    this.orbit = new OrbitControls(
      this.perspectiveCamera,
      this.renderer.domElement,
    );
    this.orbit.enableDamping = true;
    this.orbit.dampingFactor = 0.08;
    this.orbit.minDistance = 0.05;
    // Explicit touch mapping (these are also OrbitControls' defaults):
    //   1 finger  -> orbit/rotate, 2 fingers -> pinch zoom + two-finger pan.
    // Both are user-switchable; see setTouchNavigation().
    this.orbit.touches = {
      ONE: THREE.TOUCH.ROTATE,
      TWO: THREE.TOUCH.DOLLY_PAN,
    };

    this.gizmo = new TransformControls(
      this.perspectiveCamera,
      this.renderer.domElement,
    );
    this.gizmo.setMode("rotate");
    this.gizmo.setSpace("world");
    // Larger ring + picker on touch screens, where there is no hover and fingers
    // are much less precise than a mouse.
    this.gizmo.setSize(this.coarsePointer ? 0.85 : 1.0);
    this.gizmoHelper = this.gizmo.getHelper();
    this.gizmoHelper.visible = false;
    this.scene.add(this.gizmoHelper);
    this.gizmo.addEventListener("dragging-changed", (event) => {
      this.orbit.enabled = !(event as unknown as { value: boolean }).value;
    });
    this.gizmo.addEventListener("objectChange", () => this.readPoseFromGizmo());

    this.scene.add(this.moveProxy);
    this.moveGizmo = new TransformControls(
      this.perspectiveCamera,
      this.renderer.domElement,
    );
    this.moveGizmo.setMode("translate");
    this.moveGizmo.setSpace("world");
    this.moveGizmo.setSize(this.coarsePointer ? 0.85 : 1.0);
    this.moveGizmoHelper = this.moveGizmo.getHelper();
    this.moveGizmoHelper.visible = false;
    this.scene.add(this.moveGizmoHelper);
    this.moveGizmo.addEventListener("dragging-changed", (event) => {
      this.orbit.enabled = !(event as unknown as { value: boolean }).value;
    });
    this.moveGizmo.addEventListener("objectChange", () =>
      this.readOffsetFromMoveGizmo(),
    );

    this.createMarkers();
    this.scene.add(this.markerGroup);
    this.markerGroup.visible = false;

    // Capture on the host (the canvas' parent) so marker picking runs BEFORE
    // TransformControls starts a gizmo drag. Otherwise a tap on the head/neck
    // joint that sits inside the rotate gizmo's picker disc is swallowed and
    // never switches the selected bone.
    this.host.addEventListener("pointerdown", this.onPointerDown, true);
    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(this.host);
    this.resize();
    this.animate();
  }

  // -------------------------------------------------------------------------
  // Loading
  // -------------------------------------------------------------------------

  async loadFromFile(slotId: SlotId, file: File): Promise<void> {
    this.revokeSlotUrl(slotId);
    const url = URL.createObjectURL(file);
    this.slots[slotId].objectUrl = url;
    try {
      await this.loadUrl(slotId, url, file.name);
    } finally {
      // The glTF is fully parsed by now; the blob URL is no longer needed.
      this.revokeSlotUrl(slotId);
    }
    this.slots[slotId].source = { kind: "file", file };
  }

  async loadFromUrl(slotId: SlotId, url: string, name = url): Promise<void> {
    await this.loadUrl(slotId, url, name);
    this.slots[slotId].source = { kind: "url", url, name };
  }

  /** Reuse whatever is in slot A for slot B — handy for two identical heads. */
  async duplicateAtoB(): Promise<void> {
    const source = this.slots.A.source;
    if (!source) {
      this.callbacks.onStatus("Load a model into slot A first.");
      return;
    }
    if (source.kind === "file") await this.loadFromFile("B", source.file);
    else await this.loadFromUrl("B", source.url, source.name);
  }

  private async loadUrl(
    slotId: SlotId,
    url: string,
    name: string,
  ): Promise<void> {
    this.callbacks.onStatus(`Loading ${name} into slot ${slotId}…`);
    const loaded = await loadModel(url, (message) =>
      this.callbacks.onStatus(message),
    );
    this.install(slotId, loaded, name);
  }

  clearSlot(slotId: SlotId): void {
    const slot = this.slots[slotId];
    this.gizmo.detach();
    if (slot.root) {
      slot.wrapper.remove(slot.root);
      VRMUtils.deepDispose(slot.root);
      slot.root = null;
    }
    this.revokeSlotUrl(slotId);
    slot.vrm = null;
    slot.bones = {};
    slot.pose = structuredClone(ZERO_POSE);
    slot.morphTargets.clear();
    slot.expressionNames = [];
    slot.source = null;
    slot.info = emptySlotInfo(slotId);
    slot.wrapper.position.set(0, 0, 0);
    this.updateLayout();
    this.syncGizmo();
    this.emitInfo();
    this.callbacks.onStatus(`Slot ${slotId} cleared.`);
    this.callbacks.onPose(this.getPose());
  }

  /** Exchange the models in slots A and B together with their pose, scale,
   *  face, gaze and source. Positions (offsets) stay with the slot, so the two
   *  characters trade places in the layout. */
  swapSlots(): boolean {
    const a = this.slots.A;
    const b = this.slots.B;
    if (!a.root && !b.root) {
      this.callbacks.onStatus("Nothing to swap — both slots are empty.");
      return false;
    }

    this.gizmo.detach();
    this.moveGizmo.detach();
    if (a.root) a.wrapper.remove(a.root);
    if (b.root) b.wrapper.remove(b.root);

    const keys = [
      "root",
      "vrm",
      "bones",
      "pose",
      "modelScale",
      "morphTargets",
      "expressionNames",
      "source",
      "objectUrl",
      "neckOffsetY",
      "headBoneY",
      "headTopY",
      "headCenterY",
      "headHeight",
      "info",
    ] as const;
    const swap = <K extends (typeof keys)[number]>(key: K): void => {
      const tmp = a[key];
      a[key] = b[key];
      b[key] = tmp;
    };
    for (const key of keys) swap(key);
    a.info = { ...a.info, id: "A" };
    b.info = { ...b.info, id: "B" };

    const gaze = this.lookAtCameraSlots.A;
    this.lookAtCameraSlots.A = this.lookAtCameraSlots.B;
    this.lookAtCameraSlots.B = gaze;

    if (a.root) a.wrapper.add(a.root);
    if (b.root) b.wrapper.add(b.root);
    this.attachClipping(a);
    this.attachClipping(b);

    this.updateLayout();
    this.syncGizmo();
    this.emitInfo("Swapped model A and B.");
    this.callbacks.onStatus("Swapped model A and B.");
    this.callbacks.onPose(this.getPose());
    return true;
  }

  private install(slotId: SlotId, loaded: LoadedModel, name: string): void {
    const slot = this.slots[slotId];
    this.clearSlot(slotId);

    const { gltf, vrm, mode } = loaded;
    slot.root = gltf.scene;
    slot.vrm = vrm;
    slot.wrapper.add(gltf.scene);
    this.attachClipping(slot);
    slot.wrapper.scale.setScalar(slot.modelScale);
    slot.wrapper.position.set(0, 0, 0);

    let version = "VRM";
    let headNode: THREE.Object3D | null = null;
    let neckNode: THREE.Object3D | null = null;

    if (mode === "vrm" && vrm) {
      version = vrm.meta?.metaVersion === "0" ? "VRM 0.x" : "VRM 1.0";
      headNode = vrm.humanoid.getNormalizedBoneNode(VRMHumanBoneName.Head);
      neckNode = vrm.humanoid.getNormalizedBoneNode(VRMHumanBoneName.Neck);
      slot.expressionNames =
        vrm.expressionManager?.expressions.map((e) => e.expressionName) ?? [];
    } else {
      const data = gltf.userData["headNeck"] as HeadNeckData | undefined;
      version = data?.version ?? "glTF / GLB";
      if (data?.isVRM0) gltf.scene.rotation.y = Math.PI;
      headNode = data?.bones.head ?? null;
      neckNode = data?.bones.neck ?? null;
    }

    // Align every slot's neck joint to world Y = 0 so ONE clipping plane and
    // ONE camera framing work for both heads, whatever their original scale.
    this.scene.updateMatrixWorld(true);
    const joint = neckNode ?? headNode;
    slot.neckOffsetY = joint
      ? joint.getWorldPosition(new THREE.Vector3()).y / slot.modelScale
      : 0;
    slot.wrapper.position.set(0, -slot.neckOffsetY * slot.modelScale, 0);
    this.scene.updateMatrixWorld(true);

    if (headNode) slot.bones.head = this.captureBone(headNode);
    if (neckNode) slot.bones.neck = this.captureBone(neckNode);
    this.computeHeadMetrics(slot);
    this.collectMorphs(slot, gltf.scene);

    slot.info = {
      id: slotId,
      modelName: name,
      mode,
      version,
      bonesFound: KEYS.filter((k) => !!slot.bones[k]),
      expressions: [...slot.expressionNames],
      morphs: [...slot.morphTargets.keys()].slice(0, 24),
    };

    const found = slot.info.bonesFound;
    const message =
      found.length === 0
        ? "No head/neck bones detected. Check the bone names in your exporter."
        : mode === "gltf"
          ? "Loaded with the tolerant loader (not a complete VRM humanoid)."
          : "Loaded as a full VRM. Only head and neck are exposed.";

    this.callbacks.onStatus(
      `${name} → slot ${slotId} · ${version} · bones: ${found.join(", ") || "none"}`,
    );
    this.finishInstall(slotId, message);
  }

  private finishInstall(slotId: SlotId, message = ""): void {
    this.updateLayout();
    this.resetSlotPose(slotId);
    this.frameHeads();
    this.applyHeadOnly();
    this.syncGizmo();
    this.emitInfo(message);
    this.callbacks.onPose(this.getPose());
  }

  private computeHeadMetrics(slot: Slot): void {
    this.scene.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(slot.wrapper);
    slot.headTopY = box.isEmpty() ? 0.3 : box.max.y;
    const headNode = slot.bones.head?.node;
    slot.headBoneY = headNode
      ? headNode.getWorldPosition(new THREE.Vector3()).y
      : slot.headTopY - 0.2;
    slot.headHeight = Math.max(slot.headTopY - slot.headBoneY, 0.05);
    slot.headCenterY = (slot.headTopY + slot.headBoneY) / 2;
  }

  private captureBone(node: THREE.Object3D): BoneHandle {
    this.scene.updateMatrixWorld(true);
    return {
      node,
      restLocal: node.quaternion.clone(),
      restParentWorld: node.parent
        ? node.parent.getWorldQuaternion(new THREE.Quaternion())
        : new THREE.Quaternion(),
    };
  }

  private collectMorphs(slot: Slot, root: THREE.Object3D): void {
    slot.morphTargets.clear();
    root.traverse((obj) => {
      const mesh = obj as THREE.Mesh;
      if (
        !mesh.isMesh ||
        !mesh.morphTargetDictionary ||
        !mesh.morphTargetInfluences
      )
        return;
      for (const [name, index] of Object.entries(mesh.morphTargetDictionary)) {
        const targets = slot.morphTargets.get(name) ?? [];
        targets.push({ mesh, index });
        slot.morphTargets.set(name, targets);
      }
    });
  }

  /** Give every material in a slot its own clipping plane. The plane object is
   *  kept for the slot's lifetime, so changing the cut height or moving the
   *  head only updates a uniform — no shader recompilation on slider drags. */
  private attachClipping(slot: Slot): void {
    if (!slot.root) return;
    slot.root.traverse((obj) => {
      const mesh = obj as THREE.Mesh;
      if (!mesh.isMesh) return;
      const materials = Array.isArray(mesh.material)
        ? mesh.material
        : [mesh.material];
      for (const material of materials) {
        if (!material) continue;
        material.clippingPlanes = [this.clipPlanes[slot.id]];
        material.needsUpdate = true;
      }
    });
  }

  /** One offset unit = the taller loaded head's height (world units). */
  private layoutUnit(): number {
    const loaded = SLOTS.map((id) => this.slots[id]).filter((s) => !!s.root);
    return Math.max(...loaded.map((s) => s.headHeight), 0.05);
  }

  private revokeSlotUrl(slotId: SlotId): void {
    const slot = this.slots[slotId];
    if (slot.objectUrl) {
      URL.revokeObjectURL(slot.objectUrl);
      slot.objectUrl = null;
    }
  }

  /** Heads sit at ±spacing/2; a single head is centred. Spacing is expressed
   *  in head-heights so it works for full avatars and head-only models alike. */
  setSpacingRatio(ratio: number): void {
    this.spacingRatio = THREE.MathUtils.clamp(ratio, 0.6, 4);
    this.updateLayout();
    if (this.loadedSlotCount() > 0) this.frameHeads();
    this.applyHeadOnly();
    this.emitInfo();
  }

  /** Move ONE model along one axis. Values are in head-height units. The camera
   *  deliberately does NOT auto-reframe, so you can see the composition change. */
  setOffset(slotId: SlotId, axis: Axis, value: number): void {
    const next = THREE.MathUtils.clamp(
      Number(value) || 0,
      -MAX_OFFSET,
      MAX_OFFSET,
    );
    this.slots[slotId].offset = { ...this.slots[slotId].offset, [axis]: next };
    this.updateLayout();
    this.emitInfo();
  }

  setModelScale(slotId: SlotId, scale: number): void {
    const next = Number.isFinite(scale)
      ? THREE.MathUtils.clamp(scale, 0.25, 2.5)
      : 1;
    const slot = this.slots[slotId];
    slot.modelScale = next;
    if (!slot.root) return;

    slot.wrapper.scale.setScalar(next);
    this.updateLayout();
    this.computeHeadMetrics(slot);
    this.updateLayout();
    this.emitInfo();
  }

  resetOffsets(): void {
    for (const id of SLOTS) this.slots[id].offset = { ...ZERO_OFFSET };
    this.updateLayout();
    this.emitInfo();
    this.callbacks.onStatus("Both heads returned to their default positions.");
  }

  /** Symmetric layout: mirror A's X onto B, keep Y and Z the same. */
  mirrorOffsets(): void {
    const a = this.slots.A.offset;
    this.slots.B.offset = { x: -a.x, y: a.y, z: a.z };
    this.updateLayout();
    this.emitInfo();
    this.callbacks.onStatus("Mirrored slot A position onto B (X flipped).");
  }

  private updateLayout(): void {
    const loaded = SLOTS.map((id) => this.slots[id]).filter((s) => !!s.root);
    const unit = this.layoutUnit();
    const spacing = this.spacingRatio * unit;
    for (const slot of loaded) {
      const baseX =
        loaded.length === 1 ? 0 : ((slot.id === "A" ? -1 : 1) * spacing) / 2;
      slot.wrapper.scale.setScalar(slot.modelScale);
      slot.wrapper.position.set(
        baseX + slot.offset.x * unit,
        -slot.neckOffsetY * slot.modelScale + slot.offset.y * unit,
        slot.offset.z * unit,
      );
    }
    this.syncMoveProxy();
    this.scene.updateMatrixWorld(true);
    this.applyHeadOnly();
  }

  /** X position the slot's layout starts from, before its own offset. */
  private slotBaseX(slot: Slot): number {
    if (this.loadedSlotCount() <= 1) return 0;
    return (
      ((slot.id === "A" ? -1 : 1) * (this.spacingRatio * this.layoutUnit())) / 2
    );
  }

  /** Park the proxy on the active head so the move gizmo appears there. */
  private syncMoveProxy(): void {
    const slot = this.slots[this.activeSlot];
    const unit = this.layoutUnit();
    this.moveProxy.position.set(
      this.slotBaseX(slot) + slot.offset.x * unit,
      slot.headCenterY + slot.offset.y * unit,
      slot.offset.z * unit,
    );
    this.moveProxy.updateMatrixWorld(true);
  }

  private readOffsetFromMoveGizmo(): void {
    const slot = this.slots[this.activeSlot];
    const unit = this.layoutUnit();
    const p = this.moveProxy.position;
    const toOffset = (value: number): number =>
      Math.round(THREE.MathUtils.clamp(value, -MAX_OFFSET, MAX_OFFSET) * 1000) /
      1000;
    slot.offset = {
      x: toOffset((p.x - this.slotBaseX(slot)) / unit),
      y: toOffset((p.y - slot.headCenterY) / unit),
      z: toOffset(p.z / unit),
    };
    this.updateLayout(); // also snaps the proxy back if the value was clamped
    this.emitInfo();
  }

  setMoveGizmoEnabled(enabled: boolean): void {
    this.moveGizmoEnabled = enabled;
    this.syncMoveGizmo();
  }

  private syncMoveGizmo(): void {
    const slot = this.slots[this.activeSlot];
    if (this.moveGizmoEnabled && slot.root) {
      this.syncMoveProxy();
      this.moveGizmo.attach(this.moveProxy);
      this.moveGizmoHelper.visible = true;
    } else {
      this.moveGizmo.detach();
      this.moveGizmoHelper.visible = false;
    }
  }

  private loadedSlotCount(): number {
    return SLOTS.filter((id) => !!this.slots[id].root).length;
  }

  // -------------------------------------------------------------------------
  // Selection & posing
  // -------------------------------------------------------------------------

  setActiveSlot(slotId: SlotId): void {
    this.activeSlot = slotId;
    this.syncGizmo();
    this.emitInfo();
    this.callbacks.onSelection(this.activeSlot, this.selectedBone);
  }

  setSelectedBone(bone: BoneKey): void {
    if (!this.slots[this.activeSlot].bones[bone]) return;
    this.selectedBone = bone;
    this.syncGizmo();
    this.callbacks.onSelection(this.activeSlot, this.selectedBone);
  }

  setLookAtCamera(slotId: SlotId, enabled: boolean): void {
    this.lookAtCameraSlots[slotId] = enabled;
  }

  resetGaze(slotId: SlotId): void {
    this.lookAtCameraSlots[slotId] = false;
    const vrm = this.slots[slotId].vrm;
    vrm?.lookAt?.reset();
    vrm?.update(0);
  }

  getPose(): PoseMap {
    return {
      A: structuredClone(this.slots.A.pose),
      B: structuredClone(this.slots.B.pose),
    };
  }

  /** Full composition: both poses + spacing + independent XYZ offsets.
   *  Old angle-only JSON files still load (the `layout` block is optional). */
  getComposition(): Record<string, unknown> {
    return {
      ...this.getPose(),
      layout: {
        spacing: this.spacingRatio,
        offsets: {
          A: { ...this.slots.A.offset },
          B: { ...this.slots.B.offset },
        },
      },
    };
  }

  setAngle(slotId: SlotId, bone: BoneKey, axis: Axis, degrees: number): void {
    const slot = this.slots[slotId];
    if (!slot.bones[bone]) return;
    const value = THREE.MathUtils.clamp(Number(degrees) || 0, -180, 180);
    slot.pose = { ...slot.pose, [bone]: { ...slot.pose[bone], [axis]: value } };
    this.applyPoseToBone(slot, bone);
    this.callbacks.onPose(this.getPose());
  }

  setPose(map: unknown): void {
    for (const id of SLOTS) {
      const slot = this.slots[id];
      const next = structuredClone(ZERO_POSE);
      const raw =
        map && typeof map === "object"
          ? (map as Record<string, unknown>)[id]
          : undefined;
      if (raw && typeof raw === "object") {
        for (const bone of KEYS) {
          const boneRaw = (raw as Record<string, unknown>)[bone];
          if (!boneRaw || typeof boneRaw !== "object") continue;
          for (const axis of ["x", "y", "z"] as Axis[]) {
            const value = (boneRaw as Record<string, unknown>)[axis];
            if (typeof value === "number" && Number.isFinite(value)) {
              next[bone][axis] = THREE.MathUtils.clamp(value, -180, 180);
            }
          }
        }
      }
      slot.pose = next;
      for (const bone of KEYS) this.applyPoseToBone(slot, bone);
    }

    // Optional layout block — absent in pose files saved by earlier versions.
    const layout =
      map && typeof map === "object"
        ? (map as Record<string, unknown>)["layout"]
        : undefined;
    if (layout && typeof layout === "object") {
      const data = layout as Record<string, unknown>;
      if (
        typeof data["spacing"] === "number" &&
        Number.isFinite(data["spacing"])
      ) {
        this.spacingRatio = THREE.MathUtils.clamp(data["spacing"], 0.6, 4);
      }
      const rawOffsets = data["offsets"];
      if (rawOffsets && typeof rawOffsets === "object") {
        for (const id of SLOTS) {
          const raw = (rawOffsets as Record<string, unknown>)[id];
          if (!raw || typeof raw !== "object") continue;
          const next = { ...ZERO_OFFSET };
          for (const axis of ["x", "y", "z"] as Axis[]) {
            const value = (raw as Record<string, unknown>)[axis];
            if (typeof value === "number" && Number.isFinite(value)) {
              next[axis] = THREE.MathUtils.clamp(
                value,
                -MAX_OFFSET,
                MAX_OFFSET,
              );
            }
          }
          this.slots[id].offset = next;
        }
      }
      this.updateLayout();
      if (this.loadedSlotCount() > 0) this.frameHeads();
      this.emitInfo();
    }

    this.callbacks.onPose(this.getPose());
  }

  resetPose(): void {
    this.resetSlotPose(this.activeSlot);
    this.callbacks.onPose(this.getPose());
  }

  resetBothPoses(): void {
    for (const id of SLOTS) this.resetSlotPose(id);
    this.callbacks.onPose(this.getPose());
  }

  /** Copy A's pose onto B with yaw and roll flipped — a symmetric couple pose. */
  mirrorAtoB(): void {
    const source = this.slots.A.pose;
    const mirrored = {} as Pose;
    for (const bone of KEYS) {
      mirrored[bone] = {
        x: source[bone].x,
        y: -source[bone].y,
        z: -source[bone].z,
      };
    }
    this.slots.B.pose = mirrored;
    for (const bone of KEYS) this.applyPoseToBone(this.slots.B, bone);
    this.callbacks.onPose(this.getPose());
    this.callbacks.onStatus("Mirrored slot A onto B — yaw and roll flipped.");
  }

  /** Turn both heads inward by the same amount, e.g. +18° / -18°. */
  faceEachOther(degrees = 18): void {
    const yaw = THREE.MathUtils.clamp(Number(degrees) || 0, 0, 90);
    for (const id of SLOTS) {
      const sign = id === "A" ? 1 : -1;
      const slot = this.slots[id];
      slot.pose = {
        ...slot.pose,
        head: { ...slot.pose.head, y: sign * yaw },
      };
      this.applyPoseToBone(slot, "head");
    }
    this.callbacks.onPose(this.getPose());
    this.callbacks.onStatus(`Heads turned ${yaw}° toward each other.`);
  }

  private resetSlotPose(slotId: SlotId): void {
    const slot = this.slots[slotId];
    slot.pose = structuredClone(ZERO_POSE);
    for (const bone of KEYS) this.applyPoseToBone(slot, bone);
  }

  private applyPoseToBone(slot: Slot, bone: BoneKey): void {
    const handle = slot.bones[bone];
    if (!handle) return;
    const a = slot.pose[bone];
    const worldDelta = new THREE.Quaternion().setFromEuler(
      new THREE.Euler(a.x * DEG, a.y * DEG, a.z * DEG, "YXZ"),
    );
    const invParent = handle.restParentWorld.clone().invert();
    const localDelta = invParent
      .multiply(worldDelta)
      .multiply(handle.restParentWorld);
    handle.node.quaternion.copy(localDelta).multiply(handle.restLocal);
    slot.vrm?.humanoid.update();
  }

  private readPoseFromGizmo(): void {
    const slot = this.slots[this.activeSlot];
    const handle = slot.bones[this.selectedBone];
    if (!handle) return;
    const localDelta = handle.node.quaternion
      .clone()
      .multiply(handle.restLocal.clone().invert());
    const worldDelta = handle.restParentWorld
      .clone()
      .multiply(localDelta)
      .multiply(handle.restParentWorld.clone().invert());
    const euler = new THREE.Euler().setFromQuaternion(worldDelta, "YXZ");
    slot.pose = {
      ...slot.pose,
      [this.selectedBone]: {
        x: THREE.MathUtils.clamp(euler.x * RAD, -180, 180),
        y: THREE.MathUtils.clamp(euler.y * RAD, -180, 180),
        z: THREE.MathUtils.clamp(euler.z * RAD, -180, 180),
      },
    };
    this.callbacks.onPose(this.getPose());
  }

  // -------------------------------------------------------------------------
  // Expressions / morphs (active slot)
  // -------------------------------------------------------------------------

  setExpression(name: string, weight: number): void {
    this.slots[this.activeSlot].vrm?.expressionManager?.setValue(name, weight);
  }

  setMorph(name: string, weight: number): void {
    const slot = this.slots[this.activeSlot];
    for (const target of slot.morphTargets.get(name) ?? []) {
      const influences = target.mesh.morphTargetInfluences;
      if (influences) influences[target.index] = weight;
    }
  }

  resetFace(): void {
    const slot = this.slots[this.activeSlot];
    slot.vrm?.expressionManager?.resetValues();
    for (const name of slot.morphTargets.keys()) {
      for (const target of slot.morphTargets.get(name) ?? []) {
        const influences = target.mesh.morphTargetInfluences;
        if (influences) influences[target.index] = 0;
      }
    }
  }

  // -------------------------------------------------------------------------
  // Camera / gizmo / appearance
  // -------------------------------------------------------------------------

  setGizmoEnabled(enabled: boolean): void {
    this.gizmoEnabled = enabled;
    this.markerGroup.visible = enabled;
    this.syncGizmo();
  }

  /** Rebind touch gestures. Mouse behaviour (left orbit / right pan / wheel zoom)
   *  is unaffected. */
  setTouchNavigation(
    oneFinger: OneFingerMode,
    twoFingers: TwoFingerMode,
  ): void {
    this.oneFingerMode = oneFinger;
    this.twoFingerMode = twoFingers;
    this.orbit.touches = {
      ONE: oneFinger === "pan" ? THREE.TOUCH.PAN : THREE.TOUCH.ROTATE,
      TWO:
        twoFingers === "zoomRotate"
          ? THREE.TOUCH.DOLLY_ROTATE
          : THREE.TOUCH.DOLLY_PAN,
    };
  }

  getTouchNavigation(): {
    oneFinger: OneFingerMode;
    twoFingers: TwoFingerMode;
  } {
    return { oneFinger: this.oneFingerMode, twoFingers: this.twoFingerMode };
  }

  private syncGizmo(): void {
    const handle = this.gizmoEnabled
      ? this.slots[this.activeSlot].bones[this.selectedBone]
      : undefined;
    if (handle) {
      this.gizmo.attach(handle.node);
      this.gizmoHelper.visible = true;
    } else {
      this.gizmo.detach();
      this.gizmoHelper.visible = false;
    }
    this.syncMoveGizmo();
  }

  private presetDirection(preset: CameraPreset): THREE.Vector3 {
    const directions: Record<CameraPreset, THREE.Vector3> = {
      front: new THREE.Vector3(0, 0, 1),
      threeQuarter: new THREE.Vector3(0.85, 0.12, 1).normalize(),
      side: new THREE.Vector3(1, 0, 0),
      back: new THREE.Vector3(0, 0, -1),
      top: new THREE.Vector3(0, 1, 0.001),
    };
    return directions[preset].clone();
  }

  /** Orbit around whatever is currently framed (both heads or one head). */
  setCameraPreset(preset: CameraPreset): void {
    const target = this.orbit.target.clone();
    const distance = this.radius * 3.2;
    this.activeCamera.position
      .copy(target)
      .addScaledVector(this.presetDirection(preset), distance);
    this.activeCamera.lookAt(target);
    this.orbit.update();
  }

  /** Frame ALL geometry (including bodies) — use when the crop is off. */
  frameModel(): void {
    if (this.loadedSlotCount() === 0) return;
    const box = new THREE.Box3().setFromObject(this.modelsRoot);
    if (box.isEmpty()) return;
    const sphere = box.getBoundingSphere(new THREE.Sphere());
    this.center.copy(sphere.center);
    this.radius = Math.max(sphere.radius, 0.02);
    this.applyFrustum();
    this.orbit.target.copy(this.center);
    this.setCameraPreset("front");
    this.applyHeadOnly();
  }

  /** Frame BOTH head regions. This is the default for couple-art references.
   *  Includes each head's independent XYZ offset. */
  frameHeads(): void {
    const loaded = SLOTS.map((id) => this.slots[id]).filter((s) => !!s.root);
    if (loaded.length === 0) return;

    const unit = this.layoutUnit();
    const maxHead = Math.max(...loaded.map((s) => s.headHeight), 0.05);
    const ys = loaded.map((s) => s.headCenterY + s.offset.y * unit);
    const xs = loaded.map((s) => s.wrapper.position.x);
    const zs = loaded.map((s) => s.wrapper.position.z);
    const mid = (values: number[]) =>
      (Math.min(...values) + Math.max(...values)) / 2;
    const centerX = mid(xs);
    const centerY = mid(ys);
    const centerZ = mid(zs);

    const halfHeight = Math.max(
      maxHead * 0.75,
      (Math.max(...ys) - Math.min(...ys)) / 2 + maxHead * 0.6,
    );
    const halfWidth =
      loaded.length === 2
        ? Math.abs(xs[0] - xs[1]) / 2 + maxHead * 0.8
        : maxHead * 0.8;
    const halfDepth = Math.max(...zs.map((z) => Math.abs(z - centerZ)));
    const aspect = this.width / this.height;
    this.radius =
      Math.max(halfHeight, halfWidth / aspect, halfDepth * 0.8, 0.03) * 1.15;
    this.center.set(centerX, centerY, centerZ);
    this.applyFrustum();
    this.orbit.target.copy(this.center);
    this.setCameraPreset("front");
    this.applyHeadOnly();
  }

  /** Frame ONLY the active slot's head (for fine-tuning one of the two). */
  frameHead(): void {
    const slot = this.slots[this.activeSlot];
    if (!slot.root) {
      this.frameHeads();
      return;
    }
    this.radius = Math.max(slot.headHeight * 0.8, 0.03);
    this.center.set(
      slot.wrapper.position.x,
      slot.headCenterY + slot.offset.y * this.layoutUnit(),
      slot.wrapper.position.z,
    );
    this.applyFrustum();
    this.orbit.target.copy(this.center);
    this.setCameraPreset("front");
    this.applyHeadOnly();
  }

  private applyFrustum(): void {
    const distance = this.radius * 3.2;
    this.perspectiveCamera.near = Math.max(this.radius / 100, 0.001);
    this.perspectiveCamera.far = Math.max(distance * 20, 10);
    this.perspectiveCamera.updateProjectionMatrix();
    this.orthoCamera.zoom = 1;
    this.updateOrthoFrustum();
  }

  /** One-click "anime face" view for TWO heads: ortho + 3/4 + both framed. */
  setOrthoHeadView(preset: CameraPreset = "threeQuarter"): void {
    this.setProjection("orthographic");
    this.frameHeads();
    this.setCameraPreset(preset);
  }

  setProjection(projection: Projection): void {
    if (projection === this.projection) return;
    const previous = this.activeCamera;
    const target = this.orbit.target.clone();
    const direction = previous.position.clone().sub(target);
    const previousDistance = Math.max(direction.length(), 1e-6);
    direction.normalize();
    const tanHalfFov = Math.tan(DEG * (this.perspectiveCamera.fov / 2));

    if (projection === "orthographic") {
      const half = previousDistance * tanHalfFov;
      this.orthoCamera.zoom = (this.radius * 1.25) / Math.max(half, 1e-6);
      this.orthoCamera.position
        .copy(target)
        .addScaledVector(direction, previousDistance);
      this.orthoCamera.quaternion.copy(previous.quaternion);
      this.orthoCamera.updateProjectionMatrix();
      this.activeCamera = this.orthoCamera;
    } else {
      const half = (this.radius * 1.25) / Math.max(this.orthoCamera.zoom, 1e-6);
      const distance = half / tanHalfFov;
      this.perspectiveCamera.position
        .copy(target)
        .addScaledVector(direction, distance);
      this.perspectiveCamera.quaternion.copy(previous.quaternion);
      this.activeCamera = this.perspectiveCamera;
    }

    this.orbit.object = this.activeCamera;
    this.gizmo.camera = this.activeCamera;
    this.moveGizmo.camera = this.activeCamera;
    this.projection = projection;
    this.orbit.update();
  }

  /** One crop for both heads, but each plane follows its own head's Y offset,
   *  so raising/lowering a model never moves the cut line relative to its neck. */
  setHeadOnly(enabled: boolean, offsetRatio = this.cropOffsetRatio): void {
    this.headOnlyEnabled = enabled;
    this.cropOffsetRatio = offsetRatio;
    this.applyHeadOnly();
  }

  setCropOffset(offsetRatio: number): void {
    this.cropOffsetRatio = offsetRatio;
    this.applyHeadOnly();
  }

  private applyHeadOnly(): void {
    // No global plane: each slot's materials carry their own plane.
    this.renderer.clippingPlanes = [];
    const active = this.headOnlyEnabled && this.loadedSlotCount() > 0;
    const cutY = this.cropOffsetRatio * this.radius;
    const unit = this.layoutUnit();
    for (const id of SLOTS) {
      const neckWorldY = this.slots[id].offset.y * unit;
      // Keep fragments with worldY >= neckWorldY + cutY, i.e. plane.constant
      // = -(neckWorldY + cutY). A huge positive constant disables clipping.
      this.clipPlanes[id].constant = active ? -(neckWorldY + cutY) : 1e6;
    }
  }

  setBackground(color: string, transparent: boolean): void {
    this.bgColor = color;
    this.transparent = transparent;
    const c = new THREE.Color(color);
    this.scene.background = transparent ? null : c;
    this.renderer.setClearColor(c, transparent ? 0 : 1);
  }

  screenshot(): string {
    const gizmoWasVisible = this.gizmoHelper.visible;
    const markersWereVisible = this.markerGroup.visible;
    const moveGizmoWasVisible = this.moveGizmoHelper.visible;
    this.gizmoHelper.visible = false;
    this.moveGizmoHelper.visible = false;
    this.markerGroup.visible = false;
    this.renderer.render(this.scene, this.activeCamera);
    const dataUrl = this.renderer.domElement.toDataURL("image/png");
    this.gizmoHelper.visible = gizmoWasVisible;
    this.moveGizmoHelper.visible = moveGizmoWasVisible;
    this.markerGroup.visible = markersWereVisible;
    return dataUrl;
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private emitInfo(message = ""): void {
    const loaded = this.loadedSlotCount();
    const defaultMessage =
      loaded === 2
        ? "Two heads ready. Pick A or B below, then pose them independently."
        : loaded === 1
          ? "One head loaded. Add a second via slot B or “Duplicate A → B”."
          : "Load both templates, or load a model into each slot.";
    this.callbacks.onInfo({
      slots: SLOTS.map((id) => ({ ...this.slots[id].info })),
      activeSlot: this.activeSlot,
      spacingRatio: this.spacingRatio,
      offsets: {
        A: { ...this.slots.A.offset },
        B: { ...this.slots.B.offset },
      },
      layoutUnit: this.layoutUnit(),
      message: message || defaultMessage,
    });
  }

  private createMarkers(): void {
    const colors: Record<SlotId, Record<BoneKey, number>> = {
      A: { head: 0xffb454, neck: 0x55d6be },
      B: { head: 0xff7ea8, neck: 0x8aa8ff },
    };
    for (const id of SLOTS) {
      for (const bone of KEYS) {
        const marker = new THREE.Mesh(
          new THREE.SphereGeometry(1, 16, 12),
          new THREE.MeshBasicMaterial({
            color: colors[id][bone],
            depthTest: false,
            transparent: true,
            opacity: 0.9,
          }),
        );
        marker.renderOrder = 999;
        marker.userData["slot"] = id;
        marker.userData["boneKey"] = bone;
        marker.visible = false;
        this.markerGroup.add(marker);
      }
    }
  }

  private onPointerDown = (event: PointerEvent): void => {
    if (!this.gizmoEnabled || this.gizmo.dragging) return;
    const rect = this.renderer.domElement.getBoundingClientRect();
    this.pointer.set(
      ((event.clientX - rect.left) / rect.width) * 2 - 1,
      -((event.clientY - rect.top) / rect.height) * 2 + 1,
    );
    this.scene.updateMatrixWorld(true);
    this.raycaster.setFromCamera(this.pointer, this.activeCamera);
    const markerHits = this.raycaster.intersectObjects(
      this.markerGroup.children,
      false,
    );
    if (markerHits.length > 0) {
      this.activeSlot = markerHits[0].object.userData["slot"] as SlotId;
      this.selectedBone = markerHits[0].object.userData["boneKey"] as BoneKey;
      this.syncGizmo();
      this.emitInfo();
      this.callbacks.onSelection(this.activeSlot, this.selectedBone);
      return;
    }

    const gizmoMeshes: THREE.Object3D[] = [];
    this.gizmoHelper.traverseVisible((object) => {
      const mesh = object as THREE.Mesh;
      if (mesh.isMesh) gizmoMeshes.push(mesh);
    });
    if (this.raycaster.intersectObjects(gizmoMeshes, false).length === 0) {
      this.gizmo.detach();
      this.gizmoHelper.visible = false;
    }
  };

  private resize(): void {
    if (this.disposed) return;
    this.width = Math.max(this.host.clientWidth, 1);
    this.height = Math.max(this.host.clientHeight, 1);
    this.renderer.setSize(this.width, this.height, false);
    this.perspectiveCamera.aspect = this.width / this.height;
    this.perspectiveCamera.updateProjectionMatrix();
    this.updateOrthoFrustum();
  }

  private updateOrthoFrustum(): void {
    const aspect = this.width / this.height;
    const half = this.radius * 1.25;
    this.orthoCamera.left = -half * aspect;
    this.orthoCamera.right = half * aspect;
    this.orthoCamera.top = half;
    this.orthoCamera.bottom = -half;
    this.orthoCamera.near = -this.radius * 20;
    this.orthoCamera.far = this.radius * 20;
    this.orthoCamera.updateProjectionMatrix();
  }

  private animate = (): void => {
    if (this.disposed) return;
    this.frameId = requestAnimationFrame(this.animate);
    const delta = this.clock.getDelta();
    for (const id of SLOTS) {
      const vrm = this.slots[id].vrm;
      if (!vrm) continue;
      if (this.lookAtCameraSlots[id])
        vrm.lookAt?.lookAt(this.activeCamera.position);
      vrm.update(delta);
    }
    this.orbit.update();
    this.scene.updateMatrixWorld();
    this.updateMarkers();
    this.renderer.render(this.scene, this.activeCamera);
  };

  private updateMarkers(): void {
    const size = Math.max(
      this.radius * (this.coarsePointer ? 0.02 : 0.04),
      0.004,
    );
    for (const marker of this.markerGroup.children) {
      const id = marker.userData["slot"] as SlotId;
      const bone = marker.userData["boneKey"] as BoneKey;
      const handle = this.slots[id].bones[bone];
      marker.visible = !!handle;
      if (handle) {
        handle.node.getWorldPosition(marker.position);
        marker.scale.setScalar(size);
      }
    }
  }

  dispose(): void {
    this.disposed = true;
    cancelAnimationFrame(this.frameId);
    this.resizeObserver.disconnect();
    this.host.removeEventListener("pointerdown", this.onPointerDown, true);
    for (const id of SLOTS) {
      const slot = this.slots[id];
      if (slot.root) VRMUtils.deepDispose(slot.root);
      this.revokeSlotUrl(id);
    }
    this.orbit.dispose();
    this.gizmo.dispose();
    this.moveGizmo.dispose();
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }
}
