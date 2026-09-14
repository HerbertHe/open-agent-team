# Quick Start

This guide helps you get started with Zvec vector database quickly.

## Installation

```bash
pip install zvec
```

## Initialize Zvec (Optional)

Before using Zvec, you can optionally configure global settings. If omitted, Zvec automatically applies sensible defaults.

```python
import zvec

# Initialize with defaults
zvec.init()

# Or customize settings
zvec.init(
    log_type=zvec.LogType.CONSOLE,
    log_level=zvec.LogLevel.INFO,
    query_threads=4,
)
```

**Note:** `init()` must be called before any other operations and can only be called once.

## Create Your First Collection

A collection is a named container for documents in Zvec, similar to a table in a relational database.

```python
import zvec

# Define the schema
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

# Create and open the collection
collection = zvec.create_and_open("./my_data", schema)
```

## Insert Data

Documents are the basic unit of data storage in Zvec. Each document has:
- `id`: A unique string identifier
- `vectors`: Named vector embeddings
- `fields`: Named scalar fields

```python
# Insert a single document
doc = zvec.Doc(
    id="doc_1",
    vectors={"embedding": [0.1] * 768},
    fields={"title": "Hello World", "category": "example"},
)
collection.upsert(doc)

# Insert multiple documents (batch)
docs = [
    zvec.Doc(id="doc_2", vectors={"embedding": [0.2] * 768}, fields={"title": "Doc 2", "category": "example"}),
    zvec.Doc(id="doc_3", vectors={"embedding": [0.3] * 768}, fields={"title": "Doc 3", "category": "demo"}),
]
collection.upsert(docs)
```

## Perform Search

Zvec provides powerful vector search capabilities. You can search by vector similarity:

```python
# Search by vector similarity
results = collection.query(
    vectors=zvec.VectorQuery(
        field_name="embedding",
        vector=[0.1] * 768,
    ),
    topk=10,
)

# Print results
for result in results:
    print(f"ID: {result.id}, Score: {result.score}")
    print(f"Title: {result.fields.get('title')}")
```

## Next Steps

- Learn [Collection Management](./collection-management/python.md)
- Understand [Data Operations](./data-operations/python.md)
- Explore [Vector Search](./vector-search/python.md)
