// The app core's binary, as a URL Vite emits into the build. Kept apart from
// core.js for the same reason lib/audio/rhythm-assets.js is: Node (the test
// suite) cannot resolve a `?url` import, so core.js reaches this file only
// through the dynamic import in loadAppCore(), and the tests load the bytes
// themselves (appCoreFromBytes).
import url from "./appcore.wasm?url";

export { url };
