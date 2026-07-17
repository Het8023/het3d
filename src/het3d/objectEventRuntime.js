import { cloneData } from "../utils/sceneObjects.js";
import { resolveAnimationControlTarget } from "../utils/sceneAnimations.js";

export function createObjectEventRuntime(options = {}) {
    const triggerStack = [];
    let floatingPopoverOpenedDuringClick = false;
    let builtInPopoverAnchorId = "";

    function runObjectEvents(objectId, triggerType, payload = {}) {
        const objectData = options.getObjectData?.(objectId);
        if (!objectData?.events?.length) return [];
        const eventItems = objectData.events.filter((eventItem) =>
            isExecutableObjectEvent(eventItem, triggerType),
        );
        eventItems.forEach((eventItem) =>
            runObjectEventAction(objectData, eventItem, payload),
        );
        return eventItems.map((eventItem) => eventItem.actionType);
    }

    function runObjectEventAction(objectData, eventItem, payload = {}) {
        if (eventItem.actionType === "devicePopover") {
            showDevicePopover(objectData, eventItem, payload);
            return;
        }
        if (eventItem.actionType === "modelExplode") {
            options.explodeModel?.({
                objectId: objectData.id,
                eventId: eventItem.id,
                triggerType: eventItem.triggerType,
                explodeConfig: eventItem.explodeConfig,
                object: objectData,
                event: eventItem,
                pointerEvent: payload.pointerEvent,
                hit: payload.hit,
            });
            return;
        }
        if (eventItem.actionType === "animationControl") {
            const targetObjectId = resolveAnimationControlTarget(
                objectData.id,
                eventItem.animationControl,
            );
            options.animationRuntime?.playObjectAnimations({
                objectId: targetObjectId,
                restart: true,
            });
            return;
        }
        runCustomObjectEvent(objectData, eventItem, payload);
    }

    function runCustomObjectEvent(objectData, eventItem, payload = {}) {
        triggerStack.push(eventItem.triggerType);
        try {
            const handler = new Function(
                "context",
                "object",
                "object3d",
                "event",
                "scene",
                "camera",
                "controls",
                "BABYLON",
                "het3d",
                eventItem.code,
            );
            const context = {
                object: objectData,
                object3d: options.getObjectNode?.(objectData.id),
                event: eventItem,
                trigger: payload,
                scene: options.getScene?.(),
                camera: options.getCamera?.(),
                controls: options.getControls?.(),
                BABYLON: options.BABYLON,
                het3d: options.getHet3dApi?.(),
            };
            handler(
                context,
                context.object,
                context.object3d,
                context.event,
                context.scene,
                context.camera,
                context.controls,
                context.BABYLON,
                context.het3d,
            );
        } catch (error) {
            console.error("Object event execution failed", error);
            options.notify?.(
                "error",
                `Object event execution failed: ${error.message}`,
                error,
            );
        } finally {
            triggerStack.pop();
        }
    }

    function showPublicDevicePopover(input = {}) {
        if (!options.getSceneState?.()) return false;
        const normalized = normalizePublicDevicePopoverOptions(input);
        if (normalized.popoverMode !== "builtIn" && isTriggerRunning("leftClick")) {
            floatingPopoverOpenedDuringClick = true;
        }
        const objectData = resolvePublicDevicePopoverObject(normalized);
        showDevicePopover(
            objectData,
            {
                actionType: "devicePopover",
                triggerType: "manual",
                popoverMode: normalized.popoverMode,
                deviceNo: normalized.deviceNo,
                params: normalized.params,
            },
            {
                pointerEvent: normalized.pointerEvent,
                anchor: normalized.anchor,
            },
        );
        return true;
    }

    function showDevicePopover(objectData, eventItem, payload = {}) {
        options.emitDevicePopover?.({
            object: cloneData(objectData || null),
            event: cloneData(eventItem || null),
            payload: sanitizeSceneEventPayload(payload, options.vectorToData),
            mode: eventItem?.popoverMode === "builtIn" ? "builtIn" : "floating",
        });
        if (!options.hasDevicePopoverComponent?.()) return;
        if (eventItem?.popoverMode === "builtIn") {
            hideFloatingDevicePopover();
            builtInPopoverAnchorId = objectData?.id || "";
            options.getBuiltInDevicePopover?.()?.show(objectData, eventItem, {
                ...payload,
                anchor:
                    payload.anchor ||
                    options.getObjectScreenAnchor?.(objectData?.id, payload.pointerEvent),
            });
            return;
        }
        options.getFloatingDevicePopover?.()?.show(objectData, eventItem, {
            ...payload,
            pointerEvent:
                payload.pointerEvent ||
                getFloatingDevicePopoverPointerEvent(objectData?.id, payload.anchor),
        });
    }

    function updateBuiltInDevicePopoverAnchor() {
        if (!builtInPopoverAnchorId) return;
        options
            .getBuiltInDevicePopover?.()
            ?.setAnchor(options.getObjectScreenAnchor?.(builtInPopoverAnchorId));
    }

    function beginViewClick() {
        floatingPopoverOpenedDuringClick = false;
    }

    function consumeFloatingPopoverOpened() {
        const opened = floatingPopoverOpenedDuringClick;
        floatingPopoverOpenedDuringClick = false;
        return opened;
    }

    function hideFloatingDevicePopover() {
        options.getFloatingDevicePopover?.()?.hide();
    }

    function hideBuiltInDevicePopover() {
        builtInPopoverAnchorId = "";
        options.getBuiltInDevicePopover?.()?.hide();
    }

    function hideAllDevicePopovers() {
        hideFloatingDevicePopover();
        hideBuiltInDevicePopover();
    }

    function handleBuiltInDevicePopoverClose() {
        builtInPopoverAnchorId = "";
    }

    function isTriggerRunning(triggerType) {
        return triggerStack.includes(triggerType);
    }

    function getFloatingDevicePopoverPointerEvent(objectId, anchor) {
        if (Number.isFinite(anchor?.clientX) && Number.isFinite(anchor?.clientY)) {
            return { clientX: anchor.clientX, clientY: anchor.clientY };
        }
        const rect = options.getHostElement?.()?.getBoundingClientRect();
        if (!rect) return null;
        const point =
            Number.isFinite(anchor?.x) && Number.isFinite(anchor?.y)
                ? anchor
                : options.getObjectScreenAnchor?.(objectId);
        if (!point) return null;
        return { clientX: rect.left + point.x, clientY: rect.top + point.y };
    }

    function resolvePublicDevicePopoverObject(normalized) {
        if (normalized.objectData) return normalized.objectData;
        if (normalized.object) return normalized.object;
        if (normalized.objectId) {
            const objectData = options.getObjectData?.(normalized.objectId);
            if (objectData) return objectData;
        }
        return { id: normalized.objectId, name: normalized.objectName };
    }

    return {
        runObjectEvents,
        showPublicDevicePopover,
        updateBuiltInDevicePopoverAnchor,
        beginViewClick,
        consumeFloatingPopoverOpened,
        hideFloatingDevicePopover,
        hideAllDevicePopovers,
        handleBuiltInDevicePopoverClose,
        isTriggerRunning,
    };
}

