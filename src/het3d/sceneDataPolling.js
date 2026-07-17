import {
    applyProcessedDataToSceneBindings,
    normalizeHttpsConfigData,
    parseHttpsJsonText,
    runHttpsResponseProcessor,
} from "../utils/httpsSceneData.js";
import { cloneData, flattenModels } from "../utils/sceneObjects.js";

export function createSceneDataPolling(options = {}) {
    let pollingTimer = null;
    let pollingSignature = "";
    let requestRunning = false;
    let initialValueChangeEventsExecuted = false;

    function clear() {
        if (!pollingTimer) return;
        clearInterval(pollingTimer);
        pollingTimer = null;
    }

    function reset() {
        clear();
        pollingSignature = "";
        requestRunning = false;
        initialValueChangeEventsExecuted = false;
    }

    function restart({ immediate = false } = {}) {
        if (options.getMode?.() !== "view") {
            clear();
            return;
        }
        const sceneState = options.getSceneState?.();
        if (!sceneState) {
            clear();
            return;
        }
        const config = normalizeHttpsConfigData(sceneState.httpsConfig || {});
        sceneState.httpsConfig = config;
        const signature = getPollingSignature(config);
        if (!config.enabled || !config.url) {
            clear();
            pollingSignature = signature;
            runInitialBindingValueChangeEvents([]);
            return;
        }
        if (pollingTimer && signature === pollingSignature) {
            if (immediate) runRequest();
            return;
        }
        clear();
        pollingSignature = signature;
        pollingTimer = setInterval(runRequest, config.intervalSeconds * 1000);
        if (immediate) runRequest();
    }

    async function runRequest() {
        const sceneState = options.getSceneState?.();
        if (options.getMode?.() !== "view" || !sceneState || requestRunning) return;
        const config = normalizeHttpsConfigData(sceneState.httpsConfig || {});
        if (!config.enabled || !config.url) return;
        const headersResult = parseHttpsJsonText(config.headers, "Headers", { objectOnly: true });
        if (!headersResult.ok) return warn(headersResult.message);
        const queryResult = parseHttpsJsonText(config.query, "Query", { objectOnly: true });
        if (!queryResult.ok) return warn(queryResult.message);
        const bodyResult = parseHttpsJsonText(config.body, "Body");
        if (!bodyResult.ok) return warn(bodyResult.message);
        requestRunning = true;
        try {
            const requestOptions = { method: config.method, url: config.url, timeout: 10000 };
            if (hasRequestValue(headersResult.value)) requestOptions.headers = headersResult.value;
            if (hasRequestValue(queryResult.value)) requestOptions.query = queryResult.value;
            if (hasRequestValue(bodyResult.value)) requestOptions.body = bodyResult.value;
            const responseData = await requestSceneData(requestOptions);
            const processedData = await runHttpsResponseProcessor(responseData, config.processor);
            const changes = applyProcessedDataToSceneBindings(sceneState, processedData);
            if (!initialValueChangeEventsExecuted) {
                runInitialBindingValueChangeEvents(processedData, changes);
                if (changes.length) options.onSceneChange?.();
            } else if (changes.length) {
                runBindingValueChangeEvents(changes, processedData);
                options.onSceneChange?.();
            }
        } catch (error) {
            if (options.onError) options.onError(error);
            else console.error("Preview data request failed", error);
        } finally {
            requestRunning = false;
        }
    }

    function runInitialBindingValueChangeEvents(processedData = [], actualChanges = []) {
        const sceneState = options.getSceneState?.();
        if (
            options.getMode?.() !== "view" ||
            !sceneState ||
            initialValueChangeEventsExecuted
        ) {
            return;
        }
        initialValueChangeEventsExecuted = true;
        const actualChangeMap = new Map(
            actualChanges.map((change) => [
                `${change.objectId || ""}:${change.dataId || ""}`,
                change,
            ]),
        );
        flattenModels(sceneState.models || [])
            .filter((objectData) =>
                (objectData.events || []).some((eventItem) =>
                    options.isExecutableObjectEvent?.(eventItem, "valueChange"),
                ),
            )
            .forEach((objectData) => {
                const bindings = Array.isArray(objectData.dataBindings)
                    ? objectData.dataBindings
                    : [];
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
                options.runObjectEvents?.(objectData.id, "valueChange", {
                    initial: true,
                    changes: cloneData(changes),
                    processedData: cloneData(processedData),
                });
            });
    }

    function runBindingValueChangeEvents(changes, processedData) {
        const changesByObject = new Map();
        changes.forEach((change) => {
            if (!change.objectId) return;
            if (!changesByObject.has(change.objectId)) changesByObject.set(change.objectId, []);
            changesByObject.get(change.objectId).push(change);
        });
        changesByObject.forEach((objectChanges, objectId) => {
            options.runObjectEvents?.(objectId, "valueChange", {
                changes: cloneData(objectChanges),
                processedData: cloneData(processedData),
            });
        });
    }

    function handleValueChange(nextObject, previousObject, payload = {}) {
        if (options.getMode?.() !== "view" || !options.getSceneState?.()) return;
        if (options.isObjectEventTriggerRunning?.("valueChange")) return;
        const changes = getBindingValueChanges(
            nextObject,
            previousObject,
            payload,
            options.getObjectData,
        );
        if (changes.length) runBindingValueChangeEvents(changes, []);
    }

    function getSetValueOptions() {
        return {
            syncBindingValues: !options.isObjectEventTriggerRunning?.("valueChange"),
        };
    }

    async function requestSceneData(requestOptions) {
        const requestHandler = options.getRequestHandler?.();
        return requestHandler
            ? requestHandler(requestOptions)
            : defaultSceneRequestHandler(requestOptions);
    }

    function warn(message) {
        if (options.onWarning) options.onWarning(message);
        else console.warn(message);
    }

    return {
        clear,
        reset,
        restart,
        runRequest,
        handleValueChange,
        getSetValueOptions,
    };
}

