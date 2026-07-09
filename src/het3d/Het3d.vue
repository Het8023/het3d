<template>
    <div
        ref="hostRef"
        class="scene-canvas"
        tabindex="0"
        @dragover.prevent
        @drop.prevent="handleDrop">
        <div v-if="loading" class="canvas-status">
            <span class="canvas-loading-spinner"></span>
            <span>正在加载场景</span>
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
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { TransformControls } from "three/examples/jsm/controls/TransformControls.js";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { DRACOLoader } from "three/examples/jsm/loaders/DRACOLoader.js";
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
import {
    applyProcessedDataToSceneBindings,
    normalizeHttpsConfigData,
    parseHttpsJsonText,
    runHttpsResponseProcessor,
} from "../utils/httpsSceneData";
import { het3dEventBus } from "../utils/eventBus";

defineOptions({
    name: "Het3d",
});

const props = defineProps({
    projectId: {
        type: String,
        default: "",
    },
    sceneId: {
        type: String,
        default: "",
    },
    sceneData: {
        type: Object,
        default: null,
    },
    mode: {
        type: String,
        default: "edit",
    },
    selectedIds: {
        type: Array,
        default: () => [],
    },
    sceneLoader: {
        type: Function,
        default: null,
    },
    projectSceneLoader: {
        type: Function,
        default: null,
    },
    assetLoader: {
        type: Function,
        default: null,
    },
    requestHandler: {
        type: Function,
        default: null,
    },
    eventBus: {
        type: Object,
        default: null,
    },
    devicePopoverComponent: {
        type: [Object, Function, String],
        default: null,
    },
    notify: {
        type: Function,
        default: null,
    },
    installGlobal: {
        type: Boolean,
        default: true,
    },
    dracoDecoderPath: {
        type: String,
        default: "/draco/",
    },
});

const emit = defineEmits([
    "select",
    "scene-ready",
    "scene-change",
    "thumbnail-ready",
    "device-popover",
    "message",
]);

const hostRef = ref(null);
const loading = ref(false);
const devicePopoverRef = ref(null);
const sceneBuiltInDevicePopoverRef = ref(null);
const resolvedDevicePopoverComponent = computed(() => props.devicePopoverComponent || null);

function notifyMessage(type, message, detail) {
    const payload = { type, message, detail };
    emit("message", payload);
    if (typeof props.notify === "function") {
        props.notify(payload);
        return;
    }
    const logger =
        type === "error" ? console.error : type === "warning" ? console.warn : console.info;
    logger(`[het3d] ${message}`, detail || "");
}

let renderer;
let scene;
let camera;
let controls;
let transformControls;
let transformHelper;
let contentGroup;
let gridHelper;
let axesHelper;
let ambientLight;
let directionalLight;
let resizeObserver;
let frameId;
let rangeUpdateFrameId;
let sceneState = null;
let suppressPropSync = false;
let directDrag = null;
let transformDragging = false;
let pendingTransformChange = false;
let previousHet3dDescriptor = null;
let hasPreviousHet3dDescriptor = false;
let httpsPollingTimer = null;
let httpsPollingSignature = "";
let httpsRequestRunning = false;
let initialValueChangeEventsExecuted = false;
let objectEventTriggerStack = [];
let floatingDevicePopoverOpenedDuringClickEvent = false;
let previewAnimationStartedAt = 0;
let sceneBuiltInDevicePopoverAnchorId = "";
let copiedSceneObjects = [];
let pasteSerial = 0;

const objectMap = new Map();
const selectionRaycastMap = new Map();
const selectionHelpers = [];
const assetSceneCache = new Map();
const maxSelectionHelpers = 80;
const selectionHelperColor = 0xffc400;
const selectionHelperRenderOrder = 1000;
const raycaster = new THREE.Raycaster();
const pointer = new THREE.Vector2();
const dragPlane = new THREE.Plane();
const dracoLoader = new DRACOLoader();
const gltfLoader = new GLTFLoader();
const noopRaycast = () => {};
const importedModelSelectionMaterial = new THREE.MeshBasicMaterial({
    transparent: true,
    opacity: 0,
    depthWrite: false,
    colorWrite: false,
});

dracoLoader.setDecoderPath(props.dracoDecoderPath);
dracoLoader.setDecoderConfig({ type: "wasm" });
gltfLoader.setDRACOLoader(dracoLoader);

const canvasHet3dApi = createHet3dApi({
    getSceneData: () => sceneState,
    getPublicSceneData: getCanvasPublicSceneData,
    getActiveObjects: getCanvasActiveObjects,
    updateObject: updateSceneObject,
    onChange: handleHet3dValueChange,
    getSetValueOptions: getCanvasHet3dSetValueOptions,
    extra: {
        showDevicePopover: showPublicDevicePopover,
        on: onCanvasEvent,
        off: offCanvasEvent,
        once: onceCanvasEvent,
        emit: emitCanvasEvent,
    },
});

onMounted(async () => {
    initThree();
    installCanvasHet3dGlobal();
    await loadInitialScene();
    animate();
});

onBeforeUnmount(() => {
    restoreCanvasHet3dGlobal();
    clearCanvasHttpsPolling();
    cancelAnimationFrame(frameId);
    cancelAnimationFrame(rangeUpdateFrameId);
    resizeObserver?.disconnect();
    renderer?.domElement?.removeEventListener("pointerdown", handlePointerDown);
    window.removeEventListener("pointermove", handlePointerMove);
    window.removeEventListener("pointerup", handlePointerUp);
    if (transformHelper) {
        scene?.remove(transformHelper);
    }
    transformControls?.dispose();
    dracoLoader.dispose();
    importedModelSelectionMaterial.dispose();
    controls?.dispose();
    renderer?.dispose();
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

function initThree() {
    scene = new THREE.Scene();
    contentGroup = new THREE.Group();
    scene.add(contentGroup);

    const { width, height } = getHostSize();
    camera = new THREE.PerspectiveCamera(50, width / height, 0.1, 1000);

    renderer = new THREE.WebGLRenderer({
        antialias: true,
        preserveDrawingBuffer: true,
        logarithmicDepthBuffer: true,
    });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setSize(width, height);
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    hostRef.value.appendChild(renderer.domElement);

    controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.08;
    controls.addEventListener("change", syncCameraToState);

    transformControls = new TransformControls(camera, renderer.domElement);
    transformControls.addEventListener("dragging-changed", (event) => {
        transformDragging = event.value;
        controls.enabled = !event.value;
        if (!event.value && pendingTransformChange) {
            pendingTransformChange = false;
            syncSelectedObjectsFromThree();
            scheduleCameraRangeUpdate();
            emitSceneChange();
        }
    });
    transformControls.addEventListener("objectChange", () => {
        if (transformDragging) {
            pendingTransformChange = true;
            syncSelectedObjectsFromThree(false);
            return;
        }
        syncSelectedObjectsFromThree();
        scheduleCameraRangeUpdate();
        emitSceneChange();
    });
    transformHelper = transformControls.getHelper();
    scene.add(transformHelper);

    applyCanvasSettings(props.sceneData?.canvas || defaultCanvas());
    applyLightSettings(defaultLights());

    renderer.domElement.addEventListener("pointerdown", handlePointerDown);
    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", handlePointerUp);

    resizeObserver = new ResizeObserver(resizeRenderer);
    resizeObserver.observe(hostRef.value);
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
        notifyMessage(
            "warning",
            "projectId was provided, but no projectSceneLoader prop is configured",
        );
        return null;
    }
    return (await props.projectSceneLoader(projectId)) || null;
}

async function loadSceneData(data) {
    loading.value = true;
    sceneState = normalizeScene(data);
    initialValueChangeEventsExecuted = false;
    resetPreviewAnimationRuntime();
    hideAllDevicePopovers();
    const migratedToLayers = await migrateImportedMeshesToLayers(sceneState);
    objectMap.clear();
    selectionRaycastMap.clear();
    clearSelectionHelpers();
    transformControls?.detach();
    contentGroup.clear();

    applyCanvasSettings(sceneState.canvas);
    applyLightSettings(sceneState.lights);
    applyCameraSettings(sceneState.camera);

    for (const objectData of sceneState.models) {
        if (!isRenderableObject(objectData)) continue;
        const object3d = await createThreeObject(objectData);
        objectMap.set(objectData.id, object3d);
        contentGroup.add(object3d);
    }

    updateCameraRangeToScene();
    updateGridToScene();
    applySelection(props.selectedIds || sceneState.editorState?.selectedIds || [], false);
    loading.value = false;
    restartCanvasHttpsPolling({ immediate: props.mode === "view" });
    emit("scene-ready", { scene: normalizeSceneModelSources(sceneState) });
    if (migratedToLayers) {
        emitSceneChange();
    }
}

function isRenderableObject(objectData) {
    return (
        !["importedLayer", "importedMesh"].includes(objectData.type) && objectData.visible !== false
    );
}

async function createThreeObject(objectData) {
    let object3d;
    const color = objectData.material?.color || "#4f7cff";

    if (objectData.type === "sphere") {
        object3d = new THREE.Mesh(
            new THREE.SphereGeometry(0.55, 36, 18),
            createStandardMaterial(color),
        );
    } else if (objectData.type === "cylinder") {
        object3d = new THREE.Mesh(
            new THREE.CylinderGeometry(0.45, 0.45, 1.2, 36),
            createStandardMaterial(color),
        );
    } else if (objectData.type === "plane") {
        object3d = new THREE.Mesh(
            new THREE.PlaneGeometry(1.6, 1.6),
            createStandardMaterial(color, true),
        );
    } else if (objectData.type === "icon") {
        object3d = new THREE.Sprite(
            createSpriteMaterial(
                objectData.material?.symbol || "●",
                color,
                objectData.material?.shape,
            ),
        );
    } else if (objectData.type === "image") {
        object3d = new THREE.Mesh(
            new THREE.PlaneGeometry(1.8, 1.15),
            new THREE.MeshStandardMaterial({
                color,
                map: createLabelTexture(objectData.name, color),
                side: THREE.DoubleSide,
                roughness: 0.65,
                metalness: 0.02,
            }),
        );
    } else if (objectData.type === "importedModel") {
        object3d = await createImportedModel(objectData);
    } else {
        object3d = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), createStandardMaterial(color));
    }

    object3d.name = objectData.name;
    object3d.userData.sceneObjectId = objectData.id;
    object3d.position.set(objectData.position.x, objectData.position.y, objectData.position.z);
    object3d.rotation.set(objectData.rotation.x, objectData.rotation.y, objectData.rotation.z);
    object3d.scale.set(objectData.scale.x, objectData.scale.y, objectData.scale.z);
    object3d.visible = objectData.visible !== false;
    if (objectData.type !== "importedModel") {
        object3d.traverse?.((child) => {
            child.userData.sceneObjectId = objectData.id;
        });
    }
    return object3d;
}

