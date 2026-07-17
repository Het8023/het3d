import Het3d from "./Het3d.vue";
import "./style.css";

export * from "../utils/het3dApi";
export * from "../utils/sceneObjects";
export * from "../utils/httpsSceneData";
export * from "../utils/eventBus";
export * from "../utils/sceneAnimations.js";

export { Het3d };

export function install(app) {
    app.component("Het3d", Het3d);
}

Het3d.install = install;

export default Het3d;
