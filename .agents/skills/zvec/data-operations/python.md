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

Use the `insert()` method to add one or more new documents to a collection.

**Key Points:**
- The document ID must be unique (not already present in the collection)
- If a document with the same ID already exists, the insertion will fail for that document
- To overwrite existing documents, use `upsert()` instead

### Document Structure

Each `Doc` must have:
- A unique `id` (string)
- Vector embeddings under `vectors` (vector names as keys)
- Scalar fields under `fields` (scalar field names as keys)

### Single Document Insert

```python
doc = zvec.Doc(
    id="doc_1",  # Must be unique
    vectors={"embedding": [0.1, 0.2, 0.3, 0.4]},  # Must match vector name and dimension
    fields={"title": "This is a sample text."},  # Must match scalar field name
)
result = collection.insert(doc)
print(result)  # {"code": 0} means success
```

The `insert()` method validates the document first:
- Incorrect usage (unknown field or wrong vector dimension) raises an exception
- Returns a Status object: `{"code": 0}` indicates success, non-zero codes indicate failure

### Batch Insert

To insert multiple documents at once, pass a list of `Doc` objects:

```python
docs = [
    zvec.Doc(
        id="doc_1",
        vectors={"embedding": [0.1, 0.2, 0.3, 0.4]},
        fields={"title": "Doc 1"},
    ),
    zvec.Doc(
        id="doc_2",
        vectors={"embedding": [0.4, 0.3, 0.2, 0.1]},
        fields={"title": "Doc 2"},
    ),
    zvec.Doc(
        id="doc_3",
        vectors={"embedding": [-0.1, -0.2, -0.3, -0.4]},
        fields={"title": "Doc 3"},
    ),
]
results = collection.insert(docs)
print(results)  # [{"code": 0}, {"code": 0}, {"code": 0}]
```

Each document is processed independently. A failure in one (e.g., duplicate ID) does not stop others from being inserted. Always check each Status in the result list.

### Sparse Vector Insert

Insert a document with a sparse vector:

```python
doc = zvec.Doc(
    id="doc_sparse",
    vectors={
        "sparse_vec": {
            42: 1.25,    # Dimension 42 has weight 1.25
            1337: 0.8,   # Dimension 1337 has weight 0.8
            2999: 0.63,  # Dimension 2999 has weight 0.63
        }
    },
)
result = collection.insert(doc)
print(result)  # {"code": 0}
```

A sparse vector is represented as a mapping from dimension indices (integers) to values (floats). There is no fixed dimension size — only non-zero dimensions need to be included.

### Insert with Multiple Fields and Vectors

Real-world applications often require collections with multiple scalar fields and vector embeddings:

```python
doc = zvec.Doc(
    id="book_1",
    vectors={
        "dense_embedding": [0.1 for _ in range(768)],  # Use real embedding in practice
        "sparse_embedding": {42: 1.25, 1337: 0.8, 1999: 0.64},
    },
    fields={
        "book_title": "Gone with the Wind",  # String
        "category": ["Romance", "Classic Literature"],  # Array of strings
        "publish_year": 1936,  # Integer
    },
)
result = collection.insert(doc)
print(result)  # {"code": 0} means success
```

**Performance Tip:** New vectors are initially buffered for fast ingestion. For optimal search performance, call `optimize()` after inserting a large batch of documents.

## Upsert Operation

`upsert()` works similar to `insert()` — it adds one or more new documents to a collection. The key difference is that if a document with the same ID already exists, it will be overwritten.

