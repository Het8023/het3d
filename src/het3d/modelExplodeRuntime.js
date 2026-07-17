import { cloneData } from "../utils/sceneObjects.js";

export function createModelExplodeRuntime(options = {}) {
    const activeAnimations = new Map();
    const explodeStates = new Map();

    function reset() {
        activeAnimations.clear();
        explodeStates.clear();
    }

    function explodeModel(input = {}) {
        const sceneState = options.getSceneState?.();
        if (!sceneState || options.getMode?.() !== "view") return false;
        const source = isPlainRecord(input) ? input : {};
        const objectId = String(
            source.objectId ||
                source.targetId ||
                source.id ||
                source.object?.id ||
                source.objectData?.id ||
                "",
        ).trim();
        const objectData = objectId ? options.getObjectData?.(objectId) : null;
        const eventItem = resolveModelExplodeEvent(objectData, source);
        const explodeConfig = normalizeModelExplodeConfig(
            source.explodeConfig || eventItem?.explodeConfig || {},
        );
        return runModelExplode({
            sceneId: sceneState.id,
            eventId: String(source.eventId || eventItem?.id || "").trim(),
            objectId: objectData?.id || objectId,
            triggerType: source.triggerType || eventItem?.triggerType || "manual",
            explodeConfig,
            object: cloneData(objectData || source.objectData || source.object || null),
            event: cloneData(eventItem || source.event || null),
            pointerEvent: source.pointerEvent || source.event?.pointerEvent || null,
            hit: source.hit || null,
        });
    }

    function runModelExplode(payload = {}) {
        const triggerObject = payload.objectId
            ? options.getObjectData?.(payload.objectId)
            : null;
        const targets = resolveModelExplodeTargets(
            payload.explodeConfig,
            triggerObject,
            options.getObjectData,
        );
        if (!targets.length) return false;
        const now = getNow();
        const duration = Math.max(Number(payload.explodeConfig?.duration) || 800, 0);
        const eventKey = payload.eventId || payload.objectId || "manual";
        let started = false;
        targets.forEach((target, index) => {
            const targetId = String(target.objectId || target.id || "").trim();
            const targetData = targetId ? options.getObjectData?.(targetId) : null;
            const node = targetId ? options.getObjectNode?.(targetId) : null;
            if (!targetData || !node) return;
            const stateKey = `${eventKey}:${targetId}`;
            const existingState = explodeStates.get(stateKey);
            const existingAnimation = activeAnimations.get(stateKey);
            const fromPosition =
                existingState?.fromPosition ||
                normalizeModelExplodeVector(target.fromPosition, targetData.position);
            const toPosition =
                existingState?.toPosition ||
                normalizeModelExplodeVector(
                    target.toPosition,
                    getAutoTargetPosition(
                        targetData,
                        payload.explodeConfig,
                        index,
                        targets.length,
                        fromPosition,
                    ),
                );
            const targetExpanded = payload.explodeConfig?.toggle
                ? existingAnimation
                    ? !existingAnimation.targetExpanded
                    : !existingState?.expanded
                : true;
            const destination = targetExpanded ? toPosition : fromPosition;
            explodeStates.set(stateKey, {
                fromPosition,
                toPosition,
                expanded: existingState?.expanded || false,
            });
            activeAnimations.set(stateKey, {
                stateKey,
                targetId,
                targetData,
                node,
                parentImportedModelId: getParentImportedModelId(
                    targetData,
                    options.getObjectData,
                ),
                startPosition: vectorFromObject3DPosition(node.position),
                endPosition: destination,
                startedAt: now,
                duration,
                targetExpanded,
            });
            started = true;
        });
        if (started) {
            const eventPayload = options.sanitizeEventPayload?.(payload) ?? payload;
            options.emitEvent?.("modelExplode", cloneData(eventPayload));
        }
        return started;
    }

    function update() {
        if (!activeAnimations.size) return;
        const now = getNow();
        const completedImportedModelIds = new Set();
        let hasCompletedAnimation = false;
        activeAnimations.forEach((animation, stateKey) => {
            const node = animation.node || options.getObjectNode?.(animation.targetId);
            const targetData =
                animation.targetData || options.getObjectData?.(animation.targetId);
            if (!node || !targetData) {
                activeAnimations.delete(stateKey);
                return;
            }
            const progress =
                animation.duration <= 0
                    ? 1
                    : clamp((now - animation.startedAt) / animation.duration, 0, 1);
            const nextPosition = {
                x: lerp(animation.startPosition.x, animation.endPosition.x, progress),
                y: lerp(animation.startPosition.y, animation.endPosition.y, progress),
                z: lerp(animation.startPosition.z, animation.endPosition.z, progress),
            };
            applyPosition(targetData, node, nextPosition, progress >= 1);
            if (progress < 1) return;
            const state = explodeStates.get(stateKey);
            if (state) {
                state.expanded = animation.targetExpanded;
                explodeStates.set(stateKey, state);
            }
            if (animation.parentImportedModelId) {
                completedImportedModelIds.add(animation.parentImportedModelId);
            }
            activeAnimations.delete(stateKey);
            hasCompletedAnimation = true;
        });
        completedImportedModelIds.forEach((modelId) =>
            options.refreshImportedModelSelectionProxy?.(modelId),
        );
        if (completedImportedModelIds.size) options.updateSelectionHelpers?.();
        if (hasCompletedAnimation) options.onSceneChange?.();
    }

    function getAutoTargetPosition(targetData, config, index, count, fromPosition) {
        const spacing =
            Number(config?.spacing) || getDefaultSpacing(targetData, options.getObjectNode);
        const direction = config?.direction || "up";
        const offset = normalizeModelExplodeVector(config?.offset, { x: 0, y: 0, z: 0 });
        const stepIndex = count > 1 ? index : 1;
        const next = { ...fromPosition };
        if (direction === "custom") {
            next.x += offset.x * stepIndex;
            next.y += offset.y * stepIndex;
            next.z += offset.z * stepIndex;
        } else if (direction === "down") {
            next.y -= spacing * stepIndex;
        } else if (direction === "both") {
            next.y += (index - (count - 1) / 2) * spacing;
        } else {
            next.y += spacing * stepIndex;
        }
        return next;
    }

    function getDefaultSpacing(targetData, getObjectNode) {
        const node = targetData?.id ? getObjectNode?.(targetData.id) : null;
        if (!node) return 2;
        const bounds = options.getNodeBounds?.(node);
        if (!bounds || options.isBoundsEmpty?.(bounds)) return 2;
        const size = options.getBoundsSize?.(bounds) || {};
        return Math.max(size.y || 0, size.x || 0, size.z || 0, 1);
    }

    function applyPosition(targetData, node, position, shouldSyncData = false) {
        node.position = options.toVector3?.(position, { x: 0, y: 0, z: 0 }) || position;
        if (!shouldSyncData) return;
        targetData.position = options.vectorToData?.(node.position) || { ...position };
        node.position =
            options.toVector3?.(targetData.position, { x: 0, y: 0, z: 0 }) ||
            targetData.position;
    }

    function getNow() {
        return options.now?.() ?? performance.now();
    }

    return { explodeModel, update, reset };
}