export function isExecutableObjectEvent(eventItem, triggerType) {
    if (eventItem?.triggerType !== triggerType) return false;
    if (eventItem.actionType === "customFunction") {
        return Boolean(String(eventItem.code || "").trim());
    }
    if (eventItem.actionType === "devicePopover") return triggerType === "leftClick";
    if (eventItem.actionType === "modelExplode") {
        return ["leftClick", "leftDoubleClick"].includes(triggerType);
    }
    if (eventItem.actionType === "animationControl") {
        return ["leftClick", "leftDoubleClick", "valueChange"].includes(triggerType);
    }
    return false;
}

export function sanitizeSceneEventPayload(payload = {}, vectorToData = defaultVectorToData) {
    if (!isPlainRecord(payload)) return payload;
    return {
        ...payload,
        pointerEvent: sanitizePointerEvent(payload.pointerEvent),
        hit: sanitizeHit(payload.hit, vectorToData),
    };
}

function normalizePublicDevicePopoverOptions(input = {}) {
    const source = isPlainRecord(input) ? input : { deviceNo: input };
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
            source.objectName ||
                source.name ||
                source.objectData?.name ||
                source.object?.name ||
                "",
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
    return isPlainRecord(params) ? String(params.deviceNo || "").trim() : "";
}

function sanitizePointerEvent(event) {
    if (!event) return null;
    return {
        clientX: Number(event.clientX) || 0,
        clientY: Number(event.clientY) || 0,
        button: Number(event.button) || 0,
        ctrlKey: Boolean(event.ctrlKey),
        metaKey: Boolean(event.metaKey),
        shiftKey: Boolean(event.shiftKey),
        altKey: Boolean(event.altKey),
    };
}

function sanitizeHit(hit, vectorToData) {
    if (!hit) return null;
    return {
        id: hit.id || "",
        point: hit.point ? vectorToData(hit.point) : null,
    };
}

function defaultVectorToData(vector) {
    return {
        x: Number(vector?.x) || 0,
        y: Number(vector?.y) || 0,
        z: Number(vector?.z) || 0,
    };
}

function isPlainRecord(value) {
    return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
