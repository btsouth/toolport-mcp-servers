'use strict';
function applySchemaOverrides(vendor, operation, schema) {
  // Vercel's SDK uses smartUnion for this request source, not an exclusive union:
  // https://github.com/vercel/sdk/blob/main/src/models/createprojectcheckop.ts
  const source = schema.properties?.body?.properties?.source;
  if (vendor === 'vercel' && operation === 'createProjectCheck' && source?.oneOf) {
    source.anyOf = source.oneOf;
    delete source.oneOf;
  }
  // The DNS spec requires name in every branch but omits its declaration in
  // SRV, TXT and HTTPS, making those closed objects impossible to validate.
  // https://vercel.com/docs/rest-api/dns/create-a-dns-record
  if (vendor === 'vercel' && operation === 'createRecord') {
    const branches = schema.properties?.body?.anyOf || [];
    const name = branches.find(x => x.properties?.name)?.properties.name;
    for (const branch of branches) {
      if (name && branch.required?.includes('name') && !branch.properties?.name) branch.properties.name = structuredClone(name);
    }
  }
  // These optional millisecond fields are numbers in the official Sandbox SDK.
  // The OpenAPI empty oneOf alternative incorrectly rejects every integer.
  // https://github.com/vercel/sandbox/blob/main/packages/vercel-sandbox/src/sandbox.ts
  if (vendor === 'vercel' && /^(createSandboxes|updateSandbox|createSessionSnapshot|createSandboxesSessionsBySessionIdSnapshot)/.test(operation)) {
    function expiration(s) {
      if (!s || typeof s !== 'object') return;
      for (const [key, child] of Object.entries(s.properties || {})) {
        if (['snapshotExpiration', 'expiration'].includes(key) && child.oneOf?.some(x => x.type === 'integer') && child.oneOf.some(x => !Object.keys(x).length)) {
          delete child.oneOf;
          child.type = 'integer';
        }
        expiration(child);
      }
      for (const part of [...(s.oneOf || []), ...(s.anyOf || []), ...(s.allOf || [])]) expiration(part);
    }
    expiration(schema.properties?.body);
  }
  // The SDK accepts a nullable string description and a non-exclusive attack
  // mode union. Keep the other request constraints from the source spec.
  // https://github.com/vercel/sdk/blob/main/src/models/patchedgeconfigitemsop.ts
  // https://github.com/vercel/sdk/blob/main/src/models/updateattackchallengemodeop.ts
  if (vendor === 'vercel' && operation === 'patchEdgeConfigItems') {
    const item = schema.properties?.body?.properties?.items?.items;
    for (const branch of item?.oneOf || item?.anyOf || [item]) {
      const description = branch?.properties?.description;
      if (description?.oneOf) {
        const text = description.oneOf.find(x => x.type === 'string');
        delete description.oneOf;
        Object.assign(description, text);
      }
    }
  }
  if (vendor === 'vercel' && operation === 'updateAttackChallengeMode' && schema.properties?.body?.oneOf) {
    schema.properties.body.anyOf = schema.properties.body.oneOf;
    delete schema.properties.body.oneOf;
  }
}
module.exports = { applySchemaOverrides };
