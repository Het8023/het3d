<template>
    <div
        ref="hostRef"
        class="scene-canvas"
        tabindex="0"
        @dragover.prevent
        @drop.prevent="handleDrop">
        <div v-if="loading" class="canvas-status">
            <span class="canvas-loading-spinner"></span>
            <span>Loading scene</span>
        </div>
        <component
            :is="resolvedDevicePopoverComponent"
            v-if="resolvedDevicePopoverComponent"
            ref="devicePopoverRef"
            variant="floating" />
        <component
            :is="resolvedDevicePopoverComponent"
            v-if="resolvedDevicePopoverComponent"
            ref="sceneBuiltInDevicePopoverRef"
            variant="builtIn"
            @close="handleSceneBuiltInDevicePopoverClose" />
    </div>
</template>

<script setup>
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import * as BABYLON from "@babylonjs/core";
import "@babylonjs/loaders/glTF";
import {
    cloneData,
    createId,
    createSceneObject,
    deleteModelsByIds,
    findModelById,
    flattenModels,
    defaultCamera,
    defaultCanvas,
    defaultLights,
    normalizeScene,
    normalizeSceneModelSources,
    normalizeLights,
    updateModelById,
} from "../utils/sceneObjects";
import { createHet3dApi } from "../utils/het3dApi";
import { createAnimationRuntime } from "./animationRuntime.js";
import { createModelExplodeRuntime } from "./modelExplodeRuntime.js";
import { createModelImportRuntime } from "./modelImportRuntime.js";
import { createSceneDataPolling } from "./sceneDataPolling.js";
import { createSceneVisuals } from "./sceneVisuals.js";
import {
    createObjectEventRuntime,
    isExecutableObjectEvent,
    sanitizeSceneEventPayload,
} from "./objectEventRuntime.js";
import { het3dEventBus } from "../utils/eventBus";

defineOptions({
    name: "Het3d",
});

const props = defineProps({
    projectId: { type: String, default: "" },
    sceneId: { type: String, default: "" },
    sceneData: { type: Object, default: null },
    mode: { type: String, default: "edit" },
    selectedIds: { type: Array, default: () => [] },
    sceneLoader: { type: Function, default: null },
    projectSceneLoader: { type: Function, default: null },
    assetLoader: { type: Function, default: null },
    requestHandler: { type: Function, default: null },
    eventBus: { type: Object, default: null },
    devicePopoverComponent: { type: [Object, Function, String], default: null },
    notify: { type: Function, default: null },
    installGlobal: { type: Boolean, default: true },
    dracoDecoderPath: { type: String, default: "/draco/" },
});

const emit = defineEmits([
    "select",
    "scene-ready",
    "scene-change",
    "thumbnail-ready",
    "device-popover",
    "animation-catalog-ready",
    "animation-state-change",
    "animation-finish",
    "animation-error",
    "message",
]);

const hostRef = ref(null);
const loading = ref(false);
const devicePopoverRef = ref(null);
const sceneBuiltInDevicePopoverRef = ref(null);
const resolvedDevicePopoverComponent = computed(() => props.devicePopoverComponent || null);

let canvas;
let engine;
let scene;
let camera;
let controls;
let gizmoManager;
let contentRoot;
let gridHelper;
let axesHelper;
let ambientLight;
let directionalLight;
let resizeObserver;
let rangeUpdateFrameId;
let sceneState = null;
let suppressPropSync = false;
let directDrag = null;
let axisTransform = null;
let axisHighlightLock = null;
let pendingViewClick = null;
let pendingEditPointer = null;
let cameraDrag = null;
let transformDragging = false;
let pendingTransformChange = false;
let previousHet3dDescriptor = null;
let hasPreviousHet3dDescriptor = false;
let copiedSceneObjects = [];
let pasteSerial = 0;

const objectMap = new Map();
const selectionPickMap = new Map();
const selectionHelpers = [];
const assetSceneCache = new Map();
const gizmoObserverDisposers = [];
const maxSelectionHelpers = 80;
const selectionHelperColor = BABYLON.Color3.FromHexString("#ffc400");

const sceneVisuals = createSceneVisuals({ getScene: () => scene });
const {
    createStandardMaterial,
    createIconMaterial,
    createLabelMaterial,
    setSceneObjectMetadata,
    applyTransform,
    toVector3,
    vectorToData,
    getNodeRotation,
} = sceneVisuals;

const animationRuntime = createAnimationRuntime({
    getMode: () => props.mode,
    getSceneState: () => sceneState,
    getObjectData: (objectId) => getObjectData(objectId),
    getObjectNode: (objectId) => objectMap.get(objectId) || null,
    getAllObjects: () => flattenModels(sceneState?.models || []),
    emit: emitAnimationRuntimeEvent,
    notify: (type, message) => notifyMessage(type, message),
});

const modelImportRuntime = createModelImportRuntime({
    getScene: () => scene,
    getSceneState: () => sceneState,
    getAssetLoader: () => props.assetLoader,
    objectMap,
    selectionPickMap,
    assetSceneCache,
    animationRuntime,
    setSceneObjectMetadata,
    applyTransform,
    toVector3,
    vectorToData,
    getNodeRotation,
    getNodeBounds,
    isBoundsEmpty,
    getBoundsSize: boundsSize,
    getBoundsCenter: boundsCenter,
    worldToLocal,
    round,
});
const {
    getObjectModelPath,
    readBlobAsDataUrl,
    createImportedModel,
    importModelRuntime,
    disposeAnimationGroups,
    createCachedModelMetadata,
    getNodeMeshes,
    createLayerObjectData,
    removeLayerMeshObjects,
    getOriginOffsetForObject,
    shouldApplyMaterialColor,
    applyMaterialColorToObject,
    migrateImportedMeshesToLayers,
} = modelImportRuntime;

const modelExplodeRuntime = createModelExplodeRuntime({
    getMode: () => props.mode,
    getSceneState: () => sceneState,
    getObjectData,
    getObjectNode: (objectId) => objectMap.get(objectId) || null,
    getNodeBounds,
    isBoundsEmpty,
    getBoundsSize: boundsSize,
    toVector3,
    vectorToData,
    refreshImportedModelSelectionProxy,
    updateSelectionHelpers,
    sanitizeEventPayload: (payload) => sanitizeSceneEventPayload(payload, vectorToData),
    emitEvent: emitCanvasEvent,
    onSceneChange: emitSceneChange,
});
const explodeModel = modelExplodeRuntime.explodeModel;

const objectEventRuntime = createObjectEventRuntime({
    BABYLON,
    animationRuntime,
    explodeModel,
    getSceneState: () => sceneState,
    getObjectData,
    getObjectNode: (objectId) => objectMap.get(objectId) || null,
    getScene: () => scene,
    getCamera: () => camera,
    getControls: () => controls,
    getHet3dApi: () => canvasHet3dApi,
    getHostElement: () => hostRef.value,
    getFloatingDevicePopover: () => devicePopoverRef.value,
    getBuiltInDevicePopover: () => sceneBuiltInDevicePopoverRef.value,
    hasDevicePopoverComponent: () => Boolean(resolvedDevicePopoverComponent.value),
    getObjectScreenAnchor,
    vectorToData,
    emitDevicePopover: (payload) => emit("device-popover", payload),
    notify: notifyMessage,
});
const {
    runObjectEvents,
    showPublicDevicePopover,
    updateBuiltInDevicePopoverAnchor: updateSceneBuiltInDevicePopoverAnchor,
    beginViewClick,
    consumeFloatingPopoverOpened,
    hideFloatingDevicePopover,
    hideAllDevicePopovers,
    handleBuiltInDevicePopoverClose: handleSceneBuiltInDevicePopoverClose,
    isTriggerRunning: isObjectEventTriggerRunning,
} = objectEventRuntime;

const sceneDataPolling = createSceneDataPolling({
    getMode: () => props.mode,
    getSceneState: () => sceneState,
    getRequestHandler: () => props.requestHandler,
    getObjectData,
    runObjectEvents,
    isExecutableObjectEvent,
    isObjectEventTriggerRunning,
    onSceneChange: emitSceneChange,
});

const canvasHet3dApi = createHet3dApi({
    getSceneData: () => sceneState,
    getPublicSceneData: getCanvasPublicSceneData,
    getActiveObjects: getCanvasActiveObjects,
    updateObject: updateSceneObject,
    onChange: sceneDataPolling.handleValueChange,
    getSetValueOptions: sceneDataPolling.getSetValueOptions,
    extra: {
        showDevicePopover: showPublicDevicePopover,
        explodeModel,
        getAnimationCatalog: animationRuntime.getAnimationCatalog,
        playObjectAnimations: animationRuntime.playObjectAnimations,
        playAnimation: animationRuntime.playAnimation,
        pauseAnimation: animationRuntime.pauseAnimation,
        resumeAnimation: animationRuntime.resumeAnimation,
        stopAnimation: animationRuntime.stopAnimation,
        restartAnimation: animationRuntime.restartAnimation,
        seekAnimation: animationRuntime.seekAnimation,
        getAnimationState: animationRuntime.getAnimationState,
        stopAllAnimations: animationRuntime.stopAllAnimations,
        applyAnimationSettings: animationRuntime.applyAnimationSettings,
        on: onCanvasEvent,
        off: offCanvasEvent,
        once: onceCanvasEvent,
        emit: emitCanvasEvent,
    },
});

onMounted(async () => {
    initBabylon();
    installCanvasHet3dGlobal();
    document.addEventListener("visibilitychange", handleDocumentVisibilityChange);
    await loadInitialScene();
});

onBeforeUnmount(() => {
    restoreCanvasHet3dGlobal();
    document.removeEventListener("visibilitychange", handleDocumentVisibilityChange);
    animationRuntime.clear({ disposeGroups: true });
    sceneDataPolling.clear();
    cancelAnimationFrame(rangeUpdateFrameId);
    resizeObserver?.disconnect();
    canvas?.removeEventListener("pointerdown", handlePointerDown);
    canvas?.removeEventListener("dblclick", handleDoubleClick);
    canvas?.removeEventListener("wheel", handleCanvasWheel);
    canvas?.removeEventListener("contextmenu", handleCanvasContextMenu);
    window.removeEventListener("pointermove", handlePointerMove);
    window.removeEventListener("pointerup", handlePointerUp);
    clearSelectionHelpers();
    clearGizmoObservers();
    unlockAxisHighlight();
    gizmoManager?.dispose();
    engine?.stopRenderLoop();
    scene?.dispose();
    engine?.dispose();
    hostRef.value?.replaceChildren();
});

