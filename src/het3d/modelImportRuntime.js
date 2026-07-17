import * as BABYLON from "@babylonjs/core";
import {
    createId,
    createSceneObject,
    findModelById,
} from "../utils/sceneObjects.js";

export function createModelImportRuntime(options = {}) {
    function getObjectModelPath(objectData, visited = new Set()) {
        if (!objectData) return "";
        const ownModelPath =
            objectData?.modelPath ||
            objectData?.source?.modelPath ||
            objectData?.source?.sourceUrl ||
            objectData?.metadata?.sourceUrl ||
            "";
        if (ownModelPath) return ownModelPath;
        if (!objectData.parentId || visited.has(objectData.id)) return "";
        visited.add(objectData.id);
        const parent = findModelById(
            options.getSceneState?.()?.models || [],
            objectData.parentId,
        );
        return getObjectModelPath(parent, visited);
    }

    function readBlobAsDataUrl(blob) {
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(String(reader.result || ""));
            reader.onerror = () => reject(reader.error || new Error("File read failed"));
            reader.readAsDataURL(blob);
        });
    }

    function getObjectModelReference(objectData) {
        const modelPath = getObjectModelPath(objectData);
        if (modelPath) return { modelPath };
        return objectData?.assetId ? { assetId: objectData.assetId } : {};
    }

    function applyModelReferenceToObjectData(
        objectData,
        modelReference,
        { keepModelPath = false } = {},
    ) {
        if (!objectData || !modelReference) return;
        if (keepModelPath && modelReference.modelPath) {
            objectData.modelPath = modelReference.modelPath;
            delete objectData.assetId;
        } else if (keepModelPath && modelReference.assetId) {
            objectData.assetId = modelReference.assetId;
            delete objectData.modelPath;
        } else {
            delete objectData.modelPath;
            delete objectData.assetId;
        }
        if (objectData.source) {
            objectData.source = { ...objectData.source };
            delete objectData.source.modelPath;
            delete objectData.source.sourceUrl;
        }
    }

    async function getCachedModelMetadataForObject(objectData) {
        const modelPath = getObjectModelPath(objectData);
        if (modelPath) {
            return getCachedModelMetadata({ key: `path:${modelPath}`, url: modelPath });
        }
        const assetLoader = options.getAssetLoader?.();
        if (!objectData?.assetId || !assetLoader) return null;
        const asset = await assetLoader(objectData.assetId);
        let assetPath =
            asset?.modelPath || asset?.sourceUrl || asset?.metadata?.sourceUrl || "";
        if (!assetPath && asset?.blob) assetPath = await readBlobAsDataUrl(asset.blob);
        if (!assetPath) return null;
        applyModelReferenceToObjectData(
            objectData,
            { modelPath: assetPath },
            { keepModelPath: objectData.type === "importedModel" },
        );
        return getCachedModelMetadata({ key: `path:${assetPath}`, url: assetPath });
    }

    async function getCachedModelMetadata({ key, url }) {
        if (!key || !url) return null;
        const cache = options.assetSceneCache;
        if (cache?.has(key)) return cache.get(key);
        const runtime = await importModelRuntime(url, { enabled: false });
        const metadata = createCachedModelMetadata(runtime.content, runtime.meshes);
        disposeAnimationGroups(runtime.animationGroups);
        runtime.root.dispose(false, true);
        cache?.set(key, metadata);
        return metadata;
    }

    async function createImportedModel(objectData) {
        const scene = options.getScene?.();
        const modelPath = getObjectModelPath(objectData);
        if (!modelPath && !objectData?.assetId) {
            return new BABYLON.TransformNode("emptyModel", scene);
        }
        if (!modelPath && objectData.assetId) {
            await getCachedModelMetadataForObject(objectData);
        }
        const source = getObjectModelPath(objectData);
        if (!source) return new BABYLON.TransformNode("emptyModel", scene);

        const runtime = await importModelRuntime(source);
        const modelRoot = runtime.root;
        const modelContent = runtime.content;
        const originOffset = getModelOriginOffset(objectData, modelContent);
        modelContent.position = options.toVector3(originOffset, { x: 0, y: 0, z: 0 });

        const layerObjects = (objectData.children || []).filter(
            (object) => object.type === "importedLayer",
        );
        const metadata = createCachedModelMetadata(modelContent, runtime.meshes);
        if (layerObjects.length) {
            mapImportedLayersToModel(
                modelContent,
                runtime.meshes,
                metadata.layerEntries,
                layerObjects,
            );
        } else {
            mapLegacyMeshesToModel(runtime.meshes, objectData.children || []);
        }
        if (shouldApplyMaterialColor(objectData)) {
            applyMaterialColorToObject(modelRoot, objectData.material?.color);
        }
        optimizeImportedModelRuntime(modelRoot);
        addImportedModelSelectionProxy(modelRoot, modelContent, objectData.id);
        options.animationRuntime?.registerBuiltInAnimations(
            objectData.id,
            runtime.animationGroups,
        );
        return modelRoot;
    }

    async function importModelRuntime(source, { enabled = true } = {}) {
        const scene = options.getScene?.();
        const result = await BABYLON.ImportMeshAsync(source, scene);
        const nodes = uniqueNodes([...result.meshes, ...(result.transformNodes || [])]);
        const nodeSet = new Set(nodes);
        const root = new BABYLON.TransformNode(`imported_${createId("root")}`, scene);
        const content = new BABYLON.TransformNode("modelContent", scene);
        content.parent = root;
        nodes
            .filter((node) => !node.parent || !nodeSet.has(node.parent))
            .forEach((node) => {
                node.parent = content;
            });
        root.setEnabled(enabled);
        return {
            root,
            content,
            meshes: result.meshes.filter((mesh) => mesh instanceof BABYLON.AbstractMesh),
            animationGroups: result.animationGroups || [],
        };
    }

    function disposeAnimationGroups(animationGroups = []) {
        (Array.isArray(animationGroups) ? animationGroups : []).forEach((group) => {
            group?.stop?.();
            group?.dispose?.();
        });
    }

    function createCachedModelMetadata(root, meshes = collectMeshes(root)) {
        const layerEntries = collectModelLayers(root, meshes);
        markImportedModelSourceIndices(meshes, layerEntries);
        return { meshes, layerEntries };
    }

    function mapImportedLayersToModel(modelRoot, meshes, layerEntries, layerObjects) {
        const meshBySourceIndex = createMeshBySourceIndex(meshes);
        const childByLayerIndex = new Map(
            layerObjects.map((object) => [object.source?.layerIndex, object]),
        );
        layerEntries.forEach((entry) => {
            const layerData = childByLayerIndex.get(entry.layerIndex);
            if (!layerData) {
                entry.node.setEnabled(false);
                return;
            }
            entry.node.name = layerData.name;
            options.setSceneObjectMetadata(entry.node, layerData.id);
            entry.node.metadata.het3dLayerRoot = true;
            options.applyTransform(entry.node, layerData);
            entry.node.setEnabled(layerData.visible !== false);
            options.objectMap?.set(layerData.id, entry.node);

            const meshIndices = Array.isArray(layerData.source?.meshIndices)
                ? layerData.source.meshIndices
                : entry.meshIndices;
            meshIndices.forEach((meshIndex) => {
                const mesh = meshBySourceIndex.get(meshIndex);
                if (mesh) options.setSceneObjectMetadata(mesh, layerData.id);
            });
            if (shouldApplyMaterialColor(layerData)) {
                applyMaterialColorToObject(entry.node, layerData.material?.color);
            }
        });
    }

    function optimizeImportedModelRuntime(modelRoot) {
        getNodeMeshes(modelRoot).forEach((mesh) => {
            if (!mesh.metadata?.selectionProxy) mesh.isPickable = false;
        });
    }

    function addImportedModelSelectionProxy(modelRoot, modelContent, objectId) {
        const bounds = options.getNodeBounds(modelContent);
        if (options.isBoundsEmpty(bounds)) return;
        const size = options.getBoundsSize(bounds);
        const center = options.getBoundsCenter(bounds);
        const scene = options.getScene?.();
        const proxy = BABYLON.MeshBuilder.CreateBox(
            `${modelRoot.name || "importedModel"}_selectionProxy`,
            {
                width: Math.max(size.x, 0.001),
                height: Math.max(size.y, 0.001),
                depth: Math.max(size.z, 0.001),
            },
            scene,
        );
        const material = new BABYLON.StandardMaterial(`proxy_${createId("m")}`, scene);
        material.alpha = 0;
        material.disableLighting = true;
        proxy.material = material;
        proxy.visibility = 0;
        proxy.parent = modelRoot;
        proxy.position = options.worldToLocal(modelRoot, center);
        proxy.isPickable = true;
        proxy.metadata = { sceneObjectId: objectId, selectionProxy: true };
        options.selectionPickMap?.set(objectId, proxy);
    }

    function mapLegacyMeshesToModel(meshes, childObjects) {
        const childByMeshIndex = new Map(
            childObjects.map((object) => [object.source?.meshIndex, object]),
        );
        meshes.forEach((mesh, meshIndex) => {
            const childData = childByMeshIndex.get(meshIndex);
            if (!childData) {
                mesh.setEnabled(false);
                return;
            }
            mesh.name = childData.name;
            options.setSceneObjectMetadata(mesh, childData.id);
            options.objectMap?.set(childData.id, mesh);
            mesh.setEnabled(childData.visible !== false);
            options.applyTransform(mesh, childData);
            applyMaterialColor(mesh, childData.material?.color);
        });
    }

    function getNodeMeshes(node) {
        if (!node) return [];
        const meshes = node instanceof BABYLON.AbstractMesh ? [node] : [];
        return meshes.concat(node.getChildMeshes?.(false) || []);
    }

    function createLayerObjectData(entry, parent, meshes) {
        const color = getLayerMaterialColor(entry, meshes);
        return createSceneObject("importedLayer", {
            name: entry.name,
            nodeType: "layer",
            parentId: parent.id,
            position: options.vectorToData(entry.node.position),
            rotation: options.vectorToData(options.getNodeRotation(entry.node)),
            scale: options.vectorToData(entry.node.scaling),
            material: { color },
            source: {
                layerIndex: entry.layerIndex,
                layerNodeName: entry.node.name || "",
                meshIndices: entry.meshIndices,
                meshes: entry.meshIndices.map((meshIndex) => ({
                    meshIndex,
                    name: meshes[meshIndex]?.name || `Mesh ${meshIndex + 1}`,
                })),
                meshCount: entry.meshCount,
                materialColorOverride: false,
            },
        });
    }

    function removeLayerMeshObjects(layerObject) {
        const children = Array.isArray(layerObject.children) ? layerObject.children : [];
        const meshChildren = children.filter((child) => child?.type === "importedMesh");
        const otherChildren = children.filter((child) => child?.type !== "importedMesh");
        const source = { ...(layerObject.source || {}) };
        if ((!Array.isArray(source.meshes) || !source.meshes.length) && meshChildren.length) {
            source.meshes = meshChildren
                .map((meshObject) => {
                    const meshIndex = Number(meshObject?.source?.meshIndex);
                    return Number.isFinite(meshIndex)
                        ? { meshIndex, name: meshObject.name || `Mesh ${meshIndex + 1}` }
                        : null;
                })
                .filter(Boolean);
        }
        if (
            (!Array.isArray(source.meshIndices) || !source.meshIndices.length) &&
            Array.isArray(source.meshes)
        ) {
            source.meshIndices = source.meshes.map((mesh) => mesh.meshIndex);
        }
        layerObject.children = otherChildren;
        layerObject.source = { ...source };
        delete layerObject.source.meshObjectsReady;
        delete layerObject.source.meshObjectMode;
        delete layerObject.source.meshObjectLimit;
    }

    function removeModelMeshObjects(modelObject, meshCount) {
        modelObject.source = {
            ...(modelObject.source || {}),
            meshCount,
            selectionLevel: "layer",
        };
        delete modelObject.source.meshObjectMode;
        delete modelObject.source.meshObjectLimit;
        (modelObject.children || [])
            .filter((object) => object?.type === "importedLayer")
            .forEach(removeLayerMeshObjects);
    }

    function getOriginOffsetForObject(node) {
        const bounds = options.getNodeBounds(node);
        if (options.isBoundsEmpty(bounds)) return { x: 0, y: 0, z: 0 };
        const center = options.getBoundsCenter(bounds);
        return {
            x: options.round(-center.x),
            y: options.round(-bounds.min.y),
            z: options.round(-center.z),
        };
    }

    function shouldApplyMaterialColor(objectData) {
        if (!objectData?.material?.color) return false;
        if (["importedLayer", "importedModel"].includes(objectData.type)) {
            return objectData.source?.materialColorOverride === true;
        }
        return true;
    }

    function applyMaterialColorToObject(node, color) {
        if (!color) return;
        getNodeMeshes(node).forEach((mesh) => applyMaterialColor(mesh, color));
    }

    async function migrateImportedMeshesToLayers(state) {
        let changed = false;
        for (const modelObject of state.models.filter(
            (object) =>
                object.type === "importedModel" &&
                (getObjectModelPath(object) || object.assetId),
        )) {
            let modelReference = getObjectModelReference(modelObject);
            applyModelReferenceToObjectData(modelObject, modelReference, {
                keepModelPath: true,
            });
            const children = Array.isArray(modelObject.children) ? modelObject.children : [];
            const existingLayerObjects = children.filter(
                (object) => object.type === "importedLayer",
            );
            const cachedModel = await getCachedModelMetadataForObject(modelObject);
            if (!cachedModel) continue;
            modelReference = getObjectModelReference(modelObject);
            applyModelReferenceToObjectData(modelObject, modelReference, {
                keepModelPath: true,
            });
            const { meshes, layerEntries } = cachedModel;

            if (existingLayerObjects.length) {
                existingLayerObjects.forEach((layerObject) => {
                    applyModelReferenceToObjectData(layerObject, modelReference);
                    removeLayerMeshObjects(layerObject);
                });
                removeModelMeshObjects(modelObject, meshes.length);
                changed = true;
                continue;
            }

            const legacyMeshes = children.filter(
                (object) => object.type === "importedMesh",
            );
            if (!legacyMeshes.length) continue;
            const layerObjects = layerEntries.map((entry) => {
                const layerObject = createLayerObjectData(entry, modelObject, meshes);
                removeLayerMeshObjects(layerObject);
                return layerObject;
            });
            if (!layerObjects.length) continue;
            modelObject.children = layerObjects;
            modelObject.source = {
                ...(modelObject.source || {}),
                meshCount: meshes.length,
                layerCount: layerObjects.length,
                selectionLevel: "layer",
            };
            changed = true;
        }
        return changed;
    }

    function getModelOriginOffset(objectData, node) {
        if (
            objectData.source?.originOffset &&
            objectData.source?.originMode === "xz-center-y-bottom"
        ) {
            return objectData.source.originOffset;
        }
        const originOffset = getOriginOffsetForObject(node);
        objectData.source = {
            ...(objectData.source || {}),
            originOffset,
            originMode: "xz-center-y-bottom",
        };
        return originOffset;
    }

    return {
        getObjectModelPath,
        readBlobAsDataUrl,
        getCachedModelMetadataForObject,
        createImportedModel,
        importModelRuntime,
        disposeAnimationGroups,
        createCachedModelMetadata,
        getNodeMeshes,
        createLayerObjectData,
        removeLayerMeshObjects,
        getOriginOffsetForObject,
        shouldApplyMaterialColor,
        applyMaterialColorToObject,
        migrateImportedMeshesToLayers,
    };
}