function createStandardMaterial(color, doubleSide = false) {
    return new THREE.MeshStandardMaterial({
        color,
        roughness: 0.58,
        metalness: 0.08,
        side: doubleSide ? THREE.DoubleSide : THREE.FrontSide,
    });
}

function createSpriteMaterial(symbol, color, shape = "circle") {
    return new THREE.SpriteMaterial({
        map: createSymbolTexture(symbol, color, shape),
        transparent: true,
        depthWrite: false,
    });
}

function createSymbolTexture(symbol, color, shape = "circle") {
    const canvas = document.createElement("canvas");
    canvas.width = 512;
    canvas.height = 512;
    const context = canvas.getContext("2d");
    context.clearRect(0, 0, 512, 512);
    context.fillStyle = color;
    drawIconShape(context, shape);

    const text = String(symbol || "●").trim() || "●";
    const fontFamily = 'Arial, "Microsoft YaHei", sans-serif';
    const maxWidth = 330;
    const maxHeight = 180;
    let fontSize = 150;
    context.fillStyle = "#ffffff";
    context.textAlign = "center";
    context.textBaseline = "middle";

    while (fontSize > 42) {
        context.font = `700 ${fontSize}px ${fontFamily}`;
        const metrics = context.measureText(text);
        if (metrics.width <= maxWidth && fontSize <= maxHeight) break;
        fontSize -= 6;
    }

    context.font = `700 ${fontSize}px ${fontFamily}`;
    context.textAlign = "center";
    context.textBaseline = "middle";
    context.fillText(text, 256, 258);
    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    return texture;
}

function drawIconShape(context, shape) {
    context.beginPath();
    if (shape === "square") {
        context.rect(96, 96, 320, 320);
    } else if (shape === "rounded") {
        drawRoundedRect(context, 78, 96, 356, 320, 70);
    } else if (shape === "diamond") {
        context.moveTo(256, 64);
        context.lineTo(448, 256);
        context.lineTo(256, 448);
        context.lineTo(64, 256);
        context.closePath();
    } else {
        context.arc(256, 256, 190, 0, Math.PI * 2);
    }
    context.fill();
}

function drawRoundedRect(context, x, y, width, height, radius) {
    const right = x + width;
    const bottom = y + height;
    context.moveTo(x + radius, y);
    context.lineTo(right - radius, y);
    context.quadraticCurveTo(right, y, right, y + radius);
    context.lineTo(right, bottom - radius);
    context.quadraticCurveTo(right, bottom, right - radius, bottom);
    context.lineTo(x + radius, bottom);
    context.quadraticCurveTo(x, bottom, x, bottom - radius);
    context.lineTo(x, y + radius);
    context.quadraticCurveTo(x, y, x + radius, y);
    context.closePath();
}

function createLabelTexture(label, color) {
    const canvas = document.createElement("canvas");
    canvas.width = 512;
    canvas.height = 320;
    const context = canvas.getContext("2d");
    context.fillStyle = color;
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.fillStyle = "rgba(255,255,255,0.18)";
    for (let x = 0; x < canvas.width; x += 32) {
        context.fillRect(x, 0, 1, canvas.height);
    }
    for (let y = 0; y < canvas.height; y += 32) {
        context.fillRect(0, y, canvas.width, 1);
    }
    context.fillStyle = "#ffffff";
    context.font = "bold 38px Arial";
    context.textAlign = "center";
    context.textBaseline = "middle";
    context.fillText(label.slice(0, 12), 256, 160);
    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    return texture;
}

function getObjectModelPath(objectData, visited = new Set()) {
    if (!objectData) return "";
    const ownModelPath =
        objectData?.modelPath ||
        objectData?.source?.modelPath ||
        objectData?.source?.sourceUrl ||
        objectData?.metadata?.sourceUrl ||
        "";
    if (ownModelPath) return ownModelPath;
    if (!objectData.parentId || visited.has(objectData.id)) return "";
    visited.add(objectData.id);
    const parent = findModelById(sceneState?.models || [], objectData.parentId);
    return getObjectModelPath(parent, visited);
}

function readBlobAsDataUrl(blob) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result || ""));
        reader.onerror = () => reject(reader.error || new Error("文件读取失败"));
        reader.readAsDataURL(blob);
    });
}

function getObjectModelReference(objectData) {
    const modelPath = getObjectModelPath(objectData);
    if (modelPath) return { modelPath };
    return objectData?.assetId ? { assetId: objectData.assetId } : {};
}

function applyModelReferenceToObjectData(objectData, modelReference, { keepModelPath = false } = {}) {
    if (!objectData || !modelReference) return;
    if (keepModelPath && modelReference.modelPath) {
        objectData.modelPath = modelReference.modelPath;
        delete objectData.assetId;
    } else if (keepModelPath && modelReference.assetId) {
        objectData.assetId = modelReference.assetId;
        delete objectData.modelPath;
    } else {
        delete objectData.modelPath;
        delete objectData.assetId;
    }
    if (objectData.source) {
        objectData.source = { ...objectData.source };
        delete objectData.source.modelPath;
        delete objectData.source.sourceUrl;
    }
}

async function getCachedGltfForObject(objectData) {
    const modelPath = getObjectModelPath(objectData);
    if (modelPath) {
        return getCachedGltfModelSource({
            key: `path:${modelPath}`,
            url: modelPath,
        });
    }

    if (!objectData?.assetId) return null;
    if (!props.assetLoader) return null;
    const asset = await props.assetLoader(objectData.assetId);
    let assetPath = asset?.modelPath || asset?.sourceUrl || asset?.metadata?.sourceUrl || "";
    if (!assetPath && asset?.blob) {
        assetPath = await readBlobAsDataUrl(asset.blob);
    }
    if (assetPath) {
        applyModelReferenceToObjectData(objectData, { modelPath: assetPath }, {
            keepModelPath: objectData.type === "importedModel",
        });
        return getCachedGltfModelSource({
            key: `path:${assetPath}`,
            url: assetPath,
        });
    }
    return null;
}

async function createImportedModel(objectData) {
    const cachedModel = await getCachedGltfForObject(objectData);
    if (!cachedModel) {
        return new THREE.Group();
    }

    const { scene: sourceScene } = cachedModel;
    const modelContent = sourceScene.clone(true);
    const modelRoot = new THREE.Group();
    const originOffset = getModelOriginOffset(objectData, modelContent);
    modelContent.position.set(originOffset.x, originOffset.y, originOffset.z);
    modelRoot.add(modelContent);
    const clonedMeshes = collectMeshes(modelContent);
    const childObjects = Array.isArray(objectData.children) ? objectData.children : [];
    const layerObjects = childObjects.filter((object) => object.type === "importedLayer");

    if (layerObjects.length) {
        mapImportedLayersToModel(modelContent, clonedMeshes, layerObjects);
    } else {
        mapLegacyMeshesToModel(clonedMeshes, childObjects);
    }

    if (shouldApplyMaterialColor(objectData)) {
        applyMaterialColorToObject(modelRoot, objectData.material?.color);
    }

    optimizeImportedModelRuntime(modelRoot);
    addImportedModelSelectionProxy(modelRoot, modelContent, objectData.id);
    modelRoot.updateMatrixWorld(true);
    return modelRoot;
}

function mapImportedLayersToModel(modelRoot, clonedMeshes, layerObjects) {
    const taggedLayerNodes = collectTaggedLayerNodes(modelRoot);
    const layerEntries = taggedLayerNodes.size
        ? Array.from(taggedLayerNodes.entries()).map(([layerIndex, node]) => ({
            node,
            layerIndex,
            meshIndices: [],
        }))
        : collectModelLayers(modelRoot, clonedMeshes);
    const meshBySourceIndex = createMeshBySourceIndex(clonedMeshes);
    const childByLayerIndex = new Map(
        layerObjects.map((object) => [object.source?.layerIndex, object]),
    );
    layerEntries.forEach((entry) => {
        const layerData = childByLayerIndex.get(entry.layerIndex);
        if (!layerData) {
            entry.node.visible = false;
            return;
        }

        entry.node.name = layerData.name;
        entry.node.userData.sceneObjectId = layerData.id;
        entry.node.position.set(layerData.position.x, layerData.position.y, layerData.position.z);
        entry.node.rotation.set(layerData.rotation.x, layerData.rotation.y, layerData.rotation.z);
        entry.node.scale.set(layerData.scale.x, layerData.scale.y, layerData.scale.z);
        entry.node.visible = layerData.visible !== false;
        objectMap.set(layerData.id, entry.node);

        const meshIndices = Array.isArray(layerData.source?.meshIndices)
            ? layerData.source.meshIndices
            : entry.meshIndices;
        meshIndices.forEach((meshIndex) => {
            const mesh = meshBySourceIndex.get(meshIndex);
            if (!mesh) return;
            mesh.userData.sceneObjectId = layerData.id;
        });

        if (shouldApplyMaterialColor(layerData)) {
            applyMaterialColorToObject(entry.node, layerData.material?.color);
        }
    });
}

function collectTaggedLayerNodes(root) {
    const layerNodes = new Map();
    root.traverse((node) => {
        const layerIndex = Number(node.userData?.importedLayerIndex);
        if (Number.isFinite(layerIndex)) {
            layerNodes.set(layerIndex, node);
        }
    });
    return layerNodes;
}

