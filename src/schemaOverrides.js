'use strict';
function applySchemaOverrides(vendor, operation, schema) {
  // Vercel's SDK uses smartUnion for this request source, not an exclusive union:
  // https://github.com/vercel/sdk/blob/main/src/models/createprojectcheckop.ts
  const source = schema.properties?.body?.properties?.source;
  if (vendor === 'vercel' && operation === 'createProjectCheck' && source?.oneOf) {
    source.anyOf = source.oneOf;
    delete source.oneOf;
  }
}
module.exports = { applySchemaOverrides };
