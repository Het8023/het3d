export function createHet3dEventBus() {
    const listeners = new Map();

    function on(type, handler) {
        const eventType = normalizeEventType(type);
        if (!eventType || typeof handler !== "function") return () => {};
        if (!listeners.has(eventType)) listeners.set(eventType, new Set());
        listeners.get(eventType).add(handler);
        return () => off(eventType, handler);
    }

    function off(type, handler) {
        const eventType = normalizeEventType(type);
        const handlers = listeners.get(eventType);
        if (!handlers) return;
        handlers.delete(handler);
        if (!handlers.size) listeners.delete(eventType);
    }

    function once(type, handler) {
        if (typeof handler !== "function") return () => {};
        const unsubscribe = on(type, (payload) => {
            unsubscribe();
            return handler(payload);
        });
        return unsubscribe;
    }

    function emit(type, payload) {
        const eventType = normalizeEventType(type);
        const handlers = listeners.get(eventType);
        if (!handlers?.size) return [];
        return Array.from(handlers).map((handler) => handler(payload));
    }

    function clear(type) {
        if (type === undefined) {
            listeners.clear();
            return;
        }
        listeners.delete(normalizeEventType(type));
    }

    return {
        on,
        off,
        once,
        emit,
        clear,
    };
}

export const het3dEventBus = createHet3dEventBus();

export function emitHet3dEvent(type, payload) {
    return het3dEventBus.emit(type, payload);
}

function normalizeEventType(type) {
    return String(type || "").trim();
}
