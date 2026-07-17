const easingModes = new Set(["linear", "easeIn", "easeOut", "easeInOut"]);
const loopModes = new Set(["normal", "alternate"]);
const animationProperties = new Set([
    "position.x",
    "position.y",
    "position.z",
    "rotation.x",
    "rotation.y",
    "rotation.z",
    "scale.x",
    "scale.y",
    "scale.z",
]);

export const animationPropertyPaths = Array.from(animationProperties);

export function defaultAnimationSettings() {
    return {
        enabled: true,
        globalSpeed: 1,
        pauseWhenHidden: true,
    };
}

export function normalizeAnimationSettings(settings = {}) {
    const source = isRecord(settings) ? settings : {};
    return {
        enabled: source.enabled !== false,
        globalSpeed: clampFinite(source.globalSpeed, 0.1, 4, 1),
        pauseWhenHidden: source.pauseWhenHidden !== false,
    };
}

export function normalizeCustomAnimations(animations = []) {
    return (Array.isArray(animations) ? animations : []).map(normalizeCustomAnimation);
}

export function normalizeCustomAnimation(animation = {}) {
    const source = isRecord(animation) ? animation : {};
    const easing = normalizeEasing(source.easing);
    const segments = (Array.isArray(source.segments) ? source.segments : [])
        .map((segment) => normalizeAnimationSegment(segment, easing))
        .sort((left, right) => left.startTime - right.startTime);
    return {
        ...source,
        schemaVersion: 1,
        id: source.id || createRuntimeId("animation"),
        name: String(source.name || "动画1"),
        enabled: source.enabled !== false,
        targetId: String(source.targetId || "self"),
        autoPlay: source.autoPlay !== false,
        delaySeconds: Math.max(toFinite(source.delaySeconds, 0), 0),
        loopMode: loopModes.has(source.loopMode) ? source.loopMode : "normal",
        loopCount: Math.max(Math.floor(toFinite(source.loopCount, 0)), 0),
        speed: clampFinite(source.speed, 0.1, 10, 1),
        endState: source.endState === "keep" ? "keep" : "restore",
        easing,
        segments,
    };
}

export function normalizeAnimationSegment(segment = {}, inheritedEasing = "linear") {
    const source = isRecord(segment) ? segment : {};
    const startTime = Math.max(toFinite(source.startTime, 0), 0);
    const endTime = Math.max(toFinite(source.endTime, startTime), startTime);
    return {
        ...source,
        id: source.id || createRuntimeId("segment"),
        startTime,
        endTime,
        easing: normalizeEasing(source.easing || inheritedEasing),
        properties: (Array.isArray(source.properties) ? source.properties : []).map(
            normalizeAnimationProperty,
        ),
    };
}

export function normalizeAnimationProperty(property = {}) {
    const source = isRecord(property) ? property : {};
    return {
        ...source,
        id: source.id || createRuntimeId("property"),
        property: animationProperties.has(source.property) ? source.property : String(source.property || ""),
        startValue: toFinite(source.startValue, 0),
        endValue: toFinite(source.endValue, 0),
    };
}

export function normalizeBuiltInAnimations(settings = []) {
    return (Array.isArray(settings) ? settings : []).map(normalizeBuiltInAnimation);
}

export function normalizeBuiltInAnimation(setting = {}) {
    const source = isRecord(setting) ? setting : {};
    return {
        ...source,
        id: source.id || createRuntimeId("builtin"),
        clipKey: String(source.clipKey || ""),
        clipIndex: Math.max(Math.floor(toFinite(source.clipIndex, 0)), 0),
        clipName: String(source.clipName || ""),
        enabled: source.enabled === true,
        autoPlay: source.autoPlay === true,
        loopMode: loopModes.has(source.loopMode) ? source.loopMode : "normal",
        loopCount: Math.max(Math.floor(toFinite(source.loopCount, 0)), 0),
        speed: clampFinite(source.speed, 0.1, 10, 1),
        endState: source.endState === "keep" ? "keep" : "restore",
    };
}

export function normalizeAnimationControl(control = {}) {
    const source = isRecord(control) ? control : {};
    return {
        targetObjectId: String(source.targetObjectId || "").trim(),
    };
}