- Use `upsert()` if you want to overwrite an existing document (or don't mind replacing it)
- Use `insert()` if you want to avoid accidentally overwriting a document

### Single Document Upsert

```python
doc = zvec.Doc(
    id="doc_1",  # If exists, will be overwritten
    vectors={"embedding": [0.1, 0.2, 0.3, 0.4]},
    fields={"title": "This is a sample text."},
)
result = collection.upsert(doc)
print(result)  # {"code": 0} means success
```

### Batch Upsert

```python
docs = [
    zvec.Doc(
        id="doc_1",
        vectors={"embedding": [0.1, 0.2, 0.3, 0.4]},
        fields={"title": "Doc 1"},
    ),
    zvec.Doc(
        id="doc_2",
        vectors={"embedding": [0.4, 0.3, 0.2, 0.1]},
        fields={"title": "Doc 2"},
    ),
]
results = collection.upsert(docs)
print(results)  # [{"code": 0}, {"code": 0}]
```

### Upsert with Sparse Vectors

```python
doc = zvec.Doc(
    id="doc_sparse",
    vectors={
        "sparse_vec": {
            42: 1.25,
            1337: 0.8,
            2999: 0.63,
        }
    },
)
result = collection.upsert(doc)
print(result)  # {"code": 0}
```

### Upsert with Multiple Fields and Vectors

```python
doc = zvec.Doc(
    id="book_1",
    vectors={
        "dense_embedding": [0.1 for _ in range(768)],
        "sparse_embedding": {42: 1.25, 1337: 0.8, 1999: 0.64},
    },
    fields={
        "book_title": "Gone with the Wind",
        "category": ["Romance", "Classic Literature"],
        "publish_year": 1936,
    },
)
result = collection.upsert(doc)
print(result)  # {"code": 0} means success
```

**Performance Tip:** New vectors are initially buffered for fast ingestion. For optimal search performance, call `optimize()` after upserting a large batch of documents.

## Fetch Documents

Use `fetch()` to retrieve documents by their IDs. This is a direct lookup — no search, scoring, or filtering is involved.

### Fetch by Single ID

```python
result = collection.fetch(ids="doc_1")
print(result)  # {"doc_1": Doc(...)}
```

### Fetch by Multiple IDs

```python
result = collection.fetch(ids=["doc_1", "doc_2", "doc_3"])
print(result)  # {"doc_1": Doc(...), "doc_2": Doc(...), "doc_3": Doc(...)}
```

**Notes:**
- Input: A single document ID or a list of document IDs
- Output: A mapping from each found ID to its corresponding document object
- Missing IDs are silently omitted from the result (no error raised)
- The returned dictionary does not guarantee input order — access documents by ID instead

## Query Documents

The `query()` method supports vector similarity search, conditional filtering (like a SQL WHERE clause), or both combined in a hybrid query. It returns a list of `Doc` objects, each containing the matched document and its relevance score.

### Vector Search

```python
results = collection.query(
    vectors=zvec.VectorQuery(
        field_name="embedding",
        vector=[0.1] * 768,  # Use real embedding in practice
    ),
    topk=10,
)
```

### Filter Query (Conditional Filtering)

```python
results = collection.query(
    filter="publish_year < 1999",
    topk=50,
)
```

### Hybrid Search (Vector + Filter)

```python
results = collection.query(
    vectors=zvec.VectorQuery(
        field_name="embedding",
        vector=[0.1] * 768,
    ),
    filter="publish_year < 1999",
    topk=10,
)
```

### Multi-Vector Search

```python
results = collection.query(
    topk=10,
    vectors=[
        zvec.VectorQuery(field_name="dense_embedding", vector=[0.1] * 768),
        zvec.VectorQuery(field_name="sparse_embedding", vector={1: 0.1, 37: 0.43}),
    ],
    reranker=zvec.WeightedReRanker(
        topn=3,
        metric=zvec.MetricType.IP,
        weights={
            "dense_embedding": 1.2,
            "sparse_embedding": 1.0,
        },
    ),
)
```

## Update Documents

Use `update()` to modify existing documents. Only the scalar fields and vector embeddings you include will be updated; all other content remains unchanged.

### Update a Single Document

```python
doc = zvec.Doc(
    id="book_1",  # Must already exist in the collection
    vectors={
        "sparse_embedding": {  # Replaces entire sparse vector
            35: 0.25,
            237: 0.1,
            369: 0.44,
        },
    },
    fields={
        "category": [  # Replaces current category list
            "Romance",
            "Classic Literature",
            "American Civil War",
        ],
    },
    # Note: Other fields omitted stay as-is
)
result = collection.update(doc)
print(result)  # {"code": 0} means success
```

### Update a Batch of Documents

```python
docs = [
    zvec.Doc(
        id="book_1",
        vectors={"sparse_embedding": {35: 0.25, 237: 0.1, 369: 0.44}},
        fields={"category": ["Romance", "Classic Literature", "American Civil War"]},
    ),
    zvec.Doc(
        id="book_2",
        fields={"book_title": "The Great Gatsby"},
    ),
    zvec.Doc(
        id="book_3",
        fields={"book_title": "A Tale of Two Cities", "publish_year": 1859},
    ),
]
results = collection.update(docs)
print(results)  # [{"code": 0}, {"code": 0}, {"code": 0}]
```

Each document is processed independently. A failure in one (e.g., the ID doesn't exist) does not stop others from being updated. Always check each Status in the result list.

## Delete Documents

Zvec provides two ways to delete documents:

| Method | Input | When to Use |
|--------|-------|-------------|
| `delete()` | One or more document IDs | Use when you know the exact ID(s) of the documents you want to delete |
| `delete_by_filter()` | A filter expression | Use for bulk deletion based on field values |

Delete operations are immediate and irreversible. Always double-check your input before running a delete operation.

### Delete by ID

Delete a single document:

```python
result = collection.delete(ids="doc_1")
print(result)  # {"code": 0} means success
```

Delete multiple documents at once:

```python
result = collection.delete(ids=["doc_1", "doc_2", "doc_3"])
print(result)  # [{"code": 0}, {"code": 0}, {"code": 0}]
```

### Delete by Filter Condition

Use `delete_by_filter()` to remove all documents that match a boolean filter expression:

```python
# Delete all books published before 1900
collection.delete_by_filter(filter="publish_year < 1900")

# Combined filter
collection.delete_by_filter(
    filter='publish_year < 1900 AND (language = "English" OR language = "Chinese")'
)
```
