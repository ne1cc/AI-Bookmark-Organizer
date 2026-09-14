// Shared identity for schema validation, classification and reconciliation.
// Independent batches vary casing, whitespace and trailing singular/plural s.
export function canonicalKey(name) {
    return name
        .trim()
        .toLowerCase()
        .replace(/\s+/g, ' ')
        .replace(/s$/, '');
}
