"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.detectResourceStorage = detectResourceStorage;
function toLikelyTableName(resource) {
    if (!resource)
        return resource;
    if (resource.endsWith("s"))
        return resource;
    return `${resource}s`;
}
function detectResourceStorage(input) {
    const { parentResource, nestedResource, files, schema } = input;
    const evidence = [];
    if (schema && nestedResource) {
        const exactTable = `${parentResource}_${nestedResource}`;
        if (schema.tables.includes(exactTable)) {
            evidence.push(`Found table ${exactTable} in schema.`);
            return {
                parentResource,
                nestedResource,
                storageKind: "separate_table",
                tableName: exactTable,
                parentTableName: toLikelyTableName(parentResource), evidence
            };
        }
        const parentTable = toLikelyTableName(parentResource);
        const possibleJsonColumn = nestedResource;
        const jsonLikeColumn = schema.columns.find((col) => col.tableName === parentTable &&
            col.columnName === possibleJsonColumn &&
            ["json", "jsonb"].includes(col.dataType.toLowerCase()));
        if (jsonLikeColumn) {
            evidence.push(`Found JSON column ${parentTable}.${possibleJsonColumn}`);
            return {
                parentResource,
                nestedResource,
                storageKind: "json_field",
                parentTableName: parentTable,
                jsonFieldName: possibleJsonColumn,
                evidence
            };
        }
    }
    for (const file of files) {
        if (nestedResource &&
            new RegExp(`from\\(["'\`]${parentResource}_${nestedResource}["'\`]\\)`).test(file.content)) {
            evidence.push(`Detected table usage ${parentResource}_${nestedResource} in ${file.path}`);
            return {
                parentResource,
                nestedResource,
                storageKind: "separate_table",
                tableName: `${parentResource}_${nestedResource}`,
                parentTableName: `${parentResource}s`,
                evidence
            };
        }
        if (nestedResource &&
            new RegExp(`${nestedResource}\\s*:`).test(file.content) &&
            /update\(|upsert\(/.test(file.content)) {
            evidence.push(`Detected possible JSON field update for ${nestedResource} in ${file.path}`);
            return {
                parentResource,
                nestedResource,
                storageKind: "json_field",
                parentTableName: `${parentResource}s`,
                jsonFieldName: nestedResource,
                evidence
            };
        }
    }
    evidence.push("Could not confidently determine storage type.");
    return {
        parentResource,
        nestedResource,
        storageKind: "unknown",
        evidence
    };
}
//# sourceMappingURL=detectResourceStorage.js.map