export function resolveAnimationControlTarget(ownerId, control = {}) {
    const targetId = normalizeAnimationControl(control).targetObjectId;
    return !targetId || targetId === "self" ? String(ownerId || "") : targetId;
}

export function validateCustomAnimation(animation = {}) {
    const normalized = normalizeCustomAnimation(animation);
    const errors = [];
    if (!normalized.name.trim()) addError(errors, "name", "required", "请填写动画名称");
    if (!normalized.segments.length) {
        addError(errors, "segments", "required", "请至少配置一个时间段");
    }
    const tracksByProperty = new Map();
    normalized.segments.forEach((segment, segmentIndex) => {
        const segmentPath = `segments.${segmentIndex}`;
        if (!(segment.endTime > segment.startTime)) {
            addError(errors, `${segmentPath}.endTime`, "range", "结束时间必须大于开始时间");
        }
        if (!segment.properties.length) {
            addError(errors, `${segmentPath}.properties`, "required", "请至少配置一个属性");
        }
        const seen = new Set();
        segment.properties.forEach((property, propertyIndex) => {
            const propertyPath = `${segmentPath}.properties.${propertyIndex}`;
            if (!animationProperties.has(property.property)) {
                addError(errors, `${propertyPath}.property`, "unsupported", "请选择有效动画属性");
                return;
            }
            if (seen.has(property.property)) {
                addError(errors, `${propertyPath}.property`, "duplicate", "同一时间段不能重复配置属性");
            }
            seen.add(property.property);
            if (property.property.startsWith("scale.") && (property.startValue < 0.001 || property.endValue < 0.001)) {
                addError(errors, propertyPath, "scale", "缩放动画值不能小于 0.001");
            }
            if (!tracksByProperty.has(property.property)) tracksByProperty.set(property.property, []);
            tracksByProperty.get(property.property).push({
                startTime: segment.startTime,
                endTime: segment.endTime,
                segmentIndex,
            });
        });
    });
    tracksByProperty.forEach((tracks, propertyPath) => {
        tracks.sort((left, right) => left.startTime - right.startTime);
        for (let index = 1; index < tracks.length; index += 1) {
            if (tracks[index].startTime < tracks[index - 1].endTime) {
                addError(
                    errors,
                    `segments.${tracks[index].segmentIndex}`,
                    "overlap",
                    `${propertyPath} 的时间段不能重叠`,
                );
            }
        }
    });
    return { valid: errors.length === 0, errors, value: normalized };
}

export function getAnimationDuration(animation = {}) {
    const duration = Math.max(
        0,
        ...(Array.isArray(animation.segments) ? animation.segments : []).map((segment) =>
            toFinite(segment?.endTime, 0),
        ),
    );
    return Number.isFinite(duration) ? duration : 0;
}

export function getAnimationPlaybackRange(animation = {}, fallbackDuration = 0) {
    const duration = Math.max(toFinite(fallbackDuration, getAnimationDuration(animation)), 0);
    const movingSegments = (Array.isArray(animation?.segments) ? animation.segments : []).filter(
        (segment) =>
            toFinite(segment?.endTime, 0) > toFinite(segment?.startTime, 0) &&
            (Array.isArray(segment?.properties) ? segment.properties : []).some(
                (property) =>
                    animationProperties.has(property?.property) &&
                    Math.abs(
                        toFinite(property?.endValue, 0) - toFinite(property?.startValue, 0),
                    ) > Number.EPSILON,
            ),
    );
    if (!movingSegments.length) return { startTime: 0, endTime: duration, duration };
    const startTime = Math.max(
        Math.min(...movingSegments.map((segment) => toFinite(segment.startTime, 0))),
        0,
    );
    const endTime = Math.max(
        startTime,
        ...movingSegments.map((segment) => toFinite(segment.endTime, startTime)),
    );
    return { startTime, endTime, duration: endTime - startTime };
}

export function getAnimationPropertyPaths(animation = {}) {
    const paths = new Set();
    (Array.isArray(animation.segments) ? animation.segments : []).forEach((segment) => {
        (Array.isArray(segment?.properties) ? segment.properties : []).forEach((property) => {
            if (animationProperties.has(property?.property)) paths.add(property.property);
        });
    });
    return Array.from(paths);
}

