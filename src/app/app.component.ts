import { UpperCasePipe } from "@angular/common";
import {
  afterNextRender,
  Component,
  computed,
  ElementRef,
  OnDestroy,
  signal,
  viewChild,
} from "@angular/core";
import {
  VrmStudio,
  ZERO_OFFSET_MAP,
  ZERO_POSE_MAP,
  MAX_OFFSET,
  type Axis,
  type BoneKey,
  type CameraPreset,
  type OneFingerMode,
  type PoseMap,
  type Projection,
  type SlotId,
  type TwoFingerMode,
  type SlotInfo,
  type StudioInfo,
} from "./studio";
import {
  BONES,
  CAMERA_PRESETS,
  DEFAULT_MODELS,
  DEFAULT_MODEL_SCALES,
  MAX_MODEL_SCALE,
  MIN_MODEL_SCALE,
  SAVED_MODELS,
  type ControlSection,
} from "./studio.config";
import { readChecked, readNumber, readValue } from "./dom-utils";

@Component({
  selector: "app-root",
  imports: [UpperCasePipe],
  templateUrl: "./app.component.html",
  styleUrl: "./app.component.scss",
})
export class App implements OnDestroy {
  private readonly viewport =
    viewChild.required<ElementRef<HTMLDivElement>>("viewport");
  private studio: VrmStudio | null = null;

  readonly info = signal<StudioInfo>({
    slots: [
      {
        id: "A",
        modelName: "empty",
        mode: "empty",
        version: "—",
        bonesFound: [],
        expressions: [],
        morphs: [],
      },
      {
        id: "B",
        modelName: "empty",
        mode: "empty",
        version: "—",
        bonesFound: [],
        expressions: [],
        morphs: [],
      },
    ],
    activeSlot: "A",
    spacingRatio: 1.8,
    offsets: structuredClone(ZERO_OFFSET_MAP),
    layoutUnit: 0.2,
    message: "",
  });
  readonly activeInfo = computed<SlotInfo>(() => {
    const found = this.info().slots.find((s) => s.id === this.activeSlot());
    return found ?? this.info().slots[0];
  });

  readonly status = signal("Starting WebGL…");
  readonly pose = signal<PoseMap>(structuredClone(ZERO_POSE_MAP));
  readonly activeSlot = signal<SlotId>("A");
  readonly selected = signal<BoneKey>("head");
  readonly gizmoOn = signal(false);
  readonly moveGizmoOn = signal(false);
  readonly lookAtCamera = signal<Record<SlotId, boolean>>({
    A: false,
    B: false,
  });
  readonly modelScales = signal<Record<SlotId, number>>({
    ...DEFAULT_MODEL_SCALES,
  });
  readonly projection = signal<Projection>("perspective");
  readonly bgColor = signal("#20242f");
  readonly transparentBg = signal(false);
  readonly headOnly = signal(false);
  readonly cropOffset = signal(0.03);
  readonly spacing = signal(1.8);
  readonly oneFinger = signal<OneFingerMode>("rotate");
  readonly twoFingers = signal<TwoFingerMode>("zoomPan");
  readonly busy = signal(false);
  readonly dragging = signal(false);
  readonly panelOpen = signal(true);
  readonly activeSection = signal<ControlSection>("models");
  readonly savedModels = signal<Record<SlotId, string>>({ ...DEFAULT_MODELS });
  readonly expressionValues = signal<Record<SlotId, Record<string, number>>>({
    A: {},
    B: {},
  });
  readonly morphValues = signal<Record<SlotId, Record<string, number>>>({
    A: {},
    B: {},
  });

  readonly maxOffset = MAX_OFFSET;
  readonly savedModelsList = SAVED_MODELS;
  readonly axes: Axis[] = ["x", "y", "z"];
  readonly slots: SlotId[] = ["A", "B"];
  readonly bones = BONES;
  readonly presets = CAMERA_PRESETS;

  constructor() {
    afterNextRender(() => {
      this.studio = new VrmStudio(this.viewport().nativeElement, {
        onInfo: (info) => {
          this.info.set(info);
          this.spacing.set(info.spacingRatio);
        },
        onStatus: (message) => this.status.set(message),
        onPose: (pose) => this.pose.set(pose),
        onSelection: (slot, bone) => {
          this.activeSlot.set(slot);
          this.selected.set(bone);
        },
      });
      this.studio.setBackground(this.bgColor(), this.transparentBg());
      void this.loadTemplates();
    });
  }

  // -- model loading --------------------------------------------------------

  async onFile(slotId: SlotId, event: Event): Promise<void> {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    input.value = "";
    if (file)
      await this.runLoad(
        () => this.studio!.loadFromFile(slotId, file),
        [slotId],
      );
  }

  onDragOver(event: DragEvent): void {
    event.preventDefault();
    this.dragging.set(true);
  }

  onDragLeave(): void {
    this.dragging.set(false);
  }