export function normalizeModelExplodeConfig(config = {}) {
    const source = isPlainRecord(config) ? config : {};
    return {
        targets: Array.isArray(source.targets) ? source.targets : [],
        targetIds: source.targetIds || source.objectIds || source.ids || "",
        direction: ["up", "down", "both", "custom"].includes(source.direction)
            ? source.direction
            : "up",
        spacing: Math.max(Number(source.spacing) || 0, 0),
        duration: Math.max(Number(source.duration) || 800, 0),
        easing: source.easing || "linear",
        toggle: source.toggle !== false,
        offset: normalizeModelExplodeVector(source.offset, { x: 0, y: 0, z: 0 }),
    };
}

export function parseModelExplodeTargetIds(value) {
    if (Array.isArray(value)) {
        return value.map((id) => String(id || "").trim()).filter(Boolean);
    }
    return String(value || "")
        .split(",")
        .map((id) => id.trim())
        .filter(Boolean);
}

export function normalizeModelExplodeVector(value, fallback = { x: 0, y: 0, z: 0 }) {
    const source = isPlainRecord(value) ? value : {};
    return {
        x: Number.isFinite(Number(source.x)) ? Number(source.x) : Number(fallback?.x) || 0,
        y: Number.isFinite(Number(source.y)) ? Number(source.y) : Number(fallback?.y) || 0,
        z: Number.isFinite(Number(source.z)) ? Number(source.z) : Number(fallback?.z) || 0,
    };
}

