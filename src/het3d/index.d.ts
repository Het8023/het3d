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

export default Het3d;