  async onDrop(event: DragEvent): Promise<void> {
    event.preventDefault();
    this.dragging.set(false);
    const file = event.dataTransfer?.files?.[0];
    if (file) {
      const slot = this.activeSlot();
      await this.runLoad(() => this.studio!.loadFromFile(slot, file), [slot]);
    }
  }

  setSavedModel(slotId: SlotId, event: Event): void {
    const fileName = readValue(event);
    this.savedModels.update((models) => ({ ...models, [slotId]: fileName }));
  }

  async loadSavedModel(slotId: SlotId): Promise<void> {
    await this.runLoad(() => this.loadSelectedModel(slotId), [slotId]);
  }

  async loadTemplates(): Promise<void> {
    await this.runLoad(async () => {
      const results = await Promise.allSettled(
        this.slots.map((slot) => this.loadSelectedModel(slot)),
      );
      const failures = results.flatMap((result, index) => {
        if (result.status === "fulfilled") return [];
        const reason =
          result.reason instanceof Error
            ? result.reason.message
            : String(result.reason);
        const fileName = this.savedModels()[this.slots[index]];
        return [`${fileName}: ${reason}`];
      });
      if (failures.length) throw new Error(failures.join("; "));
    }, ["A", "B"]);
  }

  private loadSelectedModel(slotId: SlotId): Promise<void> {
    const fileName = this.savedModels()[slotId];
    const model = SAVED_MODELS.find(
      (candidate) => candidate.fileName === fileName,
    );
    if (!model) throw new Error(`Unknown saved model: ${fileName}`);
    const url = new URL(`models/${model.fileName}`, document.baseURI).href;
    return this.studio!.loadFromUrl(slotId, url, model.name);
  }

  selectSection(section: ControlSection): void {
    this.activeSection.set(section);
  }

  togglePanel(): void {
    this.panelOpen.update((open) => !open);
  }

  async duplicateAtoB(): Promise<void> {
    await this.runLoad(() => this.studio!.duplicateAtoB(), ["B"]);
  }

  clearSlot(slotId: SlotId): void {
    this.studio?.clearSlot(slotId);
    this.resetFaceValues([slotId]);
  }