function uniqueNodes(nodes) {
    return Array.from(new Set(nodes.filter(Boolean)));
}

function markImportedModelSourceIndices(meshes, layerEntries) {
    meshes.forEach((mesh, meshIndex) => {
        mesh.metadata = { ...(mesh.metadata || {}), importedMeshIndex: meshIndex };
    });
    layerEntries.forEach((entry) => {
        entry.node.metadata = {
            ...(entry.node.metadata || {}),
            importedLayerIndex: entry.layerIndex,
        };
    });
}

function createMeshBySourceIndex(meshes) {
    return new Map(
        meshes.map((mesh, index) => {
            const sourceIndex = Number(mesh.metadata?.importedMeshIndex);
            return [Number.isFinite(sourceIndex) ? sourceIndex : index, mesh];
        }),
    );
}

function collectMeshes(root) {
    return getNodeMeshesStatic(root).filter((mesh) => !mesh.metadata?.selectionProxy);
}

function collectModelLayers(root, meshes = collectMeshes(root)) {
    const meshIndexByNode = new Map(meshes.map((mesh, index) => [mesh, index]));
    return getLayerCandidates(root)
        .map((node, layerIndex) => {
            const meshIndices = [];
            getNodeMeshesStatic(node).forEach((child) => {
                if (meshIndexByNode.has(child)) meshIndices.push(meshIndexByNode.get(child));
            });
            return {
                node,
                layerIndex,
                name: node.name || `Layer ${layerIndex + 1}`,
                meshIndices,
                meshCount: meshIndices.length,
            };
        })
        .filter((entry) => entry.meshCount > 0);
}

