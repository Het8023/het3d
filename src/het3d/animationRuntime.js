import {
    getAnimationDuration,
    getAnimationPlaybackPositionForDuration,
    getAnimationPlaybackRange,
    getAnimationPropertyPaths,
    getAnimationPropertyValue,
    normalizeAnimationSettings,
    normalizeBuiltInAnimation,
    normalizeCustomAnimation,
} from "../utils/sceneAnimations.js";

export function createAnimationRuntime(options = {}) {
    const states = new Map();
    const channelOwners = new Map();
    const builtInCatalogs = new Map();
    let lastTickAt = nowSeconds();
    let suspended = false;

    function registerBuiltInAnimations(objectId, animationGroups = []) {
        unregisterBuiltInAnimations(objectId, { dispose: true });
        const clips = (Array.isArray(animationGroups) ? animationGroups : []).map(
            (group, index) => {
                group.stop?.();
                group.reset?.();
                const name = String(group.name || "").trim();
                const fromFrame = finite(group.from, 0);
                const toFrame = Math.max(finite(group.to, fromFrame), fromFrame);
                const fps = getAnimationGroupFps(group);
                const clip = {
                    animationId: `clip:${index}:${name}`,
                    clipKey: `clip:${index}:${name}`,
                    clipIndex: index,
                    clipName: name,
                    name: name || `动画片段 ${index + 1}`,
                    durationSeconds: Math.max((toFrame - fromFrame) / fps, 0),
                    sourceType: "builtIn",
                    available: true,
                    fromFrame,
                    toFrame,
                    group,
                };
                group.goToFrame?.(fromFrame);
                return clip;
            },
        );
        builtInCatalogs.set(String(objectId), { objectId: String(objectId), clips });
        emitEvent("animation-catalog-ready", {
            objectId: String(objectId),
            clips: clips.map(toPublicClip),
        });
        return clips.map(toPublicClip);
    }

    function unregisterBuiltInAnimations(objectId, { dispose = true } = {}) {
        const id = String(objectId || "");
        stopAllAnimations({ objectId: id, restore: true });
        const catalog = builtInCatalogs.get(id);
        if (catalog && dispose) {
            catalog.clips.forEach((clip) => {
                clip.group?.stop?.();
                clip.group?.dispose?.();
            });
        }
        builtInCatalogs.delete(id);
    }

    function getAnimationCatalog({ objectId } = {}) {
        const id = String(objectId || "");
        const objectData = getObjectData(id);
        const custom = (objectData?.animations || []).map((animation) => ({
            ...normalizeCustomAnimation(animation),
            animationId: animation.id,
            sourceType: "custom",
            durationSeconds: getAnimationDuration(animation),
            state: getStateValue(runtimeId(id, "custom", animation.id)),
        }));
        const catalog = builtInCatalogs.get(id);
        const builtIn = (catalog?.clips || []).map((clip) => {
            const setting = resolveBuiltInSetting(objectData, clip);
            return {
                ...toPublicClip(clip),
                ...setting,
                animationId: clip.clipKey,
                state: getStateValue(runtimeId(id, "builtIn", clip.clipKey)),
            };
        });
        return { objectId: id, custom, builtIn };
    }

    function playObjectAnimations({ objectId, restart = true } = {}) {
        const id = String(objectId || "").trim();
        const objectData = getObjectData(id);
        if (!objectData) return fail("object_not_found", `动画目标不存在：${id}`);
        if (!getSettings().enabled) return fail("animations_disabled", "场景动画已停用");
        const locators = [];
        (objectData.animations || [])
            .filter((animation) => animation?.enabled !== false)
            .forEach((animation) => {
                locators.push({ objectId: id, sourceType: "custom", animationId: animation.id });
            });
        const catalog = builtInCatalogs.get(id);
        (catalog?.clips || []).forEach((clip) => {
            const setting = resolveBuiltInSetting(objectData, clip);
            if (setting.enabled) {
                locators.push({ objectId: id, sourceType: "builtIn", animationId: clip.clipKey });
            }
        });
        if (!locators.length) return fail("animation_not_found", "目标对象没有已启用动画");
        const results = locators.map((locator) =>
            restart ? restartAnimation(locator) : playAnimation(locator),
        );
        return {
            ok: results.some((result) => result.ok),
            objectId: id,
            results,
        };
    }

    function playAnimation(locator = {}) {
        const resolved = resolveAnimation(locator);
        if (!resolved.ok) return resolved;
        if (!getSettings().enabled) return fail("animations_disabled", "场景动画已停用");
        if (resolved.config.enabled === false) return fail("animation_disabled", "动画已停用");
        const id = runtimeId(resolved.objectId, resolved.sourceType, resolved.animationId);
        const existing = states.get(id);
        if (existing) {
            if (existing.status === "paused") return resumeAnimation(locator);
            if (["playing", "delayed"].includes(existing.status) && !locator.restart) {
                return success(existing);
            }
            stopState(existing, { restore: true, reason: "restart" });
        }
        const state = createState(resolved);
        if (!state) return fail("invalid_animation", "动画配置无有效时长或轨道");
        claimStateOwnership(state);
        states.set(state.runtimeId, state);
        setStatus(state, state.config.delaySeconds > 0 ? "delayed" : "playing");
        return success(state);
    }

    function pauseAnimation(locator = {}) {
        const state = findState(locator);
        if (!state) return fail("runtime_not_found", "动画尚未启动");
        if (["playing", "delayed"].includes(state.status)) setStatus(state, "paused");
        return success(state);
    }

    function resumeAnimation(locator = {}) {
        const state = findState(locator);
        if (!state) return playAnimation(locator);
        if (state.status === "paused")
            setStatus(state, state.elapsed < state.delaySeconds ? "delayed" : "playing");
        return success(state);
    }

    function stopAnimation(locator = {}) {
        const state = findState(locator);
        if (!state) return fail("runtime_not_found", "动画尚未启动");
        stopState(state, {
            restore: locator.restore ?? state.config.endState !== "keep",
            reason: "manual",
        });
        return success(state);
    }

    function restartAnimation(locator = {}) {
        const state = findState(locator);
        if (state) stopState(state, { restore: true, reason: "restart" });
        return playAnimation({ ...locator, restart: true });
    }

    function seekAnimation(locator = {}) {
        const state = findState(locator);
        if (!state) return fail("runtime_not_found", "动画尚未启动");
        const requested = Math.min(Math.max(finite(locator.timeSeconds, 0), 0), state.duration);
        const speed = Math.max(state.config.speed * getSettings().globalSpeed, 0.0001);
        state.elapsed = state.delaySeconds + requested / speed;
        state.currentTime = requested;
        applyState(state, state.playbackStart + requested);
        emitState(state);
        return success(state);
    }

    function getAnimationState(locator = {}) {
        const state = findState(locator);
        return state ? success(state) : fail("runtime_not_found", "动画尚未启动");
    }

    function stopAllAnimations({ objectId = "", restore = true } = {}) {
        const targetId = String(objectId || "");
        const stopped = [];
        Array.from(states.values()).forEach((state) => {
            if (targetId && state.objectId !== targetId && state.targetId !== targetId) return;
            stopState(state, { restore, reason: "stop_all" });
            stopped.push(state.runtimeId);
        });
        return { ok: true, stopped };
    }

    function applyAnimationSettings(settings = {}) {
        const normalized = normalizeAnimationSettings(settings);
        const sceneState = options.getSceneState?.();
        if (sceneState) sceneState.animationSettings = normalized;
        if (!normalized.enabled) stopAllAnimations({ restore: true });
        lastTickAt = nowSeconds();
        return normalized;
    }

    function startAutoPlay() {
        if (options.getMode?.() !== "view" || !getSettings().enabled) return [];
        const results = [];
        getAllObjects().forEach((objectData) => {
            (objectData.animations || [])
                .filter(
                    (animation) => animation?.enabled !== false && animation?.autoPlay !== false,
                )
                .forEach((animation) => {
                    results.push(
                        playAnimation({
                            objectId: objectData.id,
                            sourceType: "custom",
                            animationId: animation.id,
                        }),
                    );
                });
            const catalog = builtInCatalogs.get(objectData.id);
            (catalog?.clips || []).forEach((clip) => {
                const setting = resolveBuiltInSetting(objectData, clip);
                if (setting.enabled && setting.autoPlay) {
                    results.push(
                        playAnimation({
                            objectId: objectData.id,
                            sourceType: "builtIn",
                            animationId: clip.clipKey,
                        }),
                    );
                }
            });
        });
        return results;
    }

    function syncObject(objectId) {
        const id = String(objectId || "");
        Array.from(states.values()).forEach((state) => {
            if (state.objectId === id) {
                const resolved = resolveAnimation({
                    objectId: state.objectId,
                    sourceType: state.sourceType,
                    animationId: state.animationId,
                });
                if (!resolved.ok || resolved.config.enabled === false) {
                    stopState(state, { restore: true, reason: "config_changed" });
                } else {
                    state.config = resolved.config;
                }
            }
            if (state.targetId === id && state.sourceType === "custom") {
                state.ownedChannels.forEach((propertyPath) => {
                    state.baseValues[propertyPath] = readDataProperty(
                        getObjectData(id),
                        propertyPath,
                    );
                });
            }
        });
    }

    function update() {
        const current = nowSeconds();
        const delta = Math.min(Math.max(current - lastTickAt, 0), 0.25);
        lastTickAt = current;
        if (suspended || !getSettings().enabled || !states.size) return;
        Array.from(states.values()).forEach((state) => {
            if (!["playing", "delayed"].includes(state.status)) return;
            state.elapsed += delta;
            const position = getAnimationPlaybackPositionForDuration(
                state.config,
                state.timelineDuration,
                state.elapsed,
                getSettings().globalSpeed,
            );
            state.currentTime = Math.min(
                Math.max(position.localTime - state.playbackStart, 0),
                state.duration,
            );
            state.direction = position.direction;
            state.completedLoops = position.completedLoops;
            if (position.status === "delayed") {
                if (state.status !== "delayed") setStatus(state, "delayed");
                return;
            }
            if (state.status !== "playing") setStatus(state, "playing");
            applyState(state, position.localTime);
            if (position.status === "completed") finishState(state);
        });
    }

    function setDocumentHidden(hidden) {
        if (!getSettings().pauseWhenHidden) return;
        suspended = Boolean(hidden);
        lastTickAt = nowSeconds();
    }

    function clear({ disposeGroups = true } = {}) {
        stopAllAnimations({ restore: true });
        if (disposeGroups) {
            Array.from(builtInCatalogs.keys()).forEach((objectId) =>
                unregisterBuiltInAnimations(objectId, { dispose: true }),
            );
        } else {
            builtInCatalogs.clear();
        }
        channelOwners.clear();
        lastTickAt = nowSeconds();
    }

    function createState(resolved) {
        const timelineDuration =
            resolved.sourceType === "custom"
                ? getAnimationDuration(resolved.config)
                : resolved.clip.durationSeconds;
        const playbackRange = getAnimationPlaybackRange(resolved.config, timelineDuration);
        const duration = playbackRange.duration;
        if (!(duration > 0)) return null;
        const state = {
            runtimeId: runtimeId(resolved.objectId, resolved.sourceType, resolved.animationId),
            objectId: resolved.objectId,
            targetId: resolved.targetId,
            importedRootId: getImportedRootId(resolved.targetId || resolved.objectId),
            sourceType: resolved.sourceType,
            animationId: resolved.animationId,
            config: resolved.config,
            clip: resolved.clip || null,
            duration,
            timelineDuration,
            playbackStart: playbackRange.startTime,
            delaySeconds: Math.max(finite(resolved.config.delaySeconds, 0), 0),
            elapsed: 0,
            currentTime: 0,
            direction: 1,
            completedLoops: 0,
            status: "idle",
            baseValues: {},
            ownedChannels: [],
            stopReason: "",
        };
        if (resolved.sourceType === "custom") {
            state.ownedChannels = getAnimationPropertyPaths(resolved.config);
            const targetData = getObjectData(resolved.targetId);
            state.ownedChannels.forEach((path) => {
                state.baseValues[path] = readDataProperty(targetData, path);
            });
            if (!state.ownedChannels.length) return null;
        } else {
            state.ownedChannels = [`builtin:${resolved.objectId}`];
        }
        return state;
    }

    function claimStateOwnership(state) {
        if (state.importedRootId) {
            Array.from(states.values()).forEach((existing) => {
                if (existing.importedRootId !== state.importedRootId) return;
                if (existing.sourceType === state.sourceType) return;
                stopState(existing, { restore: true, reason: "conflict" });
            });
        }
        const remaining = [];
        state.ownedChannels.forEach((channel) => {
            const key = `${state.targetId}:${channel}`;
            const previousId = channelOwners.get(key);
            const previous = previousId ? states.get(previousId) : null;
            if (previous && previous.runtimeId !== state.runtimeId) {
                previous.ownedChannels = previous.ownedChannels.filter((item) => item !== channel);
                if (!previous.ownedChannels.length) {
                    stopState(previous, { restore: false, reason: "conflict" });
                }
                options.notify?.("warning", `动画属性冲突，后启动动画接管 ${channel}`);
            }
            channelOwners.set(key, state.runtimeId);
            remaining.push(channel);
        });
        state.ownedChannels = remaining;
    }

    function applyState(state, localTime) {
        if (state.sourceType === "builtIn") {
            const clip = state.clip;
            const progress = state.timelineDuration ? localTime / state.timelineDuration : 0;
            clip.group?.goToFrame?.(clip.fromFrame + (clip.toFrame - clip.fromFrame) * progress);
            return;
        }
        const node = getObjectNode(state.targetId);
        if (!node) return;
        state.ownedChannels.forEach((propertyPath) => {
            const value = getAnimationPropertyValue(state.config, propertyPath, localTime);
            if (value !== null) writeNodeProperty(node, propertyPath, value);
        });
    }

    function finishState(state) {
        const restore = state.config.endState !== "keep";
        releaseOwnership(state);
        if (restore) restoreState(state);
        state.status = "completed";
        states.delete(state.runtimeId);
        emitState(state);
        emitEvent("animation-finish", publicStatePayload(state));
    }

    function stopState(state, { restore = true, reason = "manual" } = {}) {
        releaseOwnership(state);
        if (restore) restoreState(state);
        state.stopReason = reason;
        state.status = "stopped";
        states.delete(state.runtimeId);
        emitState(state);
    }

    function restoreState(state) {
        if (state.sourceType === "builtIn") {
            state.clip?.group?.stop?.();
            state.clip?.group?.reset?.();
            state.clip?.group?.goToFrame?.(state.clip.fromFrame);
            return;
        }
        const node = getObjectNode(state.targetId);
        if (!node) return;
        Object.entries(state.baseValues).forEach(([path, value]) =>
            writeNodeProperty(node, path, value),
        );
    }

    function releaseOwnership(state) {
        state.ownedChannels.forEach((channel) => {
            const key = `${state.targetId}:${channel}`;
            if (channelOwners.get(key) === state.runtimeId) channelOwners.delete(key);
        });
    }

    function resolveAnimation(locator = {}) {
        const objectId = String(locator.objectId || "").trim();
        const sourceType = locator.sourceType === "builtIn" ? "builtIn" : "custom";
        const animationId = String(locator.animationId || "").trim();
        const objectData = getObjectData(objectId);
        if (!objectData) return fail("object_not_found", `动画对象不存在：${objectId}`);
        if (sourceType === "custom") {
            const source = (objectData.animations || []).find(
                (animation) => animation?.id === animationId,
            );
            if (!source) return fail("animation_not_found", `自定义动画不存在：${animationId}`);
            const config = normalizeCustomAnimation(source);
            const targetId =
                !config.targetId || config.targetId === "self" ? objectId : config.targetId;
            if (!getObjectData(targetId) || !getObjectNode(targetId)) {
                return fail("target_not_found", `动画目标不存在：${targetId}`);
            }
            return { ok: true, objectId, sourceType, animationId, targetId, config };
        }
        const catalog = builtInCatalogs.get(objectId);
        const clip = (catalog?.clips || []).find(
            (item) => item.clipKey === animationId || item.animationId === animationId,
        );
        if (!clip) return fail("clip_not_found", `模型自带动画不存在：${animationId}`);
        const config = resolveBuiltInSetting(objectData, clip);
        return {
            ok: true,
            objectId,
            sourceType,
            animationId: clip.clipKey,
            targetId: objectId,
            config,
            clip,
        };
    }

    function resolveBuiltInSetting(objectData, clip) {
        const list = Array.isArray(objectData?.builtInAnimations)
            ? objectData.builtInAnimations
            : [];
        const exact = list.find((item) => item?.clipKey && item.clipKey === clip.clipKey);
        const sameName = clip.clipName
            ? list.filter((item) => item?.clipName === clip.clipName)
            : [];
        const source =
            exact ||
            (sameName.length === 1 ? sameName[0] : null) ||
            list.find((item) => Number(item?.clipIndex) === clip.clipIndex);
        return normalizeBuiltInAnimation({
            ...(source || {}),
            clipKey: clip.clipKey,
            clipIndex: clip.clipIndex,
            clipName: clip.clipName,
        });
    }

    function findState(locator) {
        const sourceType = locator.sourceType === "builtIn" ? "builtIn" : "custom";
        return states.get(runtimeId(locator.objectId, sourceType, locator.animationId)) || null;
    }

    function setStatus(state, status) {
        state.status = status;
        emitState(state);
    }

    function emitState(state) {
        emitEvent("animation-state-change", publicStatePayload(state));
    }

    function emitEvent(type, payload) {
        options.emit?.(type, payload);
    }

    function fail(code, message) {
        const payload = { ok: false, code, message };
        options.emit?.("animation-error", payload);
        options.notify?.("warning", message);
        return payload;
    }

    function success(state) {
        return {
            ok: true,
            runtimeId: state.runtimeId,
            state: getStateValue(state.runtimeId, state),
        };
    }

    function getStateValue(id, fallback = null) {
        const state = states.get(id) || fallback;
        if (!state) return { status: "idle", currentTime: 0 };
        return {
            status: state.status,
            currentTime: state.currentTime,
            duration: state.duration,
            direction: state.direction,
            completedLoops: state.completedLoops,
            stopReason: state.stopReason,
        };
    }

    function publicStatePayload(state) {
        return {
            runtimeId: state.runtimeId,
            objectId: state.objectId,
            targetId: state.targetId,
            animationId: state.animationId,
            sourceType: state.sourceType,
            state: getStateValue(state.runtimeId, state),
        };
    }

    function getSettings() {
        return normalizeAnimationSettings(options.getSceneState?.()?.animationSettings);
    }

    function getObjectData(objectId) {
        return options.getObjectData?.(String(objectId || "")) || null;
    }

    function getObjectNode(objectId) {
        return options.getObjectNode?.(String(objectId || "")) || null;
    }

    function getAllObjects() {
        return options.getAllObjects?.() || [];
    }

    function getImportedRootId(objectId) {
        const visited = new Set();
        let current = getObjectData(objectId);
        while (current && !visited.has(current.id)) {
            visited.add(current.id);
            if (current.type === "importedModel") return current.id;
            current = current.parentId ? getObjectData(current.parentId) : null;
        }
        return "";
    }

    function nowSeconds() {
        return (options.now?.() ?? performance.now()) / 1000;
    }

    return {
        registerBuiltInAnimations,
        unregisterBuiltInAnimations,
        getAnimationCatalog,
        playObjectAnimations,
        playAnimation,
        pauseAnimation,
        resumeAnimation,
        stopAnimation,
        restartAnimation,
        seekAnimation,
        getAnimationState,
        stopAllAnimations,
        applyAnimationSettings,
        startAutoPlay,
        syncObject,
        update,
        setDocumentHidden,
        clear,
    };
}

function runtimeId(objectId, sourceType, animationId) {
    return `${String(objectId || "")}:${sourceType}:${String(animationId || "")}`;
}

function readDataProperty(objectData, propertyPath) {
    const [field, axis] = String(propertyPath || "").split(".");
    return finite(objectData?.[field]?.[axis], field === "scale" ? 1 : 0);
}

function writeNodeProperty(node, propertyPath, value) {
    const [field, axis] = String(propertyPath || "").split(".");
    const nodeField = field === "scale" ? "scaling" : field;
    if (!["position", "rotation", "scaling"].includes(nodeField) || !["x", "y", "z"].includes(axis))
        return;
    node[nodeField][axis] =
        field === "scale" ? Math.max(finite(value, 1), 0.001) : finite(value, 0);
}

function getAnimationGroupFps(group) {
    const values = (group?.targetedAnimations || [])
        .map((item) => finite(item?.animation?.framePerSecond, 0))
        .filter((value) => value > 0);
    return values.length ? Math.max(...values) : 60;
}

function toPublicClip(clip) {
    const { group, fromFrame, toFrame, ...publicClip } = clip;
    return publicClip;
}

function finite(value, fallback) {
    const number = Number(value);
    return Number.isFinite(number) ? number : fallback;
}
