# het3d 使用文档

`het3d` 是一个基于 Vue 3 和 Babylon.js 的 3D 场景组件。它只提供 npm 包运行所需的能力：3D 画布、场景渲染、编辑态对象操作、预览态事件执行、模型加载、动画、数据绑定和运行时 API。

当前已更新为babylonjs，优化大模型导入卡顿问题

本包不包含登录页、路由、业务接口、demo 页面、内置资源库和项目应用壳。宿主项目需要自己提供场景数据、模型 URL、请求方法和业务弹窗。

源码地址：[het3d](https://github.com/Het8023/het3d)

演示项目地址：[het3d_preview](https://het8023.github.io/het3d_edit_preview/)

示例代码地址：[het3d_edit](https://github.com/Het8023/het3d_edit)

## 安装

Vue 3 + Vite 项目中安装：

```bash
npm install het3d vue
```

`vue` 是 peer dependency，需要由宿主项目安装；Babylon.js 运行依赖由 `het3d` 提供。

## 基础使用

```vue
<template>
    <div class="viewer">
        <Het3d
            ref="het3dRef"
            :scene-data="sceneData"
            mode="view"
            :asset-loader="loadAsset"
            :request-handler="request"
            @scene-ready="handleSceneReady"
            @scene-change="handleSceneChange"
            @message="handleMessage" />
    </div>
</template>

<script setup>
import { ref } from "vue";
import Het3d from "het3d";
import "het3d/style.css";

const het3dRef = ref(null);
const sceneData = ref({
    id: "scene_demo",
    projectId: "project_demo",
    models: [],
});

async function loadAsset(assetId) {
    return {
        id: assetId,
        modelPath: `/models/${assetId}.glb`,
    };
}

async function request(options) {
    const response = await fetch(options.url, {
        method: options.method || "GET",
    });
    return {
        data: await response.json(),
        status: response.status,
    };
}

function handleSceneReady({ scene }) {
    console.log("scene ready", scene);
}

function handleSceneChange({ scene }) {
    sceneData.value = scene;
}

function handleMessage({ type, message, detail }) {
    console.log(type, message, detail);
}
</script>

<style scoped>
.viewer {
    width: 100%;
    height: 100vh;
}
</style>
```

也可以全局注册：

```js
import { createApp } from "vue";
import Het3d from "het3d";
import "het3d/style.css";
import App from "./App.vue";

createApp(App).use(Het3d).mount("#app");
```

## Props

| Prop                     | 类型                                     | 默认值       | 说明                                                               |
| ------------------------ | ---------------------------------------- | ------------ | ------------------------------------------------------------------ |
| `sceneData`              | `object \| null`                         | `null`       | 直接传入场景数据，优先级最高。                                     |
| `mode`                   | `"edit" \| "view" \| string`             | `"edit"`     | `edit` 支持选择、拖拽、导入、变换；`view` 支持预览事件和轮询数据。 |
| `selectedIds`            | `string[]`                               | `[]`         | 外部受控选中对象 ID。                                              |
| `sceneId`                | `string`                                 | `""`         | 配合 `sceneLoader(sceneId)` 加载场景。                             |
| `projectId`              | `string`                                 | `""`         | 配合 `projectSceneLoader(projectId)` 加载项目场景。                |
| `sceneLoader`            | `(sceneId) => Promise<object \| null>`   | `null`       | 根据场景 ID 返回场景数据。                                         |
| `projectSceneLoader`     | `(projectId) => Promise<object \| null>` | `null`       | 根据项目 ID 返回场景数据。                                         |
| `assetLoader`            | `(assetId) => Promise<object \| null>`   | `null`       | 根据 `assetId` 返回模型资源。                                      |
| `requestHandler`         | `(options) => Promise<any>`              | 内置 `fetch` | 预览态 HTTPS 轮询请求处理器。                                      |
| `eventBus`               | `Het3dEventBus`                          | 默认总线     | 自定义事件总线，多实例隔离时使用。                                 |
| `devicePopoverComponent` | `Vue component`                          | `null`       | 可选设备弹窗组件，需要暴露 `show`、`hide`、`setAnchor`。           |
| `notify`                 | `({ type, message, detail }) => void`    | `console`    | 内部消息提示适配器。                                               |
| `installGlobal`          | `boolean`                                | `true`       | 预览态是否挂载 `window.het3d`。                                    |
| `dracoDecoderPath`       | `string`                                 | `"/draco/"`  | DRACO decoder 目录。                                               |

加载优先级为：`sceneData` > `sceneId + sceneLoader` > `projectId + projectSceneLoader`。

## Events

| Event                     | Payload                                        | 说明                                         |
| ------------------------- | ---------------------------------------------- | -------------------------------------------- |
| `scene-ready`             | `{ scene }`                                    | 场景加载并创建 Babylon.js 对象后触发。       |
| `scene-change`            | `{ scene }`                                    | 编辑态对象、相机、灯光或画布配置变化时触发。 |
| `select`                  | `{ ids, objects }`                             | 画布选中对象变化时触发。                     |
| `thumbnail-ready`         | `{ thumbnail }`                                | 调用 `captureThumbnail()` 后触发。           |
| `device-popover`          | `{ object, event, payload, mode }`             | 设备弹窗动作触发时发出。                     |
| `animation-catalog-ready` | `{ objectId, clips }`                          | 导入模型的 GLB 动画目录可用时触发。          |
| `animation-state-change`  | `{ objectId, animationId, sourceType, state }` | 动画状态变化时触发。                         |
| `animation-finish`        | `{ objectId, animationId, sourceType, state }` | 动画完成时触发。                             |
| `animation-error`         | `{ code, message, ... }`                       | 动画目标、配置或运行状态无效时触发。         |
| `message`                 | `{ type, message, detail }`                    | 导入失败、事件执行失败等消息。               |

## Ref 方法

通过组件 `ref` 调用：

```js
const api = het3dRef.value;
const snapshot = api.getSceneSnapshot();
```

| 方法                                         | 说明                                                  |
| -------------------------------------------- | ----------------------------------------------------- |
| `loadScene(sceneId)`                         | 调用 `sceneLoader` 加载场景。                         |
| `reloadScene()`                              | 重新加载当前内存中的场景数据。                        |
| `getSceneSnapshot()`                         | 获取当前场景快照，会同步最新相机状态。                |
| `captureThumbnail()`                         | 返回当前画布 PNG data URL，并触发 `thumbnail-ready`。 |
| `resetCamera()`                              | 重置或自适应相机。                                    |
| `focusSelection()`                           | 聚焦当前选中对象。                                    |
| `selectAllSelectableObjects()`               | 选中所有可选根对象。                                  |
| `selectAllMeshes()`                          | 当前等同于 `selectAllSelectableObjects()`。           |
| `setTransformMode(mode)`                     | 设置变换模式：`translate`、`rotate`、`scale`。        |
| `addPrimitive(type)`                         | 添加基础对象：`box`、`sphere`、`cylinder`、`plane`。  |
| `addObjectFromResource(resource, position?)` | 从资源描述添加对象。                                  |
| `copySelectedObjects()`                      | 复制当前选中对象，返回数量。                          |
| `pasteCopiedObjects()`                       | 粘贴已复制对象，返回新增对象数组。                    |
| `importModelFile(file)`                      | 导入本地 `.glb/.gltf` 文件。                          |
| `updateSceneObject(objectData)`              | 更新对象数据并同步 Babylon.js 对象。                  |
| `setObjectVisible(id, visible)`              | 设置对象显示或隐藏。                                  |
| `applyCanvasSettings(canvas)`                | 应用画布设置。                                        |
| `applyLightSettings(lights)`                 | 应用灯光设置。                                        |
| `applyCameraSettings(camera)`                | 应用相机设置。                                        |
| `getAnimationCatalog(locator)`               | 获取对象的自定义动画和 GLB 自带动画目录。             |
| `playObjectAnimations(options)`              | 从头启动对象上全部已启用动画。                        |
| `playAnimation(locator)`                     | 播放指定动画；暂停状态下继续播放。                    |
| `pauseAnimation(locator)`                    | 暂停指定动画。                                        |
| `resumeAnimation(locator)`                   | 继续指定动画。                                        |
| `stopAnimation(locator)`                     | 停止指定动画，可通过 `restore` 控制是否恢复。         |
| `restartAnimation(locator)`                  | 恢复基础姿态并从头播放指定动画。                      |
| `seekAnimation(locator)`                     | 跳转到 `timeSeconds` 指定的时间。                     |
| `getAnimationState(locator)`                 | 获取指定动画的当前运行状态。                          |
| `stopAllAnimations(options)`                 | 停止全部或指定对象相关动画。                          |
| `applyAnimationSettings(settings)`           | 应用场景动画总开关、全局速率和隐藏暂停策略。          |
| `deleteObjects(ids)`                         | 删除指定对象。                                        |
| `deleteSelected()`                           | 删除当前选中对象。                                    |

## 运行时 API

`installGlobal=true` 时，组件会临时挂载：

```js
window.het3d;
```

卸载组件时会恢复之前的 `window.het3d`。

| 字段或方法                                                                              | 说明                                  |
| --------------------------------------------------------------------------------------- | ------------------------------------- |
| `het3d.data`                                                                            | 当前场景完整快照，未加载时为 `null`。 |
| `het3d.active`                                                                          | 当前选中对象数组。                    |
| `het3d.setValue(payload)`                                                               | 按对象 ID 修改对象字段。              |
| `het3d.showDevicePopover(options)`                                                      | 触发设备弹窗动作，返回 `true/false`。 |
| `het3d.explodeModel(options)`                                                           | 触发模型展开动作，返回 `true/false`。 |
| `het3d.getAnimationCatalog(locator)`                                                    | 获取对象动画目录。                    |
| `het3d.playObjectAnimations(options)`                                                   | 启动对象全部已启用动画。              |
| `het3d.playAnimation(locator)` / `pauseAnimation(locator)` / `resumeAnimation(locator)` | 控制单个动画。                        |
| `het3d.stopAnimation(locator)` / `restartAnimation(locator)` / `seekAnimation(locator)` | 停止、重播或跳转单个动画。            |
| `het3d.getAnimationState(locator)` / `stopAllAnimations(options)`                       | 查询状态或批量停止。                  |
| `het3d.applyAnimationSettings(settings)`                                                | 应用场景动画设置。                    |
| `het3d.on(name, handler)`                                                               | 监听自定义事件，返回取消监听函数。    |
| `het3d.off(name, handler)`                                                              | 移除自定义事件监听。                  |
| `het3d.once(name, handler)`                                                             | 只监听一次自定义事件。                |
| `het3d.emit(name, payload)`                                                             | 发送自定义事件给外部监听者。          |
| `het3d.utils.cloneData(value)`                                                          | 深拷贝工具。                          |

示例：

```js
het3d.setValue({
    id: "obj_1",
    name: "水泵 A",
    positionX: 2,
    materialColor: "#ff0000",
    running: true,
});
```

快捷字段会写入嵌套结构：

| 快捷字段         | 实际字段          |
| ---------------- | ----------------- |
| `positionX/Y/Z`  | `position.x/y/z`  |
| `rotationX/Y/Z`  | `rotation.x/y/z`  |
| `scaleX/Y/Z`     | `scale.x/y/z`     |
| `materialColor`  | `material.color`  |
| `materialSymbol` | `material.symbol` |
| `materialLabel`  | `material.label`  |
| `materialShape`  | `material.shape`  |

对象事件自定义代码中会注入 `het3d`：

```js
het3d.setValue({
    id: object.id,
    materialColor: "#00ff00",
});
```

也可以通过上下文访问：

```js
context.het3d.showDevicePopover({
    objectId: object.id,
    deviceNo: "device_001",
    popoverMode: "floating",
});
```

模型展开也可以通过自定义事件代码触发：

```js
context.het3d.explodeModel({
    objectId: object.id,
});
```

事件上下文包含：

```js
{
    (object, object3d, event, trigger, scene, camera, controls, BABYLON, het3d);
}
```

## 事件总线

事件总线用于“包内自定义事件代码通知外部业务”。它只负责发布和订阅，不会在包内执行业务逻辑。

用法类似：

```js
het3d.on("input-editor", (msg) => {
    createTextEditor(msg);
});
```

### 在对象事件中发送消息

场景对象事件仍然由 `leftClick`、`leftDoubleClick` 或 `valueChange` 等内置触发时机执行。事件代码里调用 `het3d.emit(name, payload)`，把业务参数交给外部：

```js
{
  id: "event_input_editor",
  name: "打开文本编辑器",
  triggerType: "leftClick",
  actionType: "customFunction",
  code: `
    het3d.emit("input-editor", {
      object,
      object3d,
      event,
      trigger,
      params: event.params,
    });
  `,
  params: {
    editableField: "name",
  },
}
```

外部监听：

```vue
<template>
    <Het3d ref="het3dRef" :scene-data="sceneData" mode="view" @scene-ready="handleSceneReady" />
</template>

<script setup>
import { onBeforeUnmount, ref } from "vue";
import Het3d from "het3d";

const het3dRef = ref(null);
let offInputEditor;

function handleSceneReady() {
    offInputEditor = het3dRef.value?.on("input-editor", (msg) => {
        createTextEditor(msg);
    });
}

function createTextEditor({ object, params }) {
    console.log("打开外部编辑器", object, params);
}

onBeforeUnmount(() => {
    offInputEditor?.();
});
</script>
```

也可以监听默认总线：

```js
import { het3dEventBus } from "het3d";

const off = het3dEventBus.on("input-editor", (msg) => {
    createTextEditor(msg);
});
```

多实例隔离时，创建独立总线并传给组件：

```vue
<template>
    <Het3d :scene-data="sceneData" mode="view" :event-bus="bus" />
</template>

<script setup>
import { createHet3dEventBus } from "het3d";

const bus = createHet3dEventBus();

bus.on("input-editor", (msg) => {
    createTextEditor(msg);
});
</script>
```

### API

| 方法                  | 说明                                      |
| --------------------- | ----------------------------------------- |
| `on(name, handler)`   | 监听事件，返回取消监听函数。              |
| `off(name, handler)`  | 移除监听。                                |
| `once(name, handler)` | 只监听一次。                              |
| `emit(name, payload)` | 发送事件，返回所有 handler 的返回值数组。 |

这些方法可以从三个地方使用：

```js
het3dRef.value.on("input-editor", handler);
window.het3d.on("input-editor", handler);
het3dEventBus.on("input-editor", handler);
```

在对象事件代码中推荐只调用 `het3d.emit(...)`。外部监听后可以创建 DOM、打开弹窗、调用业务接口或执行任何宿主项目自己的逻辑。

## 场景数据格式

最小场景：

```js
const sceneData = {
    id: "scene_1",
    projectId: "project_1",
    models: [],
    camera: {
        position: { x: 5, y: 5, z: 6 },
        target: { x: 0, y: 0.5, z: 0 },
        near: 0.1,
        far: 1000,
    },
    canvas: {
        backgroundColor: "#f5f7fb",
        showGrid: true,
        showAxes: true,
    },
    lights: {
        ambient: { color: "#ffffff", intensity: 1.6 },
        directional: {
            color: "#ffffff",
            intensity: 1.25,
            position: { x: 4, y: 8, z: 5 },
        },
    },
    httpsConfig: {
        enabled: false,
        method: "GET",
        url: "",
        headers: "{}",
        query: "{}",
        body: "{}",
        processor: "",
        intervalSeconds: 10,
    },
    animationSettings: {
        enabled: true,
        globalSpeed: 1,
        pauseWhenHidden: true,
    },
    editorState: {
        selectedIds: [],
        transformMode: "translate",
    },
};
```

模型对象：

```js
{
  id: "obj_1",
  name: "立方体",
  type: "box",
  nodeType: "mesh",
  parentId: null,
  children: [],
  position: { x: 0, y: 0.5, z: 0 },
  rotation: { x: 0, y: 0, z: 0 },
  scale: { x: 1, y: 1, z: 1 },
  material: {
    color: "#4f7cff",
    symbol: "",
    label: "立方体",
    shape: "",
  },
  modelPath: "",
  assetId: "",
  source: null,
  dataBindings: [],
  events: [],
  animations: [],
  builtInAnimations: [],
  metadata: null,
  visible: true,
  locked: false,
}
```

常用字段说明：

| 字段                | 说明                                                                                                           |
| ------------------- | -------------------------------------------------------------------------------------------------------------- |
| `id`                | 对象唯一 ID，`setValue`、选中、删除都依赖它。                                                                  |
| `type`              | 支持 `box`、`sphere`、`cylinder`、`plane`、`icon`、`image`、`importedModel`、`importedLayer`、`importedMesh`。 |
| `position`          | 位置 `{ x, y, z }`。                                                                                           |
| `rotation`          | 欧拉角 `{ x, y, z }`，单位为弧度。                                                                             |
| `scale`             | 缩放 `{ x, y, z }`。                                                                                           |
| `modelPath`         | `importedModel` 可直接使用的模型 URL 或 data URL。                                                             |
| `assetId`           | 配合 `assetLoader` 获取模型资源。                                                                              |
| `dataBindings`      | 设备或接口数据绑定配置。                                                                                       |
| `events`            | 对象交互事件配置。                                                                                             |
| `animations`        | 自定义动画配置。旧数据缺少 `autoPlay` 时按 `true` 兼容。                                                       |
| `builtInAnimations` | 导入模型的 GLB 片段引用与播放设置，不保存关键帧或运行时对象。                                                  |

## 数据绑定

```js
{
  id: "device_1-temperature-value",
  displayName: "温度",
  propName: "temperature",
  type: "number",
  value: 26,
  binding: {
    deviceId: "device_1",
    deviceName: "空调",
    deviceNo: "AC001",
    identifier: "temperature",
    propertyId: "prop_1",
    propertyName: "温度",
    valueMode: "value",
  },
}
```

当执行 `het3d.setValue({ id: "obj_1", temperature: 28 })` 且命中 `propName` 时，会同步更新对象字段和绑定项的 `value`。

## 对象事件

自定义函数：

```js
{
  id: "event_1",
  name: "点击变色",
  triggerType: "leftClick",
  actionType: "customFunction",
  code: "het3d.setValue({ id: object.id, materialColor: '#ff0000' })",
}
```

设备弹窗事件：

```js
{
  id: "event_device",
  name: "打开设备弹窗",
  triggerType: "leftClick",
  actionType: "devicePopover",
  popoverMode: "floating",
  deviceNo: "AC001",
  params: { deviceNo: "AC001" },
}
```

模型展开事件：

```js
{
  id: "event_explode",
  name: "楼栋分层展开",
  triggerType: "leftDoubleClick",
  actionType: "modelExplode",
  explodeConfig: {
    targetIds: "",
    direction: "up",
    spacing: 2,
    duration: 800,
    easing: "linear",
    toggle: true,
    offset: { x: 0, y: 2, z: 0 },
  },
}
```

动画控制事件：

```js
{
  id: "event_animation",
  name: "启动动画",
  triggerType: "leftClick",
  actionType: "animationControl",
  animationControl: {
    targetObjectId: "",
  },
}
```

`targetObjectId` 缺省、为空或为 `self` 时使用事件所属对象。触发后从头启动目标对象全部已启用动画；该动作不接受动画来源、动画 ID、命令或停止策略字段。

支持的 `triggerType`：

| 值                | 说明                           |
| ----------------- | ------------------------------ |
| `leftClick`       | 预览态鼠标左键点击对象时触发。 |
| `leftDoubleClick` | 预览态鼠标左键双击对象时触发。 |
| `valueChange`     | 数据绑定值变化时触发。         |

支持的 `actionType`：

| 值                 | 说明                                 |
| ------------------ | ------------------------------------ |
| `customFunction`   | 执行 `code` 中的 JavaScript 函数体。 |
| `devicePopover`    | 触发设备弹窗。                       |
| `modelExplode`     | 触发模型展开或收起。                 |
| `animationControl` | 从头启动目标对象全部已启用动画。     |

## 动画配置

自定义动画保存在对象的 `animations` 数组中。运行时只修改 Babylon.js 节点，不逐帧写回场景对象、不触发 `scene-change`，也不写入存储。

```js
{
  schemaVersion: 1,
  id: "animation_move",
  name: "移动",
  enabled: true,
  targetId: "self",
  autoPlay: true,
  delaySeconds: 0,
  loopMode: "normal",
  loopCount: 1,
  speed: 1,
  endState: "restore",
  easing: "linear",
  segments: [{
    id: "segment_1",
    startTime: 0,
    endTime: 1,
    easing: "easeInOut",
    properties: [{
      id: "property_1",
      property: "position.x",
      startValue: 0,
      endValue: 1,
    }],
  }],
}
```

动画 locator 使用 `{ objectId, sourceType, animationId }`。`sourceType` 为 `custom` 或 `builtIn`；跳转时额外传入 `timeSeconds`，停止时可额外传入 `restore`。

## 模型资源适配器

`assetLoader` 在模型对象只有 `assetId` 且没有 `modelPath` 时调用。宿主项目可以在这里把自己的资源 ID 转成真实模型地址：

```js
async function assetLoader(assetId) {
    return {
        id: assetId,
        modelPath: "/models/building.glb",
    };
}
```

可返回字段：

| 字段                 | 说明                                    |
| -------------------- | --------------------------------------- |
| `modelPath`          | 模型 URL 或 data URL。                  |
| `sourceUrl`          | 模型 URL，`modelPath` 不存在时使用。    |
| `metadata.sourceUrl` | 备用模型 URL。                          |
| `blob`               | `File` 或 `Blob`，组件会转为 data URL。 |

## HTTP/HTTPS 轮询配置

场景数据中的 `httpsConfig` 用于预览态数据轮询。字段名沿用 `httpsConfig`，实际支持普通 HTTP 和 HTTPS。

运行条件：

| 条件                                 | 说明                   |
| ------------------------------------ | ---------------------- |
| `mode="view"`                        | 只有预览态会执行轮询。 |
| `sceneData.httpsConfig.enabled=true` | 未启用时不请求。       |
| `sceneData.httpsConfig.url` 非空     | 请求地址为空时不请求。 |
| `intervalSeconds >= 1`               | 最小轮询间隔为 1 秒。  |

完整配置：

```js
const sceneData = {
    id: "scene_1",
    models: [
        {
            id: "obj_ac_1",
            name: "空调 1",
            type: "box",
            dataBindings: [
                {
                    id: "device_001-temperature-value",
                    displayName: "温度",
                    propName: "temperature",
                    value: null,
                    binding: {
                        deviceId: "device_001",
                        deviceNo: "AC001",
                        identifier: "temperature",
                        valueMode: "value",
                    },
                },
            ],
        },
    ],
    httpsConfig: {
        enabled: true,
        method: "GET",
        url: "/api/device/realtime",
        headers: JSON.stringify(
            {
                "X-App-Id": "your-app-id",
            },
            null,
            2,
        ),
        query: JSON.stringify(
            {
                projectId: "project_1",
                deviceNos: ["AC001"],
            },
            null,
            2,
        ),
        body: "{}",
        intervalSeconds: 5,
        processor: `function handleMessage(e) {
  const list = Array.isArray(e) ? e : [];
  return list.map((item) => ({
    dataId: item.dataId,
    value: item.value,
  }));
}`,
    },
};
```

`httpsConfig` 字段：

| 字段              | 类型               | 说明                                                              |
| ----------------- | ------------------ | ----------------------------------------------------------------- |
| `enabled`         | `boolean`          | 是否启用轮询。                                                    |
| `method`          | `"GET" \| "POST"`  | 只支持 `GET` 和 `POST`，其他值会按 `GET` 处理。                   |
| `url`             | `string`           | 请求地址，可以是相对地址或完整 URL。                              |
| `headers`         | `string \| object` | JSON 对象。请求头只来自该配置，不会默认添加 token 或业务请求头。  |
| `query`           | `string \| object` | JSON 对象。非空时会拼到 URL 查询参数中，`GET` / `POST` 都生效。   |
| `body`            | `string \| object` | JSON 值。非空且为 `POST` 时才作为请求体发送；请求头需要自行配置。 |
| `processor`       | `string`           | 响应处理函数源码，必须返回 `{ dataId, value }[]`。                |
| `intervalSeconds` | `number`           | 轮询间隔秒数，最小为 1。                                          |

`GET` 请求示例：

```js
httpsConfig: {
  enabled: true,
  method: "GET",
  url: "/api/device/realtime",
  headers: {},
  query: {
    projectId: "project_1",
    deviceNos: ["AC001", "PUMP001"],
  },
  body: "{}",
  intervalSeconds: 5,
  processor: `function handleMessage(e) {
    return e.map((item) => ({
      dataId: item.dataId,
      value: item.value,
    }));
  }`,
}
```

默认请求会变成：

```text
GET /api/device/realtime?projectId=project_1&deviceNos=AC001&deviceNos=PUMP001
```

`POST` 请求示例：

```js
httpsConfig: {
  enabled: true,
  method: "POST",
  url: "/api/device/realtime",
  headers: {
    "Content-Type": "application/json",
  },
  query: "{}",
  body: {
    projectId: "project_1",
    deviceNos: ["AC001", "PUMP001"],
  },
  intervalSeconds: 5,
  processor: `function handleMessage(e) {
    const rows = Array.isArray(e?.records) ? e.records : [];
    return rows.map((row) => ({
      dataId: row.dataId,
      value: row.value,
    }));
  }`,
}
```

默认请求会发送：

```text
POST /api/device/realtime
Content-Type: application/json

{"projectId":"project_1","deviceNos":["AC001","PUMP001"]}
```

### requestHandler

如果宿主项目需要使用已有请求库或统一错误处理，传入 `requestHandler`。组件只转发
`httpsConfig` 中配置的 `headers`、`query` 和 `body`，不会自行读取本地 token 或添加特定服务的请求头：

```js
async function requestHandler(options) {
    const { method, url, headers, query, body, timeout } = options;
    const controller = new AbortController();
    const timer = window.setTimeout(() => controller.abort(), timeout || 10000);

    try {
        const requestUrl = new URL(url, window.location.origin);
        Object.entries(query || {}).forEach(([key, value]) => {
            if (Array.isArray(value)) {
                value.forEach((item) => requestUrl.searchParams.append(key, String(item)));
            } else if (value !== undefined) {
                requestUrl.searchParams.set(key, value == null ? "" : String(value));
            }
        });

        const response = await fetch(requestUrl.toString(), {
            method: method === "POST" ? "POST" : "GET",
            headers,
            body: method === "POST" && body !== undefined ? JSON.stringify(body) : undefined,
            signal: controller.signal,
        });

        return await response.json();
    } finally {
        window.clearTimeout(timer);
    }
}
```

组件调用 `requestHandler` 时传入：

```js
{
  method: "GET" | "POST",
  url: "/api/device/realtime",
  headers?: {},
  query?: {},
  body?: {},
  timeout: 10000
}
```

`headers`、`query` 和 `body` 只有在对应配置不为空时才会传入。`requestHandler` 返回什么，
`processor` 的 `e` 就接收到什么。内置 `fetch` 返回的 `e` 是接口响应体本身，JSON 文本会解析为对象或数组，
非 JSON 文本会保持字符串，不会自动读取 `data` 字段。

### processor

`processor` 负责把接口响应转换为 het3d 能识别的数据绑定数组：

```js
[
    { dataId: "device_001-temperature-value", value: 26.5 },
    { dataId: "device_001-running-value", value: true },
];
```

`dataId` 必须匹配模型对象的 `dataBindings[].id`。匹配后组件会更新：

| 更新位置               | 说明                                            |
| ---------------------- | ----------------------------------------------- |
| `dataBindings[].value` | 绑定项当前值。                                  |
| `object[propName]`     | 如果绑定项配置了 `propName`，同步写入对象字段。 |
| `valueChange` 事件     | 值变化后触发对象上配置的 `valueChange` 事件。   |

推荐写法：

```js
processor: `function handleMessage(e) {
  const rows = Array.isArray(e) ? e : [];
  return rows
    .filter((item) => item.dataId && Object.prototype.hasOwnProperty.call(item, "value"))
    .map((item) => ({
      dataId: String(item.dataId),
      value: item.value,
    }));
}`;
```

也可以直接写成函数表达式：

```js
processor: `(response) => {
  const list = Array.isArray(response)
    ? response
    : Array.isArray(response?.records)
      ? response.records
      : [];
  return list.map((item) => ({
    dataId: item.dataId,
    value: item.value,
  }));
}`;
```

常见问题：

| 问题             | 处理方式                                                          |
| ---------------- | ----------------------------------------------------------------- |
| 需要传 headers   | 写在 `httpsConfig.headers`，或通过自定义 `requestHandler` 处理。  |
| `query` 解析失败 | `query` 必须是 JSON 对象，不支持数组作为根值。                    |
| 轮询没有执行     | 确认 `mode="view"`、`enabled=true`、`url` 非空。                  |
| 场景值没更新     | 确认 `processor` 返回数组，且 `dataId` 等于 `dataBindings[].id`。 |

## 设备弹窗配置

设备弹窗有两种接入方式：

| 方式                          | 适用场景                                              |
| ----------------------------- | ----------------------------------------------------- |
| 监听 `device-popover` 事件    | 宿主项目已有弹窗系统，想完全自己控制展示。            |
| 传入 `devicePopoverComponent` | 希望 het3d 自动调用弹窗组件的 `show/hide/setAnchor`。 |

### 方式一：监听事件自行展示

```vue
<template>
    <Het3d :scene-data="sceneData" mode="view" @device-popover="openDeviceDialog" />

    <YourDeviceDialog
        v-model="dialogVisible"
        :device-no="activeDeviceNo"
        :object-data="activeObject" />
</template>

<script setup>
import { ref } from "vue";
import Het3d from "het3d";
import "het3d/style.css";

const dialogVisible = ref(false);
const activeDeviceNo = ref("");
const activeObject = ref(null);

function openDeviceDialog(payload) {
    activeObject.value = payload.object;
    activeDeviceNo.value = payload.event?.deviceNo || payload.event?.params?.deviceNo || "";
    dialogVisible.value = true;
}
</script>
```

`device-popover` 事件 payload：

| 字段      | 说明                          |
| --------- | ----------------------------- |
| `object`  | 触发弹窗的场景对象快照。      |
| `event`   | 触发弹窗的事件配置。          |
| `payload` | 鼠标事件、锚点等运行时信息。  |
| `mode`    | `"floating"` 或 `"builtIn"`。 |

### 方式二：传入弹窗组件

宿主组件中传入：

```vue
<template>
    <Het3d :scene-data="sceneData" mode="view" :device-popover-component="DevicePopover" />
</template>

<script setup>
import Het3d from "het3d";
import "het3d/style.css";
import DevicePopover from "./DevicePopover.vue";
</script>
```

`DevicePopover.vue` 示例：

```vue
<template>
    <div v-if="visible" class="device-popover" :style="popoverStyle">
        <button class="device-popover__close" type="button" @click="hide">x</button>
        <div class="device-popover__title">{{ title }}</div>
        <div class="device-popover__row">设备编号：{{ deviceNo || "-" }}</div>
        <div class="device-popover__row">对象名称：{{ objectData?.name || "-" }}</div>
    </div>
</template>

<script setup>
import { computed, ref } from "vue";

const props = defineProps({
    variant: {
        type: String,
        default: "floating",
    },
});

const visible = ref(false);
const objectData = ref(null);
const eventItem = ref(null);
const runtimePayload = ref({});
const anchor = ref(null);

const deviceNo = computed(() => {
    const params = eventItem.value?.params;
    return eventItem.value?.deviceNo || params?.deviceNo || "";
});

const title = computed(() => {
    return eventItem.value?.name || objectData.value?.name || "设备详情";
});

const popoverStyle = computed(() => {
    if (props.variant === "builtIn") {
        const point = anchor.value || runtimePayload.value?.anchor || { x: 24, y: 24 };
        return {
            position: "absolute",
            left: `${Math.max((point.x || 0) + 12, 12)}px`,
            top: `${Math.max((point.y || 0) + 12, 12)}px`,
            zIndex: 20,
        };
    }

    const point = runtimePayload.value?.pointerEvent || { clientX: 24, clientY: 24 };
    return {
        position: "fixed",
        left: `${Math.max((point.clientX || 0) + 12, 12)}px`,
        top: `${Math.max((point.clientY || 0) + 12, 12)}px`,
        zIndex: 9999,
    };
});

function show(nextObjectData, nextEventItem, nextPayload = {}) {
    objectData.value = nextObjectData;
    eventItem.value = nextEventItem;
    runtimePayload.value = nextPayload;
    anchor.value = nextPayload.anchor || null;
    visible.value = true;

    // 可以在这里根据 deviceNo 请求设备详情。
}

function hide() {
    visible.value = false;
}

function setAnchor(nextAnchor) {
    anchor.value = nextAnchor;
}

defineExpose({
    show,
    hide,
    setAnchor,
});
</script>

<style scoped>
.device-popover {
    width: 280px;
    padding: 12px;
    border: 1px solid #d7dde8;
    border-radius: 6px;
    background: #ffffff;
    box-shadow: 0 10px 30px rgb(15 23 42 / 18%);
    color: #1f2937;
}

.device-popover__close {
    float: right;
}

.device-popover__title {
    margin-bottom: 8px;
    font-weight: 600;
}

.device-popover__row {
    line-height: 24px;
    font-size: 13px;
}
</style>
```

弹窗组件接口：

```js
defineExpose({
    show(objectData, eventItem, payload) {},
    hide() {},
    setAnchor(anchor) {},
});
```

| 方法                                   | 调用时机                                            |
| -------------------------------------- | --------------------------------------------------- |
| `show(objectData, eventItem, payload)` | 设备弹窗被触发时调用。                              |
| `hide()`                               | 组件内部需要关闭弹窗，或 het3d 切换弹窗状态时调用。 |
| `setAnchor(anchor)`                    | `builtIn` 弹窗随相机或画布变化更新锚点时调用。      |

`payload` 常用字段：

| 字段           | 说明                                                    |
| -------------- | ------------------------------------------------------- |
| `pointerEvent` | `floating` 模式下的鼠标位置，包含 `clientX/clientY`。   |
| `anchor`       | `builtIn` 模式下的画布内锚点，包含 `x/y/width/height`。 |

### 如何触发设备弹窗

场景对象事件中配置：

```js
{
  id: "event_device",
  name: "打开设备弹窗",
  triggerType: "leftClick",
  actionType: "devicePopover",
  popoverMode: "floating",
  deviceNo: "AC001",
  params: {
    deviceNo: "AC001",
    title: "空调 1",
  },
}
```

在自定义事件代码中触发：

```js
het3d.showDevicePopover({
    objectId: object.id,
    deviceNo: "AC001",
    params: {
        deviceNo: "AC001",
        title: "空调 1",
    },
    popoverMode: "builtIn",
});
```

也可以在浏览器控制台或宿主代码中触发：

```js
window.het3d.showDevicePopover({
    objectId: "obj_ac_1",
    deviceNo: "AC001",
    popoverMode: "floating",
});
```

`showDevicePopover(options)` 参数：

| 参数                           | 说明                                                                            |
| ------------------------------ | ------------------------------------------------------------------------------- |
| `objectId` / `targetId` / `id` | 目标对象 ID。                                                                   |
| `objectData` / `object`        | 直接传入对象数据；优先级高于对象 ID 查询。                                      |
| `objectName` / `name`          | 找不到对象数据时用于弹窗显示的名称。                                            |
| `deviceNo`                     | 设备编号。                                                                      |
| `params`                       | 业务参数，会原样进入 `eventItem.params`。如果是字符串，会作为 `deviceNo` 兜底。 |
| `popoverMode`                  | `"floating"` 或 `"builtIn"`，默认 `"floating"`。                                |
| `pointerEvent` / `event`       | 手动指定鼠标位置。                                                              |
| `anchor`                       | 手动指定锚点，支持 `{ x, y }` 或 `{ clientX, clientY }`。                       |

`floating` 和 `builtIn` 的区别：

| 模式       | 说明                                                  |
| ---------- | ----------------------------------------------------- |
| `floating` | 弹窗按鼠标位置或对象投影位置展示，适合全局浮层。      |
| `builtIn`  | 弹窗挂在 het3d 画布内部，锚点会随相机和对象位置更新。 |

## 如何触发模型展开

模型展开用于把一个模型或多个图层按预设方向和间距匀速移动到展开位置。典型场景是楼栋模型按楼层上下展开。

### 通过对象事件触发

在对象 `events` 数组中配置 `actionType: "modelExplode"`：

```js
{
  id: "event_explode",
  name: "楼栋分层展开",
  triggerType: "leftDoubleClick",
  actionType: "modelExplode",
  explodeConfig: {
    targetIds: "",
    direction: "up",
    spacing: 2,
    duration: 800,
    easing: "linear",
    toggle: true,
    offset: { x: 0, y: 2, z: 0 },
  },
}
```

当 `targetIds` 为空时，默认使用当前触发对象。当前触发对象如果是导入父模型，het3d 会自动解析其 `importedLayer` 子图层，并按 `source.layerIndex` 顺序把每个图层作为独立动画目标。也就是说，4 层楼栋双击后会是 4 个图层同时开始分层运动，而不是父模型整体移动。

### 通过公共 API 触发

可以在浏览器控制台、宿主代码或对象事件自定义函数中调用：

```js
window.het3d.explodeModel({
    objectId: "obj_building_1",
});
```

也可以直接通过事件总线兼容入口触发：

```js
window.het3d.on("modelExplode", {
    objectId: "obj_building_1",
    explodeConfig: {
        direction: "custom",
        offset: { x: 0, y: 3, z: 0 },
        duration: 800,
        toggle: true,
    },
});
```

`explodeModel(options)` 参数：

| 参数                           | 说明                                                                 |
| ------------------------------ | -------------------------------------------------------------------- |
| `objectId` / `targetId` / `id` | 触发展开的对象 ID；未传 `explodeConfig` 时会从该对象事件中查找配置。 |
| `objectData` / `object`        | 直接传入对象数据，用于辅助解析当前事件和目标。                       |
| `eventId`                      | 指定要使用的模型展开事件 ID。                                        |
| `triggerType`                  | 触发方式，例如 `manual`、`leftClick`、`leftDoubleClick`。            |
| `explodeConfig`                | 展开配置；未传时使用目标对象上第一个 `modelExplode` 事件配置。       |
| `event`                        | 直接传入事件对象，优先用于读取 `explodeConfig`。                     |

`explodeConfig` 字段：

| 字段        | 说明                                                                       |
| ----------- | -------------------------------------------------------------------------- |
| `targetIds` | 逗号分隔的目标对象 ID；为空时默认当前触发对象。                            |
| `targets`   | 高级目标列表，每项可包含 `objectId` / `id`、`fromPosition`、`toPosition`。 |
| `direction` | 展开方向：`up`、`down`、`both`、`custom`。                                 |
| `spacing`   | 自动展开间距。                                                             |
| `offset`    | `custom` 方向下的 XYZ 偏移，多个图层会按顺序逐层叠加。                     |
| `duration`  | 动画时长，单位毫秒；默认 `800`。                                           |
| `easing`    | 当前使用匀速移动，值为 `linear`。                                          |
| `toggle`    | `true` 时再次触发会按原动画收起；`false` 时只展开。                        |

### 目标解析和动画规则

- `targetIds` 或 `targets` 指向普通对象时，直接移动该对象。
- `targetIds` 或 `targets` 指向导入父模型时，自动展开为父模型下的 `importedLayer` 子对象。
- `up` / `down` / `both` 使用 `spacing` 生成目标位置。
- `custom` 使用 `offset` 生成目标位置；多图层时第 1 个目标使用 0 倍偏移，第 2 个目标使用 1 倍偏移，以此形成层间空隙；单个目标使用 1 倍偏移。
- 如果显式传入 `targets[].toPosition`，优先使用该目标位置。
- 展开过程中只改变位置，不改变旋转、缩放、材质、可见性和业务绑定字段。
- `toggle` 为 `true` 时，已展开状态再次触发会回到原始 `fromPosition`；动画未完成时再次触发，会从当前实际位置平滑切换。

### 大模型性能说明

模型展开动画运行期间，het3d 每帧只更新参与对象的 Babylon.js 节点位置和必要矩阵状态，不会每帧写回完整场景数据、重算父模型包围盒或重复触发 `scene-change`。动画完成后才同步最终位置到场景数据。

导入图层作为展开目标时，图层根节点保持可更新矩阵；内部静态网格仍可保留运行时优化。父导入模型的透明点击代理会在展开或收起完成后根据子图层最新包围盒刷新，保证展开后点击任意可见子图层区域仍能命中父模型事件并再次触发收起。

## 源码结构

`src/het3d/Het3d.vue` 负责 Vue 生命周期、Babylon.js 主循环、相机/选择交互和公共方法组装。独立业务状态拆分到以下模块，并通过访问器和回调注入场景依赖：

| 模块                     | 职责                                            |
| ------------------------ | ----------------------------------------------- |
| `animationRuntime.js`    | 自定义动画和 GLB 动画实例、状态、冲突与播放控制 |
| `sceneDataPolling.js`    | HTTPS 请求、轮询、数据绑定更新和值变化事件      |
| `modelExplodeRuntime.js` | 模型炸开配置、展开状态和逐帧位置求值            |
| `modelImportRuntime.js`  | GLB 加载、层级映射、缓存、材质覆盖和旧数据迁移  |
| `objectEventRuntime.js`  | 对象事件分发、自定义代码执行和设备弹窗状态      |
| `sceneVisuals.js`        | 材质、动态纹理、对象元数据和坐标转换            |

运行时模块不持有 Vue 组件实例，只通过构造参数访问当前场景，便于独立测试和继续拆分。

## 构建和发包

```bash
npm run build
npm run pack:check
npm publish
```

发布内容由 `package.json` 的 `files` 字段控制，只包含：

```text
dist/
src/het3d/index.d.ts
README.md
package.json
```

## 2026-07-13 交互与画布配置补充

### 编辑态变换

- `setTransformMode("translate")` 对应 W/移动模式。
- `setTransformMode("rotate")` 对应 E/旋转模式。
- `setTransformMode("scale")` 对应 R/缩放模式。
- 拖拽 X/Y/Z 单轴手柄时，只更新当前对象对应轴向的 `position`、`rotation` 或 `scale`。
- 控制器轴向拖拽优先级高于对象选择、对象直接拖拽和相机控制。
- 鼠标左键按住可选对象本体时支持直接拖拽移动；如果对象未选中，会先选中再拖拽；锁定对象不会进入拖拽。

### 滚轮缩放

组件会移除 Babylon.js 默认滚轮相机输入，并使用自定义滚轮逻辑控制 `ArcRotateCamera.radius`：

- 不设置固定缩放上限。
- 允许大场景继续拉远、小场景继续拉近。
- 缩放后会同步更新相机 `near` / `far`，降低大模型视角移动时的裁剪和闪烁问题。

### `canvas.axesSize`

`applyCanvasSettings(canvas)` 支持坐标轴长度配置：

```js
het3dRef.value.applyCanvasSettings({
    showAxes: true,
    axesSize: 3,
});
```

场景数据示例：

```js
canvas: {
    backgroundColor: "#f5f7fb",
    showGrid: true,
    showAxes: true,
    axesSize: 3,
}
```

- `axesSize` 单位与场景坐标一致。
- 默认值为 `3`。
- 非法值会回退为默认值。
- 组件内部限制范围为 `0.1` 到 `1000000`。