function resolveModelExplodeEvent(objectData, source) {
    if (isPlainRecord(source.event) && source.event.actionType === "modelExplode") {
        return source.event;
    }
    const events = Array.isArray(objectData?.events) ? objectData.events : [];
    const eventId = String(source.eventId || "").trim();
    if (eventId) {
        const matched = events.find((eventItem) => eventItem?.id === eventId);
        if (matched) return matched;
    }
    return events.find((eventItem) => eventItem?.actionType === "modelExplode") || null;
}

function resolveModelExplodeTargets(config = {}, triggerObject, getObjectData) {
    if (Array.isArray(config.targets) && config.targets.length) {
        return config.targets
            .map((target) => (isPlainRecord(target) ? target : null))
            .filter((target) => target?.objectId || target?.id)
            .flatMap((target) => expandModelExplodeTarget(target, getObjectData));
    }
    const ids = parseModelExplodeTargetIds(config.targetIds);
    if (!ids.length && triggerObject?.id) ids.push(triggerObject.id);
    return ids.flatMap((id) =>
        expandModelExplodeTarget({ objectId: id }, getObjectData),
    );
}

function expandModelExplodeTarget(target, getObjectData) {
    const targetId = String(target.objectId || target.id || "").trim();
    const targetData = targetId ? getObjectData?.(targetId) : null;
    if (!targetData) return [];
    const childLayers = getModelExplodeLayerTargets(targetData);
    if (childLayers.length) {
        return childLayers.map((layerData) => ({
            ...target,
            objectId: layerData.id,
            id: layerData.id,
            fromPosition: target.fromPosition ? undefined : layerData.position,
        }));
    }
    return [{ ...target, objectId: targetId, id: targetId }];
}

function getModelExplodeLayerTargets(objectData) {
    const layers = (objectData?.children || []).filter(
        (child) => child?.type === "importedLayer",
    );
    return layers.length ? layers.slice().sort(compareModelExplodeLayers) : [];
}

function compareModelExplodeLayers(left, right) {
    const leftIndex = Number(left?.source?.layerIndex);
    const rightIndex = Number(right?.source?.layerIndex);
    if (Number.isFinite(leftIndex) && Number.isFinite(rightIndex)) {
        return leftIndex - rightIndex;
    }
    return String(left?.name || "").localeCompare(String(right?.name || ""), "zh-Hans-CN");
}

function getParentImportedModelId(targetData, getObjectData) {
    if (targetData?.type === "importedModel") return targetData.id;
    const parentData = targetData?.parentId ? getObjectData?.(targetData.parentId) : null;
    return parentData?.type === "importedModel" ? parentData.id : "";
}

function vectorFromObject3DPosition(position) {
    return {
        x: Number(position?.x) || 0,
        y: Number(position?.y) || 0,
        z: Number(position?.z) || 0,
    };
}

function isPlainRecord(value) {
    return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function clamp(value, min, max) {
    return Math.min(Math.max(Number(value) || 0, min), max);
}

function lerp(start, end, progress) {
    return start + (end - start) * progress;
}