  private async runLoad(
    task: () => Promise<void>,
    slots: SlotId[] = [this.activeSlot()],
  ): Promise<void> {
    if (!this.studio) return;
    this.busy.set(true);
    try {
      await task();
      this.resetFaceValues(slots);
    } catch (error) {
      this.status.set(
        `Load failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      this.busy.set(false);
    }
  }

  // -- selection & posing ---------------------------------------------------

  selectSlot(slotId: SlotId): void {
    this.activeSlot.set(slotId);
    this.studio?.setActiveSlot(slotId);
  }

  selectBone(bone: BoneKey): void {
    this.selected.set(bone);
    this.studio?.setSelectedBone(bone);
  }

  setAngle(axis: Axis, event: Event): void {
    const degrees = readNumber(event);
    this.studio?.setAngle(this.activeSlot(), this.selected(), axis, degrees);
  }

  setLookAtCamera(event: Event): void {
    const slot = this.activeSlot();
    const enabled = readChecked(event);
    this.lookAtCamera.update((states) => ({ ...states, [slot]: enabled }));
    this.studio?.setLookAtCamera(slot, enabled);
  }

  resetGaze(): void {
    const slot = this.activeSlot();
    this.lookAtCamera.update((states) => ({ ...states, [slot]: false }));
    this.studio?.resetGaze(slot);
  }

  resetPose(): void {
    this.studio?.resetPose();
  }

  resetBothPoses(): void {
    this.studio?.resetBothPoses();
  }

  mirrorAtoB(): void {
    this.studio?.mirrorAtoB();
  }

  faceEachOther(): void {
    this.studio?.faceEachOther(18);
  }

  savePose(): void {
    const composition = this.studio?.getComposition() ?? this.pose();
    const blob = new Blob([JSON.stringify(composition, null, 2)], {
      type: "application/json",
    });
    this.downloadBlob(blob, "two-head-composition.json");
  }

  async onPoseFile(event: Event): Promise<void> {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    input.value = "";
    if (!file) return;
    try {
      this.studio?.setPose(JSON.parse(await file.text()));
    } catch {
      this.status.set("That pose file is not valid JSON.");
    }
  }

  setSpacing(event: Event): void {
    const value = readNumber(event);
    this.spacing.set(value);
    this.studio?.setSpacingRatio(value);
  }

  setOffset(axis: Axis, event: Event): void {
    const value = readNumber(event);
    this.studio?.setOffset(this.activeSlot(), axis, value);
  }

  setModelScale(event: Event): void {
    const scale = readNumber(event);
    this.applyModelScale(scale);
  }

  setModelScaleNumber(event: Event): void {
    const input = event.target as HTMLInputElement;
    const scale = Number(input.value);
    if (!Number.isFinite(scale)) return;
    const clampedScale = Math.min(
      MAX_MODEL_SCALE,
      Math.max(MIN_MODEL_SCALE, scale),
    );
    input.value = String(clampedScale);
    this.applyModelScale(clampedScale);
  }

  private applyModelScale(scale: number): void {
    const slot = this.activeSlot();
    this.modelScales.update((scales) => ({ ...scales, [slot]: scale }));
    this.studio?.setModelScale(slot, scale);
  }

  resetModelScale(): void {
    const slot = this.activeSlot();
    this.modelScales.update((scales) => ({
      ...scales,
      [slot]: DEFAULT_MODEL_SCALES[slot],
    }));
    this.studio?.setModelScale(slot, this.modelScales()[slot]);
  }

  resetPositions(): void {
    this.studio?.resetOffsets();
  }

  mirrorPositions(): void {
    this.studio?.mirrorOffsets();
  }

  positionLabel(axis: Axis): string {
    return axis === "x"
      ? "X · left / right"
      : axis === "y"
        ? "Y · up / down"
        : "Z · near / far";
  }

  // -- face -----------------------------------------------------------------

  setExpression(name: string, event: Event): void {
    const weight = readNumber(event);
    const slot = this.activeSlot();
    this.expressionValues.update((v) => ({
      ...v,
      [slot]: { ...v[slot], [name]: weight },
    }));
    this.studio?.setExpression(name, weight);
  }

  setMorph(name: string, event: Event): void {
    const weight = readNumber(event);
    const slot = this.activeSlot();
    this.morphValues.update((v) => ({
      ...v,
      [slot]: { ...v[slot], [name]: weight },
    }));
    this.studio?.setMorph(name, weight);
  }

  resetFace(): void {
    this.studio?.resetFace();
    this.resetFaceValues([this.activeSlot()]);
  }

  private resetFaceValues(slots: SlotId[]): void {
    this.expressionValues.update((v) => {
      const next = { ...v };
      for (const slot of slots) next[slot] = {};
      return next;
    });
    this.morphValues.update((v) => {
      const next = { ...v };
      for (const slot of slots) next[slot] = {};
      return next;
    });
  }

  // -- camera / appearance --------------------------------------------------

  setPreset(preset: CameraPreset): void {
    this.studio?.setCameraPreset(preset);
  }

  frameModel(): void {
    this.studio?.frameModel();
  }

  frameHeads(): void {
    this.studio?.frameHeads();
  }

  frameHead(): void {
    this.studio?.frameHead();
  }

  setProjection(projection: Projection): void {
    this.projection.set(projection);
    this.studio?.setProjection(projection);
  }

  orthoHeadView(): void {
    this.projection.set("orthographic");
    this.studio?.setOrthoHeadView("threeQuarter");
  }

  setGizmo(event: Event): void {
    const enabled = readChecked(event);
    this.gizmoOn.set(enabled);
    this.studio?.setGizmoEnabled(enabled);
  }

  setMoveGizmo(event: Event): void {
    const enabled = readChecked(event);
    this.moveGizmoOn.set(enabled);
    this.studio?.setMoveGizmoEnabled(enabled);
  }

  setOneFinger(mode: OneFingerMode): void {
    this.oneFinger.set(mode);
    this.studio?.setTouchNavigation(mode, this.twoFingers());
  }

  setTwoFingers(mode: TwoFingerMode): void {
    this.twoFingers.set(mode);
    this.studio?.setTouchNavigation(this.oneFinger(), mode);
  }

  setBackground(event: Event): void {
    const color = (event.target as HTMLInputElement).value;
    this.bgColor.set(color);
    this.studio?.setBackground(color, this.transparentBg());
  }

  setTransparent(event: Event): void {
    const transparent = readChecked(event);
    this.transparentBg.set(transparent);
    this.studio?.setBackground(this.bgColor(), transparent);
  }

  setHeadOnly(event: Event): void {
    const enabled = readChecked(event);
    this.headOnly.set(enabled);
    this.studio?.setHeadOnly(enabled, this.cropOffset());
  }

  setCropOffset(event: Event): void {
    const value = readNumber(event);
    this.cropOffset.set(value);
    this.studio?.setCropOffset(value);
  }

  savePng(): void {
    const url = this.studio?.screenshot();
    if (!url) return;
    const link = document.createElement("a");
    link.href = url;
    link.download = `couple-reference-${Date.now()}.png`;
    link.click();
  }

  // -- helpers --------------------------------------------------------------

  slotInfo(id: SlotId): SlotInfo {
    return this.info().slots.find((s) => s.id === id) ?? this.info().slots[0];
  }

  axisLabel(axis: Axis): string {
    return axis === "x"
      ? "Pitch · nod"
      : axis === "y"
        ? "Yaw · turn"
        : "Roll · tilt";
  }

  round(value: number): number {
    return Math.round(value);
  }

  round2(value: number): number {
    return Math.round(value * 100) / 100;
  }

  private downloadBlob(blob: Blob, filename: string): void {
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = filename;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  ngOnDestroy(): void {
    this.studio?.dispose();
  }
}
