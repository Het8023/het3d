import * as BABYLON from "@babylonjs/core";
import { createId } from "../utils/sceneObjects.js";

export function createSceneVisuals(options = {}) {
    function createStandardMaterial(color, doubleSide = false) {
        const material = new BABYLON.StandardMaterial(
            `mat_${createId("m")}`,
            options.getScene?.(),
        );
        material.diffuseColor = BABYLON.Color3.FromHexString(color);
        material.specularColor = new BABYLON.Color3(0.12, 0.12, 0.12);
        material.backFaceCulling = !doubleSide;
        return material;
    }

    function createIconMaterial(symbol, color, shape = "circle") {
        const texture = createSymbolTexture(symbol, color, shape);
        const material = new BABYLON.StandardMaterial(
            `icon_${createId("m")}`,
            options.getScene?.(),
        );
        material.diffuseTexture = texture;
        material.opacityTexture = texture;
        material.useAlphaFromDiffuseTexture = true;
        material.diffuseTexture.hasAlpha = true;
        material.specularColor = BABYLON.Color3.Black();
        material.backFaceCulling = false;
        return material;
    }

    function createLabelMaterial(label, color) {
        const texture = createLabelTexture(label, color);
        const material = new BABYLON.StandardMaterial(
            `label_${createId("m")}`,
            options.getScene?.(),
        );
        material.diffuseTexture = texture;
        material.specularColor = BABYLON.Color3.Black();
        material.backFaceCulling = false;
        return material;
    }

    function createSymbolTexture(symbol, color, shape = "circle") {
        const texture = new BABYLON.DynamicTexture(
            `symbol_${createId("t")}`,
            { width: 512, height: 512 },
            options.getScene?.(),
            false,
        );
        const context = texture.getContext();
        context.clearRect(0, 0, 512, 512);
        context.fillStyle = color;
        drawIconShape(context, shape);
        const text = String(symbol || "*").trim() || "*";
        const fontFamily = 'Arial, "Microsoft YaHei", sans-serif';
        let fontSize = 150;
        context.fillStyle = "#ffffff";
        context.textAlign = "center";
        context.textBaseline = "middle";
        while (fontSize > 42) {
            context.font = `700 ${fontSize}px ${fontFamily}`;
            const metrics = context.measureText(text);
            if (metrics.width <= 330 && fontSize <= 180) break;
            fontSize -= 6;
        }
        context.font = `700 ${fontSize}px ${fontFamily}`;
        context.fillText(text, 256, 258);
        texture.update();
        texture.hasAlpha = true;
        return texture;
    }

    function createLabelTexture(label, color) {
        const texture = new BABYLON.DynamicTexture(
            `label_${createId("t")}`,
            { width: 512, height: 320 },
            options.getScene?.(),
            false,
        );
        const context = texture.getContext();
        context.fillStyle = color;
        context.fillRect(0, 0, 512, 320);
        context.fillStyle = "rgba(255,255,255,0.18)";
        for (let x = 0; x < 512; x += 32) context.fillRect(x, 0, 1, 320);
        for (let y = 0; y < 320; y += 32) context.fillRect(0, y, 512, 1);
        context.fillStyle = "#ffffff";
        context.font = "bold 38px Arial";
        context.textAlign = "center";
        context.textBaseline = "middle";
        context.fillText(String(label || "").slice(0, 12), 256, 160);
        texture.update();
        return texture;
    }

    function setSceneObjectMetadata(node, objectId) {
        node.metadata = {
            ...(node.metadata || {}),
            sceneObjectId: objectId,
        };
    }

    function applyTransform(node, objectData) {
        node.position = toVector3(objectData.position, { x: 0, y: 0, z: 0 });
        node.rotationQuaternion = null;
        node.rotation = toVector3(objectData.rotation, { x: 0, y: 0, z: 0 });
        node.scaling = toVector3(objectData.scale, { x: 1, y: 1, z: 1 });
    }

    function toVector3(value, fallback) {
        return new BABYLON.Vector3(
            Number.isFinite(Number(value?.x)) ? Number(value.x) : fallback.x,
            Number.isFinite(Number(value?.y)) ? Number(value.y) : fallback.y,
            Number.isFinite(Number(value?.z)) ? Number(value.z) : fallback.z,
        );
    }

    function vectorToData(vector) {
        return {
            x: round(vector?.x || 0),
            y: round(vector?.y || 0),
            z: round(vector?.z || 0),
        };
    }

    function getNodeRotation(node) {
        return node.rotationQuaternion
            ? node.rotationQuaternion.toEulerAngles()
            : node.rotation;
    }

    return {
        createStandardMaterial,
        createIconMaterial,
        createLabelMaterial,
        setSceneObjectMetadata,
        applyTransform,
        toVector3,
        vectorToData,
        getNodeRotation,
    };
}

function drawIconShape(context, shape) {
    context.beginPath();
    if (shape === "square") {
        context.rect(96, 96, 320, 320);
    } else if (shape === "rounded") {
        drawRoundedRect(context, 78, 96, 356, 320, 70);
    } else if (shape === "diamond") {
        context.moveTo(256, 64);
        context.lineTo(448, 256);
        context.lineTo(256, 448);
        context.lineTo(64, 256);
        context.closePath();
    } else {
        context.arc(256, 256, 190, 0, Math.PI * 2);
    }
    context.fill();
}

function drawRoundedRect(context, x, y, width, height, radius) {
    const right = x + width;
    const bottom = y + height;
    context.moveTo(x + radius, y);
    context.lineTo(right - radius, y);
    context.quadraticCurveTo(right, y, right, y + radius);
    context.lineTo(right, bottom - radius);
    context.quadraticCurveTo(right, bottom, right - radius, bottom);
    context.lineTo(x + radius, bottom);
    context.quadraticCurveTo(x, bottom, x, bottom - radius);
    context.lineTo(x, y + radius);
    context.quadraticCurveTo(x, y, x + radius, y);
    context.closePath();
}

function round(value) {
    return Math.round((Number(value) || 0) * 1e6) / 1e6;
}