export function getAnimationPropertyValue(animation, propertyPath, localTime) {
    const tracks = [];
    (Array.isArray(animation?.segments) ? animation.segments : []).forEach((segment) => {
        (Array.isArray(segment?.properties) ? segment.properties : [])
            .filter((property) => property?.property === propertyPath)
            .forEach((property) => {
                tracks.push({
                    startTime: toFinite(segment.startTime, 0),
                    endTime: toFinite(segment.endTime, 0),
                    startValue: toFinite(property.startValue, 0),
                    endValue: toFinite(property.endValue, 0),
                    easing: normalizeEasing(segment.easing || animation.easing),
                });
            });
    });
    tracks.sort((left, right) => left.startTime - right.startTime);
    if (!tracks.length) return null;
    const time = Math.max(toFinite(localTime, 0), 0);
    for (let index = 0; index < tracks.length; index += 1) {
        const track = tracks[index];
        if (time < track.startTime) {
            return index === 0 ? track.startValue : tracks[index - 1].endValue;
        }
        if (time <= track.endTime) {
            const duration = Math.max(track.endTime - track.startTime, 0.0001);
            const progress = easeAnimationProgress((time - track.startTime) / duration, track.easing);
            return lerp(track.startValue, track.endValue, progress);
        }
    }
    return tracks[tracks.length - 1].endValue;
}

export function getAnimationPlaybackPosition(animation, elapsedSeconds, globalSpeed = 1) {
    const duration = getAnimationDuration(animation);
    return getAnimationPlaybackPositionForDuration(animation, duration, elapsedSeconds, globalSpeed);
}

export function getAnimationPlaybackPositionForDuration(
    animation,
    durationSeconds,
    elapsedSeconds,
    globalSpeed = 1,
) {
    const range = getAnimationPlaybackRange(animation, durationSeconds);
    const duration = range.duration;
    if (!duration) return { status: "error", localTime: 0, direction: 1, completedLoops: 0 };
    const elapsed = Math.max(toFinite(elapsedSeconds, 0), 0);
    const delay = Math.max(toFinite(animation?.delaySeconds, 0), 0);
    if (elapsed < delay) {
        return {
            status: "delayed",
            localTime: range.startTime,
            direction: 1,
            completedLoops: 0,
        };
    }
    const speed = clampFinite(animation?.speed, 0.1, 10, 1) * clampFinite(globalSpeed, 0.1, 4, 1);
    const scaledElapsed = (elapsed - delay) * speed;
    const loopCount = Math.max(Math.floor(toFinite(animation?.loopCount, 0)), 0);
    const cycleIndex = Math.floor(scaledElapsed / duration);
    if (loopCount > 0 && cycleIndex >= loopCount) {
        const lastCycleIndex = loopCount - 1;
        const reverse = animation?.loopMode === "alternate" && lastCycleIndex % 2 === 1;
        return {
            status: "completed",
            localTime: reverse ? range.startTime : range.endTime,
            direction: reverse ? -1 : 1,
            completedLoops: loopCount,
        };
    }
    const reverse = animation?.loopMode === "alternate" && cycleIndex % 2 === 1;
    const cycleTime = scaledElapsed % duration;
    return {
        status: "playing",
        localTime: range.startTime + (reverse ? duration - cycleTime : cycleTime),
        direction: reverse ? -1 : 1,
        completedLoops: cycleIndex,
    };
}

export function easeAnimationProgress(value, easing = "linear") {
    const progress = Math.min(Math.max(toFinite(value, 0), 0), 1);
    if (easing === "easeIn") return progress * progress;
    if (easing === "easeOut") return 1 - (1 - progress) * (1 - progress);
    if (easing === "easeInOut") {
        return progress < 0.5
            ? 2 * progress * progress
            : 1 - Math.pow(-2 * progress + 2, 2) / 2;
    }
    return progress;
}

function normalizeEasing(value) {
    return easingModes.has(value) ? value : "linear";
}

function isRecord(value) {
    return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function toFinite(value, fallback) {
    const number = Number(value);
    return Number.isFinite(number) ? number : fallback;
}

function clampFinite(value, min, max, fallback) {
    return Math.min(Math.max(toFinite(value, fallback), min), max);
}

function lerp(start, end, progress) {
    return start + (end - start) * progress;
}

function addError(errors, path, code, message) {
    errors.push({ path, code, message });
}

function createRuntimeId(prefix) {
    return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}
