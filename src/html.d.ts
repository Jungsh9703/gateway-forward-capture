// Wrangler bundles *.html imports as text modules by default.
declare module "*.html" {
  const content: string;
  export default content;
}