watch(
    () => props.sceneData,
    async (value) => {
        if (!value || suppressPropSync) return;
        if (sceneState?.id === value.id) return;
        await loadSceneData(value);
    },
);

watch(
    () => props.selectedIds,
    (ids) => {
        applySelection(ids || [], false);
    },
    { deep: true },
);

function initBabylon() {
    canvas = document.createElement("canvas");
    canvas.className = "scene-canvas-element";
    hostRef.value.appendChild(canvas);

    engine = new BABYLON.Engine(canvas, true, {
        preserveDrawingBuffer: true,
        stencil: true,
        antialias: true,
    });
    engine.setHardwareScalingLevel(Math.max(1 / Math.min(window.devicePixelRatio || 1, 2), 0.5));

    scene = new BABYLON.Scene(engine);
    scene.useRightHandedSystem = false;
    scene.skipPointerMovePicking = true;
    contentRoot = new BABYLON.TransformNode("contentRoot", scene);

    const { width, height } = getHostSize();
    camera = new BABYLON.ArcRotateCamera(
        "camera",
        -Math.PI / 4,
        Math.PI / 3,
        8,
        BABYLON.Vector3.Zero(),
        scene,
    );
    controls = camera;
    camera.minZ = 0.01;
    camera.maxZ = 100000;
    camera.lowerRadiusLimit = 0.0001;
    camera.upperRadiusLimit = null;
    camera.panningSensibility = 85;
    camera.attachControl(canvas, true);
    disableDefaultPointerCameraInput();
    disableDefaultWheelCameraInput();
    applyCameraSettings({
        ...defaultCamera(),
        position: { x: 5, y: 5, z: 6 },
        target: { x: 0, y: 0.5, z: 0 },
    });

    gizmoManager = new BABYLON.GizmoManager(scene);
    gizmoManager.usePointerToAttachGizmos = false;
    gizmoManager.clearGizmoOnEmptyPointerEvent = false;
    gizmoManager.scaleRatio = 1.1;
    setTransformMode("translate");

    applyCanvasSettings(props.sceneData?.canvas || defaultCanvas());
    applyLightSettings(defaultLights());

    canvas.addEventListener("pointerdown", handlePointerDown);
    canvas.addEventListener("dblclick", handleDoubleClick);
    canvas.addEventListener("wheel", handleCanvasWheel, { passive: false });
    canvas.addEventListener("contextmenu", handleCanvasContextMenu);
    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", handlePointerUp);

    resizeObserver = new ResizeObserver(resizeRenderer);
    resizeObserver.observe(hostRef.value);

    engine.runRenderLoop(() => {
        animationRuntime.update();
        modelExplodeRuntime.update();
        updateSceneBuiltInDevicePopoverAnchor();
        scene.render();
    });
    engine.resize(width, height);
}

async function loadInitialScene() {
    if (props.sceneData) {
        await loadSceneData(props.sceneData);
        return;
    }
    if (props.sceneId) {
        await loadScene(props.sceneId);
        return;
    }
    if (props.projectId) {
        const data = await loadProjectScene(props.projectId);
        if (data) await loadSceneData(data);
    }
}

async function loadScene(sceneId) {
    const data = await props.sceneLoader?.(sceneId);
    if (data) await loadSceneData(data);
    return data || null;
}

async function loadProjectScene(projectId) {
    if (!props.projectSceneLoader) {
        notifyMessage("warning", "projectId was provided, but no projectSceneLoader prop is configured");
        return null;
    }
    return (await props.projectSceneLoader(projectId)) || null;
}

async function loadSceneData(data) {
    loading.value = true;
    animationRuntime.clear({ disposeGroups: true });
    sceneState = normalizeScene(data);
    sceneDataPolling.reset();
    modelExplodeRuntime.reset();
    hideAllDevicePopovers();

    const migratedToLayers = await migrateImportedMeshesToLayers(sceneState);
    objectMap.clear();
    selectionPickMap.clear();
    clearSelectionHelpers();
    detachGizmo();
    clearContentRoot();

    applyCanvasSettings(sceneState.canvas);
    applyLightSettings(sceneState.lights);
    applyCameraSettings(sceneState.camera);

    for (const objectData of sceneState.models) {
        if (!isRenderableObject(objectData)) continue;
        const node = await createBabylonObject(objectData);
        objectMap.set(objectData.id, node);
        node.parent = contentRoot;
    }

    updateCameraRangeToScene();
    updateGridToScene();
    applySelection(props.selectedIds || sceneState.editorState?.selectedIds || [], false);
    loading.value = false;
    sceneDataPolling.restart({ immediate: props.mode === "view" });
    emit("scene-ready", { scene: normalizeSceneModelSources(sceneState) });
    animationRuntime.startAutoPlay();
    if (migratedToLayers) emitSceneChange();
}

function clearContentRoot() {
    [...contentRoot.getChildren()].forEach((node) => node.dispose(false, true));
}

function isRenderableObject(objectData) {
    return !["importedLayer", "importedMesh"].includes(objectData.type) && objectData.visible !== false;
}

async function createBabylonObject(objectData) {
    let node;
    const color = objectData.material?.color || "#4f7cff";

    if (objectData.type === "sphere") {
        node = BABYLON.MeshBuilder.CreateSphere("sphere", { diameter: 1.1, segments: 36 }, scene);
        node.material = createStandardMaterial(color);
    } else if (objectData.type === "cylinder") {
        node = BABYLON.MeshBuilder.CreateCylinder(
            "cylinder",
            { height: 1.2, diameterTop: 0.9, diameterBottom: 0.9, tessellation: 36 },
            scene,
        );
        node.material = createStandardMaterial(color);
    } else if (objectData.type === "plane") {
        node = BABYLON.MeshBuilder.CreatePlane("plane", { width: 1.6, height: 1.6, sideOrientation: BABYLON.Mesh.DOUBLESIDE }, scene);
        node.material = createStandardMaterial(color, true);
    } else if (objectData.type === "icon") {
        node = BABYLON.MeshBuilder.CreatePlane("icon", { width: 1, height: 1, sideOrientation: BABYLON.Mesh.DOUBLESIDE }, scene);
        node.billboardMode = BABYLON.Mesh.BILLBOARDMODE_ALL;
        node.material = createIconMaterial(objectData.material?.symbol || "*", color, objectData.material?.shape);
    } else if (objectData.type === "image") {
        node = BABYLON.MeshBuilder.CreatePlane("image", { width: 1.8, height: 1.15, sideOrientation: BABYLON.Mesh.DOUBLESIDE }, scene);
        node.material = createLabelMaterial(objectData.name, color);
    } else if (objectData.type === "importedModel") {
        node = await createImportedModel(objectData);
    } else {
        node = BABYLON.MeshBuilder.CreateBox("box", { size: 1 }, scene);
        node.material = createStandardMaterial(color);
    }

    node.name = objectData.name;
    setSceneObjectMetadata(node, objectData.id);
    applyTransform(node, objectData);
    node.setEnabled(objectData.visible !== false);
    if (objectData.type !== "importedModel") {
        getNodeMeshes(node).forEach((mesh) => {
            setSceneObjectMetadata(mesh, objectData.id);
            mesh.isPickable = true;
        });
    }
    return node;
}

function applyCanvasSettings(canvasSettings = {}) {
    if (!engine || !scene) return;
    if (sceneState) sceneState.canvas = { ...sceneState.canvas, ...canvasSettings };
    const color = canvasSettings.backgroundColor || "#f5f7fb";
    scene.clearColor = BABYLON.Color4.FromHexString(`${color}ff`);
    if (gridHelper) {
        gridHelper.dispose(false, true);
        gridHelper = null;
    }
    if (axesHelper) {
        axesHelper.dispose(false, true);
        axesHelper = null;
    }
    updateGridToScene(canvasSettings);
    if (canvasSettings.showAxes !== false) {
        axesHelper = createAxesHelper(getAxesHelperSize(canvasSettings));
    }
}

function getAxesHelperSize(canvasSettings = {}) {
    const value = Number(canvasSettings.axesSize);
    return Number.isFinite(value) ? clamp(value, 0.1, 1000000) : 3;
}

function applyLightSettings(lightSettings = defaultLights()) {
    if (!scene) return;
    const lights = normalizeLights(lightSettings);
    if (!ambientLight) {
        ambientLight = new BABYLON.HemisphericLight("ambient", new BABYLON.Vector3(0, 1, 0), scene);
    }
    if (!directionalLight) {
        directionalLight = new BABYLON.DirectionalLight("directional", new BABYLON.Vector3(-1, -2, -1), scene);
    }
    ambientLight.diffuse = BABYLON.Color3.FromHexString(lights.ambient.color);
    ambientLight.groundColor = BABYLON.Color3.FromHexString("#aab7c4");
    ambientLight.intensity = lights.ambient.intensity;
    directionalLight.diffuse = BABYLON.Color3.FromHexString(lights.directional.color);
    directionalLight.intensity = lights.directional.intensity;
    directionalLight.position = toVector3(lights.directional.position, { x: 4, y: 8, z: 5 });
    directionalLight.direction = directionalLight.position.scale(-1).normalize();
    if (sceneState) sceneState.lights = cloneData(lights);
}

function applyCameraSettings(cameraSettings = defaultCamera()) {
    if (!camera) return;
    const position = cameraSettings.position || defaultCamera().position;
    const target = cameraSettings.target || defaultCamera().target;
    camera.setTarget(toVector3(target, { x: 0, y: 0, z: 0 }));
    camera.setPosition(toVector3(position, { x: 5, y: 5, z: 6 }));
    camera.minZ = cameraSettings.near || camera.minZ || 0.01;
    camera.maxZ = cameraSettings.far || camera.maxZ || 100000;
    camera.lowerRadiusLimit = 0.0001;
    camera.upperRadiusLimit = null;
    updateCameraRangeToScene();
    syncCameraToState();
}

function syncCameraToState() {
    if (!sceneState || !camera) return;
    sceneState.camera = {
        position: vectorToData(camera.position),
        target: vectorToData(camera.target),
        near: round(camera.minZ),
        far: round(camera.maxZ),
    };
}

function getSceneBounds() {
    const bounds = createEmptyBounds();
    contentRoot?.getChildren().forEach((node) => {
        if (node.isEnabled?.() !== false) expandBounds(bounds, getNodeBounds(node));
    });
    return bounds;
}

