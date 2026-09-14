# Data Operations

Zvec provides a complete set of data manipulation operations to manage documents in your collection.

| Operation | Purpose |
|-----------|---------|
| **Insert** | Add new documents (fails if the document ID already exists) |
| **Upsert** | Insert new documents or replace existing ones by ID |
| **Update** | Modify specific fields of existing documents by ID |
| **Delete** | Delete documents by ID or using a scalar filter condition |
| **Query** | Perform vector similarity search, optionally combined with scalar filtering |
| **Fetch** | Retrieve full documents directly by ID |

All write operations (insert, upsert, update, delete) are immediately visible for querying — enabling true real-time, streaming workloads.

## Insert Documents

Use the `insertSync()` method to add one or more new documents to a collection.

**Key Points:**
- The document ID must be unique (not already present in the collection)
- If a document with the same ID already exists, the insertion will fail for that document
- To overwrite existing documents, use `upsertSync()` instead

### Document Structure

Each document must have:
- A unique `id` (string)
- Vector embeddings under `vectors` (vector names as keys)
- Scalar fields under `fields` (scalar field names as keys)

### Single Document Insert

```typescript
const doc = {
  id: "doc_1",  // Must be unique
  vectors: { embedding: [0.1, 0.2, 0.3, 0.4] },  // Must match vector name and dimension
  fields: { title: "This is a sample text." },  // Must match scalar field name
};
const result = collection.insertSync(doc);
console.log(result);  // { ok: true } means success
```

The `insertSync()` method validates the document first:
- Incorrect usage (unknown field or wrong vector dimension) raises an exception
- Returns a Status object: `{ ok: true }` indicates success

### Batch Insert

To insert multiple documents at once, pass an array of document objects:

```typescript
const docs = [
  {
    id: "doc_1",
    vectors: { embedding: [0.1, 0.2, 0.3, 0.4] },
    fields: { title: "Doc 1" },
  },
  {
    id: "doc_2",
    vectors: { embedding: [0.4, 0.3, 0.2, 0.1] },
    fields: { title: "Doc 2" },
  },
  {
    id: "doc_3",
    vectors: { embedding: [-0.1, -0.2, -0.3, -0.4] },
    fields: { title: "Doc 3" },
  },
];
const results = collection.insertSync(docs);
console.log(results);  // [{ ok: true }, { ok: true }, { ok: true }]
```

Each document is processed independently. A failure in one (e.g., duplicate ID) does not stop others from being inserted. Always check each Status in the result list.

### Sparse Vector Insert

Insert a document with a sparse vector:

```typescript
const doc = {
  id: "doc_sparse",
  vectors: {
    sparse_vec: {
      42: 1.25,    // Dimension 42 has weight 1.25
      1337: 0.8,   // Dimension 1337 has weight 0.8
      2999: 0.63,  // Dimension 2999 has weight 0.63
    },
  },
};
const result = collection.insertSync(doc);
console.log(result);  // { ok: true }
```

A sparse vector is represented as a mapping from dimension indices (integers) to values (floats). There is no fixed dimension size — only non-zero dimensions need to be included.

### Insert with Multiple Fields and Vectors

Real-world applications often require collections with multiple scalar fields and vector embeddings:

```typescript
const doc = {
  id: "book_1",
  vectors: {
    dense_embedding: new Array(768).fill(0.1),  // Use real embedding in practice
    sparse_embedding: { 42: 1.25, 1337: 0.8, 1999: 0.64 },
  },
  fields: {
    book_title: "Gone with the Wind",  // String
    category: ["Romance", "Classic Literature"],  // Array of strings
    publish_year: 1936,  // Integer
  },
};
const result = collection.insertSync(doc);
console.log(result);  // { ok: true } means success
```

**Performance Tip:** New vectors are initially buffered for fast ingestion. For optimal search performance, call `optimizeSync()` after inserting a large batch of documents.

## Upsert Operation

`upsertSync()` works similar to `insertSync()` — it adds one or more new documents to a collection. The key difference is that if a document with the same ID already exists, it will be overwritten.