function createMeshBySourceIndex(meshes) {
    return new Map(
        meshes.map((mesh, index) => {
            const sourceIndex = Number(mesh.userData?.importedMeshIndex);
            return [Number.isFinite(sourceIndex) ? sourceIndex : index, mesh];
        }),
    );
}

function optimizeImportedModelRuntime(modelRoot) {
    modelRoot.traverse((node) => {
        if (!node.isMesh || node.userData?.selectionProxy) return;
        node.updateMatrix();
        node.matrixAutoUpdate = false;
        node.raycast = noopRaycast;
    });
}

function addImportedModelSelectionProxy(modelRoot, modelContent, objectId) {
    modelContent.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(modelContent);
    if (box.isEmpty()) return;

    const size = new THREE.Vector3();
    const center = new THREE.Vector3();
    box.getSize(size);
    box.getCenter(center);

    const proxy = new THREE.Mesh(
        new THREE.BoxGeometry(
            Math.max(size.x, 0.001),
            Math.max(size.y, 0.001),
            Math.max(size.z, 0.001),
        ),
        importedModelSelectionMaterial,
    );
    proxy.name = `${modelRoot.name || "importedModel"}_selectionProxy`;
    proxy.position.copy(center);
    proxy.userData.sceneObjectId = objectId;
    proxy.userData.selectionProxy = true;
    modelRoot.add(proxy);
    selectionRaycastMap.set(objectId, proxy);
}

function mapLegacyMeshesToModel(clonedMeshes, childObjects) {
    const childByMeshIndex = new Map(
        childObjects.map((object) => [object.source?.meshIndex, object]),
    );

    clonedMeshes.forEach((mesh, meshIndex) => {
        const childData = childByMeshIndex.get(meshIndex);
        if (!childData) {
            mesh.visible = false;
            return;
        }

        mesh.name = childData.name;
        mesh.userData.sceneObjectId = childData.id;
        objectMap.set(childData.id, mesh);
        mesh.visible = childData.visible !== false;
        mesh.position.set(childData.position.x, childData.position.y, childData.position.z);
        mesh.rotation.set(childData.rotation.x, childData.rotation.y, childData.rotation.z);
        mesh.scale.set(childData.scale.x, childData.scale.y, childData.scale.z);
        applyMaterialColor(mesh, childData.material?.color);
    });
}

function collectMeshes(root) {
    const meshes = [];
    root.traverse((node) => {
        if (node.isMesh) meshes.push(node);
    });
    return meshes;
}

function collectModelLayers(root, meshes = collectMeshes(root)) {
    const meshIndexByNode = new Map(meshes.map((mesh, index) => [mesh, index]));
    return getLayerCandidates(root)
        .map((node, layerIndex) => {
            const meshIndices = [];
            node.traverse((child) => {
                if (child.isMesh && meshIndexByNode.has(child)) {
                    meshIndices.push(meshIndexByNode.get(child));
                }
            });
            return {
                node,
                layerIndex,
                name: node.name || `图层 ${layerIndex + 1}`,
                meshIndices,
                meshCount: meshIndices.length,
            };
        })
        .filter((entry) => entry.meshCount > 0);
}

function createCachedGltfModelSource(sourceScene) {
    sourceScene.updateMatrixWorld(true);
    const meshes = collectMeshes(sourceScene);
    const layerEntries = collectModelLayers(sourceScene, meshes);
    markImportedModelSourceIndices(meshes, layerEntries);
    return {
        scene: sourceScene,
        meshes,
        layerEntries,
    };
}

function markImportedModelSourceIndices(meshes, layerEntries) {
    meshes.forEach((mesh, meshIndex) => {
        mesh.userData = {
            ...(mesh.userData || {}),
            importedMeshIndex: meshIndex,
        };
    });
    layerEntries.forEach((entry) => {
        entry.node.userData = {
            ...(entry.node.userData || {}),
            importedLayerIndex: entry.layerIndex,
        };
    });
}

function getLayerCandidates(root) {
    let candidates = root.children.filter((child) => hasMeshDescendant(child));

    while (candidates.length === 1) {
        const nestedGroups = candidates[0].children.filter(
            (child) => !child.isMesh && hasMeshDescendant(child),
        );
        if (nestedGroups.length <= 1) break;
        candidates = nestedGroups;
    }

    if (!candidates.length && hasMeshDescendant(root)) {
        candidates = [root];
    }
    return candidates;
}

function hasMeshDescendant(node) {
    if (node.isMesh) return true;
    return node.children?.some((child) => hasMeshDescendant(child)) || false;
}

function createLayerObjectData(entry, parent, meshes) {
    const color = getLayerMaterialColor(entry, meshes);
    return createSceneObject("importedLayer", {
        name: entry.name,
        nodeType: "layer",
        parentId: parent.id,
        position: {
            x: round(entry.node.position.x),
            y: round(entry.node.position.y),
            z: round(entry.node.position.z),
        },
        rotation: {
            x: round(entry.node.rotation.x),
            y: round(entry.node.rotation.y),
            z: round(entry.node.rotation.z),
        },
        scale: {
            x: round(entry.node.scale.x),
            y: round(entry.node.scale.y),
            z: round(entry.node.scale.z),
        },
        material: { color },
        source: {
            layerIndex: entry.layerIndex,
            layerNodeName: entry.node.name || "",
            meshIndices: entry.meshIndices,
            meshes: entry.meshIndices.map((meshIndex) => ({
                meshIndex,
                name: meshes[meshIndex]?.name || `Mesh ${meshIndex + 1}`,
            })),
            meshCount: entry.meshCount,
            materialColorOverride: false,
        },
    });
}

function removeLayerMeshObjects(layerObject) {
    const children = Array.isArray(layerObject.children) ? layerObject.children : [];
    const meshChildren = children.filter((child) => child?.type === "importedMesh");
    const otherChildren = children.filter((child) => child?.type !== "importedMesh");
    const source = { ...(layerObject.source || {}) };

    if ((!Array.isArray(source.meshes) || !source.meshes.length) && meshChildren.length) {
        source.meshes = meshChildren
            .map((meshObject) => {
                const meshIndex = Number(meshObject?.source?.meshIndex);
                if (!Number.isFinite(meshIndex)) return null;
                return {
                    meshIndex,
                    name: meshObject.name || `Mesh ${meshIndex + 1}`,
                };
            })
            .filter(Boolean);
    }
    if ((!Array.isArray(source.meshIndices) || !source.meshIndices.length) && Array.isArray(source.meshes)) {
        source.meshIndices = source.meshes.map((mesh) => mesh.meshIndex);
    }

    layerObject.children = otherChildren;
    layerObject.source = {
        ...source,
    };
    delete layerObject.source.meshObjectsReady;
    delete layerObject.source.meshObjectMode;
    delete layerObject.source.meshObjectLimit;
}

function removeModelMeshObjects(modelObject, meshCount) {
    modelObject.source = {
        ...(modelObject.source || {}),
        meshCount,
        selectionLevel: "layer",
    };
    delete modelObject.source.meshObjectMode;
    delete modelObject.source.meshObjectLimit;
    (modelObject.children || [])
        .filter((object) => object?.type === "importedLayer")
        .forEach(removeLayerMeshObjects);
}

function getModelOriginOffset(objectData, object3d) {
    if (objectData.source?.originOffset && objectData.source?.originMode === "xz-center-y-bottom") {
        return objectData.source.originOffset;
    }

    const originOffset = getOriginOffsetForObject(object3d);
    objectData.source = {
        ...(objectData.source || {}),
        originOffset,
        originMode: "xz-center-y-bottom",
    };
    return originOffset;
}

function getOriginOffsetForObject(object3d) {
    object3d.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(object3d);
    if (box.isEmpty()) {
        return { x: 0, y: 0, z: 0 };
    }

    const center = new THREE.Vector3();
    box.getCenter(center);
    return {
        x: round(-center.x),
        y: round(-box.min.y),
        z: round(-center.z),
    };
}

function getLayerMaterialColor(entry, meshes) {
    const mesh = entry.meshIndices
        .map((meshIndex) => meshes[meshIndex])
        .find((item) => item?.material?.color);
    return mesh?.material?.color ? `#${mesh.material.color.getHexString()}` : "#868e96";
}

function shouldApplyMaterialColor(objectData) {
    if (!objectData?.material?.color) return false;
    if (["importedLayer", "importedModel"].includes(objectData.type)) {
        return objectData.source?.materialColorOverride === true;
    }
    return true;
}

function applyMaterialColorToObject(object3d, color) {
    if (!color) return;
    object3d.traverse?.((child) => {
        if (child.isMesh) applyMaterialColor(child, color);
    });
}

function applyMaterialColor(mesh, color) {
    if (!color || !mesh.material) return;
    const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    materials.forEach((material, index) => {
        if (!material?.color) return;
        if (!material.userData?.sceneCanvasCloned) {
            const cloned = material.clone();
            cloned.userData = { ...(material.userData || {}), sceneCanvasCloned: true };
            if (Array.isArray(mesh.material)) {
                mesh.material[index] = cloned;
            } else {
                mesh.material = cloned;
            }
            material = cloned;
        }
        material.color.set(color);
    });
}

async function getCachedGltfModelSource({ key, url }) {
    if (!key || !url) return null;
    if (assetSceneCache.has(key)) {
        return assetSceneCache.get(key);
    }

    const gltf = await gltfLoader.loadAsync(url);
    const cached = createCachedGltfModelSource(gltf.scene);
    assetSceneCache.set(key, cached);
    return cached;
}

