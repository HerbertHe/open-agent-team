# Collection Management

Collection is the basic container for storing data in Zvec. Think of a collection as a table in a relational database: it's where you store, organize, and query your data.

## Create Collection

To create a new collection, you need to define:
- **Schema** — the structural blueprint of your data, specifying scalar fields and vector embeddings
- **Collection options** (optional) — runtime settings that control how the collection behaves when opened

### Define a Collection Schema

A collection schema defines the structure that every document inserted into the collection must conform to. The schema in Zvec is dynamic: you can add or remove scalar fields and vectors at any time without rebuilding the collection.

**CollectionSchema has three parts:**
1. `name`: An identifier for the collection
2. `fields`: A list of scalar fields
3. `vectors`: A list of vector fields

#### Scalar Fields

Scalar fields store non-vector (i.e., structured) data — such as strings, numbers, booleans, or arrays.

Each field is defined using `ZVecFieldSchema` with the following properties:
- `name`: A unique string identifier for the field within the collection
- `dataType`: The type of data stored — e.g., `STRING`, `INT64`, or array types like `ARRAY_STRING`
- `nullable` (optional): Whether the field is allowed to have no value (defaults to `false`)
- `indexParams` (optional): Enables fast filtering by creating an inverted index via `ZVecInvertIndexParams`

#### Vectors (Embeddings)

A vector is defined using `ZVecVectorSchema` with the following properties:
- `name`: A unique string identifier for the vector within the collection
- `dataType`: The numeric format of the vector
  - Dense vectors: `VECTOR_FP32`, `VECTOR_FP16`, etc.
  - Sparse vectors: `SPARSE_VECTOR_FP32`, `SPARSE_VECTOR_FP16`
- `dimension`: Required for dense vectors — the number of dimensions
- `indexParams`: Configures the vector index type and similarity metric

**Choosing Vector Index Type:**
- `metricType`: `COSINE`, `L2`, or `IP` (inner product) — Ensure your metric matches how your embeddings were trained!
- `quantizeType` (optional): Compress vectors to reduce index size and speed up search (with slight recall trade-off)

### Create Collection Example

```typescript
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

// Configure collection options (optional)
const collectionOption = new ZVecCollectionOption({ readOnly: false, enableMmap: true });

// Create and open the collection
const collection = ZVecCreateAndOpen("./my_data", schema, collectionOption);
```

**Note:** If a collection already exists at the specified path, `ZVecCreateAndOpen()` will raise an error to prevent accidental overwrites.

### Collection Options

The `ZVecCollectionOption` lets you control runtime behavior when creating the collection:
- `readOnly`: Opens the collection in read-only mode. Attempts to write will raise an error.
  - Note: `readOnly` must be set to `false` when calling `ZVecCreateAndOpen()`, since creation requires writing files to disk.
- `enableMmap`: Uses memory-mapped I/O for faster access (defaults to `true`). This trades slightly higher memory cache usage for improved performance.

## Open Existing Collection

To open an existing collection, use the `ZVecOpen()` function to load it from disk.

```typescript
const existingCollection = ZVecOpen(
  "./my_data",
  new ZVecCollectionOption({ readOnly: false, enableMmap: true })
);
```

**Parameters:**
- `path`: The filesystem path to the collection directory
- `option`: Runtime settings that control how the collection is accessed
  - `readOnly`: Opens the collection in read-only mode. Use read-only mode when sharing a collection across multiple processes — it ensures safe concurrent access without risking data corruption.
  - `enableMmap`: Uses memory-mapped I/O for faster access (defaults to `true`)

## View Collection Info

Once you've opened a collection, you can inspect its structure, configuration, and runtime state.

### Quick Reference

| Property | Description |
|----------|-------------|
| `collection.schema` | Collection structure and field definitions (e.g., vector dimensions, data types) |
| `collection.stats` | Runtime metrics such as document count and index completeness |
| `collection.option` | Runtime settings (e.g., read-only mode, memory mapping) |
| `collection.path` | Filesystem path to the collection directory |

### View Schema

```typescript
console.log(collection.schema);

// View only scalar fields
console.log(collection.schema.fields);

// View only vector fields
console.log(collection.schema.vectors);
```

### View Statistics

The `stats` property provides real-time operational insights:

```typescript
console.log(collection.stats);
```

## Schema Modifications

Zvec supports dynamic schema evolution, allowing you to modify a collection's structure after it has been created — without downtime, data re-ingestion, or reindexing.

You can:
- Add or drop scalar fields
- Rename fields or change their data types (as long as the change is safe — e.g., from INT32 to INT64)
- Create or drop indexes on fields

### Add Column

To add a new scalar field to an existing collection, use `addColumnSync()`:

```typescript
collection.addColumnSync({
  field: new ZVecFieldSchema({
    name: "rating",
    dataType: ZVecDataType.INT32,
  }),
  expression: "5"  // Default value for existing documents
});
```

- `field`: Defines the name and data type of the new field
- `expression`: Specifies the default value for existing documents. Currently, only numerical scalar fields can be added via `addColumnSync()`. The expression must evaluate to a number.

### Drop Column

To permanently remove a scalar field, use `dropColumnSync()`:

```typescript
collection.dropColumnSync("old_field");
```

This deletes the field and all its data from every document in the collection. The operation is irreversible.

### Alter Column

To rename a column or update its schema, use `alterColumnSync()`:

```typescript
// Rename
collection.alterColumnSync({ oldName: "publish_year", newName: "release_year" });

// Change type (if compatible)
collection.alterColumnSync({
  field: new ZVecFieldSchema({ name: "rating", dataType: ZVecDataType.FLOAT })
});
```

## Index Management

### Create Index

```typescript
collection.createIndexSync({
  fieldName: "category",
  indexParams: new ZVecInvertIndexParams(),
});
```

### Drop Index

```typescript
collection.dropIndexSync("category");
```

## Maintenance Operations

### Optimize Collection

The `optimizeSync()` method improves search performance by building the configured vector index from vectors accumulated in a temporary flat buffer. It runs in the background and does not block reads or writes.

**Why Optimization is Needed:**

In Zvec, newly inserted vectors are not added directly to the configured vector index. Instead, they are first appended to a lightweight flat (brute-force) index buffer. This enables high-speed data ingestion but can degrade search performance over time as the flat buffer grows.

Call `optimizeSync()` periodically to merge the buffered vectors into the configured vector index.

```typescript
// Insert some documents
for (let i = 0; i < 1000; i++) {
  const doc = {
    id: `doc_${i}`,
    vectors: { embedding: [i + 0.1, i + 0.2, i + 0.3] }
  };
  collection.upsertSync(doc);
}

// Optimize the collection
collection.optimizeSync();
```

**When to Call `optimizeSync()`:**

Optimize regularly — but not too often:
- Too infrequent → Flat buffers grow large, degrading search performance
- Too frequent → Wastes resources optimizing small batches prematurely

As a general guideline, consider optimizing when you have 100,000+ unindexed documents.

### Flush Collection

```typescript
collection.flushSync();
```

Flushes all pending writes to disk for durability.

## Delete Collection

Destroying a collection permanently deletes it from disk. This operation cannot be undone.

**Warning:** All data in the collection will be lost. Ensure you no longer need the collection or have created a backup before calling `destroySync()`.

```typescript
collection.destroySync();
```

After calling `destroySync()`, the collection directory and its contents are removed from the filesystem. Do not use the collection object afterward — it is no longer valid.
