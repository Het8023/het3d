import {
    defaultAnimationSettings,
    normalizeAnimationSettings,
    normalizeBuiltInAnimations,
    normalizeCustomAnimations,
} from "./sceneAnimations.js";

export function createId(prefix = "id") {
    return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

export function cloneData(value) {
    return JSON.parse(JSON.stringify(value));
}

export function nowIso() {
    return new Date().toISOString();
}

function isObjectRecord(value) {
    return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function getModelPathFromData(data) {
    return (
        data?.modelPath ||
        data?.source?.modelPath ||
        data?.source?.sourceUrl ||
        data?.metadata?.sourceUrl ||
        ""
    );
}

export function getDataBindingId(binding = {}) {
    const deviceId = String(binding?.deviceId || "").trim();
    const identifier = String(binding?.identifier || "").trim();
    if (!deviceId || !identifier) return "";
    const valueMode = normalizeDataBindingValueMode(binding?.valueMode);
    return valueMode ? `${deviceId}-${identifier}-${valueMode}` : `${deviceId}-${identifier}`;
}

export function normalizeDataBindingValueMode(value) {
    const mode = String(value || "").trim();
    return mode === "value" || mode === "explain" ? mode : "";
}

export function getDataBindingValueModeFromId(dataId = "") {
    const suffix = String(dataId || "").trim().split("-").pop();
    return normalizeDataBindingValueMode(suffix);
}

function createLegacyBindingMap(dataIds = []) {
    const map = new Map();
    if (!Array.isArray(dataIds)) return map;
    dataIds.forEach((binding) => {
        if (!binding?.deviceId || !binding?.identifier) return;
        if (binding.dataId) map.set(`id:${binding.dataId}`, binding);
        if (binding.propName) map.set(`prop:${binding.propName}`, binding);
    });
    return map;
}

export function normalizeDataBindings(dataBindings = [], dataIds = []) {
    if (!Array.isArray(dataBindings)) return [];
    const legacyBindings = createLegacyBindingMap(dataIds);
    return dataBindings.map((item) => {
        const next = { ...item };
        const legacyBinding =
            legacyBindings.get(`id:${next.id}`) ||
            legacyBindings.get(`prop:${next.propName}`);
        if (!next.binding && legacyBinding) {
            next.binding = {
                deviceId: legacyBinding.deviceId,
                deviceName: legacyBinding.deviceName,
                deviceNo: legacyBinding.deviceNo,
                identifier: legacyBinding.identifier,
                propertyId: legacyBinding.propertyId,
                propertyName: legacyBinding.propertyName,
            };
        }

        const valueMode =
            normalizeDataBindingValueMode(next.binding?.valueMode) ||
            getDataBindingValueModeFromId(next.id) ||
            normalizeDataBindingValueMode(legacyBinding?.valueMode);
        if (next.binding && valueMode) {
            next.binding = {
                ...next.binding,
                valueMode,
            };
        }
        const bindingId = getDataBindingId(next.binding);
        next.id = bindingId || next.id || createId("data");
        return next;
    });
}

function normalizeModelSourceObject(object, { keepModelPath = false } = {}) {
    const modelPath = keepModelPath ? getModelPathFromData(object) : "";
    object.dataBindings = normalizeDataBindings(object.dataBindings, object.dataIds);
    delete object.dataIds;

    if (keepModelPath && modelPath) {
        object.modelPath = modelPath;
        delete object.assetId;
    } else if (keepModelPath && object.assetId) {
        delete object.modelPath;
    } else {
        delete object.modelPath;
        delete object.assetId;
    }

    if (isObjectRecord(object.source)) {
        object.source = { ...object.source };
        delete object.source.modelPath;
        delete object.source.sourceUrl;
    }

    return object;
}

function normalizeModelSourceTree(model, isRoot = false) {
    if (!isObjectRecord(model)) return model;
    const next = normalizeModelSourceObject(
        { ...model },
        { keepModelPath: isRoot && model.type === "importedModel" },
    );
    next.children = Array.isArray(next.children)
        ? next.children.map((child) => normalizeModelSourceTree(child, false))
        : [];
    if (isRoot && next.type === "importedModel") {
        return removeImportedMeshObjects(next);
    }
    return next;
}

export function normalizeSceneModelSources(scene) {
    if (!scene) return scene;
    const next = cloneData(scene);
    next.models = Array.isArray(next.models)
        ? next.models.map((model) => normalizeModelSourceTree(model, true))
        : [];
    return next;
}

function toMeshSourceItem(meshObject) {
    const meshIndex = Number(meshObject?.source?.meshIndex);
    if (!Number.isFinite(meshIndex)) return null;
    return {
        meshIndex,
        name: meshObject.name || `Mesh ${meshIndex + 1}`,
    };
}

function compactImportedLayerMeshObjects(layerObject) {
    if (!isObjectRecord(layerObject) || layerObject.type !== "importedLayer") return layerObject;

    const children = Array.isArray(layerObject.children) ? layerObject.children : [];
    const meshChildren = children.filter((child) => child?.type === "importedMesh");
    const otherChildren = children.filter((child) => child?.type !== "importedMesh");
    const source = isObjectRecord(layerObject.source) ? { ...layerObject.source } : {};

    if ((!Array.isArray(source.meshes) || !source.meshes.length) && meshChildren.length) {
        source.meshes = meshChildren.map(toMeshSourceItem).filter(Boolean);
    }
    if (
        (!Array.isArray(source.meshIndices) || !source.meshIndices.length) &&
        Array.isArray(source.meshes)
    ) {
        source.meshIndices = source.meshes.map((item) => item.meshIndex);
    }
    delete source.meshObjectsReady;
    delete source.meshObjectMode;
    delete source.meshObjectLimit;

    return {
        ...layerObject,
        source,
        children: otherChildren.map((child) =>
            child?.type === "importedLayer" ? compactImportedLayerMeshObjects(child) : child,
        ),
    };
}

function removeImportedMeshObjects(model) {
    const compactChildren = (model.children || []).map((child) =>
        child?.type === "importedLayer" ? compactImportedLayerMeshObjects(child) : child,
    );
    const source = { ...(model.source || {}) };
    if (source.meshCount) {
        source.selectionLevel = "layer";
    }
    delete source.meshObjectMode;
    delete source.meshObjectLimit;

    return {
        ...model,
        children: compactChildren,
        source,
    };
}

export function defaultCamera() {
    return {
        position: { x: 5, y: 5, z: 6 },
        target: { x: 0, y: 0.5, z: 0 },
        near: 0.1,
        far: 1000,
    };
}

export function defaultCanvas() {
    return {
        backgroundColor: "#f5f7fb",
        showGrid: true,
        showAxes: true,
        axesSize: 3,
    };
}

export function defaultLights() {
    return {
        ambient: { color: "#ffffff", intensity: 1.6 },
        directional: {
            color: "#ffffff",
            intensity: 1.25,
            position: { x: 4, y: 8, z: 5 },
        },
    };
}

function legacyDefaultLights() {
    return {
        ambient: { color: "#ffffff", intensity: 0.75 },
        directional: {
            color: "#ffffff",
            intensity: 1,
            position: { x: 4, y: 7, z: 5 },
        },
    };
}

function normalizeColor(value, fallback) {
    return typeof value === "string" && /^#(?:[0-9a-f]{3}){1,2}$/i.test(value) ? value : fallback;
}

function normalizeNumber(value, fallback, min = -Infinity, max = Infinity) {
    const number = Number(value);
    if (!Number.isFinite(number)) return fallback;
    return Math.min(Math.max(number, min), max);
}

function normalizeVector3(value, fallback) {
    return {
        x: normalizeNumber(value?.x, fallback.x),
        y: normalizeNumber(value?.y, fallback.y),
        z: normalizeNumber(value?.z, fallback.z),
    };
}

function isSameNumber(left, right) {
    return Math.abs(Number(left) - Number(right)) < 0.000001;
}

function isLegacyDefaultLights(value) {
    if (!isObjectRecord(value)) return false;
    const legacy = legacyDefaultLights();
    return (
        value.ambient?.color === legacy.ambient.color &&
        isSameNumber(value.ambient?.intensity, legacy.ambient.intensity) &&
        value.directional?.color === legacy.directional.color &&
        isSameNumber(value.directional?.intensity, legacy.directional.intensity) &&
        isSameNumber(value.directional?.position?.x, legacy.directional.position.x) &&
        isSameNumber(value.directional?.position?.y, legacy.directional.position.y) &&
        isSameNumber(value.directional?.position?.z, legacy.directional.position.z)
    );
}

export function normalizeLights(value) {
    const defaults = defaultLights();
    const source = isObjectRecord(value) && !isLegacyDefaultLights(value) ? value : defaults;
    return {
        ambient: {
            color: normalizeColor(source.ambient?.color, defaults.ambient.color),
            intensity: normalizeNumber(
                source.ambient?.intensity,
                defaults.ambient.intensity,
                0,
                10,
            ),
        },
        directional: {
            color: normalizeColor(source.directional?.color, defaults.directional.color),
            intensity: normalizeNumber(
                source.directional?.intensity,
                defaults.directional.intensity,
                0,
                10,
            ),
            position: normalizeVector3(source.directional?.position, defaults.directional.position),
        },
    };
}

export function defaultHttpsConfig() {
    return {
        enabled: false,
        method: "GET",
        url: "",
        headers: "{}",
        query: "{}",
        body: "{}",
        processor: defaultHttpsProcessor(),
        intervalSeconds: 10,
    };
}

function normalizeJsonText(value) {
    return typeof value === "string" ? value : JSON.stringify(value || {}, null, 2);
}

function defaultHttpsProcessor() {
    return `function handleMessage(e) {
  return Array.isArray(e) ? e
    .filter((item) => item?.dataId && Object.prototype.hasOwnProperty.call(item, "value"))
    .map((item) => ({
      dataId: String(item.dataId),
      value: item.value,
    })) : []
}`;
}

function normalizeProcessorText(value) {
    const source = String(value || "").trim();
    if (!source) return defaultHttpsProcessor();
    return source;
}

export function createSceneObject(type, options = {}) {
    const position = options.position || { x: 0, y: 0.5, z: 0 };
    const rotation =
        options.rotation ||
        (type === "plane" ? { x: -Math.PI / 2, y: 0, z: 0 } : { x: 0, y: 0, z: 0 });
    const scale = options.scale || { x: 1, y: 1, z: 1 };
    const defaultNames = {
        box: "立方体",
        sphere: "球体",
        cylinder: "圆柱体",
        plane: "平面",
        icon: "图标",
        image: "图片面片",
        importedModel: "导入模型",
        importedLayer: "导入图层",
    };

    const modelPath = type === "importedModel" ? getModelPathFromData(options) : "";
    const source = options.source ? { ...options.source } : null;
    if (source && modelPath) {
        delete source.modelPath;
        delete source.sourceUrl;
    } else if (source) {
        delete source.modelPath;
        delete source.sourceUrl;
    }

    const object = {
        id: options.id || createId("obj"),
        name: options.name || defaultNames[type] || "对象",
        type,
        nodeType:
            options.nodeType ||
            (type === "importedModel"
                ? "model"
                : type === "importedLayer"
                  ? "layer"
                  : type === "icon" || type === "image"
                    ? type
                    : "mesh"),
        parentId: options.parentId || null,
        children: Array.isArray(options.children) ? options.children : [],
        position: { x: position.x, y: position.y, z: position.z },
        rotation: { x: rotation.x, y: rotation.y, z: rotation.z },
        scale: { x: scale.x, y: scale.y, z: scale.z },
        material: {
            color: options.material?.color || options.color || "#4f7cff",
            symbol: options.material?.symbol || options.symbol || "",
            label: options.material?.label || options.name || defaultNames[type] || "对象",
            shape: options.material?.shape || (type === "icon" ? "circle" : ""),
        },
        source,
        dataBindings: normalizeDataBindings(options.dataBindings, options.dataIds),
        events: Array.isArray(options.events) ? options.events : [],
        animations: normalizeCustomAnimations(options.animations),
        builtInAnimations: normalizeBuiltInAnimations(options.builtInAnimations),
        metadata: options.metadata || null,
        visible: options.visible ?? true,
        locked: options.locked ?? false,
    };
    if (modelPath) {
        object.modelPath = modelPath;
    } else if (options.assetId) {
        object.assetId = options.assetId;
    }
    return object;
}

export function createDefaultScene(projectId, sceneId = createId("scene")) {
    const cube = createSceneObject("box", {
        name: "默认立方体",
        position: { x: 0, y: 0.5, z: 0 },
        material: { color: "#4f7cff" },
    });

    return {
        id: sceneId,
        projectId,
        models: [cube],
        hierarchy: [],
        camera: defaultCamera(),
        canvas: defaultCanvas(),
        lights: defaultLights(),
        animationSettings: defaultAnimationSettings(),
        httpsConfig: defaultHttpsConfig(),
        editorState: {
            selectedIds: [],
            transformMode: "translate",
        },
        updatedAt: nowIso(),
    };
}

export function normalizeScene(scene) {
    const next = cloneData(scene);
    delete next.objects;
    next.models = normalizeModelTree(next.models);
    next.hierarchy = Array.isArray(next.hierarchy) ? next.hierarchy : [];
    next.camera = next.camera || defaultCamera();
    next.camera.position = next.camera.position || defaultCamera().position;
    next.camera.target = next.camera.target || defaultCamera().target;
    next.canvas = { ...defaultCanvas(), ...(next.canvas || {}) };
    next.lights = normalizeLights(next.lights);
    next.animationSettings = normalizeAnimationSettings(next.animationSettings);
    next.httpsConfig = { ...defaultHttpsConfig(), ...(next.httpsConfig || {}) };
    next.httpsConfig.method = ["GET", "POST"].includes(
        String(next.httpsConfig.method).toUpperCase(),
    )
        ? String(next.httpsConfig.method).toUpperCase()
        : "GET";
    next.httpsConfig.headers = normalizeJsonText(next.httpsConfig.headers);
    next.httpsConfig.query = normalizeJsonText(next.httpsConfig.query);
    next.httpsConfig.body = normalizeJsonText(next.httpsConfig.body);
    next.httpsConfig.processor = normalizeProcessorText(next.httpsConfig.processor);
    next.httpsConfig.intervalSeconds = Math.max(Number(next.httpsConfig.intervalSeconds) || 10, 1);
    next.editorState = next.editorState || { selectedIds: [], transformMode: "translate" };
    return next;
}

export function buildSceneTree(models) {
    return (Array.isArray(models) ? models : []).map(buildTreeNode).filter(Boolean);
}

function normalizeModelTree(models) {
    const flattened = flattenInputModels(Array.isArray(models) ? models : []);
    const nodeMap = new Map();
    const roots = [];

    flattened.forEach((model) => {
        if (!model.id || nodeMap.has(model.id)) return;
        nodeMap.set(model.id, normalizeModelNode(model));
    });

    nodeMap.forEach((model) => {
        if (model.parentId && nodeMap.has(model.parentId)) {
            nodeMap.get(model.parentId).children.push(model);
        } else {
            model.parentId = null;
            roots.push(model);
        }
    });

    return roots.map((model) =>
        model?.type === "importedModel" ? removeImportedMeshObjects(model) : model,
    );
}

function flattenInputModels(models, parentId = null) {
    const flattened = [];
    models.forEach((model) => {
        if (!isObjectRecord(model)) return;
        const node = normalizeModelSourceObject(
            {
                ...model,
                parentId: parentId ?? model.parentId ?? null,
                children: [],
            },
            { keepModelPath: model.type === "importedModel" },
        );
        flattened.push(node);
        if (Array.isArray(model.children)) {
            flattened.push(...flattenInputModels(model.children.filter(isObjectRecord), model.id));
        }
    });
    return flattened;
}

function normalizeModelNode(model) {
    const next = {
        ...model,
        children: [],
        material: {
            color: model.material?.color || model.color || "#4f7cff",
            symbol: model.material?.symbol || model.symbol || "",
            label: model.material?.label || model.name || "对象",
            shape: model.material?.shape || (model.type === "icon" ? "circle" : ""),
        },
        dataBindings: normalizeDataBindings(model.dataBindings, model.dataIds),
        events: Array.isArray(model.events) ? model.events : [],
        animations: normalizeCustomAnimations(model.animations),
        builtInAnimations: normalizeBuiltInAnimations(model.builtInAnimations),
        metadata: model.metadata || null,
        visible: model.visible ?? true,
        locked: model.locked ?? false,
    };
    return normalizeModelSourceObject(next, { keepModelPath: model.type === "importedModel" });
}

function buildTreeNode(model) {
    if (!model || model.type === "importedMesh") return null;
    return {
        id: model.id,
        label: model.name,
        type: model.type,
        nodeType: model.nodeType,
        visible: model.visible,
        locked: model.locked,
        children: (model.children || []).map(buildTreeNode).filter(Boolean),
    };
}

export function flattenModels(models) {
    const flattened = [];
    const visit = (model) => {
        if (!isObjectRecord(model)) return;
        flattened.push(model);
        (model.children || []).forEach(visit);
    };
    (Array.isArray(models) ? models : []).forEach(visit);
    return flattened;
}

export function findModelById(models, id) {
    if (!id) return null;
    return flattenModels(models).find((model) => model.id === id) || null;
}

export function updateModelById(models, nextModel) {
    let updated = false;
    const updateList = (items) =>
        (items || []).map((model) => {
            if (model.id === nextModel.id) {
                updated = true;
                return cloneData(nextModel);
            }
            return {
                ...model,
                children: updateList(model.children || []),
            };
        });

    return {
        models: updateList(models),
        updated,
    };
}

export function collectModelAndDescendantIds(models, ids = []) {
    const targets = new Set(ids.filter(Boolean));
    const collected = new Set();
    const visit = (model, shouldCollect = false) => {
        const matched = targets.has(model.id);
        const collect = shouldCollect || matched;
        if (collect) collected.add(model.id);
        (model.children || []).forEach((child) => visit(child, collect));
    };
    (models || []).forEach((model) => visit(model));
    return collected;
}

export function deleteModelsByIds(models, ids = []) {
    const deleteIds = collectModelAndDescendantIds(models, ids);
    const filterList = (items) =>
        (items || [])
            .filter((model) => !deleteIds.has(model.id))
            .map((model) => ({
                ...model,
                children: filterList(model.children || []),
            }));

    return {
        models: filterList(models),
        deletedIds: Array.from(deleteIds),
    };
}
