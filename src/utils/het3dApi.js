import { cloneData, findModelById } from "./sceneObjects";

export const het3dValueFieldMap = {
    positionX: ["position", "x"],
    positionY: ["position", "y"],
    positionZ: ["position", "z"],
    rotationX: ["rotation", "x"],
    rotationY: ["rotation", "y"],
    rotationZ: ["rotation", "z"],
    scaleX: ["scale", "x"],
    scaleY: ["scale", "y"],
    scaleZ: ["scale", "z"],
    materialColor: ["material", "color"],
    materialSymbol: ["material", "symbol"],
    materialLabel: ["material", "label"],
    materialShape: ["material", "shape"],
};

const nestedMergeFields = new Set(["position", "rotation", "scale", "material", "source", "metadata"]);

export function isPlainObject(value) {
    return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

export function mergeHet3dObjectValue(current, patch, options = {}) {
    const shouldSyncBindingValues = options.syncBindingValues !== false;
    const next = cloneData(current);
    const changedKeys = new Set();
    Object.entries(patch).forEach(([key, value]) => {
        if (key === "id") return;
        if (applyMappedSetValueField(next, key, value)) return;
        changedKeys.add(key);
        if (nestedMergeFields.has(key) && isPlainObject(value)) {
            next[key] = {
                ...(isPlainObject(next[key]) ? next[key] : {}),
                ...cloneValue(value),
            };
            return;
        }
        next[key] = cloneValue(value);
    });
    if (shouldSyncBindingValues) {
        syncChangedBindingValues(next, changedKeys);
    }
    next.id = current.id;
    return next;
}

export function syncHet3dObjectInPlace(target, source) {
    if (!isPlainObject(target) || !isPlainObject(source)) return;
    Object.keys(target).forEach((key) => {
        if (!Object.prototype.hasOwnProperty.call(source, key)) {
            delete target[key];
        }
    });
    Object.entries(source).forEach(([key, value]) => {
        target[key] = cloneValue(value);
    });
}

export function createHet3dApi({
    getSceneData,
    getPublicSceneData,
    getActiveObjects = () => [],
    updateObject,
    onChange,
    getSetValueOptions = () => ({}),
    extra = {},
} = {}) {
    function setValue(payload = {}) {
        if (!isPlainObject(payload)) {
            throw new Error("het3d.setValue payload must be an object");
        }
        const id = String(payload.id || "").trim();
        if (!id) {
            throw new Error("het3d.setValue requires id");
        }

        const sceneData = getSceneData?.();
        const current = findModelById(sceneData?.models || [], id);
        if (!current) {
            throw new Error(`het3d.setValue object not found: ${id}`);
        }

        const previous = cloneData(current);
        const setValueOptions = getSetValueOptions?.(payload) || {};
        const next = mergeHet3dObjectValue(current, payload, setValueOptions);
        updateObject?.(next);
        syncHet3dObjectInPlace(current, next);
        onChange?.(next, previous, { ...payload });
        return cloneData(next);
    }

    return {
        get data() {
            return cloneData(getPublicSceneData?.() || getSceneData?.() || null);
        },
        get active() {
            return cloneData(getActiveObjects?.() || []);
        },
        setValue,
        utils: {
            cloneData,
        },
        ...extra,
    };
}

function applyMappedSetValueField(target, key, value) {
    const path = het3dValueFieldMap[key];
    if (!path) return false;
    const [field, prop] = path;
    target[field] = {
        ...(isPlainObject(target[field]) ? target[field] : {}),
        [prop]: cloneValue(value),
    };
    return true;
}

function syncChangedBindingValues(object, changedKeys) {
    const bindings = Array.isArray(object?.dataBindings) ? object.dataBindings : [];
    bindings.forEach((bindingItem) => {
        const propName = String(bindingItem?.propName || "").trim();
        if (!propName) return;
        if (changedKeys.has(propName)) {
            bindingItem.value = cloneValue(object[propName]);
        } else if (Object.prototype.hasOwnProperty.call(object, propName)) {
            object[propName] = cloneValue(bindingItem.value);
        }
    });
}

function cloneValue(value) {
    return value === undefined ? undefined : cloneData(value);
}
