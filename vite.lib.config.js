import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";

export default defineConfig({
    plugins: [vue()],
    publicDir: false,
    build: {
        lib: {
            entry: "src/het3d/index.js",
            name: "Het3d",
            fileName: (format) => (format === "es" ? "het3d.es.js" : "het3d.umd.cjs"),
            cssFileName: "het3d",
            formats: ["es", "umd"],
        },
        rollupOptions: {
            external: [/^vue$/, /^three$/],
            output: {
                exports: "named",
                globals: {
                    vue: "Vue",
                    three: "THREE",
                },
            },
        },
    },
});