function updateGridToScene(canvasSettings = sceneState?.canvas || {}) {
    if (!scene) return;
    if (gridHelper) {
        gridHelper.dispose(false, true);
        gridHelper = null;
    }
    if (canvasSettings.showGrid === false) return;
    const { size, divisions } = getGridMetrics(getSceneBounds());
    gridHelper = createGridHelper(size, divisions);
}

function createGridHelper(size, divisions) {
    const half = size / 2;
    const step = size / divisions;
    const lines = [];
    for (let i = 0; i <= divisions; i += 1) {
        const v = -half + i * step;
        lines.push([new BABYLON.Vector3(-half, 0, v), new BABYLON.Vector3(half, 0, v)]);
        lines.push([new BABYLON.Vector3(v, 0, -half), new BABYLON.Vector3(v, 0, half)]);
    }
    const mesh = BABYLON.MeshBuilder.CreateLineSystem("grid", { lines }, scene);
    mesh.color = BABYLON.Color3.FromHexString("#cbd5e1");
    mesh.isPickable = false;
    return mesh;
}

function createAxesHelper(size) {
    const root = new BABYLON.TransformNode("axesHelper", scene);
    const axes = [
        { name: "x", color: "#ef4444", end: new BABYLON.Vector3(size, 0, 0) },
        { name: "y", color: "#22c55e", end: new BABYLON.Vector3(0, size, 0) },
        { name: "z", color: "#3b82f6", end: new BABYLON.Vector3(0, 0, size) },
    ];
    axes.forEach((axis) => {
        const line = BABYLON.MeshBuilder.CreateLines(`axis_${axis.name}`, {
            points: [BABYLON.Vector3.Zero(), axis.end],
        }, scene);
        line.color = BABYLON.Color3.FromHexString(axis.color);
        line.isPickable = false;
        line.parent = root;
    });
    return root;
}

function getGridMetrics(bounds) {
    if (!bounds || isBoundsEmpty(bounds)) return { size: 24, divisions: 24 };
    const size = boundsSize(bounds);
    const rawSize = Math.max(size.x, size.z, 24) * 1.15;
    const gridSize = getRoundedGridSize(rawSize);
    return { size: gridSize, divisions: getGridDivisions(gridSize) };
}

function getRoundedGridSize(value) {
    const exponent = Math.pow(10, Math.floor(Math.log10(value)));
    return Math.ceil(value / exponent) * exponent;
}

function getGridDivisions(size) {
    const targetStep = getRoundedGridSize(size / 40);
    return Math.max(12, Math.min(200, Math.round(size / targetStep)));
}

function getObjectBoundsByIds(ids) {
    const bounds = createEmptyBounds();
    ids.forEach((id) => {
        const node = objectMap.get(id);
        if (node?.isEnabled?.() !== false) expandBounds(bounds, getNodeBounds(node));
    });
    return bounds;
}

function updateCameraRangeToScene() {
    if (!camera || !contentRoot) return;
    updateCameraRangeToBounds(getSceneBounds());
}

function updateCameraRangeToBounds(bounds) {
    if (!camera || !bounds || isBoundsEmpty(bounds)) return;
    const center = boundsCenter(bounds);
    const size = boundsSize(bounds);
    const radius = Math.max(size.length() * 0.5, 1);
    const distance = Math.max(BABYLON.Vector3.Distance(camera.position, center), radius);
    const cameraRadius = Math.max(camera.radius || BABYLON.Vector3.Distance(camera.position, camera.target), 0.0001);
    const far = Math.max(1000, distance + radius * 8, cameraRadius + radius * 8);
    const near = Math.min(Math.max(cameraRadius / 10000, radius / 20000), far / 10000);
    camera.minZ = clamp(near, 0.0001, 10);
    camera.maxZ = far;
    camera.lowerRadiusLimit = 0.0001;
    camera.upperRadiusLimit = null;
}

function scheduleCameraRangeUpdate() {
    if (rangeUpdateFrameId) cancelAnimationFrame(rangeUpdateFrameId);
    rangeUpdateFrameId = requestAnimationFrame(() => {
        rangeUpdateFrameId = null;
        updateCameraRangeToScene();
        syncCameraToState();
    });
}

function fitCameraToBox(bounds) {
    if (!camera || !bounds || isBoundsEmpty(bounds)) return false;
    const center = boundsCenter(bounds);
    const size = boundsSize(bounds);
    const maxDim = Math.max(size.x, size.y, size.z, 1);
    const fov = camera.fov || 0.8;
    const distance = (maxDim / (2 * Math.tan(fov / 2))) * 1.35;
    const direction = new BABYLON.Vector3(1, 0.85, 1).normalize();
    camera.setTarget(center);
    camera.setPosition(center.add(direction.scale(distance)));
    updateCameraRangeToBounds(bounds);
    syncCameraToState();
    return true;
}

function createEmptyBounds() {
    return {
        min: new BABYLON.Vector3(Infinity, Infinity, Infinity),
        max: new BABYLON.Vector3(-Infinity, -Infinity, -Infinity),
    };
}

function isBoundsEmpty(bounds) {
    return !bounds || !Number.isFinite(bounds.min.x) || !Number.isFinite(bounds.max.x);
}

function expandBounds(target, source) {
    if (isBoundsEmpty(source)) return target;
    target.min = BABYLON.Vector3.Minimize(target.min, source.min);
    target.max = BABYLON.Vector3.Maximize(target.max, source.max);
    return target;
}

function getNodeBounds(node) {
    const bounds = createEmptyBounds();
    getNodeMeshes(node).forEach((mesh) => {
        if (!mesh.isEnabled() || mesh.metadata?.selectionProxy || mesh.metadata?.selectionHelper) return;
        try {
            mesh.computeWorldMatrix(true);
            const box = mesh.getBoundingInfo().boundingBox;
            bounds.min = BABYLON.Vector3.Minimize(bounds.min, box.minimumWorld);
            bounds.max = BABYLON.Vector3.Maximize(bounds.max, box.maximumWorld);
        } catch {
            // Some imported helper nodes do not carry geometry.
        }
    });
    return bounds;
}

function boundsSize(bounds) {
    return bounds.max.subtract(bounds.min);
}

function boundsCenter(bounds) {
    return bounds.min.add(bounds.max).scale(0.5);
}

function worldToLocal(node, point) {
    node.computeWorldMatrix(true);
    const inverted = node.getWorldMatrix().clone().invert();
    return BABYLON.Vector3.TransformCoordinates(point, inverted);
}

function round(value) {
    return Number((Number(value) || 0).toFixed(4));
}

function resizeRenderer() {
    engine?.resize();
}

function getHostSize() {
    const rect = hostRef.value?.getBoundingClientRect();
    return {
        width: Math.max(rect?.width || 800, 320),
        height: Math.max(rect?.height || 520, 320),
    };
}

function getObjectScreenAnchor(objectId, pointerEvent) {
    const rect = hostRef.value?.getBoundingClientRect();
    const width = Math.max(rect?.width || 800, 320);
    const height = Math.max(rect?.height || 520, 320);
    const fallback = {
        x: pointerEvent ? pointerEvent.clientX - (rect?.left || 0) : width * 0.46,
        y: pointerEvent ? pointerEvent.clientY - (rect?.top || 0) : height * 0.38,
        width,
        height,
    };
    const node = objectId ? objectMap.get(objectId) : null;
    if (!node || !camera || !scene) return fallback;
    const bounds = getNodeBounds(node);
    const worldPosition = isBoundsEmpty(bounds)
        ? node.getAbsolutePosition?.() || BABYLON.Vector3.Zero()
        : new BABYLON.Vector3(boundsCenter(bounds).x, bounds.max.y, boundsCenter(bounds).z);
    const projected = BABYLON.Vector3.Project(
        worldPosition,
        BABYLON.Matrix.IdentityReadOnly,
        scene.getTransformMatrix(),
        camera.viewport.toGlobal(width, height),
    );
    return {
        x: clamp(projected.x, 0, width),
        y: clamp(projected.y, 0, height),
        width,
        height,
    };
}

function getCanvasPoint(event) {
    const rect = canvas.getBoundingClientRect();
    return {
        x: event.clientX - rect.left,
        y: event.clientY - rect.top,
    };
}

function getPickingRay(event) {
    const point = getCanvasPoint(event);
    return scene.createPickingRay(point.x, point.y, BABYLON.Matrix.Identity(), camera);
}

function getHit(event) {
    if (!scene || !camera) return null;
    const point = getCanvasPoint(event);
    const pick = scene.pick(point.x, point.y, (mesh) => {
        if (!mesh?.isPickable || !mesh.isEnabled() || mesh.metadata?.selectionHelper) return false;
        return Boolean(mesh.metadata?.sceneObjectId);
    });
    if (!pick?.hit || !pick.pickedMesh) return null;
    let target = pick.pickedMesh;
    while (target && !target.metadata?.sceneObjectId) target = target.parent;
    if (!target) return null;
    const selectionId = resolveCanvasSelectionId(target.metadata.sceneObjectId);
    const objectData = getObjectData(selectionId);
    const selectionObject = objectMap.get(selectionId);
    if (!objectData || !selectionObject || objectData.visible === false) return null;
    return {
        id: selectionId,
        object: selectionObject,
        point: pick.pickedPoint || BABYLON.Vector3.Zero(),
    };
}

function resolveCanvasSelectionId(id) {
    let objectData = getObjectData(id);
    if (!objectData) return null;
    if (["importedLayer", "importedMesh"].includes(objectData.type)) {
        const visited = new Set();
        while (objectData?.parentId && !visited.has(objectData.id)) {
            visited.add(objectData.id);
            const parent = getObjectData(objectData.parentId);
            if (!parent) break;
            if (parent.type === "importedModel") return parent.id;
            objectData = parent;
        }
    }
    return objectData.type === "importedMesh" ? null : objectData.id;
}

function isGizmoPointerActive(event = null) {
    return Boolean(
        gizmoManager?.isDragging ||
            gizmoManager?.isHovered ||
            transformDragging ||
            (event && isGizmoPointerHit(event)),
    );
}

function isGizmoPointerHit(event) {
    return Boolean(getGizmoAxisHit(event));
}

function getGizmoAxisHit(event) {
    if (!event || props.mode !== "edit" || !gizmoManager?.attachedNode) return null;
    const utilityLayer = gizmoManager.utilityLayer;
    const utilityScene = utilityLayer?.utilityLayerScene;
    if (!utilityScene || !canvas) return null;
    const point = getCanvasPoint(event);
    const previousActiveCamera = utilityScene.activeCamera;
    if (!utilityScene.activeCamera) {
        utilityScene.activeCamera = utilityLayer.getRenderCamera?.() || camera;
    }
    const pick = utilityScene.pick(point.x, point.y);
    if (!previousActiveCamera) utilityScene.activeCamera = previousActiveCamera;
    if (pick?.hit && pick.pickedMesh) {
        const meshHit = getGizmoAxisHitFromMesh(pick.pickedMesh);
        if (meshHit?.axis) return meshHit;
    }
    return getGizmoScreenAxisHit(event);
}

