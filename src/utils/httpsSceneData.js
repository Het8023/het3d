import { cloneData, flattenModels } from "./sceneObjects";

export function defaultHttpsProcessor() {
    return `function handleMessage(e) {
    const data = e?.data ?? e
    const list = Array.isArray(data) ? data : Array.isArray(data?.data) ? data.data : []
    return list
        .filter((item) => item?.dataId && Object.prototype.hasOwnProperty.call(item, "value"))
        .map((item) => ({
            dataId: String(item.dataId),
            value: item.value,
        }))
}`;
}

export function normalizeHttpsJsonText(value) {
    return typeof value === "string" ? value : JSON.stringify(value || {}, null, 2);
}

export function isMeaningfulJsonText(value) {
    const text = String(value || "").trim();
    return Boolean(text && text !== "{}");
}

export function normalizeHttpsProcessorText(value) {
    const source = String(value || "").trim();
    if (!source) return defaultHttpsProcessor();
    return source;
}

export function normalizeHttpsConfigData(config = {}) {
    const next = { ...config };
    const hasQuery = Object.prototype.hasOwnProperty.call(next, "query");
    next.enabled = Boolean(next.enabled);
    next.method = ["GET", "POST"].includes(String(next.method).toUpperCase())
        ? String(next.method).toUpperCase()
        : "GET";
    next.url = String(next.url || "").trim();
    const normalizedBody = normalizeHttpsJsonText(next.body);
    delete next.headers;
    if (!hasQuery && next.method === "GET" && isMeaningfulJsonText(normalizedBody)) {
        next.query = normalizedBody;
        next.body = "{}";
    } else {
        next.query = normalizeHttpsJsonText(next.query);
        next.body = normalizedBody;
    }
    next.processor = normalizeHttpsProcessorText(next.processor);
    next.intervalSeconds = Math.max(Number(next.intervalSeconds) || 10, 1);
    return next;
}

export function parseHttpsJsonText(jsonText, label, options = {}) {
    const raw = String(jsonText || "").trim();
    if (!raw) return { ok: true, value: {} };
    try {
        const value = JSON.parse(raw);
        if (options.objectOnly && (!value || typeof value !== "object" || Array.isArray(value))) {
            return { ok: false, value: null, message: `${label} must be a JSON object` };
        }
        return { ok: true, value };
    } catch (error) {
        return { ok: false, value: null, message: `${label} JSON error: ${error.message}` };
    }
}

export async function runHttpsResponseProcessor(responseData, processorCode) {
    const code = normalizeHttpsProcessorText(processorCode);
    const handler = createHttpsResponseProcessorRunner(code);
    const result = await handler(responseData);
    if (!Array.isArray(result)) {
        throw new Error("Message processor must return an array");
    }
    return result;
}

export function applyProcessedDataToSceneBindings(sceneData, processedData) {
    if (!sceneData || !Array.isArray(processedData)) return [];
    const changes = [];
    const objects = flattenModels(sceneData.models || []);
    const valueByDataId = createProcessedValueMap(processedData);

    objects.forEach((object) => {
        const bindings = Array.isArray(object.dataBindings) ? object.dataBindings : [];
        bindings.forEach((bindingItem) => {
            const resolved = resolveBindingValue(valueByDataId, bindingItem);
            if (!resolved.found) return;

            const previousValue = bindingItem.value;
            if (isDataValueEqual(previousValue, resolved.value)) return;

            bindingItem.value = cloneValue(resolved.value);
            syncDataBindingFieldForItem(object, bindingItem);
            changes.push({
                objectId: object.id,
                object: cloneValue(object),
                dataId: bindingItem.id,
                propName: bindingItem.propName,
                displayName: bindingItem.displayName,
                binding: cloneValue(bindingItem.binding || null),
                previousValue: cloneValue(previousValue),
                currentValue: cloneValue(resolved.value),
                sourceRecord: cloneValue(resolved.record),
            });
        });
        syncDataBindingFieldsForObject(object);
    });

    return changes;
}

function createProcessedValueMap(records) {
    const valueByDataId = new Map();
    records.forEach((record) => {
        if (!isRecordObject(record)) return;
        const dataId = String(record.dataId || "").trim();
        if (!dataId || !hasOwn(record, "value")) return;
        valueByDataId.set(dataId, {
            value: record.value,
            record,
        });
    });
    return valueByDataId;
}

export function syncDataBindingFieldsForObject(object, previousPropNames = []) {
    if (!object) return;
    const bindings = Array.isArray(object.dataBindings) ? object.dataBindings : [];
    const currentPropNames = new Set(
        bindings.map((item) => String(item?.propName || "").trim()).filter(Boolean),
    );

    previousPropNames
        .map((name) => String(name || "").trim())
        .filter(Boolean)
        .forEach((name) => {
            if (!currentPropNames.has(name) && Object.prototype.hasOwnProperty.call(object, name)) {
                delete object[name];
            }
        });

    bindings.forEach((bindingItem) => syncDataBindingFieldForItem(object, bindingItem));
}

function isStandaloneHttpsProcessorFunctionSource(value) {
    const source = String(value || "").trim();
    return (
        /^(async\s+)?function\b/.test(source) ||
        /^(async\s+)?\(?\s*[\w$,\s{}[\]]+\s*\)?\s*=>/.test(source)
    );
}

function tryCreateStandaloneHttpsProcessorHandler(source) {
    if (!isStandaloneHttpsProcessorFunctionSource(source)) return null;
    try {
        const handler = new Function("console", `return (${source});`)(console);
        return typeof handler === "function" ? handler : null;
    } catch {
        return null;
    }
}

function createHttpsResponseProcessorRunner(source) {
    const standaloneHandler = tryCreateStandaloneHttpsProcessorHandler(source);
    if (standaloneHandler) return standaloneHandler;

    const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
    const runner = new AsyncFunction(
        "e",
        "responseData",
        "console",
        `"use strict";
${source}
if (typeof handleMessage === "function") {
    return await handleMessage(e);
}`,
    );
    return (responseData) => runner(responseData, responseData, console);
}

function syncDataBindingFieldForItem(object, bindingItem) {
    const propName = String(bindingItem?.propName || "").trim();
    if (!object || !propName) return;
    object[propName] = cloneValue(bindingItem.value);
}

function resolveBindingValue(valueByDataId, bindingItem) {
    const dataId = String(bindingItem?.id || "").trim();
    if (!dataId || !valueByDataId.has(dataId)) {
        return { found: false, value: undefined, record: null };
    }
    const matched = valueByDataId.get(dataId);
    return {
        found: true,
        value: matched.value,
        record: matched.record,
    };
}

function isRecordObject(value) {
    return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function hasOwn(target, key) {
    return Object.prototype.hasOwnProperty.call(target, key);
}

function cloneValue(value) {
    return value === undefined ? undefined : cloneData(value);
}

function isDataValueEqual(left, right) {
    return stableDataValue(left) === stableDataValue(right);
}

function stableDataValue(value) {
    if (value === undefined) return "__undefined__";
    return JSON.stringify(value);
}
