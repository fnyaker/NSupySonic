import { vitePreprocess } from "@sveltejs/vite-plugin-svelte";

export default {
  // `script: true` enables TypeScript stripping in <script lang="ts"> blocks.
  // It is off by default; svelte-spa-router (v5+) ships its components as raw
  // .svelte with TypeScript, so without this Rollup chokes on the types.
  preprocess: vitePreprocess({ script: true }),
};