function getGizmoAxisHitFromMesh(mesh) {
    const mode = getActiveTransformMode();
    const gizmo = getActiveModeGizmo(mode);
    if (!gizmo) return null;
    const axisEntries = [
        { axis: "x", gizmo: gizmo.xGizmo },
        { axis: "y", gizmo: gizmo.yGizmo },
        { axis: "z", gizmo: gizmo.zGizmo },
    ];
    for (const entry of axisEntries) {
        if (isMeshInGizmoAxis(mesh, entry.gizmo)) return { mode, axis: entry.axis, mesh };
    }
    return isGizmoAxisMesh(mesh) ? { mode, axis: "", mesh } : null;
}

function getActiveTransformMode() {
    const mode = sceneState?.editorState?.transformMode || "translate";
    return ["translate", "rotate", "scale"].includes(mode) ? mode : "translate";
}

function getActiveModeGizmo(mode = getActiveTransformMode()) {
    if (mode === "rotate") return gizmoManager?.gizmos.rotationGizmo || null;
    if (mode === "scale") return gizmoManager?.gizmos.scaleGizmo || null;
    return gizmoManager?.gizmos.positionGizmo || null;
}

function getAxisGizmo(mode, axis) {
    if (!["x", "y", "z"].includes(axis)) return null;
    return getActiveModeGizmo(mode)?.[`${axis}Gizmo`] || null;
}

function getAxisGizmoCache(axisGizmo) {
    const axisCache = gizmoManager?._gizmoAxisCache;
    if (!axisGizmo || !axisCache) return null;
    const roots = [axisGizmo._rootMesh, axisGizmo._gizmoMesh].filter(Boolean);
    for (const root of roots) {
        if (axisCache.has(root)) return axisCache.get(root);
        const children = root.getChildMeshes?.(false) || [];
        for (const child of children) {
            if (axisCache.has(child)) return axisCache.get(child);
            if (axisCache.has(child.parent)) return axisCache.get(child.parent);
        }
    }
    return null;
}

function lockAxisHighlight(mode, axis) {
    unlockAxisHighlight();
    const axisGizmo = getAxisGizmo(mode, axis);
    const cache = getAxisGizmoCache(axisGizmo);
    if (!axisGizmo || !cache?.gizmoMeshes?.length || !cache.hoverMaterial) return;
    axisHighlightLock = {
        cache,
        restoreMaterial: cache.dragBehavior?.enabled ? cache.material : cache.disableMaterial,
        material: cache.hoverMaterial,
        previousActive: cache.active,
    };
    cache.active = true;
    applyAxisHighlightLock();
}

function applyAxisHighlightLock() {
    if (!axisHighlightLock) return;
    const { cache, material } = axisHighlightLock;
    if (!cache?.gizmoMeshes?.length || !material) return;
    cache.active = true;
    for (const mesh of cache.gizmoMeshes) {
        if (mesh?.isDisposed?.()) continue;
        mesh.material = material;
        if (mesh.color && material.diffuseColor) {
            mesh.color = material.diffuseColor;
        }
    }
}

function unlockAxisHighlight() {
    if (!axisHighlightLock) return;
    const { cache, restoreMaterial, previousActive } = axisHighlightLock;
    axisHighlightLock = null;
    if (!cache?.gizmoMeshes?.length || !restoreMaterial) return;
    cache.active = previousActive;
    const material = cache.dragBehavior?.enabled ? restoreMaterial : cache.disableMaterial || restoreMaterial;
    for (const mesh of cache.gizmoMeshes) {
        if (mesh?.isDisposed?.()) continue;
        mesh.material = material;
        if (mesh.color && material.diffuseColor) {
            mesh.color = material.diffuseColor;
        }
    }
}

function getGizmoScreenAxisHit(event) {
    const mode = getActiveTransformMode();
    if (!["translate", "scale"].includes(mode)) return null;
    const node = gizmoManager?.attachedNode;
    if (!node) return null;
    const origin = node.getAbsolutePosition?.() || node.position;
    const originScreen = projectWorldToCanvas(origin);
    const pointer = getCanvasPoint(event);
    const handleLength = mode === "scale" ? 86 : 94;
    const threshold = mode === "scale" ? 24 : 18;
    let bestHit = null;
    for (const axis of ["x", "y", "z"]) {
        const axisScreen = getAxisScreenDirection(origin, getTransformAxisWorld(node, axis));
        const endScreen = {
            x: originScreen.x + axisScreen.x * handleLength,
            y: originScreen.y + axisScreen.y * handleLength,
        };
        const distance = Math.min(
            getPointDistance(pointer, endScreen),
            getPointToSegmentDistance(pointer, originScreen, endScreen),
        );
        if (distance <= threshold && (!bestHit || distance < bestHit.distance)) {
            bestHit = { mode, axis, mesh: null, distance };
        }
    }
    return bestHit ? { mode: bestHit.mode, axis: bestHit.axis, mesh: null } : null;
}

function isMeshInGizmoAxis(mesh, axisGizmo) {
    if (!mesh || !axisGizmo) return false;
    let current = mesh;
    while (current) {
        if (current === axisGizmo._rootMesh || current === axisGizmo._gizmoMesh) return true;
        current = current.parent;
    }
    const meshes = [
        ...(axisGizmo._rootMesh?.getChildMeshes?.(false) || []),
        ...(axisGizmo._gizmoMesh?.getChildMeshes?.(false) || []),
    ];
    return meshes.includes(mesh);
}

function isGizmoAxisMesh(mesh) {
    const axisCache = gizmoManager?._gizmoAxisCache;
    if (!mesh || !axisCache) return false;
    let current = mesh;
    while (current) {
        if (axisCache.has(current)) return true;
        current = current.parent;
    }
    for (const cache of axisCache.values()) {
        if (cache.colliderMeshes?.includes(mesh)) return true;
    }
    return false;
}

function handlePointerDown(event) {
    if (!sceneState || ![0, 2].includes(event.button)) return;
    focusCanvasHost();
    if (event.button === 2) {
        event.preventDefault();
        event.stopPropagation?.();
        beginCameraDragCandidate(event, "pan");
        return;
    }
    if (props.mode === "view") {
        beginCameraDragCandidate(event, "rotate");
        const hit = getHit(event);
        pendingViewClick = {
            hit,
            startX: event.clientX,
            startY: event.clientY,
        };
        return;
    }
    if (props.mode !== "edit") return;
    const axisHit = getGizmoAxisHit(event);
    if (axisHit?.axis && beginAxisTransform(event, axisHit)) return;
    if (isGizmoPointerActive(event)) return;
    beginCameraDragCandidate(event, "rotate");
    const hit = getHit(event);
    pendingEditPointer = {
        hit,
        startX: event.clientX,
        startY: event.clientY,
        selectedIds: [...(sceneState.editorState?.selectedIds || props.selectedIds || [])],
        ctrlKey: event.ctrlKey,
        metaKey: event.metaKey,
    };
    if (!hit) return;
}

function finishPendingEditClick(event) {
    const pending = pendingEditPointer;
    pendingEditPointer = null;
    if (!pending) return;
    const distance = getPointerDistance(event, pending);
    if (distance > 6) return;
    const hit = pending.hit;
    if (!hit) {
        if (!pending.ctrlKey) applySelection([], true);
        return;
    }
    applyEditSelectionFromHit(hit, pending);
}

function applyEditSelectionFromHit(hit, pending) {
    const currentSelectedIds = sceneState.editorState?.selectedIds || props.selectedIds || [];
    const hitIsSelected = currentSelectedIds.includes(hit.id);
    const nextIds = pending.ctrlKey
        ? toggleId(currentSelectedIds, hit.id)
        : hitIsSelected && currentSelectedIds.length > 1
          ? currentSelectedIds
          : [hit.id];
    applySelection(nextIds, true);
}

function handleDoubleClick(event) {
    if (event.button !== 0 || props.mode !== "view" || !sceneState) return;
    focusCanvasHost();
    const hit = getHit(event);
    if (!hit) return;
    runObjectEvents(hit.id, "leftDoubleClick", { pointerEvent: event, hit });
}

function focusCanvasHost() {
    hostRef.value?.focus?.({ preventScroll: true });
}

function refreshImportedModelSelectionProxy(modelId) {
    const modelData = getObjectData(modelId);
    const modelRoot = objectMap.get(modelId);
    const proxy = selectionPickMap.get(modelId);
    if (!modelData || modelData.type !== "importedModel" || !modelRoot || !proxy) return;
    const bounds = createEmptyBounds();
    modelRoot.getChildren().forEach((child) => {
        if (child === proxy || child.metadata?.selectionProxy) return;
        expandBounds(bounds, getNodeBounds(child));
    });
    if (isBoundsEmpty(bounds)) return;
    const size = boundsSize(bounds);
    const center = boundsCenter(bounds);
    proxy.scaling = new BABYLON.Vector3(Math.max(size.x, 0.001), Math.max(size.y, 0.001), Math.max(size.z, 0.001));
    proxy.position = worldToLocal(modelRoot, center);
}

function emitAnimationRuntimeEvent(type, payload) {
    emit(type, payload);
    emitCanvasEvent(type, payload);
}

function handleDocumentVisibilityChange() {
    animationRuntime.setDocumentHidden(document.hidden);
}

function getCanvasEventBus() {
    return props.eventBus || het3dEventBus;
}

function onCanvasEvent(type, handler) {
    if (type === "modelExplode" && typeof handler !== "function") return explodeModel(handler);
    return getCanvasEventBus()?.on?.(type, handler) || (() => {});
}

function offCanvasEvent(type, handler) {
    return getCanvasEventBus()?.off?.(type, handler);
}

function onceCanvasEvent(type, handler) {
    return getCanvasEventBus()?.once?.(type, handler) || (() => {});
}

function emitCanvasEvent(type, payload) {
    return getCanvasEventBus()?.emit?.(type, payload) || [];
}

function toggleId(ids, id) {
    return ids.includes(id) ? ids.filter((item) => item !== id) : [...ids, id];
}

