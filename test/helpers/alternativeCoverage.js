'use strict';
const alternativeKey = node => JSON.stringify([node.path, node.alternatives]);
function missingAlternatives(expected, checked, failures) {
  return [...expected].filter(([key]) => !checked.has(key)).map(([key, entry]) =>
    failures.get(key) || { ...entry, error: 'Alternative did not complete an exact dry run' });
}
module.exports = { alternativeKey, missingAlternatives };
