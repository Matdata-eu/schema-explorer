/// <reference types="vite/client" />
declare module "*.css?inline" {
  const css: string;
  export default css;
}
declare const __APP_VERSION__: string;