function beginAxisTransform(event, axisHit) {
    const id = sceneState?.editorState?.selectedIds?.[0] || gizmoManager?.attachedNode?.metadata?.sceneObjectId || "";
    const node = objectMap.get(id);
    const objectData = getObjectData(id);
    if (!node || !objectData || objectData.locked || !axisHit?.axis) return false;

    event.preventDefault();
    event.stopPropagation?.();
    releaseActiveGizmoDrags();

    const origin = node.getAbsolutePosition?.() || node.position.clone();
    const axisWorld = getTransformAxisWorld(node, axisHit.axis);
    const axisDistance = getAxisPointerDistance(event, origin, axisWorld);
    const axisDragPlaneNormal = getAxisDragPlaneNormal(axisWorld);
    const axisDragStartPoint = axisDragPlaneNormal
        ? intersectRayPlane(getPickingRay(event), origin, axisDragPlaneNormal)
        : null;
    const centerScreen = projectWorldToCanvas(origin);
    const startPointer = getCanvasPoint(event);
    const startAngle = Math.atan2(startPointer.y - centerScreen.y, startPointer.x - centerScreen.x);
    axisTransform = {
        mode: axisHit.mode,
        axis: axisHit.axis,
        id,
        node,
        origin,
        axisWorld,
        axisDragPlaneNormal,
        axisDragStartPoint,
        axisScreen: getAxisScreenDirection(origin, axisWorld),
        centerScreen,
        startPointer,
        startAngle,
        startAxisDistance: axisDistance,
        startAbsolutePosition: origin.clone(),
        startPosition: node.position.clone(),
        startRotation: getNodeRotation(node).clone(),
        startScaling: node.scaling.clone(),
        moved: false,
    };
    pendingEditPointer = null;
    cameraDrag = null;
    transformDragging = true;
    pendingTransformChange = false;
    lockAxisHighlight(axisHit.mode, axisHit.axis);
    setCameraControlEnabled(false);
    return true;
}

function releaseActiveGizmoDrags() {
    [
        gizmoManager?.gizmos.positionGizmo,
        gizmoManager?.gizmos.rotationGizmo,
        gizmoManager?.gizmos.scaleGizmo,
    ]
        .flatMap((gizmo) => [gizmo?.xGizmo, gizmo?.yGizmo, gizmo?.zGizmo, gizmo?.uniformScaleGizmo])
        .filter(Boolean)
        .forEach((gizmo) => gizmo.dragBehavior?.releaseDrag?.());
}

function updateAxisTransform(event) {
    if (!axisTransform || !sceneState) return;
    if (axisTransform.mode === "rotate") updateAxisRotation(event);
    else if (axisTransform.mode === "scale") updateAxisScale(event);
    else updateAxisTranslation(event);
    axisTransform.moved = true;
    pendingTransformChange = true;
    applyAxisHighlightLock();
    syncSelectedObjectsFromBabylon(false);
}

function updateAxisTranslation(event) {
    const state = axisTransform;
    const dragPoint = state.axisDragPlaneNormal
        ? intersectRayPlane(getPickingRay(event), state.origin, state.axisDragPlaneNormal)
        : null;
    const delta = dragPoint && state.axisDragStartPoint
        ? BABYLON.Vector3.Dot(dragPoint.subtract(state.axisDragStartPoint), state.axisWorld)
        : getAxisScreenDelta(event, state) * getScreenWorldStep(state.origin);
    const nextAbsolutePosition = state.startAbsolutePosition.add(state.axisWorld.scale(delta));
    setNodeAbsolutePosition(state.node, nextAbsolutePosition);
}

function updateAxisRotation(event) {
    const state = axisTransform;
    const point = getCanvasPoint(event);
    const currentAngle = Math.atan2(point.y - state.centerScreen.y, point.x - state.centerScreen.x);
    const fallbackDelta = (point.x - state.startPointer.x - (point.y - state.startPointer.y)) * 0.01;
    const angleDelta = Number.isFinite(currentAngle) && Number.isFinite(state.startAngle)
        ? normalizeAngle(currentAngle - state.startAngle)
        : fallbackDelta;
    state.node.rotationQuaternion = null;
    state.node.rotation.copyFrom(state.startRotation);
    state.node.rotation[state.axis] = state.startRotation[state.axis] + angleDelta;
}

function updateAxisScale(event) {
    const state = axisTransform;
    const delta = getAxisScreenDelta(event, state);
    const factor = Math.max(0.01, 1 + delta / 140);
    state.node.scaling.copyFrom(state.startScaling);
    state.node.scaling[state.axis] = Math.max(0.01, state.startScaling[state.axis] * factor);
}

function finishAxisTransform() {
    const shouldEmit = axisTransform?.moved;
    axisTransform = null;
    unlockAxisHighlight();
    cameraDrag = null;
    transformDragging = false;
    setCameraControlEnabled(true);
    syncSelectedObjectsFromBabylon();
    if (shouldEmit) {
        pendingTransformChange = false;
        scheduleCameraRangeUpdate();
        emitSceneChange();
    }
}

function getTransformAxisWorld(node, axis) {
    const localAxis = new BABYLON.Vector3(axis === "x" ? 1 : 0, axis === "y" ? 1 : 0, axis === "z" ? 1 : 0);
    const matrix = node.getWorldMatrix?.() || BABYLON.Matrix.Identity();
    const worldAxis = BABYLON.Vector3.TransformNormal(localAxis, matrix);
    if (worldAxis.lengthSquared() < 0.000001) return localAxis;
    return worldAxis.normalize();
}

function getAxisPointerDistance(event, origin, axisWorld) {
    const ray = getPickingRay(event);
    const rayDirection = ray.direction.normalize();
    const lineDirection = axisWorld.normalize();
    const dot = BABYLON.Vector3.Dot(lineDirection, rayDirection);
    const denominator = 1 - dot * dot;
    if (Math.abs(denominator) < 0.000001) return null;
    const between = origin.subtract(ray.origin);
    const lineDot = BABYLON.Vector3.Dot(lineDirection, between);
    const rayDot = BABYLON.Vector3.Dot(rayDirection, between);
    return (dot * rayDot - lineDot) / denominator;
}

function getAxisDragPlaneNormal(axisWorld) {
    if (!camera || !axisWorld) return null;
    const forward = camera.getForwardRay().direction.normalize();
    const axis = axisWorld.normalize();
    const normal = forward.subtract(axis.scale(BABYLON.Vector3.Dot(forward, axis)));
    if (normal.lengthSquared() < 0.000001) return null;
    return normal.normalize();
}

function getAxisScreenDelta(event, state) {
    const point = getCanvasPoint(event);
    const deltaX = point.x - state.startPointer.x;
    const deltaY = point.y - state.startPointer.y;
    return deltaX * state.axisScreen.x + deltaY * state.axisScreen.y;
}

function getAxisScreenDirection(origin, axisWorld) {
    const start = projectWorldToCanvas(origin);
    const end = projectWorldToCanvas(origin.add(axisWorld.scale(getScreenWorldStep(origin) * 80)));
    const x = end.x - start.x;
    const y = end.y - start.y;
    const length = Math.hypot(x, y);
    if (length < 0.000001) return { x: 1, y: 0 };
    return { x: x / length, y: y / length };
}

function getScreenWorldStep(origin) {
    const distance = camera?.position ? BABYLON.Vector3.Distance(camera.position, origin) : 8;
    return Math.max(distance / 900, 0.002);
}

function projectWorldToCanvas(point) {
    const rect = canvas.getBoundingClientRect();
    const viewport = camera.viewport.toGlobal(rect.width || canvas.width || 1, rect.height || canvas.height || 1);
    const projected = BABYLON.Vector3.Project(
        point,
        BABYLON.Matrix.IdentityReadOnly,
        scene.getTransformMatrix(),
        viewport,
    );
    return { x: projected.x, y: projected.y };
}

function setNodeAbsolutePosition(node, absolutePosition) {
    if (typeof node.setAbsolutePosition === "function") {
        node.setAbsolutePosition(absolutePosition);
        return;
    }
    if (!node.parent) {
        node.position.copyFrom(absolutePosition);
        return;
    }
    node.position.copyFrom(worldToLocal(node.parent, absolutePosition));
}

function normalizeAngle(angle) {
    let next = angle;
    while (next > Math.PI) next -= Math.PI * 2;
    while (next < -Math.PI) next += Math.PI * 2;
    return next;
}

function beginDirectDrag(event, ids) {
    const draggableIds = ids.filter((id) => !getObjectData(id)?.locked && objectMap.has(id));
    if (!draggableIds.length) return;
    event.preventDefault();
    const normal = camera.getForwardRay().direction.normalize();
    const firstObject = objectMap.get(draggableIds[0]);
    if (!firstObject) return;
    const worldPosition = firstObject.getAbsolutePosition?.() || firstObject.position;
    const ray = getPickingRay(event);
    const startPoint = intersectRayPlane(ray, worldPosition, normal);
    if (!startPoint) return;
    directDrag = {
        ids: draggableIds,
        planePoint: worldPosition.clone(),
        planeNormal: normal.clone(),
        startPoint,
        startPositions: new Map(draggableIds.map((id) => [id, objectMap.get(id)?.position.clone()]).filter(([, value]) => value)),
        moved: false,
    };
    setCameraControlEnabled(false);
}

function handlePointerMove(event) {
    if (axisTransform && props.mode === "edit") {
        updateAxisTransform(event);
        return;
    }
    if (pendingEditPointer && props.mode === "edit") {
        maybeBeginEditDirectDrag(event);
    }
    if (!directDrag) {
        updateCameraDrag(event);
    }
    if (!directDrag || !sceneState) return;
    const ray = getPickingRay(event);
    const point = intersectRayPlane(ray, directDrag.planePoint, directDrag.planeNormal);
    if (!point) return;
    const delta = point.subtract(directDrag.startPoint);
    directDrag.ids.forEach((id) => {
        const node = objectMap.get(id);
        const startPosition = directDrag.startPositions.get(id);
        const objectData = getObjectData(id);
        if (!node || !startPosition || !objectData) return;
        node.position = startPosition.add(delta);
    });
    updateSelectionHelpers();
    directDrag.moved = true;
}

function handlePointerUp(event) {
    if (axisTransform && props.mode === "edit") {
        finishAxisTransform();
        return;
    }
    if (pendingViewClick && props.mode === "view") {
        finishPendingViewClick(event);
    }
    if (pendingEditPointer && props.mode === "edit") {
        finishPendingEditClick(event);
    }
    if (!directDrag) {
        cameraDrag = null;
        return;
    }
    const shouldEmit = directDrag.moved;
    directDrag = null;
    cameraDrag = null;
    setCameraControlEnabled(true);
    syncSelectedObjectsFromBabylon();
    if (shouldEmit) {
        scheduleCameraRangeUpdate();
        emitSceneChange();
    }
}

