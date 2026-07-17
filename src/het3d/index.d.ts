import type { App, DefineComponent } from "vue";

export type Het3dMode = "edit" | "view" | string;

export interface Het3dRequestOptions {
    method?: "GET" | "POST" | string;
    url: string;
    headers?: Record<string, unknown>;
    query?: Record<string, unknown>;
    body?: unknown;
    timeout?: number;
}

export interface Het3dMessage {
    type: "success" | "warning" | "error" | "info" | string;
    message: string;
    detail?: unknown;
}

export type Het3dAnimationSourceType = "custom" | "builtIn";
export type Het3dAnimationStatus =
    | "idle"
    | "delayed"
    | "playing"
    | "paused"
    | "completed"
    | "stopped"
    | "error";

export interface Het3dAnimationLocator {
    objectId: string;
    sourceType: Het3dAnimationSourceType;
    animationId: string;
    restart?: boolean;
    restore?: boolean;
}

export interface Het3dAnimationResult {
    ok: boolean;
    runtimeId?: string;
    code?: string;
    message?: string;
    state?: Record<string, unknown>;
}

export type Het3dEventHandler<T = unknown> = (payload: T) => unknown;

export interface Het3dEventBus {
    on(type: string, handler: Het3dEventHandler): () => void;
    off(type: string, handler: Het3dEventHandler): void;
    once(type: string, handler: Het3dEventHandler): () => void;
    emit(type: string, payload?: unknown): unknown[];
    clear(type?: string): void;
}

export interface Het3dProps {
    projectId?: string;
    sceneId?: string;
    sceneData?: Record<string, unknown> | null;
    mode?: Het3dMode;
    selectedIds?: string[];
    sceneLoader?: ((sceneId: string) => Promise<Record<string, unknown> | null>) | null;
    projectSceneLoader?: ((projectId: string) => Promise<Record<string, unknown> | null>) | null;
    assetLoader?: ((assetId: string) => Promise<Record<string, unknown> | null>) | null;
    requestHandler?: ((options: Het3dRequestOptions) => Promise<unknown>) | null;
    eventBus?: Het3dEventBus | null;
    devicePopoverComponent?: unknown;
    notify?: ((message: Het3dMessage) => void) | null;
    installGlobal?: boolean;
    dracoDecoderPath?: string;
}

export interface Het3dApi {
    readonly data: unknown;
    readonly active: unknown[];
    setValue(payload: Record<string, unknown> & { id: string }): Record<string, unknown>;
    showDevicePopover(options?: Record<string, unknown>): boolean;
    explodeModel(options?: Record<string, unknown>): boolean;
    getAnimationCatalog(options: { objectId: string }): Record<string, unknown>;
    playObjectAnimations(options: { objectId: string; restart?: boolean }): Het3dAnimationResult;
    playAnimation(options: Het3dAnimationLocator): Het3dAnimationResult;
    pauseAnimation(options: Het3dAnimationLocator): Het3dAnimationResult;
    resumeAnimation(options: Het3dAnimationLocator): Het3dAnimationResult;
    stopAnimation(options: Het3dAnimationLocator): Het3dAnimationResult;
    restartAnimation(options: Het3dAnimationLocator): Het3dAnimationResult;
    seekAnimation(options: Het3dAnimationLocator & { timeSeconds: number }): Het3dAnimationResult;
    getAnimationState(options: Het3dAnimationLocator): Het3dAnimationResult;
    stopAllAnimations(options?: { objectId?: string; restore?: boolean }): Het3dAnimationResult;
    applyAnimationSettings(settings: Record<string, unknown>): Record<string, unknown>;
    on(type: "modelExplode", payload: Record<string, unknown>): boolean;
    on(type: string, handler: Het3dEventHandler): () => void;
    off(type: string, handler: Het3dEventHandler): void;
    once(type: string, handler: Het3dEventHandler): () => void;
    emit(type: string, payload?: unknown): unknown[];
    utils: {
        cloneData<T>(value: T): T;
    };
    [key: string]: unknown;
}

export declare const Het3d: DefineComponent<Het3dProps>;

export declare function install(app: App): void;

export declare const het3dValueFieldMap: Record<string, string[]>;
export declare function isPlainObject(value: unknown): value is Record<string, unknown>;
export declare function mergeHet3dObjectValue(
    current: Record<string, unknown>,
    patch: Record<string, unknown>,
    options?: Record<string, unknown>,
): Record<string, unknown>;
export declare function syncHet3dObjectInPlace(
    target: Record<string, unknown>,
    source: Record<string, unknown>,
): void;
export declare function createHet3dApi(options?: Record<string, unknown>): Het3dApi;

export declare function createHet3dEventBus(): Het3dEventBus;
export declare const het3dEventBus: Het3dEventBus;
export declare function emitHet3dEvent(type: string, payload?: unknown): unknown[];

export declare function cloneData<T>(value: T): T;
export declare function createId(prefix?: string): string;
export declare function normalizeScene(scene: Record<string, unknown>): Record<string, unknown>;
export declare function normalizeSceneModelSources<T>(scene: T): T;
export declare const animationPropertyPaths: string[];
export declare function defaultAnimationSettings(): Record<string, unknown>;
export declare function normalizeAnimationSettings(value?: unknown): Record<string, unknown>;
export declare function normalizeCustomAnimation(value?: unknown): Record<string, unknown>;
export declare function normalizeCustomAnimations(value?: unknown): Record<string, unknown>[];
export declare function normalizeBuiltInAnimation(value?: unknown): Record<string, unknown>;
export declare function normalizeBuiltInAnimations(value?: unknown): Record<string, unknown>[];
export declare function normalizeAnimationControl(value?: unknown): { targetObjectId: string };
export declare function resolveAnimationControlTarget(ownerId: string, value?: unknown): string;
export declare function validateCustomAnimation(value?: unknown): {
    valid: boolean;
    errors: Array<{ path: string; code: string; message: string }>;
    value: Record<string, unknown>;
};

export default Het3d;
