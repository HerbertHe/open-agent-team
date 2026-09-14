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

Each field is defined using `FieldSchema` with the following properties:
- `name`: A unique string identifier for the field within the collection
- `data_type`: The type of data stored — e.g., `STRING`, `INT64`, or array types like `ARRAY_STRING`
- `nullable` (optional): Whether the field is allowed to have no value (defaults to `False`)
- `index_param` (optional): Enables fast filtering by creating an inverted index via `InvertIndexParam`

#### Vectors (Embeddings)

A vector is defined using `VectorSchema` with the following properties:
- `name`: A unique string identifier for the vector within the collection
- `data_type`: The numeric format of the vector
  - Dense vectors: `VECTOR_FP32`, `VECTOR_FP16`, etc.
  - Sparse vectors: `SPARSE_VECTOR_FP32`, `SPARSE_VECTOR_FP16`
- `dimension`: Required for dense vectors — the number of dimensions
- `index_param`: Configures the vector index type and similarity metric

**Choosing Vector Index Type:**
- `metric_type`: `COSINE`, `L2`, or `IP` (inner product) — Ensure your metric matches how your embeddings were trained!
- `quantize_type` (optional): Compress vectors to reduce index size and speed up search (with slight recall trade-off)

### Create Collection Example

```python
schema = zvec.CollectionSchema(
    name="my_collection",
    fields=[
        zvec.FieldSchema(name="title", data_type=zvec.DataType.STRING),
        zvec.FieldSchema(name="category", data_type=zvec.DataType.STRING),
    ],
    vectors=[
        zvec.VectorSchema(
            name="embedding",
            data_type=zvec.DataType.VECTOR_FP32,
            dimension=768,
            index_param=zvec.HnswIndexParam(
                metric_type=zvec.MetricType.COSINE,
                M=16,
                ef_construction=100,
            ),
        ),
    ],
)

# Configure collection options (optional)
collection_option = zvec.CollectionOption(read_only=False, enable_mmap=True)

# Create and open the collection
collection = zvec.create_and_open("./my_data", schema, option=collection_option)
```

**Note:** If a collection already exists at the specified path, `create_and_open()` will raise an error to prevent accidental overwrites.

### Collection Options

The `CollectionOption` lets you control runtime behavior when creating the collection:
- `read_only`: Opens the collection in read-only mode. Attempts to write will raise an error.
  - Note: `read_only` must be set to `False` when calling `create_and_open()`, since creation requires writing files to disk.
- `enable_mmap`: Uses memory-mapped I/O for faster access (defaults to `True`). This trades slightly higher memory cache usage for improved performance.

## Open Existing Collection

To open an existing collection, use the `open()` function to load it from disk.

```python
collection = zvec.open(
    path="./my_data",
    option=zvec.CollectionOption(read_only=False, enable_mmap=True),
)
```

**Parameters:**
- `path`: The filesystem path to the collection directory
- `option`: Runtime settings that control how the collection is accessed
  - `read_only`: Opens the collection in read-only mode. Use read-only mode when sharing a collection across multiple processes — it ensures safe concurrent access without risking data corruption.
  - `enable_mmap`: Uses memory-mapped I/O for faster access (defaults to `True`)

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

```python
print(collection.schema)

# View only scalar fields
print(collection.schema.fields)

# View only vector fields
print(collection.schema.vectors)
```

### View Statistics

The `stats` property provides real-time operational insights:

```python
print(collection.stats)
```

## Schema Modifications

Zvec supports dynamic schema evolution, allowing you to modify a collection's structure after it has been created — without downtime, data re-ingestion, or reindexing.

You can:
- Add or drop scalar fields
- Rename fields or change their data types (as long as the change is safe — e.g., from INT32 to INT64)
- Create or drop indexes on fields

### Add Column

To add a new scalar field to an existing collection, use `add_column()`:

```python
collection.add_column(
    field=zvec.FieldSchema(
        name="rating",
        data_type=zvec.DataType.INT32,
    ),
    expression="5"  # Default value for existing documents
)
```

- `field`: Defines the name and data type of the new field
- `expression`: Specifies the default value for existing documents. Currently, only numerical scalar fields can be added via `add_column()`. The expression must evaluate to a number.

### Drop Column

To permanently remove a scalar field, use `drop_column()`:

```python
collection.drop_column("old_field")
```

This deletes the field and all its data from every document in the collection. The operation is irreversible.

### Alter Column

To rename a column or update its schema, use `alter_column()`:

```python
# Rename
collection.alter_column(old_name="publish_year", new_name="release_year")

# Change type (if compatible)
updated = zvec.FieldSchema(name="rating", data_type=zvec.DataType.FLOAT)
collection.alter_column(field_schema=updated)
```

## Index Management

### Create Index

```python
collection.create_index(
    field_name="category",
    index_param=zvec.InvertIndexParam(),
)
```

### Drop Index

```python
collection.drop_index("category")
```

## Maintenance Operations

### Optimize Collection

The `optimize()` method improves search performance by building the configured vector index from vectors accumulated in a temporary flat buffer. It runs in the background and does not block reads or writes.

**Why Optimization is Needed:**

In Zvec, newly inserted vectors are not added directly to the configured vector index. Instead, they are first appended to a lightweight flat (brute-force) index buffer. This enables high-speed data ingestion but can degrade search performance over time as the flat buffer grows.

Call `optimize()` periodically to merge the buffered vectors into the configured vector index.

```python
# Insert some documents
for i in range(1000):
    doc = zvec.Doc(id=f"doc_{i}", vectors={"embedding": [i + 0.1, i + 0.2, i + 0.3]})
    collection.insert(doc)

# Optimize the collection
collection.optimize()
```

**When to Call `optimize()`:**

Optimize regularly — but not too often:
- Too infrequent → Flat buffers grow large, degrading search performance
- Too frequent → Wastes resources optimizing small batches prematurely

As a general guideline, consider optimizing when you have 100,000+ unindexed documents.

### Flush Collection

```python
collection.flush()
```

Flushes all pending writes to disk for durability.

## Delete Collection

Destroying a collection permanently deletes it from disk. This operation cannot be undone.

**Warning:** All data in the collection will be lost. Ensure you no longer need the collection or have created a backup before calling `destroy()`.

```python
collection.destroy()
```

After calling `destroy()`, the collection directory and its contents are removed from the filesystem. Do not use the collection object afterward — it is no longer valid.