async function migrateImportedMeshesToLayers(state) {
    let changed = false;

    for (const modelObject of state.models.filter(
        (object) => object.type === "importedModel" && (getObjectModelPath(object) || object.assetId),
    )) {
        let modelReference = getObjectModelReference(modelObject);
        applyModelReferenceToObjectData(modelObject, modelReference, { keepModelPath: true });
        const children = Array.isArray(modelObject.children) ? modelObject.children : [];
        const existingLayerObjects = children.filter((object) => object.type === "importedLayer");
        const cachedModel = await getCachedGltfForObject(modelObject);
        if (!cachedModel) continue;
        modelReference = getObjectModelReference(modelObject);
        applyModelReferenceToObjectData(modelObject, modelReference, { keepModelPath: true });
        const { meshes, layerEntries } = cachedModel;

        if (existingLayerObjects.length) {
            existingLayerObjects.forEach((layerObject) => {
                applyModelReferenceToObjectData(layerObject, modelReference);
                removeLayerMeshObjects(layerObject);
            });
            removeModelMeshObjects(modelObject, meshes.length);
            changed = true;
            continue;
        }

        const legacyMeshes = children.filter((object) => object.type === "importedMesh");
        if (!legacyMeshes.length) continue;

        const layerObjects = [];
        layerEntries.forEach((entry) => {
            const layerObject = createLayerObjectData(entry, modelObject, meshes);
            removeLayerMeshObjects(layerObject);
            layerObjects.push(layerObject);
        });
        if (!layerObjects.length) continue;

        modelObject.children = layerObjects;
        modelObject.source = {
            ...(modelObject.source || {}),
            meshCount: meshes.length,
            layerCount: layerObjects.length,
            selectionLevel: "layer",
        };
        changed = true;
    }

    return changed;
}

function applyCanvasSettings(canvasSettings = {}) {
    if (!renderer || !scene) return;
    if (sceneState) {
        sceneState.canvas = { ...sceneState.canvas, ...canvasSettings };
    }
    const color = canvasSettings.backgroundColor || "#f5f7fb";
    scene.background = new THREE.Color(color);
    renderer.setClearColor(color);

    if (gridHelper) {
        scene.remove(gridHelper);
        gridHelper.dispose?.();
        gridHelper = null;
    }
    if (axesHelper) {
        scene.remove(axesHelper);
        axesHelper.dispose?.();
        axesHelper = null;
    }
    updateGridToScene(canvasSettings);
    if (canvasSettings.showAxes !== false) {
        axesHelper = new THREE.AxesHelper(3);
        scene.add(axesHelper);
    }
}

function applyLightSettings(lightSettings = defaultLights()) {
    if (!scene) return;
    const lights = normalizeLights(lightSettings);
    if (!ambientLight) {
        ambientLight = new THREE.HemisphereLight(0xffffff, 0xaab7c4, lights.ambient.intensity);
        scene.add(ambientLight);
    }
    if (!directionalLight) {
        directionalLight = new THREE.DirectionalLight(0xffffff, lights.directional.intensity);
        scene.add(directionalLight);
        scene.add(directionalLight.target);
    }

    ambientLight.color.set(lights.ambient.color);
    ambientLight.groundColor.set("#aab7c4");
    ambientLight.intensity = lights.ambient.intensity;
    directionalLight.color.set(lights.directional.color);
    directionalLight.intensity = lights.directional.intensity;
    directionalLight.position.set(
        lights.directional.position.x,
        lights.directional.position.y,
        lights.directional.position.z,
    );
    directionalLight.target.position.set(0, 0, 0);
    directionalLight.target.updateMatrixWorld();

    if (sceneState) {
        sceneState.lights = cloneData(lights);
    }
}

function applyCameraSettings(cameraSettings = defaultCamera()) {
    if (!camera || !controls) return;
    const position = cameraSettings.position || defaultCamera().position;
    const target = cameraSettings.target || defaultCamera().target;
    camera.position.set(position.x, position.y, position.z);
    camera.near = cameraSettings.near || camera.near;
    camera.far = cameraSettings.far || camera.far;
    camera.updateProjectionMatrix();
    controls.target.set(target.x, target.y, target.z);
    controls.update();
    updateCameraRangeToScene();
    syncCameraToState();
}

function syncCameraToState() {
    if (!sceneState || !camera || !controls) return;
    sceneState.camera = {
        position: {
            x: round(camera.position.x),
            y: round(camera.position.y),
            z: round(camera.position.z),
        },
        target: {
            x: round(controls.target.x),
            y: round(controls.target.y),
            z: round(controls.target.z),
        },
        near: round(camera.near),
        far: round(camera.far),
    };
}

function getSceneBounds() {
    const box = new THREE.Box3();
    contentGroup?.children?.forEach((object) => {
        if (object.visible !== false) box.expandByObject(object);
    });
    return box;
}

function updateGridToScene(canvasSettings = sceneState?.canvas || {}) {
    if (!scene) return;
    if (gridHelper) {
        scene.remove(gridHelper);
        gridHelper.dispose?.();
        gridHelper = null;
    }
    if (canvasSettings.showGrid === false) return;

    const box = getSceneBounds();
    const { size, divisions } = getGridMetrics(box);
    gridHelper = new THREE.GridHelper(size, divisions, 0x9ca3af, 0xd0d7de);
    gridHelper.position.set(0, 0, 0);
    scene.add(gridHelper);
}

function getGridMetrics(box) {
    if (!box || box.isEmpty()) {
        return {
            size: 24,
            divisions: 24,
        };
    }

    const size = new THREE.Vector3();
    box.getSize(size);
    const rawSize = Math.max(size.x, size.z, 24) * 1.15;
    const gridSize = getRoundedGridSize(rawSize);
    return {
        size: gridSize,
        divisions: getGridDivisions(gridSize),
    };
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
    const box = new THREE.Box3();
    ids.forEach((id) => {
        const object3d = objectMap.get(id);
        if (object3d?.visible !== false) box.expandByObject(object3d);
    });
    return box;
}

function updateCameraRangeToScene() {
    if (!camera || !controls || !contentGroup) return;
    updateCameraRangeToBox(getSceneBounds());
}

function updateCameraRangeToBox(box) {
    if (!camera || !controls || !box || box.isEmpty()) return;
    const center = new THREE.Vector3();
    const size = new THREE.Vector3();
    box.getCenter(center);
    box.getSize(size);
    const radius = Math.max(size.length() * 0.5, 1);
    const distance = Math.max(camera.position.distanceTo(center), radius);

    camera.near = Math.max(radius / 5000, 0.1);
    camera.far = Math.max(1000, radius * 12, distance + radius * 6);
    camera.updateProjectionMatrix();

    controls.minDistance = Math.max(radius / 10000, 0.1);
    controls.maxDistance = Math.max(camera.far * 0.75, radius * 8, 1000);
}

function scheduleCameraRangeUpdate() {
    if (rangeUpdateFrameId) cancelAnimationFrame(rangeUpdateFrameId);
    rangeUpdateFrameId = requestAnimationFrame(() => {
        rangeUpdateFrameId = null;
        updateCameraRangeToScene();
        syncCameraToState();
    });
}

function fitCameraToBox(box) {
    if (!camera || !controls || !box || box.isEmpty()) return false;
    const center = new THREE.Vector3();
    const size = new THREE.Vector3();
    box.getCenter(center);
    box.getSize(size);

    const maxDim = Math.max(size.x, size.y, size.z, 1);
    const fov = THREE.MathUtils.degToRad(camera.fov);
    const distance = (maxDim / (2 * Math.tan(fov / 2))) * 1.35;
    const direction = new THREE.Vector3(1, 0.85, 1).normalize();

    camera.position.copy(center).add(direction.multiplyScalar(distance));
    controls.target.copy(center);
    updateCameraRangeToBox(box);
    controls.update();
    syncCameraToState();
    return true;
}

function round(value) {
    return Number(value.toFixed(4));
}

function resizeRenderer() {
    if (!renderer || !camera) return;
    const { width, height } = getHostSize();
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
    renderer.setSize(width, height);
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

    const object3d = objectId ? objectMap.get(objectId) : null;
    if (!object3d || !camera) return fallback;

    const box = new THREE.Box3().setFromObject(object3d);
    const worldPosition = new THREE.Vector3();
    if (box.isEmpty()) {
        object3d.getWorldPosition(worldPosition);
    } else {
        box.getCenter(worldPosition);
        worldPosition.y = box.max.y;
    }

    const projected = worldPosition.project(camera);
    return {
        x: THREE.MathUtils.clamp((projected.x * 0.5 + 0.5) * width, 0, width),
        y: THREE.MathUtils.clamp((-projected.y * 0.5 + 0.5) * height, 0, height),
        width,
        height,
    };
}

function updateSceneBuiltInDevicePopoverAnchor() {
    if (!sceneBuiltInDevicePopoverAnchorId) return;
    sceneBuiltInDevicePopoverRef.value?.setAnchor(
        getObjectScreenAnchor(sceneBuiltInDevicePopoverAnchorId),
    );
}

function animate() {
    updatePreviewAnimations();
    controls?.update();
    updateSceneBuiltInDevicePopoverAnchor();
    renderer?.render(scene, camera);
    frameId = requestAnimationFrame(animate);
}

function resetPreviewAnimationRuntime() {
    previewAnimationStartedAt = performance.now() / 1000;
}

function updatePreviewAnimations() {
    if (props.mode !== "view" || !sceneState) return;
    const elapsed = Math.max(performance.now() / 1000 - previewAnimationStartedAt, 0);
    flattenModels(sceneState.models || []).forEach((ownerData) => {
        const animations = Array.isArray(ownerData.animations) ? ownerData.animations : [];
        animations
            .filter((animation) => animation?.enabled !== false)
            .forEach((animation) => applyPreviewAnimation(ownerData, animation, elapsed));
    });
}

function applyPreviewAnimation(ownerData, animation, elapsed) {
    const duration = getAnimationDuration(animation);
    if (!duration) return;
    const targetId =
        animation.targetId && animation.targetId !== "self" ? animation.targetId : ownerData.id;
    const targetData = getObjectData(targetId);
    const object3d = objectMap.get(targetId);
    if (!targetData || !object3d) return;

    const localTime = getAnimationLocalTime(animation, elapsed, duration);
    const propertyPaths = getAnimationPropertyPaths(animation);
    propertyPaths.forEach((propertyPath) => {
        const value = getAnimationPropertyValue(animation, propertyPath, localTime);
        if (value === null) return;
        applyAnimationPropertyValue(targetData, object3d, propertyPath, value);
    });
}