function disableDefaultPointerCameraInput() {
    const pointerInput = camera?.inputs?.attached?.pointers;
    if (pointerInput) {
        pointerInput.buttons = [];
    }
}

function disableDefaultWheelCameraInput() {
    const wheelInput = camera?.inputs?.attached?.mousewheel;
    if (wheelInput) camera.inputs.remove(wheelInput);
}

function handleCanvasContextMenu(event) {
    event.preventDefault();
}

function handleCanvasWheel(event) {
    if (!camera || !sceneState) return;
    event.preventDefault();
    event.stopPropagation?.();
    const delta = Number(event.deltaY || 0);
    if (!Number.isFinite(delta) || delta === 0) return;
    const zoomFactor = Math.pow(1.0015, delta);
    camera.inertialRadiusOffset = 0;
    camera.lowerRadiusLimit = 0.0001;
    camera.upperRadiusLimit = null;
    camera.radius = Math.max(0.0001, camera.radius * zoomFactor);
    updateCameraRangeToScene();
    syncCameraToState();
}

function beginCameraDragCandidate(event, mode = "rotate") {
    cameraDrag = {
        mode,
        startX: event.clientX,
        startY: event.clientY,
        startAlpha: camera?.alpha || 0,
        startBeta: camera?.beta || 0,
        startRadius: camera?.radius || 1,
        startTarget: camera?.target?.clone?.() || BABYLON.Vector3.Zero(),
        startPosition: camera?.position?.clone?.() || BABYLON.Vector3.Zero(),
        startRight: camera?.getDirection?.(BABYLON.Axis.X)?.normalize?.() || BABYLON.Vector3.Right(),
        startUp: camera?.getDirection?.(BABYLON.Axis.Y)?.normalize?.() || BABYLON.Vector3.Up(),
        moved: false,
    };
}

function updateCameraDrag(event) {
    if (!cameraDrag || !camera || (props.mode === "edit" && isGizmoPointerActive(event))) return;
    const isRotateDrag = cameraDrag.mode !== "pan";
    const requiredButtonMask = isRotateDrag ? 1 : 2;
    if ((event.buttons & requiredButtonMask) !== requiredButtonMask) return;
    const distance = getPointerDistance(event, cameraDrag);
    if (distance <= 3) return;
    const dx = Number(event.clientX || 0) - cameraDrag.startX;
    const dy = Number(event.clientY || 0) - cameraDrag.startY;
    if (cameraDrag.mode === "pan") {
        panCameraByScreenDelta(dx, dy);
        cameraDrag.moved = true;
        syncCameraToState();
        return;
    }
    const sensitivity = 0.005;
    camera.target.copyFrom(cameraDrag.startTarget);
    camera.radius = cameraDrag.startRadius;
    camera.alpha = cameraDrag.startAlpha - dx * sensitivity;
    camera.beta = clamp(cameraDrag.startBeta - dy * sensitivity, 0.08, Math.PI - 0.08);
    cameraDrag.moved = true;
    syncCameraToState();
}

function panCameraByScreenDelta(deltaX, deltaY) {
    if (!cameraDrag || !camera) return;
    const rect = canvas?.getBoundingClientRect?.();
    const viewportHeight = Math.max(rect?.height || canvas?.clientHeight || canvas?.height || 1, 1);
    const panScale = (cameraDrag.startRadius || BABYLON.Vector3.Distance(cameraDrag.startPosition, cameraDrag.startTarget) || 1) / viewportHeight;
    const offset = cameraDrag.startRight.scale(-deltaX * panScale).add(cameraDrag.startUp.scale(deltaY * panScale));
    setCameraTargetAndPosition(cameraDrag.startTarget.add(offset), cameraDrag.startPosition.add(offset));
}

function setCameraTargetAndPosition(target, position) {
    camera.inertialAlphaOffset = 0;
    camera.inertialBetaOffset = 0;
    camera.inertialRadiusOffset = 0;
    camera.inertialPanningX = 0;
    camera.inertialPanningY = 0;
    camera.target.copyFrom(target);
    camera.position.copyFrom(position);
    camera.rebuildAnglesAndRadius?.();
}

function maybeBeginEditDirectDrag(event) {
    const pending = pendingEditPointer;
    if (!pending || !pending.hit || pending.ctrlKey || pending.metaKey) return;
    if (getPointerDistance(event, pending) <= 6) return;
    if (isGizmoPointerActive(event)) {
        pendingEditPointer = null;
        return;
    }
    const selectedIds = pending.selectedIds.length ? pending.selectedIds : [];
    const hitIsSelected = selectedIds.includes(pending.hit.id);
    const dragIds = hitIsSelected ? selectedIds.filter((id) => objectMap.has(id)) : [pending.hit.id];
    if (!dragIds.length) {
        pendingEditPointer = null;
        return;
    }
    const objectData = getObjectData(pending.hit.id);
    pendingEditPointer = null;
    if (!objectData || objectData.locked) return;
    if (!hitIsSelected) applySelection([pending.hit.id], true);
    beginDirectDrag(event, dragIds);
}

function finishPendingViewClick(event) {
    const pending = pendingViewClick;
    pendingViewClick = null;
    if (!pending) return;
    const distance = getPointerDistance(event, pending);
    if (distance > 6) return;
    if (pending.hit) {
        beginViewClick();
        const actions = runObjectEvents(pending.hit.id, "leftClick", {
            pointerEvent: event,
            hit: pending.hit,
        });
        const openedByCustomEvent = consumeFloatingPopoverOpened();
        const shouldKeepFloatingDevicePopover =
            actions.includes("devicePopover") || openedByCustomEvent;
        if (!shouldKeepFloatingDevicePopover) hideFloatingDevicePopover();
    } else {
        hideFloatingDevicePopover();
    }
}

function getPointerDistance(event, pending) {
    return Math.hypot(
        Number(event?.clientX || 0) - pending.startX,
        Number(event?.clientY || 0) - pending.startY,
    );
}

function getPointDistance(left, right) {
    return Math.hypot(Number(left.x || 0) - Number(right.x || 0), Number(left.y || 0) - Number(right.y || 0));
}

function getPointToSegmentDistance(point, start, end) {
    const dx = end.x - start.x;
    const dy = end.y - start.y;
    const lengthSquared = dx * dx + dy * dy;
    if (lengthSquared <= 0.000001) return getPointDistance(point, start);
    const t = clamp(((point.x - start.x) * dx + (point.y - start.y) * dy) / lengthSquared, 0, 1);
    return getPointDistance(point, { x: start.x + dx * t, y: start.y + dy * t });
}

function intersectRayPlane(ray, planePoint, planeNormal) {
    const denominator = BABYLON.Vector3.Dot(ray.direction, planeNormal);
    if (Math.abs(denominator) < 0.000001) return null;
    const distance = BABYLON.Vector3.Dot(planePoint.subtract(ray.origin), planeNormal) / denominator;
    if (distance < 0) return null;
    return ray.origin.add(ray.direction.scale(distance));
}

function setCameraControlEnabled(enabled) {
    if (!camera || !canvas) return;
    if (enabled) {
        camera.attachControl(canvas, true);
        disableDefaultPointerCameraInput();
    } else {
        camera.detachControl(canvas);
    }
}

function applySelection(ids, shouldEmit) {
    if (!sceneState) return;
    const filtered = ids.filter((id) => objectMap.has(id) || findModelById(sceneState?.models || [], id));
    sceneState.editorState = {
        ...(sceneState.editorState || {}),
        selectedIds: filtered,
    };
    updateSelectionHelpers();
    if (filtered.length === 1 && objectMap.has(filtered[0]) && props.mode === "edit") {
        gizmoManager?.attachToNode(objectMap.get(filtered[0]));
    } else {
        detachGizmo();
    }
    if (shouldEmit) {
        emit("select", {
            selectedIds: filtered,
            models: filtered.map((id) => getObjectData(id)).filter(Boolean),
        });
    }
}

function detachGizmo() {
    gizmoManager?.attachToNode(null);
}

function updateSelectionHelpers() {
    clearSelectionHelpers();
    const ids = sceneState?.editorState?.selectedIds || [];
    ids.slice(0, maxSelectionHelpers).forEach((id) => {
        const node = objectMap.get(id);
        if (!node) return;
        const bounds = getNodeBounds(node);
        if (isBoundsEmpty(bounds)) return;
        const helper = createSelectionBoundsHelper(bounds);
        selectionHelpers.push(helper);
    });
}

function createSelectionBoundsHelper(bounds) {
    const min = bounds.min;
    const max = bounds.max;
    const p = [
        new BABYLON.Vector3(min.x, min.y, min.z),
        new BABYLON.Vector3(max.x, min.y, min.z),
        new BABYLON.Vector3(max.x, max.y, min.z),
        new BABYLON.Vector3(min.x, max.y, min.z),
        new BABYLON.Vector3(min.x, min.y, max.z),
        new BABYLON.Vector3(max.x, min.y, max.z),
        new BABYLON.Vector3(max.x, max.y, max.z),
        new BABYLON.Vector3(min.x, max.y, max.z),
    ];
    const lines = [
        [p[0], p[1]], [p[1], p[2]], [p[2], p[3]], [p[3], p[0]],
        [p[4], p[5]], [p[5], p[6]], [p[6], p[7]], [p[7], p[4]],
        [p[0], p[4]], [p[1], p[5]], [p[2], p[6]], [p[3], p[7]],
    ];
    const helper = BABYLON.MeshBuilder.CreateLineSystem("selectionHelper", { lines }, scene);
    helper.color = selectionHelperColor;
    helper.isPickable = false;
    helper.metadata = { selectionHelper: true };
    return helper;
}

function clearSelectionHelpers() {
    selectionHelpers.splice(0).forEach((helper) => helper.dispose(false, true));
}

function syncSelectedObjectsFromBabylon(shouldUpdateHelpers = true) {
    const ids = sceneState?.editorState?.selectedIds || [];
    ids.forEach((id) => {
        const node = objectMap.get(id);
        const objectData = getObjectData(id);
        if (!node || !objectData) return;
        objectData.position = vectorToData(node.position);
        objectData.rotation = vectorToData(getNodeRotation(node));
        objectData.scale = vectorToData(node.scaling);
    });
    if (shouldUpdateHelpers) updateSelectionHelpers();
}

function getObjectData(id) {
    return findModelById(sceneState?.models || [], id);
}