- Use `upsertSync()` if you want to overwrite an existing document (or don't mind replacing it)
- Use `insertSync()` if you want to avoid accidentally overwriting a document

### Single Document Upsert

```typescript
const doc = {
  id: "doc_1",  // If exists, will be overwritten
  vectors: { embedding: [0.1, 0.2, 0.3, 0.4] },
  fields: { title: "This is a sample text." },
};
const result = collection.upsertSync(doc);
console.log(result);  // { ok: true } means success
```

### Batch Upsert

```typescript
const docs = [
  {
    id: "doc_1",
    vectors: { embedding: [0.1, 0.2, 0.3, 0.4] },
    fields: { title: "Doc 1" },
  },
  {
    id: "doc_2",
    vectors: { embedding: [0.4, 0.3, 0.2, 0.1] },
    fields: { title: "Doc 2" },
  },
];
const results = collection.upsertSync(docs);
console.log(results);  // [{ ok: true }, { ok: true }]
```

### Upsert with Sparse Vectors

```typescript
const doc = {
  id: "doc_sparse",
  vectors: {
    sparse_vec: {
      42: 1.25,
      1337: 0.8,
      2999: 0.63,
    },
  },
};
const result = collection.upsertSync(doc);
console.log(result);  // { ok: true }
```

### Upsert with Multiple Fields and Vectors

```typescript
const doc = {
  id: "book_1",
  vectors: {
    dense_embedding: new Array(768).fill(0.1),
    sparse_embedding: { 42: 1.25, 1337: 0.8, 1999: 0.64 },
  },
  fields: {
    book_title: "Gone with the Wind",
    category: ["Romance", "Classic Literature"],
    publish_year: 1936,
  },
};
const result = collection.upsertSync(doc);
console.log(result);  // { ok: true } means success
```

**Performance Tip:** New vectors are initially buffered for fast ingestion. For optimal search performance, call `optimizeSync()` after upserting a large batch of documents.

## Fetch Documents

Use `fetchSync()` to retrieve documents by their IDs. This is a direct lookup — no search, scoring, or filtering is involved.

### Fetch by Single ID

```typescript
const result = collection.fetchSync("doc_1");
console.log(result);  // { "doc_1": Doc(...) }
```

### Fetch by Multiple IDs

```typescript
const result = collection.fetchSync(["doc_1", "doc_2", "doc_3"]);
console.log(result);  // { "doc_1": Doc(...), "doc_2": Doc(...), "doc_3": Doc(...) }
```

**Notes:**
- Input: A single document ID or an array of document IDs
- Output: A mapping from each found ID to its corresponding document object
- Missing IDs are silently omitted from the result (no error raised)
- The returned object does not guarantee input order — access documents by ID instead

## Query Documents

The `querySync()` method supports vector similarity search, conditional filtering (like a SQL WHERE clause), or both combined in a hybrid query. It returns an array of document objects, each containing the matched document and its relevance score.

### Vector Search

```typescript
const results = collection.querySync({
  vectors: [{
    fieldName: "embedding",
    vector: new Array(768).fill(0.1),  // Use real embedding in practice
  }],
  topk: 10,
});
```

### Filter Query (Conditional Filtering)

```typescript
const results = collection.querySync({
  filter: "publish_year < 1999",
  topk: 50,
});
```

### Hybrid Search (Vector + Filter)

```typescript
const results = collection.querySync({
  vectors: [{
    fieldName: "embedding",
    vector: new Array(768).fill(0.1),
  }],
  filter: "publish_year < 1999",
  topk: 10,
});
```

### Multi-Vector Search

```typescript
const results = collection.querySync({
  topk: 10,
  vectors: [
    { fieldName: "dense_embedding", vector: new Array(768).fill(0.1) },
    { fieldName: "sparse_embedding", vector: { 1: 0.1, 37: 0.43 } },
  ],
  reranker: {
    type: "weighted",
    topn: 3,
    metric: ZVecMetricType.IP,
    weights: {
      dense_embedding: 1.2,
      sparse_embedding: 1.0,
    },
  },
});
```

## Update Documents

Use `updateSync()` to modify existing documents. Only the scalar fields and vector embeddings you include will be updated; all other content remains unchanged.

### Update a Single Document

```typescript
const doc = {
  id: "book_1",  // Must already exist in the collection
  vectors: {
    sparse_embedding: {  // Replaces entire sparse vector
      35: 0.25,
      237: 0.1,
      369: 0.44,
    },
  },
  fields: {
    category: [  // Replaces current category list
      "Romance",
      "Classic Literature",
      "American Civil War",
    ],
  },
  // Note: Other fields omitted stay as-is
};
const result = collection.updateSync(doc);
console.log(result);  // { ok: true } means success
```

### Update a Batch of Documents

```typescript
const docs = [
  {
    id: "book_1",
    vectors: { sparse_embedding: { 35: 0.25, 237: 0.1, 369: 0.44 } },
    fields: { category: ["Romance", "Classic Literature", "American Civil War"] },
  },
  {
    id: "book_2",
    fields: { book_title: "The Great Gatsby" },
  },
  {
    id: "book_3",
    fields: { book_title: "A Tale of Two Cities", publish_year: 1859 },
  },
];
const results = collection.updateSync(docs);
console.log(results);  // [{ ok: true }, { ok: true }, { ok: true }]
```

Each document is processed independently. A failure in one (e.g., the ID doesn't exist) does not stop others from being updated. Always check each Status in the result list.

## Delete Documents

Zvec provides two ways to delete documents:

| Method | Input | When to Use |
|--------|-------|-------------|
| `deleteSync()` | One or more document IDs | Use when you know the exact ID(s) of the documents you want to delete |
| `deleteByFilterSync()` | A filter expression | Use for bulk deletion based on field values |

Delete operations are immediate and irreversible. Always double-check your input before running a delete operation.

### Delete by ID

Delete a single document:

```typescript
const result = collection.deleteSync({ ids: "doc_1" });
console.log(result);  // { ok: true } means success
```

Delete multiple documents at once:

```typescript
const result = collection.deleteSync({ ids: ["doc_1", "doc_2", "doc_3"] });
console.log(result);  // [{ ok: true }, { ok: true }, { ok: true }]
```

### Delete by Filter Condition

Use `deleteByFilterSync()` to remove all documents that match a boolean filter expression:

```typescript
// Delete all books published before 1900
collection.deleteByFilterSync({ filter: "publish_year < 1900" });

// Combined filter
collection.deleteByFilterSync({
  filter: 'publish_year < 1900 AND (language = "English" OR language = "Chinese")',
});
```