function getAnimationDuration(animation) {
    const duration = Math.max(
        0,
        ...(animation?.segments || []).map((segment) => Number(segment?.endTime) || 0),
    );
    return Number.isFinite(duration) ? duration : 0;
}

function getAnimationLocalTime(animation, elapsed, duration) {
    const speed = Math.max(Number(animation?.speed) || 1, 0.1);
    const scaledElapsed = elapsed * speed;
    const loopCount = Math.max(Number(animation?.loopCount) || 0, 0);
    const cycleIndex = Math.floor(scaledElapsed / duration);
    const finished = loopCount > 0 && cycleIndex >= loopCount;

    if (finished) {
        if (animation?.endState === "keep") {
            const lastCycleIndex = Math.max(loopCount - 1, 0);
            return animation?.loopMode === "alternate" && lastCycleIndex % 2 === 1 ? 0 : duration;
        }
        return 0;
    }

    let localTime = scaledElapsed % duration;
    if (animation?.loopMode === "alternate" && cycleIndex % 2 === 1) {
        localTime = duration - localTime;
    }
    return localTime;
}

function getAnimationPropertyPaths(animation) {
    const paths = new Set();
    (animation?.segments || []).forEach((segment) => {
        (segment?.properties || []).forEach((property) => {
            if (property?.property) paths.add(property.property);
        });
    });
    return Array.from(paths);
}

function getAnimationPropertyValue(animation, propertyPath, localTime) {
    const tracks = [];
    (animation?.segments || []).forEach((segment) => {
        (segment?.properties || [])
            .filter((property) => property?.property === propertyPath)
            .forEach((property) => {
                tracks.push({
                    startTime: Number(segment.startTime) || 0,
                    endTime: Number(segment.endTime) || 0,
                    startValue: Number(property.startValue) || 0,
                    endValue: Number(property.endValue) || 0,
                });
            });
    });
    tracks.sort((left, right) => left.startTime - right.startTime);
    if (!tracks.length) return null;

    for (const track of tracks) {
        if (localTime < track.startTime) return track.startValue;
        if (localTime <= track.endTime) {
            const duration = Math.max(track.endTime - track.startTime, 0.0001);
            const progress = THREE.MathUtils.clamp((localTime - track.startTime) / duration, 0, 1);
            return THREE.MathUtils.lerp(track.startValue, track.endValue, progress);
        }
    }

    return tracks[tracks.length - 1].endValue;
}

function applyAnimationPropertyValue(targetData, object3d, propertyPath, value) {
    if (!Number.isFinite(value)) return;
    const [field, axis] = String(propertyPath || "").split(".");
    if (!["position", "rotation", "scale"].includes(field) || !["x", "y", "z"].includes(axis)) {
        return;
    }
    targetData[field] = {
        ...(targetData[field] || {}),
        [axis]: field === "scale" ? Math.max(value, 0.001) : value,
    };
    object3d[field][axis] = targetData[field][axis];
}

function setPointer(event) {
    const rect = renderer.domElement.getBoundingClientRect();
    pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
    pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
}