function getCanvasPublicSceneData() {
    if (!sceneState) return null;
    syncCameraToState();
    return normalizeSceneModelSources({
        ...cloneData(sceneState),
        sceneId: sceneState.id,
        mode: props.mode,
    });
}

function getCanvasActiveObjects() {
    if (!sceneState) return [];
    const ids = new Set(sceneState.editorState?.selectedIds || props.selectedIds || []);
    return flattenModels(sceneState.models || []).filter((object) => ids.has(object.id));
}

function installCanvasHet3dGlobal() {
    if (typeof window === "undefined" || !props.installGlobal) return;
    previousHet3dDescriptor = Object.getOwnPropertyDescriptor(window, "het3d") || null;
    hasPreviousHet3dDescriptor = Boolean(previousHet3dDescriptor);
    Object.defineProperty(window, "het3d", {
        configurable: true,
        value: canvasHet3dApi,
    });
}

function restoreCanvasHet3dGlobal() {
    if (typeof window === "undefined" || !props.installGlobal) return;
    if (window.het3d === canvasHet3dApi) {
        if (hasPreviousHet3dDescriptor) Object.defineProperty(window, "het3d", previousHet3dDescriptor);
        else delete window.het3d;
    }
    previousHet3dDescriptor = null;
    hasPreviousHet3dDescriptor = false;
}

function emitSceneChange() {
    if (!sceneState) return;
    suppressPropSync = true;
    emit("scene-change", { scene: normalizeSceneModelSources(sceneState) });
    queueMicrotask(() => {
        suppressPropSync = false;
    });
}

async function handleDrop(event) {
    if (props.mode !== "edit") return;
    const payloadText = event.dataTransfer.getData("application/x-scene-resource");
    if (!payloadText) return;
    const payload = JSON.parse(payloadText);
    const position = getDropPosition(event);
    await addObjectFromResource(payload, position);
}

function getDropPosition(event) {
    const hit = getHit(event);
    if (hit?.point) return hit.point;
    const ray = getPickingRay(event);
    const point = intersectRayPlane(ray, BABYLON.Vector3.Zero(), BABYLON.Vector3.Up());
    return point || new BABYLON.Vector3(0, 0.5, 0);
}

async function addObjectFromResource(resource, position = new BABYLON.Vector3(0, 0.5, 0)) {
    if (!sceneState) return null;
    if (resource.type === "localModel") return importLocalModelResource(resource);
    const type = resource.type || "box";
    const defaultScale = getDefaultObjectScale(type, resource);
    const objectData = createSceneObject(type, {
        name: resource.name,
        position: {
            x: round(position.x),
            y: round(getResourceDropY(type, position.y, defaultScale)),
            z: round(position.z),
        },
        scale: defaultScale,
        material: {
            color: resource.color || "#4f7cff",
            symbol: resource.symbol || "",
            label: resource.name,
        },
    });
    sceneState.models.push(objectData);
    const node = await createBabylonObject(objectData);
    objectMap.set(objectData.id, node);
    node.parent = contentRoot;
    applySelection([objectData.id], true);
    updateGridToScene();
    scheduleCameraRangeUpdate();
    emitSceneChange();
    return objectData;
}

function copySelectedObjects() {
    const objects = getSelectedCopyableObjects();
    copiedSceneObjects = objects.map((object) => cloneData(object));
    pasteSerial = 0;
    return copiedSceneObjects.length;
}

function getSelectedCopyableObjects() {
    if (!sceneState) return [];
    const selectedObjectMap = new Map();
    const ids = sceneState.editorState?.selectedIds || props.selectedIds || [];
    ids.forEach((id) => {
        const objectData = getCopyableObjectData(id);
        if (objectData) selectedObjectMap.set(objectData.id, objectData);
    });
    const selectedIds = new Set(selectedObjectMap.keys());
    return Array.from(selectedObjectMap.values()).filter((objectData) => !hasSelectedAncestor(objectData, selectedIds));
}

function getCopyableObjectData(id) {
    const objectData = getObjectData(id);
    if (!objectData) return null;
    if (!["importedLayer", "importedMesh"].includes(objectData.type)) return objectData;
    return getImportedModelAncestor(objectData);
}

function getImportedModelAncestor(objectData) {
    const visited = new Set();
    let current = objectData;
    while (current?.parentId && !visited.has(current.id)) {
        visited.add(current.id);
        current = getObjectData(current.parentId);
        if (current?.type === "importedModel") return current;
    }
    return null;
}

function hasSelectedAncestor(objectData, selectedIds) {
    const visited = new Set();
    let parentId = objectData?.parentId;
    while (parentId && !visited.has(parentId)) {
        visited.add(parentId);
        if (selectedIds.has(parentId)) return true;
        parentId = getObjectData(parentId)?.parentId;
    }
    return false;
}

async function pasteCopiedObjects() {
    if (!sceneState || !copiedSceneObjects.length) return [];
    pasteSerial += 1;
    const context = { idMap: new Map(), pasteSerial };
    const pastedObjects = copiedSceneObjects.map((objectData) => createPastedObjectTree(objectData, context, true));
    remapPastedObjectReferences(pastedObjects, context.idMap);
    const offset = getPasteOffsetVector(pasteSerial);
    pastedObjects.forEach((objectData) => {
        objectData.parentId = null;
        offsetObjectTreePosition(objectData, offset);
    });
    for (const objectData of pastedObjects) {
        sceneState.models.push(objectData);
        const node = await createBabylonObject(objectData);
        objectMap.set(objectData.id, node);
        node.parent = contentRoot;
    }
    applySelection(pastedObjects.map((objectData) => objectData.id), true);
    updateGridToScene();
    scheduleCameraRangeUpdate();
    emitSceneChange();
    return cloneData(pastedObjects);
}

function createPastedObjectTree(sourceObject, context, isRoot = false) {
    const objectData = cloneData(sourceObject);
    const previousId = objectData.id;
    objectData.id = createId("obj");
    context.idMap.set(previousId, objectData.id);
    if (isRoot) objectData.name = createPastedObjectName(objectData.name, context.pasteSerial);
    objectData.children = (objectData.children || []).map((child) => createPastedObjectTree(child, context));
    regeneratePastedObjectInternalIds(objectData);
    return objectData;
}

function createPastedObjectName(name, serial) {
    const baseName = String(name || "Object").trim() || "Object";
    return serial > 1 ? `${baseName} Copy ${serial}` : `${baseName} Copy`;
}

function regeneratePastedObjectInternalIds(objectData) {
    if (Array.isArray(objectData.events)) {
        objectData.events = objectData.events.map((eventItem) => ({ ...eventItem, id: createId("event") }));
    }
    if (Array.isArray(objectData.animations)) objectData.animations = objectData.animations.map(regeneratePastedAnimationIds);
    if (Array.isArray(objectData.builtInAnimations)) {
        objectData.builtInAnimations = objectData.builtInAnimations.map((animation) => ({
            ...animation,
            id: createId("builtin"),
        }));
    }
}

function regeneratePastedAnimationIds(animation) {
    return {
        ...animation,
        id: createId("animation"),
        segments: (animation.segments || []).map((segment) => ({
            ...segment,
            id: createId("segment"),
            properties: (segment.properties || []).map((property) => ({ ...property, id: createId("property") })),
        })),
    };
}

function remapPastedObjectReferences(pastedObjects, idMap) {
    flattenModels(pastedObjects).forEach((objectData) => {
        if (objectData.parentId && idMap.has(objectData.parentId)) objectData.parentId = idMap.get(objectData.parentId);
        if (Array.isArray(objectData.animations)) {
            objectData.animations.forEach((animation) => {
                if (idMap.has(animation.targetId)) animation.targetId = idMap.get(animation.targetId);
            });
        }
        (objectData.events || []).forEach((eventItem) => {
            const targetObjectId = eventItem?.animationControl?.targetObjectId;
            if (targetObjectId && idMap.has(targetObjectId)) {
                eventItem.animationControl.targetObjectId = idMap.get(targetObjectId);
            }
        });
    });
}

function offsetObjectTreePosition(objectData, offset) {
    objectData.position = {
        ...(objectData.position || {}),
        x: round(Number(objectData.position?.x || 0) + offset.x),
        y: round(Number(objectData.position?.y || 0) + offset.y),
        z: round(Number(objectData.position?.z || 0) + offset.z),
    };
}

function getPasteOffsetVector(serial) {
    const step = getSceneRelativeObjectSize({ fallback: 0.8, ratio: 0.03, min: 0.6, max: 2000 });
    return { x: round(step * serial), y: 0, z: round(step * serial) };
}

function getDefaultObjectScale(type, resource) {
    if (resource?.scale) return cloneData(resource.scale);
    if (isDefaultModelType(type)) {
        const size = getSceneRelativeDefaultModelScale();
        return { x: size, y: size, z: size };
    }
    if (!["icon", "image"].includes(type)) return undefined;
    const size = type === "image" ? getSceneRelativeImageScale() : getSceneRelativeIconSize();
    return { x: size, y: size, z: size };
}

function isDefaultModelType(type) {
    return ["box", "sphere", "cylinder", "plane"].includes(type);
}

function getSceneRelativeDefaultModelScale() {
    return getSceneRelativeObjectSize({ fallback: 1, ratio: 0.035, min: 1, max: 3000 });
}

function getSceneRelativeIconSize() {
    return getSceneRelativeObjectSize({ fallback: 1.8, ratio: 0.035, min: 1.8, max: 3000 });
}

function getSceneRelativeImageScale() {
    return getSceneRelativeObjectSize({ fallback: 1.5, ratio: 0.025, min: 1.5, max: 2500 });
}

function getSceneRelativeObjectSize({ fallback, ratio, min, max }) {
    const bounds = getSceneReferenceBoundsForPlacements();
    if (!bounds || isBoundsEmpty(bounds)) return fallback;
    const size = boundsSize(bounds);
    const maxDimension = Math.max(size.x, size.y, size.z);
    if (!Number.isFinite(maxDimension) || maxDimension <= 0) return fallback;
    return round(clamp(maxDimension * ratio, min, max));
}

function getSceneReferenceBoundsForPlacements() {
    const bounds = createEmptyBounds();
    contentRoot?.getChildren().forEach((node) => {
        const objectData = getObjectData(node.metadata?.sceneObjectId);
        if (!objectData || objectData.type === "icon" || objectData.type === "image") return;
        if (node.isEnabled?.() !== false) expandBounds(bounds, getNodeBounds(node));
    });
    return isBoundsEmpty(bounds) ? getSceneBounds() : bounds;
}

