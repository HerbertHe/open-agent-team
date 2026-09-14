# Quick Start

This guide helps you get started with Zvec vector database quickly.

## Installation

```bash
npm install @zvec/zvec
```

## Initialize Zvec (Optional)

Before using Zvec, you can optionally configure global settings. If omitted, Zvec automatically applies sensible defaults.

```typescript
import { ZVecInitialize, ZVecLogType, ZVecLogLevel } from "@zvec/zvec";

// Initialize with defaults
ZVecInitialize();

// Or customize settings
ZVecInitialize({
  logType: ZVecLogType.CONSOLE,
  logLevel: ZVecLogLevel.INFO,
  queryThreads: 4,
});
```

**Note:** `ZVecInitialize()` must be called before any other operations and can only be called once.

## Create Your First Collection

A collection is a named container for documents in Zvec, similar to a table in a relational database.

```typescript
import { ZVecCreateAndOpen, ZVecCollectionSchema, ZVecFieldSchema, ZVecVectorSchema, ZVecDataType, ZVecHnswIndexParams, ZVecMetricType } from "@zvec/zvec";

// Define the schema
const schema = new ZVecCollectionSchema({
  name: "my_collection",
  fields: [
    new ZVecFieldSchema({ name: "title", dataType: ZVecDataType.STRING }),
    new ZVecFieldSchema({ name: "category", dataType: ZVecDataType.STRING }),
  ],
  vectors: [
    new ZVecVectorSchema({
      name: "embedding",
      dataType: ZVecDataType.VECTOR_FP32,
      dimension: 768,
      indexParams: new ZVecHnswIndexParams({
        metricType: ZVecMetricType.COSINE,
        M: 16,
        efConstruction: 100,
      }),
    }),
  ],
});

// Create and open the collection
const collection = ZVecCreateAndOpen("./my_data", schema);
```

## Insert Data

Documents are the basic unit of data storage in Zvec. Each document has:
- `id`: A unique string identifier
- `vectors`: Named vector embeddings
- `fields`: Named scalar fields

```typescript
// Insert a single document
const doc = {
  id: "doc_1",
  vectors: { embedding: new Array(768).fill(0.1) },
  fields: { title: "Hello World", category: "example" },
};
collection.upsertSync(doc);

// Insert multiple documents (batch)
const docs = [
  { id: "doc_2", vectors: { embedding: new Array(768).fill(0.2) }, fields: { title: "Doc 2", category: "example" } },
  { id: "doc_3", vectors: { embedding: new Array(768).fill(0.3) }, fields: { title: "Doc 3", category: "demo" } },
];
collection.upsertSync(docs);
```

## Perform Search

Zvec provides powerful vector search capabilities. You can search by vector similarity:

```typescript
// Search by vector similarity
const results = collection.querySync({
  vectors: [{
    fieldName: "embedding",
    vector: new Array(768).fill(0.1),
  }],
  topk: 10,
});

// Print results
results.forEach(result => {
  console.log(`ID: ${result.id}, Score: ${result.score}`);
  console.log(`Title: ${result.fields?.title}`);
});
```

## Next Steps

- Learn [Collection Management](./collection-management/typescript.md)
- Understand [Data Operations](./data-operations/typescript.md)
- Explore [Vector Search](./vector-search/typescript.md)