function getLayerCandidates(root) {
    let candidates = root.getChildren().filter((child) => hasMeshDescendant(child));
    while (candidates.length === 1) {
        const nestedGroups =
            candidates[0]
                .getChildren?.()
                .filter((child) => hasMeshDescendant(child)) || [];
        if (nestedGroups.length <= 1) break;
        candidates = nestedGroups;
    }
    if (!candidates.length && hasMeshDescendant(root)) candidates = [root];
    return candidates;
}

function hasMeshDescendant(node) {
    return getNodeMeshesStatic(node).some((mesh) => !mesh.metadata?.selectionProxy);
}

function getNodeMeshesStatic(node) {
    if (!node) return [];
    const meshes = node instanceof BABYLON.AbstractMesh ? [node] : [];
    return meshes.concat(node.getChildMeshes?.(false) || []);
}

function getLayerMaterialColor(entry, meshes) {
    const mesh = entry.meshIndices
        .map((meshIndex) => meshes[meshIndex])
        .find((item) => item?.material?.diffuseColor);
    return mesh?.material?.diffuseColor
        ? mesh.material.diffuseColor.toHexString()
        : "#868e96";
}

function applyMaterialColor(mesh, color) {
    if (!color || !mesh?.material) return;
    const materials = mesh.material.subMaterials || [mesh.material];
    materials.forEach((sourceMaterial) => {
        let material = sourceMaterial;
        if (!material?.diffuseColor) return;
        if (!material.metadata?.sceneCanvasCloned && material.clone) {
            const cloned = material.clone(`${material.name || "mat"}_${createId("clone")}`);
            cloned.metadata = { ...(material.metadata || {}), sceneCanvasCloned: true };
            mesh.material = cloned;
            material = cloned;
        }
        material.diffuseColor = BABYLON.Color3.FromHexString(color);
    });
}