function getResourceDropY(type, baseY, scale) {
    if (type === "plane") return baseY + 0.02;
    if (type === "box") return baseY + (scale?.y || 1) * 0.5;
    if (type === "sphere") return baseY + (scale?.y || 1) * 0.55;
    if (type === "cylinder") return baseY + (scale?.y || 1) * 0.6;
    if (type === "icon") return baseY + (scale?.y || 1) * 0.5;
    if (type === "image") return baseY + (scale?.y || 1) * 1.15 * 0.5;
    return baseY + 0.5;
}

async function addPrimitive(type) {
    const resource = {
        name: { box: "Box", sphere: "Sphere", cylinder: "Cylinder", plane: "Plane" }[type] || "Model",
        type,
    };
    return addObjectFromResource(resource, new BABYLON.Vector3(0, type === "plane" ? 0 : 0.5, 0));
}

function updateSceneObject(objectData) {
    const result = updateModelById(sceneState.models, objectData);
    if (!result.updated) return;
    sceneState.models = result.models;
    const node = objectMap.get(objectData.id);
    if (node) {
        node.name = objectData.name;
        applyTransform(node, objectData);
        node.setEnabled(objectData.visible !== false);
        if (objectData.type === "icon") updateIconMaterial(node, objectData);
        else if (shouldApplyMaterialColor(objectData)) applyMaterialColorToObject(node, objectData.material?.color);
    }
    animationRuntime.syncObject(objectData.id);
    updateSelectionHelpers();
    scheduleCameraRangeUpdate();
    emitSceneChange();
}

function updateIconMaterial(node, objectData) {
    if (!(node instanceof BABYLON.AbstractMesh)) return;
    node.material?.dispose?.(true, true);
    node.material = createIconMaterial(
        objectData.material?.symbol || "*",
        objectData.material?.color || "#4f7cff",
        objectData.material?.shape,
    );
}

async function deleteObjects(ids = []) {
    const { models, deletedIds } = deleteModelsByIds(sceneState.models, ids);
    if (!deletedIds.length) return [];
    const deleteIds = new Set(deletedIds);
    sceneState.models = models;
    sceneState.editorState = {
        ...(sceneState.editorState || {}),
        selectedIds: (sceneState.editorState?.selectedIds || []).filter((id) => !deleteIds.has(id)),
    };
    await loadSceneData(sceneState);
    applySelection(sceneState.editorState?.selectedIds || [], true);
    emitSceneChange();
    return deletedIds;
}

function deleteSelected() {
    return deleteObjects(sceneState.editorState?.selectedIds || []);
}

async function setObjectVisible(id, visible) {
    const objectData = getObjectData(id);
    if (!objectData) return false;
    objectData.visible = visible;
    const node = objectMap.get(id);
    if (node) node.setEnabled(visible);
    else await loadSceneData(sceneState);
    const selectedIds = sceneState.editorState?.selectedIds || [];
    if (!visible && selectedIds.includes(id)) {
        applySelection(selectedIds.filter((selectedId) => selectedId !== id), true);
    } else {
        updateSelectionHelpers();
    }
    scheduleCameraRangeUpdate();
    emitSceneChange();
    return true;
}

async function importModelFile(file) {
    if (!sceneState || !file) return false;
    return importModelBlob({ name: file.name, blob: file });
}

async function importLocalModelResource(resource) {
    if (!sceneState || !resource?.url) return false;
    const fileName = resource.fileName || decodeURIComponent(resource.url.split("/").pop() || "model.glb");
    return importModelSource({ name: resource.name || fileName, modelPath: resource.url });
}

async function importModelBlob({ name, blob }) {
    const modelPath = await readBlobAsDataUrl(blob);
    return importModelSource({ name, modelPath });
}

async function importModelSource({ name, modelPath = "" }) {
    if (!sceneState || !modelPath) return false;
    loading.value = true;
    try {
        const runtime = await importModelRuntime(modelPath, { enabled: false });
        const { meshes, layerEntries } = createCachedModelMetadata(runtime.content, runtime.meshes);
        const originOffset = getOriginOffsetForObject(runtime.content);
        disposeAnimationGroups(runtime.animationGroups);
        runtime.root.dispose(false, true);
        assetSceneCache.set(`path:${modelPath}`, { meshes, layerEntries });

        const parent = createSceneObject("importedModel", {
            name,
            nodeType: "model",
            modelPath,
            children: [],
            position: { x: 0, y: 0, z: 0 },
            source: {
                meshCount: meshes.length,
                layerCount: layerEntries.length,
                selectionLevel: "layer",
                originOffset,
                originMode: "xz-center-y-bottom",
            },
        });
        const layerObjects = layerEntries.map((entry) => {
            const layerObject = createLayerObjectData(entry, parent, meshes);
            removeLayerMeshObjects(layerObject);
            return layerObject;
        });
        if (!layerObjects.length) {
            notifyMessage("warning", "No usable mesh was found in the imported model");
            return false;
        }
        parent.children = layerObjects;
        sceneState.models.push(parent);
        const node = await createBabylonObject(parent);
        objectMap.set(parent.id, node);
        node.parent = contentRoot;
        updateGridToScene();
        updateCameraRangeToScene();
        fitCameraToBox(getObjectBoundsByIds([parent.id]));
        applySelection([parent.id], true);
        emitSceneChange();
        notifyMessage("success", `Model imported: ${layerObjects.length} layers, ${meshes.length} meshes`);
        return true;
    } catch (error) {
        notifyMessage("error", `Model import failed: ${error.message}`, error);
        return false;
    } finally {
        loading.value = false;
    }
}

function setTransformMode(mode) {
    if (!gizmoManager) return;
    gizmoManager.positionGizmoEnabled = mode === "translate";
    gizmoManager.rotationGizmoEnabled = mode === "rotate";
    gizmoManager.scaleGizmoEnabled = mode === "scale";
    bindGizmoDragEvents();
    if (sceneState) {
        sceneState.editorState = { ...(sceneState.editorState || {}), transformMode: mode };
    }
}

function bindGizmoDragEvents() {
    clearGizmoObservers();
    const gizmos = [
        gizmoManager?.gizmos.positionGizmo,
        gizmoManager?.gizmos.rotationGizmo,
        gizmoManager?.gizmos.scaleGizmo,
    ].filter(Boolean);
    gizmos.forEach((gizmo) => {
        const startObserver = gizmo.onDragStartObservable?.add?.(() => {
            transformDragging = true;
            setCameraControlEnabled(false);
        });
        const dragObserver = gizmo.onDragObservable?.add?.(() => {
            pendingTransformChange = true;
            syncSelectedObjectsFromBabylon(false);
            updateSelectionHelpers();
        });
        const endObserver = gizmo.onDragEndObservable?.add?.(() => {
            transformDragging = false;
            setCameraControlEnabled(true);
            if (pendingTransformChange) {
                pendingTransformChange = false;
                syncSelectedObjectsFromBabylon();
                scheduleCameraRangeUpdate();
                emitSceneChange();
            }
        });
        if (startObserver) gizmoObserverDisposers.push(() => gizmo.onDragStartObservable.remove(startObserver));
        if (dragObserver) gizmoObserverDisposers.push(() => gizmo.onDragObservable.remove(dragObserver));
        if (endObserver) gizmoObserverDisposers.push(() => gizmo.onDragEndObservable.remove(endObserver));
    });
}

function clearGizmoObservers() {
    gizmoObserverDisposers.splice(0).forEach((dispose) => dispose());
}

function resetCamera() {
    if (!fitCameraToBox(getSceneBounds())) applyCameraSettings(defaultCamera());
    emitSceneChange();
}

function focusSelection() {
    const ids = sceneState?.editorState?.selectedIds || [];
    const bounds = ids.length ? getObjectBoundsByIds(ids) : getSceneBounds();
    if (!fitCameraToBox(bounds)) return;
    emitSceneChange();
}

function selectAllSelectableObjects() {
    const ids = flattenModels(sceneState.models)
        .filter((object) => !["importedLayer", "importedMesh"].includes(object.type) && object.visible !== false)
        .map((object) => object.id);
    applySelection(ids, true);
}

function selectAllMeshes() {
    selectAllSelectableObjects();
}

function captureThumbnail() {
    scene.render();
    const thumbnail = canvas.toDataURL("image/png");
    emit("thumbnail-ready", { thumbnail });
    return thumbnail;
}

function getSceneSnapshot() {
    syncCameraToState();
    return normalizeSceneModelSources(sceneState);
}

function clamp(value, min, max) {
    return Math.min(Math.max(Number(value) || 0, min), max);
}

function lerp(start, end, progress) {
    return start + (end - start) * progress;
}

function notifyMessage(type, message, detail) {
    const payload = { type, message, detail };
    emit("message", payload);
    if (typeof props.notify === "function") {
        props.notify(payload);
        return;
    }
    const logger = type === "error" ? console.error : type === "warning" ? console.warn : console.info;
    logger(`[het3d] ${message}`, detail || "");
}

defineExpose({
    get data() {
        return canvasHet3dApi.data;
    },
    get active() {
        return canvasHet3dApi.active;
    },
    setValue: canvasHet3dApi.setValue,
    showDevicePopover: showPublicDevicePopover,
    explodeModel,
    getAnimationCatalog: animationRuntime.getAnimationCatalog,
    playObjectAnimations: animationRuntime.playObjectAnimations,
    playAnimation: animationRuntime.playAnimation,
    pauseAnimation: animationRuntime.pauseAnimation,
    resumeAnimation: animationRuntime.resumeAnimation,
    stopAnimation: animationRuntime.stopAnimation,
    restartAnimation: animationRuntime.restartAnimation,
    seekAnimation: animationRuntime.seekAnimation,
    getAnimationState: animationRuntime.getAnimationState,
    stopAllAnimations: animationRuntime.stopAllAnimations,
    applyAnimationSettings: animationRuntime.applyAnimationSettings,
    loadScene,
    reloadScene: () => loadSceneData(sceneState),
    captureThumbnail,
    resetCamera,
    focusSelection,
    selectAllMeshes,
    selectAllSelectableObjects,
    setTransformMode,
    addPrimitive,
    addObjectFromResource,
    copySelectedObjects,
    pasteCopiedObjects,
    importModelFile,
    updateSceneObject,
    setObjectVisible,
    applyCanvasSettings,
    applyLightSettings,
    applyCameraSettings,
    deleteObjects,
    deleteSelected,
    getSceneSnapshot,
    on: onCanvasEvent,
    off: offCanvasEvent,
    once: onceCanvasEvent,
    emit: emitCanvasEvent,
});
</script>