export async function defaultSceneRequestHandler({
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
    const requestOptions = { method: requestMethod, signal: controller.signal };
    if (Object.keys(requestHeaders).length) requestOptions.headers = requestHeaders;
    if (requestMethod !== "GET" && hasRequestValue(body)) {
        requestOptions.body = stringifyRequestBody(body);
    }
    try {
        const response = await fetch(requestUrl, requestOptions);
        const data = await readResponseData(response);
        if (!response.ok) throw new Error(`${requestMethod} ${response.status}`);
        return data;
    } finally {
        clearTimeout(timeoutId);
    }
}

export function appendQueryToUrl(url, query = {}) {
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

export function hasRequestValue(value) {
    if (value === undefined) return false;
    if (value === null) return true;
    if (Array.isArray(value)) return value.length > 0;
    if (typeof value === "object") return Object.keys(value).length > 0;
    if (typeof value === "string") return value.length > 0;
    return true;
}

export function getBindingValueChanges(
    nextObject,
    previousObject,
    payload = {},
    getObjectData = () => null,
) {
    if (!nextObject?.id) return [];
    const payloadKeys = new Set(Object.keys(payload || {}).filter((key) => key !== "id"));
    const previousBindings = new Map(
        (previousObject?.dataBindings || []).map((bindingItem, index) => [
            getBindingChangeKey(bindingItem, index),
            bindingItem,
        ]),
    );
    const latestObject = getObjectData?.(nextObject.id) || nextObject;
    return (nextObject.dataBindings || [])
        .map((bindingItem, index) => {
            const propName = String(bindingItem?.propName || "").trim();
            if (!propName || !payloadKeys.has(propName)) return null;
            const previousBinding = previousBindings.get(
                getBindingChangeKey(bindingItem, index),
            );
            const previousValue = getBindingRuntimeValue(
                previousObject,
                previousBinding,
                propName,
            );
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

function getPollingSignature(config) {
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

function cloneEventValue(value) {
    return value === undefined ? undefined : cloneData(value);
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