function getHit(event) {
    setPointer(event);
    raycaster.setFromCamera(pointer, camera);
    const objects = getSelectableObjects();
    const hits = raycaster.intersectObjects(objects, true);
    for (const hit of hits) {
        let target = hit.object;
        while (target && !target.userData.sceneObjectId) {
            target = target.parent;
        }
        if (!target) continue;
        const objectData = getObjectData(target.userData.sceneObjectId);
        const selectionId = resolveCanvasSelectionId(target.userData.sceneObjectId);
        if (!objectData || !selectionId || objectData.visible === false || target.visible === false)
            continue;
        const selectionObject = objectMap.get(selectionId);
        if (!selectionObject) continue;
        return {
            id: selectionId,
            object: selectionObject,
            point: hit.point,
        };
    }
    return null;
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

function getSelectableObjects() {
    return Array.from(objectMap.entries())
        .filter(([id, object]) => {
            const objectData = getObjectData(id);
            if (!objectData || objectData.visible === false) return false;
            if (["importedLayer", "importedMesh"].includes(objectData.type)) return false;
            return object.visible !== false;
        })
        .map(([id, object]) => selectionRaycastMap.get(id) || object);
}

function isTransformControlsPointerActive() {
    return Boolean(transformControls?.object && (transformControls.axis || transformControls.dragging));
}

function handlePointerDown(event) {
    if (event.button !== 0 || !sceneState) return;
    focusCanvasHost();
    if (props.mode === "view") {
        const hit = getHit(event);
        if (hit) {
            floatingDevicePopoverOpenedDuringClickEvent = false;
            const actions = runObjectEvents(hit.id, "leftClick", { pointerEvent: event, hit });
            const shouldKeepFloatingDevicePopover =
                actions.includes("devicePopover") || floatingDevicePopoverOpenedDuringClickEvent;
            floatingDevicePopoverOpenedDuringClickEvent = false;
            if (!shouldKeepFloatingDevicePopover) hideFloatingDevicePopover();
        } else {
            hideFloatingDevicePopover();
        }
        return;
    }
    if (props.mode !== "edit") return;
    if (isTransformControlsPointerActive()) return;

    const hit = getHit(event);
    if (!hit) {
        if (!event.ctrlKey) applySelection([], true);
        return;
    }

    const currentSelectedIds = sceneState.editorState?.selectedIds || props.selectedIds || [];
    const hitIsSelected = currentSelectedIds.includes(hit.id);
    const nextIds = event.ctrlKey
        ? toggleId(currentSelectedIds, hit.id)
        : hitIsSelected && currentSelectedIds.length > 1
          ? currentSelectedIds
          : [hit.id];
    applySelection(nextIds, true);

    if (event.ctrlKey || event.metaKey || nextIds.length <= 1 || !nextIds.includes(hit.id)) return;

    const objectData = getObjectData(hit.id);
    if (!objectData || objectData.locked) return;
    beginDirectDrag(event, nextIds);
}

function focusCanvasHost() {
    hostRef.value?.focus?.({ preventScroll: true });
}

function runObjectEvents(objectId, triggerType, payload = {}) {
    const objectData = getObjectData(objectId);
    if (!objectData?.events?.length) return [];
    const eventItems = objectData.events.filter((eventItem) =>
        isExecutableObjectEvent(eventItem, triggerType, payload),
    );
    eventItems.forEach((eventItem) => runObjectEventAction(objectData, eventItem, payload));
    return eventItems.map((eventItem) => eventItem.actionType);
}

function isExecutableObjectEvent(eventItem, triggerType, payload = {}) {
    if (eventItem?.triggerType !== triggerType) return false;
    if (eventItem.actionType === "customFunction") return Boolean(String(eventItem.code || "").trim());
    if (eventItem.actionType === "devicePopover") return triggerType === "leftClick";
    return false;
}

function runObjectEventAction(objectData, eventItem, payload = {}) {
    if (eventItem.actionType === "devicePopover") {
        showDevicePopover(objectData, eventItem, payload);
        return;
    }
    runCustomObjectEvent(objectData, eventItem, payload);
}

function runCustomObjectEvent(objectData, eventItem, payload = {}) {
    objectEventTriggerStack.push(eventItem.triggerType);
    try {
        const handler = new Function(
            "context",
            "object",
            "object3d",
            "event",
            "scene",
            "camera",
            "controls",
            "THREE",
            "het3d",
            eventItem.code,
        );
        const context = {
            object: objectData,
            object3d: objectMap.get(objectData.id),
            event: eventItem,
            trigger: payload,
            scene,
            camera,
            controls,
            THREE,
            het3d: canvasHet3dApi,
        };
        handler(
            context,
            context.object,
            context.object3d,
            context.event,
            context.scene,
            context.camera,
            context.controls,
            context.THREE,
            context.het3d,
        );
    } catch (error) {
        console.error("对象事件执行失败", error);
        notifyMessage("error", `对象事件执行失败：${error.message}`, error);
    } finally {
        objectEventTriggerStack.pop();
    }
}

function showPublicDevicePopover(options = {}) {
    if (!sceneState) return false;

    const normalizedOptions = normalizePublicDevicePopoverOptions(options);
    if (
        normalizedOptions.popoverMode !== "builtIn" &&
        isObjectEventTriggerRunning("leftClick")
    ) {
        floatingDevicePopoverOpenedDuringClickEvent = true;
    }
    const objectData = resolvePublicDevicePopoverObject(normalizedOptions);
    showDevicePopover(
        objectData,
        {
            actionType: "devicePopover",
            triggerType: "manual",
            popoverMode: normalizedOptions.popoverMode,
            deviceNo: normalizedOptions.deviceNo,
            params: normalizedOptions.params,
        },
        {
            pointerEvent: normalizedOptions.pointerEvent,
            anchor: normalizedOptions.anchor,
        },
    );
    return true;
}

function normalizePublicDevicePopoverOptions(options = {}) {
    const source = isPlainRecord(options) ? options : { deviceNo: options };
    const params = source.params;
    const paramsDeviceNo = getPublicDevicePopoverParamsDeviceNo(params);
    const objectId = String(
        source.objectId ||
            source.targetId ||
            source.id ||
            source.objectData?.id ||
            source.object?.id ||
            "",
    ).trim();

    return {
        objectId,
        objectData: isPlainRecord(source.objectData) ? source.objectData : null,
        object: isPlainRecord(source.object) ? source.object : null,
        objectName: String(
            source.objectName || source.name || source.objectData?.name || source.object?.name || "",
        ),
        deviceNo: String(source.deviceNo || paramsDeviceNo || "").trim(),
        params,
        popoverMode: source.popoverMode === "builtIn" ? "builtIn" : "floating",
        pointerEvent: source.pointerEvent || source.event || null,
        anchor: source.anchor || null,
    };
}

function getPublicDevicePopoverParamsDeviceNo(params) {
    if (!params) return "";
    if (typeof params === "string") {
        const text = params.trim();
        if (!text) return "";
        try {
            const parsed = JSON.parse(text);
            return String(parsed?.deviceNo || text).trim();
        } catch {
            return text;
        }
    }
    if (isPlainRecord(params)) return String(params.deviceNo || "").trim();
    return "";
}

function resolvePublicDevicePopoverObject(options) {
    if (options.objectData) return options.objectData;
    if (options.object) return options.object;
    if (options.objectId) {
        const objectData = getObjectData(options.objectId);
        if (objectData) return objectData;
    }
    return {
        id: options.objectId,
        name: options.objectName,
    };
}

function isPlainRecord(value) {
    return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function getCanvasEventBus() {
    return props.eventBus || het3dEventBus;
}

function onCanvasEvent(type, handler) {
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

function showDevicePopover(objectData, eventItem, payload = {}) {
    emit("device-popover", {
        object: cloneData(objectData || null),
        event: cloneData(eventItem || null),
        payload,
        mode: eventItem?.popoverMode === "builtIn" ? "builtIn" : "floating",
    });
    if (!resolvedDevicePopoverComponent.value) return;
    if (eventItem?.popoverMode === "builtIn") {
        hideFloatingDevicePopover();
        sceneBuiltInDevicePopoverAnchorId = objectData?.id || "";
        sceneBuiltInDevicePopoverRef.value?.show(objectData, eventItem, {
            ...payload,
            anchor: payload.anchor || getObjectScreenAnchor(objectData?.id, payload.pointerEvent),
        });
        return;
    }
    devicePopoverRef.value?.show(objectData, eventItem, {
        ...payload,
        pointerEvent:
            payload.pointerEvent ||
            getFloatingDevicePopoverPointerEvent(objectData?.id, payload.anchor),
    });
}

function getFloatingDevicePopoverPointerEvent(objectId, anchor) {
    if (Number.isFinite(anchor?.clientX) && Number.isFinite(anchor?.clientY)) {
        return {
            clientX: anchor.clientX,
            clientY: anchor.clientY,
        };
    }

    const rect = hostRef.value?.getBoundingClientRect();
    if (!rect) return null;

    const point =
        Number.isFinite(anchor?.x) && Number.isFinite(anchor?.y)
            ? anchor
            : getObjectScreenAnchor(objectId);
    if (!point) return null;

    return {
        clientX: rect.left + point.x,
        clientY: rect.top + point.y,
    };
}

function hideFloatingDevicePopover() {
    devicePopoverRef.value?.hide();
}

function hideSceneBuiltInDevicePopover() {
    sceneBuiltInDevicePopoverAnchorId = "";
    sceneBuiltInDevicePopoverRef.value?.hide();
}

function hideAllDevicePopovers() {
    hideFloatingDevicePopover();
    hideSceneBuiltInDevicePopover();
}

function handleSceneBuiltInDevicePopoverClose() {
    sceneBuiltInDevicePopoverAnchorId = "";
}

function getCanvasHet3dSetValueOptions() {
    return {
        syncBindingValues: !isObjectEventTriggerRunning("valueChange"),
    };
}

function isObjectEventTriggerRunning(triggerType) {
    return objectEventTriggerStack.includes(triggerType);
}

function clearCanvasHttpsPolling() {
    if (httpsPollingTimer) {
        clearInterval(httpsPollingTimer);
        httpsPollingTimer = null;
    }
}

function getCanvasHttpsPollingSignature(config) {
    if (!config) return "";
    return JSON.stringify({
        enabled: Boolean(config.enabled),
        url: config.url,
        method: config.method,
        headers: config.headers,
        query: config.query,
        body: config.body,
        processor: config.processor,
        intervalSeconds: config.intervalSeconds,
    });
}

function restartCanvasHttpsPolling({ immediate = false } = {}) {
    if (props.mode !== "view") {
        clearCanvasHttpsPolling();
        return;
    }

    const config = normalizeHttpsConfigData(sceneState?.httpsConfig || {});
    sceneState.httpsConfig = config;
    const signature = getCanvasHttpsPollingSignature(config);
    if (!config.enabled || !config.url) {
        clearCanvasHttpsPolling();
        httpsPollingSignature = signature;
        runInitialBindingValueChangeEvents([]);
        return;
    }

    if (httpsPollingTimer && signature === httpsPollingSignature) {
        if (immediate) runCanvasHttpsRequest();
        return;
    }

    clearCanvasHttpsPolling();
    httpsPollingSignature = signature;
    httpsPollingTimer = setInterval(runCanvasHttpsRequest, config.intervalSeconds * 1000);
    if (immediate) runCanvasHttpsRequest();
}

async function requestSceneData(options) {
    if (props.requestHandler) {
        return props.requestHandler(options);
    }
    return defaultRequestHandler(options);
}

async function defaultRequestHandler({
    method,
    url,
    headers,
    query,
    body,
    timeout = 10000,
}) {
    const requestMethod = method === "POST" ? "POST" : "GET";
    const requestHeaders = normalizeRequestHeaders(headers);
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeout);
    const requestUrl = appendQueryToUrl(url, query);
    const requestOptions = {
        method: requestMethod,
        signal: controller.signal,
    };
    if (Object.keys(requestHeaders).length) {
        requestOptions.headers = requestHeaders;
    }
    if (requestMethod !== "GET" && hasRequestValue(body)) {
        requestOptions.body = stringifyRequestBody(body);
    }

    try {
        const response = await fetch(requestUrl, requestOptions);
        const data = await readResponseData(response);
        if (!response.ok) {
            throw new Error(`${requestMethod} ${response.status}`);
        }
        return data;
    } finally {
        clearTimeout(timeoutId);
    }
}

function normalizeRequestHeaders(headers = {}) {
    if (!headers || typeof headers !== "object" || Array.isArray(headers)) return {};
    return Object.fromEntries(
        Object.entries(headers)
            .filter(([, value]) => value !== undefined && value !== null)
            .map(([key, value]) => [key, String(value)]),
    );
}

async function readResponseData(response) {
    const text = await response.text();
    if (!text) return null;
    try {
        return JSON.parse(text);
    } catch {
        return text;
    }
}

function stringifyRequestBody(body) {
    return typeof body === "string" ? body : JSON.stringify(body);
}

function hasRequestValue(value) {
    if (value === undefined) return false;
    if (value === null) return true;
    if (Array.isArray(value)) return value.length > 0;
    if (typeof value === "object") return Object.keys(value).length > 0;
    if (typeof value === "string") return value.length > 0;
    return true;
}

function appendQueryToUrl(url, query = {}) {
    const requestUrl = String(url || "").trim();
    const entries = Object.entries(query || {}).filter(([, value]) => value !== undefined);
    if (!entries.length) return requestUrl;

    const [urlWithoutHash, hash = ""] = requestUrl.split("#");
    const [baseUrl, search = ""] = urlWithoutHash.split("?");
    const params = new URLSearchParams(search);
    entries.forEach(([key, value]) => {
        if (Array.isArray(value)) {
            params.delete(key);
            value.forEach((item) => params.append(key, item == null ? "" : String(item)));
            return;
        }
        params.set(key, value == null ? "" : String(value));
    });
    const nextSearch = params.toString();
    return `${baseUrl}${nextSearch ? `?${nextSearch}` : ""}${hash ? `#${hash}` : ""}`;
}

async function runCanvasHttpsRequest() {
    if (props.mode !== "view" || !sceneState || httpsRequestRunning) return;
    const config = normalizeHttpsConfigData(sceneState.httpsConfig || {});
    if (!config.enabled || !config.url) return;

    const headersResult = parseHttpsJsonText(config.headers, "Headers", { objectOnly: true });
    if (!headersResult.ok) {
        console.warn(headersResult.message);
        return;
    }
    const queryResult = parseHttpsJsonText(config.query, "Query", { objectOnly: true });
    if (!queryResult.ok) {
        console.warn(queryResult.message);
        return;
    }
    const bodyResult = parseHttpsJsonText(config.body, "Body");
    if (!bodyResult.ok) {
        console.warn(bodyResult.message);
        return;
    }

    httpsRequestRunning = true;
    try {
        const requestOptions = {
            method: config.method,
            url: config.url,
            timeout: 10000,
        };
        if (hasRequestValue(headersResult.value)) {
            requestOptions.headers = headersResult.value;
        }
        if (hasRequestValue(queryResult.value)) {
            requestOptions.query = queryResult.value;
        }
        if (hasRequestValue(bodyResult.value)) {
            requestOptions.body = bodyResult.value;
        }
        const responseData = await requestSceneData(requestOptions);
        const processedData = await runHttpsResponseProcessor(responseData, config.processor);
        const changes = applyProcessedDataToSceneBindings(sceneState, processedData);
        if (!initialValueChangeEventsExecuted) {
            runInitialBindingValueChangeEvents(processedData, changes);
            if (changes.length) emitSceneChange();
        } else if (changes.length) {
            runBindingValueChangeEvents(changes, processedData);
            emitSceneChange();
        }
    } catch (error) {
        console.error("预览数据请求失败", error);
    } finally {
        httpsRequestRunning = false;
    }
}

function runInitialBindingValueChangeEvents(processedData = [], actualChanges = []) {
    if (props.mode !== "view" || !sceneState || initialValueChangeEventsExecuted) return;
    initialValueChangeEventsExecuted = true;

    const actualChangeMap = new Map(
        actualChanges.map((change) => [`${change.objectId || ""}:${change.dataId || ""}`, change]),
    );

    flattenModels(sceneState.models || [])
        .filter(hasExecutableValueChangeEvent)
        .forEach((objectData) => {
            const bindings = Array.isArray(objectData.dataBindings) ? objectData.dataBindings : [];
            const changes = bindings.map((bindingItem) => {
                const changeKey = `${objectData.id}:${bindingItem.id || ""}`;
                const actualChange = actualChangeMap.get(changeKey);
                if (actualChange) return actualChange;
                return {
                    objectId: objectData.id,
                    object: cloneData(objectData),
                    dataId: bindingItem.id,
                    propName: bindingItem.propName,
                    displayName: bindingItem.displayName,
                    binding: cloneData(bindingItem.binding || null),
                    previousValue: undefined,
                    currentValue: cloneEventValue(bindingItem.value),
                    sourceRecord: null,
                    initial: true,
                };
            });

            runObjectEvents(objectData.id, "valueChange", {
                initial: true,
                changes: cloneData(changes),
                processedData: cloneData(processedData),
            });
        });
}

function hasExecutableValueChangeEvent(objectData) {
    return (objectData.events || []).some(
        (eventItem) =>
            eventItem?.triggerType === "valueChange" &&
            eventItem?.actionType === "customFunction" &&
            String(eventItem?.code || "").trim(),
    );
}

function cloneEventValue(value) {
    return value === undefined ? undefined : cloneData(value);
}

function runBindingValueChangeEvents(changes, processedData) {
    const changesByObject = new Map();
    changes.forEach((change) => {
        if (!change.objectId) return;
        if (!changesByObject.has(change.objectId)) changesByObject.set(change.objectId, []);
        changesByObject.get(change.objectId).push(change);
    });

    changesByObject.forEach((objectChanges, objectId) => {
        runObjectEvents(objectId, "valueChange", {
            changes: cloneData(objectChanges),
            processedData: cloneData(processedData),
        });
    });
}

function handleHet3dValueChange(nextObject, previousObject, payload = {}) {
    if (props.mode !== "view" || !sceneState) return;
    if (isObjectEventTriggerRunning("valueChange")) return;
    const changes = getHet3dBindingValueChanges(nextObject, previousObject, payload);
    if (!changes.length) return;
    runBindingValueChangeEvents(changes, []);
}

function getHet3dBindingValueChanges(nextObject, previousObject, payload = {}) {
    if (!nextObject?.id) return [];
    const payloadKeys = new Set(Object.keys(payload || {}).filter((key) => key !== "id"));
    const previousBindings = new Map(
        (previousObject?.dataBindings || []).map((bindingItem, index) => [
            getBindingChangeKey(bindingItem, index),
            bindingItem,
        ]),
    );
    const latestObject = getObjectData(nextObject.id) || nextObject;

    return (nextObject.dataBindings || [])
        .map((bindingItem, index) => {
            const propName = String(bindingItem?.propName || "").trim();
            if (!propName || !payloadKeys.has(propName)) return null;

            const previousBinding = previousBindings.get(getBindingChangeKey(bindingItem, index));
            const previousValue = getBindingRuntimeValue(previousObject, previousBinding, propName);
            const currentValue = getBindingRuntimeValue(nextObject, bindingItem, propName);
            if (isEventDataValueEqual(previousValue, currentValue)) return null;

            return {
                objectId: nextObject.id,
                object: cloneData(latestObject),
                dataId: bindingItem.id,
                propName,
                displayName: bindingItem.displayName,
                binding: cloneEventValue(bindingItem.binding || null),
                previousValue: cloneEventValue(previousValue),
                currentValue: cloneEventValue(currentValue),
                sourceRecord: null,
                source: "het3d.setValue",
            };
        })
        .filter(Boolean);
}

function getBindingChangeKey(bindingItem, index) {
    return bindingItem?.id || bindingItem?.propName || String(index);
}

function getBindingRuntimeValue(objectData, bindingItem, propName) {
    if (bindingItem && Object.prototype.hasOwnProperty.call(bindingItem, "value")) {
        return bindingItem.value;
    }
    return objectData?.[propName];
}

function isEventDataValueEqual(left, right) {
    return stableEventDataValue(left) === stableEventDataValue(right);
}

function stableEventDataValue(value) {
    if (value === undefined) return "__undefined__";
    try {
        return JSON.stringify(value);
    } catch {
        return String(value);
    }
}

function toggleId(ids, id) {
    return ids.includes(id) ? ids.filter((item) => item !== id) : [...ids, id];
}

function beginDirectDrag(event, ids) {
    const draggableIds = ids.filter((id) => !getObjectData(id)?.locked && objectMap.has(id));
    if (!draggableIds.length) return;

    event.preventDefault();
    setPointer(event);
    raycaster.setFromCamera(pointer, camera);
    const normal = camera.getWorldDirection(new THREE.Vector3()).normalize();
    const firstObject = objectMap.get(draggableIds[0]);
    if (!firstObject) return;
    const worldPosition = firstObject.getWorldPosition(new THREE.Vector3());
    dragPlane.setFromNormalAndCoplanarPoint(normal, worldPosition);
    const startPoint = new THREE.Vector3();
    raycaster.ray.intersectPlane(dragPlane, startPoint);

    directDrag = {
        ids: draggableIds,
        startPoint,
        startPositions: new Map(
            draggableIds
                .map((id) => [id, objectMap.get(id)?.position.clone()])
                .filter(([, value]) => value),
        ),
        moved: false,
    };
    controls.enabled = false;
}

function handlePointerMove(event) {
    if (!directDrag || !sceneState) return;
    setPointer(event);
    raycaster.setFromCamera(pointer, camera);
    const point = new THREE.Vector3();
    if (!raycaster.ray.intersectPlane(dragPlane, point)) return;
    const delta = point.sub(directDrag.startPoint);

    directDrag.ids.forEach((id) => {
        const object3d = objectMap.get(id);
        const startPosition = directDrag.startPositions.get(id);
        const objectData = getObjectData(id);
        if (!object3d || !startPosition || !objectData) return;
        object3d.position.copy(startPosition).add(delta);
    });
    selectionHelpers.forEach((helper) => helper.update?.());
    directDrag.moved = true;
}

function handlePointerUp() {
    if (!directDrag) return;
    const shouldEmit = directDrag.moved;
    directDrag = null;
    controls.enabled = true;
    syncSelectedObjectsFromThree();
    if (shouldEmit) {
        scheduleCameraRangeUpdate();
        emitSceneChange();
    }
}

function applySelection(ids, shouldEmit) {
    const filtered = ids.filter(
        (id) => objectMap.has(id) || findModelById(sceneState?.models || [], id),
    );
    sceneState.editorState = {
        ...(sceneState.editorState || {}),
        selectedIds: filtered,
    };
    updateSelectionHelpers();

    if (filtered.length === 1 && objectMap.has(filtered[0]) && props.mode === "edit") {
        transformControls.attach(objectMap.get(filtered[0]));
    } else {
        transformControls.detach();
    }

    if (shouldEmit) {
        emit("select", {
            selectedIds: filtered,
            models: filtered.map((id) => getObjectData(id)).filter(Boolean),
        });
    }
}

function updateSelectionHelpers() {
    clearSelectionHelpers();
    const ids = sceneState?.editorState?.selectedIds || [];
    ids.slice(0, maxSelectionHelpers).forEach((id) => {
        const object3d = objectMap.get(id);
        if (!object3d) return;
        const helper = new THREE.BoxHelper(object3d, selectionHelperColor);
        helper.material.depthTest = false;
        helper.material.depthWrite = false;
        helper.material.transparent = true;
        helper.material.opacity = 1;
        helper.renderOrder = selectionHelperRenderOrder;
        selectionHelpers.push(helper);
        scene.add(helper);
    });
}

function clearSelectionHelpers() {
    selectionHelpers.splice(0).forEach((helper) => {
        scene?.remove(helper);
        helper.geometry?.dispose?.();
        helper.material?.dispose?.();
    });
}

function syncSelectedObjectsFromThree(shouldUpdateHelpers = true) {
    const ids = sceneState?.editorState?.selectedIds || [];
    ids.forEach((id) => {
        const object3d = objectMap.get(id);
        const objectData = getObjectData(id);
        if (!object3d || !objectData) return;
        objectData.position = {
            x: round(object3d.position.x),
            y: round(object3d.position.y),
            z: round(object3d.position.z),
        };
        objectData.rotation = {
            x: round(object3d.rotation.x),
            y: round(object3d.rotation.y),
            z: round(object3d.rotation.z),
        };
        objectData.scale = {
            x: round(object3d.scale.x),
            y: round(object3d.scale.y),
            z: round(object3d.scale.z),
        };
    });
    if (shouldUpdateHelpers) {
        updateSelectionHelpers();
    }
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
    if (typeof window === "undefined" || props.mode !== "view" || !props.installGlobal) return;
    previousHet3dDescriptor = Object.getOwnPropertyDescriptor(window, "het3d") || null;
    hasPreviousHet3dDescriptor = Boolean(previousHet3dDescriptor);
    Object.defineProperty(window, "het3d", {
        configurable: true,
        value: canvasHet3dApi,
    });
}

function restoreCanvasHet3dGlobal() {
    if (typeof window === "undefined" || props.mode !== "view" || !props.installGlobal) return;
    if (window.het3d === canvasHet3dApi) {
        if (hasPreviousHet3dDescriptor) {
            Object.defineProperty(window, "het3d", previousHet3dDescriptor);
        } else {
            delete window.het3d;
        }
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
    setPointer(event);
    raycaster.setFromCamera(pointer, camera);
    const objects = getSelectableObjects();
    const hits = raycaster.intersectObjects(objects, true);
    if (hits.length) return hits[0].point;

    const groundPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
    const point = new THREE.Vector3();
    if (raycaster.ray.intersectPlane(groundPlane, point)) {
        return point;
    }
    return new THREE.Vector3(0, 0.5, 0);
}

async function addObjectFromResource(resource, position = new THREE.Vector3(0, 0.5, 0)) {
    if (!sceneState) return null;
    if (resource.type === "localModel") {
        return importLocalModelResource(resource);
    }

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
    const object3d = await createThreeObject(objectData);
    objectMap.set(objectData.id, object3d);
    contentGroup.add(object3d);
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
    return Array.from(selectedObjectMap.values()).filter(
        (objectData) => !hasSelectedAncestor(objectData, selectedIds),
    );
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
    const context = {
        idMap: new Map(),
        pasteSerial,
    };
    const pastedObjects = copiedSceneObjects.map((objectData) =>
        createPastedObjectTree(objectData, context, true),
    );
    remapPastedObjectReferences(pastedObjects, context.idMap);

    const offset = getPasteOffsetVector(pasteSerial);
    pastedObjects.forEach((objectData) => {
        objectData.parentId = null;
        offsetObjectTreePosition(objectData, offset);
    });

    for (const objectData of pastedObjects) {
        sceneState.models.push(objectData);
        const object3d = await createThreeObject(objectData);
        objectMap.set(objectData.id, object3d);
        contentGroup.add(object3d);
    }

    applySelection(
        pastedObjects.map((objectData) => objectData.id),
        true,
    );
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
    if (isRoot) {
        objectData.name = createPastedObjectName(objectData.name, context.pasteSerial);
    }
    objectData.children = (objectData.children || []).map((child) =>
        createPastedObjectTree(child, context),
    );
    regeneratePastedObjectInternalIds(objectData);
    return objectData;
}

function createPastedObjectName(name, serial) {
    const baseName = String(name || "对象").trim() || "对象";
    return serial > 1 ? `${baseName} 副本 ${serial}` : `${baseName} 副本`;
}

function regeneratePastedObjectInternalIds(objectData) {
    if (Array.isArray(objectData.events)) {
        objectData.events = objectData.events.map((eventItem) => ({
            ...eventItem,
            id: createId("event"),
        }));
    }
    if (Array.isArray(objectData.animations)) {
        objectData.animations = objectData.animations.map(regeneratePastedAnimationIds);
    }
}

function regeneratePastedAnimationIds(animation) {
    return {
        ...animation,
        id: createId("animation"),
        segments: (animation.segments || []).map((segment) => ({
            ...segment,
            id: createId("segment"),
            properties: (segment.properties || []).map((property) => ({
                ...property,
                id: createId("property"),
            })),
        })),
    };
}

function remapPastedObjectReferences(pastedObjects, idMap) {
    flattenModels(pastedObjects).forEach((objectData) => {
        if (objectData.parentId && idMap.has(objectData.parentId)) {
            objectData.parentId = idMap.get(objectData.parentId);
        }
        if (Array.isArray(objectData.animations)) {
            objectData.animations.forEach((animation) => {
                if (idMap.has(animation.targetId)) {
                    animation.targetId = idMap.get(animation.targetId);
                }
            });
        }
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
    const step = getSceneRelativeObjectSize({
        fallback: 0.8,
        ratio: 0.03,
        min: 0.6,
        max: 2000,
    });
    return {
        x: round(step * serial),
        y: 0,
        z: round(step * serial),
    };
}

function getDefaultObjectScale(type, resource) {
    if (resource?.scale) return cloneData(resource.scale);
    if (isDefaultModelType(type)) {
        const size = getSceneRelativeDefaultModelScale();
        return {
            x: size,
            y: size,
            z: size,
        };
    }
    if (!["icon", "image"].includes(type)) return undefined;

    const size = type === "image" ? getSceneRelativeImageScale() : getSceneRelativeIconSize();
    return {
        x: size,
        y: size,
        z: size,
    };
}

function isDefaultModelType(type) {
    return ["box", "sphere", "cylinder", "plane"].includes(type);
}

function getSceneRelativeDefaultModelScale() {
    return getSceneRelativeObjectSize({
        fallback: 1,
        ratio: 0.035,
        min: 1,
        max: 3000,
    });
}

function getSceneRelativeIconSize() {
    return getSceneRelativeObjectSize({
        fallback: 1.8,
        ratio: 0.035,
        min: 1.8,
        max: 3000,
    });
}

function getSceneRelativeImageScale() {
    return getSceneRelativeObjectSize({
        fallback: 1.5,
        ratio: 0.025,
        min: 1.5,
        max: 2500,
    });
}

function getSceneRelativeObjectSize({ fallback, ratio, min, max }) {
    const box = getSceneReferenceBoundsForPlacements();
    if (!box || box.isEmpty()) return fallback;

    const size = new THREE.Vector3();
    box.getSize(size);
    const maxDimension = Math.max(size.x, size.y, size.z);
    if (!Number.isFinite(maxDimension) || maxDimension <= 0) return fallback;

    return round(THREE.MathUtils.clamp(maxDimension * ratio, min, max));
}

function getSceneReferenceBoundsForPlacements() {
    const box = new THREE.Box3();
    contentGroup?.children?.forEach((object) => {
        const objectData = getObjectData(object.userData.sceneObjectId);
        if (!objectData || objectData.type === "icon" || objectData.type === "image") return;
        if (object.visible !== false) box.expandByObject(object);
    });
    return box.isEmpty() ? getSceneBounds() : box;
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
        name:
            {
                box: "立方体",
                sphere: "球体",
                cylinder: "圆柱体",
                plane: "平面",
            }[type] || "模型",
        type,
    };
    return addObjectFromResource(resource, new THREE.Vector3(0, type === "plane" ? 0 : 0.5, 0));
}

function updateSceneObject(objectData) {
    const result = updateModelById(sceneState.models, objectData);
    if (!result.updated) return;
    sceneState.models = result.models;
    const object3d = objectMap.get(objectData.id);
    if (object3d) {
        object3d.name = objectData.name;
        object3d.position.set(objectData.position.x, objectData.position.y, objectData.position.z);
        object3d.rotation.set(objectData.rotation.x, objectData.rotation.y, objectData.rotation.z);
        object3d.scale.set(objectData.scale.x, objectData.scale.y, objectData.scale.z);
        object3d.visible = objectData.visible !== false;
        if (objectData.type === "icon") {
            updateSpriteMaterial(object3d, objectData);
        } else if (shouldApplyMaterialColor(objectData)) {
            applyMaterialColorToObject(object3d, objectData.material?.color);
        }
    }
    updateSelectionHelpers();
    scheduleCameraRangeUpdate();
    emitSceneChange();
}

function updateSpriteMaterial(sprite, objectData) {
    if (!sprite?.isSprite) return;
    sprite.material?.map?.dispose?.();
    sprite.material?.dispose?.();
    sprite.material = createSpriteMaterial(
        objectData.material?.symbol || "●",
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

    const object3d = objectMap.get(id);
    if (object3d) {
        object3d.visible = visible;
    } else {
        await loadSceneData(sceneState);
    }

    const selectedIds = sceneState.editorState?.selectedIds || [];
    if (!visible && selectedIds.includes(id)) {
        applySelection(
            selectedIds.filter((selectedId) => selectedId !== id),
            true,
        );
    } else {
        updateSelectionHelpers();
    }
    scheduleCameraRangeUpdate();
    emitSceneChange();
    return true;
}

async function importModelFile(file) {
    if (!sceneState || !file) return false;
    return importModelBlob({
        name: file.name,
        blob: file,
    });
}

async function importLocalModelResource(resource) {
    if (!sceneState || !resource?.url) return false;
    const fileName =
        resource.fileName || decodeURIComponent(resource.url.split("/").pop() || "model.glb");
    return importModelSource({
        name: resource.name || fileName,
        modelPath: resource.url,
    });
}

async function importModelBlob({ name, blob }) {
    const modelPath = await readBlobAsDataUrl(blob);
    return importModelSource({ name, modelPath });
}

async function importModelSource({ name, modelPath = "" }) {
    if (!sceneState || !modelPath) return false;
    loading.value = true;
    try {
        const gltf = await gltfLoader.loadAsync(modelPath);
        const cachedModel = createCachedGltfModelSource(gltf.scene);
        const { meshes, layerEntries } = cachedModel;
        const originOffset = getOriginOffsetForObject(gltf.scene);
        const modelReference = { modelPath };
        assetSceneCache.set(`path:${modelPath}`, cachedModel);

        const parent = createSceneObject("importedModel", {
            name,
            nodeType: "model",
            ...modelReference,
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
        const layerObjects = [];
        layerEntries.forEach((entry) => {
            const layerObject = createLayerObjectData(entry, parent, meshes);
            removeLayerMeshObjects(layerObject);
            layerObjects.push(layerObject);
        });

        if (!layerObjects.length) {
            notifyMessage("warning", "导入文件中没有找到可用 mesh");
            return false;
        }

        parent.children = layerObjects;
        sceneState.models.push(parent);
        const object3d = await createThreeObject(parent);
        objectMap.set(parent.id, object3d);
        contentGroup.add(object3d);
        updateGridToScene();
        updateCameraRangeToScene();
        fitCameraToBox(getObjectBoundsByIds([parent.id]));
        applySelection([parent.id], true);
        emitSceneChange();
        notifyMessage("success", `模型导入成功：${layerObjects.length} 个图层，${meshes.length} 个 mesh`);
        return true;
    } catch (error) {
        notifyMessage("error", `模型导入失败：${error.message}`, error);
        return false;
    } finally {
        loading.value = false;
    }
}

function setTransformMode(mode) {
    transformControls?.setMode(mode);
    if (sceneState) {
        sceneState.editorState = {
            ...(sceneState.editorState || {}),
            transformMode: mode,
        };
    }
}

function resetCamera() {
    if (!fitCameraToBox(getSceneBounds())) {
        applyCameraSettings(defaultCamera());
    }
    emitSceneChange();
}

function focusSelection() {
    const ids = sceneState?.editorState?.selectedIds || [];
    const box = ids.length ? getObjectBoundsByIds(ids) : getSceneBounds();
    if (!fitCameraToBox(box)) return;
    emitSceneChange();
}

function selectAllSelectableObjects() {
    const ids = flattenModels(sceneState.models)
        .filter(
            (object) =>
                !["importedLayer", "importedMesh"].includes(object.type) &&
                object.visible !== false,
        )
        .map((object) => object.id);
    applySelection(ids, true);
}

function selectAllMeshes() {
    selectAllSelectableObjects();
}

function captureThumbnail() {
    renderer.render(scene, camera);
    const thumbnail = renderer.domElement.toDataURL("image/png");
    emit("thumbnail-ready", { thumbnail });
    return thumbnail;
}

function getSceneSnapshot() {
    syncCameraToState();
    return normalizeSceneModelSources(sceneState);
}

defineExpose({
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
