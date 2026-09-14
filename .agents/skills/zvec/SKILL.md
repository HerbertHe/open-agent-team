---
name: zvec
description: |
  Zvec vector database development assistant. Use this skill when users need to develop vector search applications based on zvec,
  build RAG systems, implement semantic search, or handle vector data storage and querying.
  Suitable for Python and Node.js development environments, providing complete technical guidance from basic concepts to advanced usage.
  Proactively use this skill when users mention vector databases, similarity search, embedding storage, HNSW/IVF indexes,
  hybrid search, multi-vector queries, or zvec API usage.
---

## Usage Instructions

### Before starting, understand the following:

1. **Development Language**: Python or Node.js?
   - Python: use `pip install zvec`
   - Node.js: use `npm install @zvec/zvec`

2. **Use Cases**:
   - RAG document retrieval system
   - Semantic search
   - Multimodal search (image + text)
   - Hybrid search (keywords + semantic)

3. **Data Scale**:
   - < 100k: use FLAT index (exact search)
   - 100k-10M: use HNSW index (recommended default)
   - > 10M: use IVF index (memory optimized)

### Decision Workflow

- User needs vector search functionality
  - Choose development language (Python/Node.js)
  - Determine use case
    - RAG system → use single-vector search + document chunk management
    - E-commerce search → use hybrid search (vector + filter)
    - Multimodal → use multi-vector search + weighted ranking
  - Design Schema (vector fields + scalar fields)
  - Select index type (HNSW/FLAT/IVF)
  - Implement data synchronization strategy

### Default Recommendations

- Use `create_and_open()` / `ZVecCreateAndOpen()` to create Collection
- Use cosine similarity (COSINE) as default distance metric
- Use FP32 type for dense vectors
- Create `InvertIndexParam` index for filter fields

### Validation Checklist

- Vector dimensions match Schema definition
- Scalar field types are correct
- Filter condition syntax is correct
- Call `optimize()` after large batch writes

## Quick Start

**Python:**

```python
import zvec

# Create Collection
schema = zvec.CollectionSchema(
    name="my_collection",
    fields=[
        zvec.FieldSchema(name="title", data_type=zvec.DataType.STRING),
    ],
    vectors=[
        zvec.VectorSchema(
            name="embedding",
            data_type=zvec.DataType.VECTOR_FP32,
            dimension=768,
            index_param=zvec.HnswIndexParam(
                metric_type=zvec.MetricType.COSINE
            ),
        ),
    ],
)

collection = zvec.create_and_open("./my_data", schema)

# Insert document
collection.upsert(zvec.Doc(
    id="doc_1",
    vectors={"embedding": [0.1] * 768},
    fields={"title": "Hello World"},
))

# Search
results = collection.query(
    vectors=zvec.VectorQuery(
        field_name="embedding",
        vector=[0.1] * 768,
    ),
    topk=10,
)
```

**Node.js:**

```typescript
import { ZVecCreateAndOpen, ZVecCollectionSchema, ZVecFieldSchema, ZVecVectorSchema, ZVecDataType, ZVecHnswIndexParams, ZVecMetricType } from "@zvec/zvec";

const schema = new ZVecCollectionSchema({
  name: "my_collection",
  fields: [new ZVecFieldSchema({ name: "title", dataType: ZVecDataType.STRING })],
  vectors: [new ZVecVectorSchema({
    name: "embedding",
    dataType: ZVecDataType.VECTOR_FP32,
    dimension: 768,
    indexParams: new ZVecHnswIndexParams({ metricType: ZVecMetricType.COSINE }),
  })],
});

const collection = ZVecCreateAndOpen("./my_data", schema);
```

## Core Concepts

### Data Model

**Collection**
- Similar to a table in relational databases, a container for storing, organizing, and querying data
- Each Collection has a Schema defining its structure
- Each Collection is independently persisted in a dedicated directory on disk

**Document**
- Basic unit of data storage, similar to a row in a relational table
- Contains three core components:
  - `id`: unique string identifier
  - `vectors`: named vector collection (supports dense and sparse vectors)
  - `fields`: named scalar field collection

**Schema**
- Dynamic Schema: scalar fields and vectors can be added or removed at any time
- Strong type system: each field must declare a DataType

### Vector Types

**Dense Vector**
- Fixed-length real-valued embeddings
- Types: `VECTOR_FP16`, `VECTOR_FP32`, `VECTOR_INT8`
- Suitable for: semantic understanding, context capture

**Sparse Vector**
- High-dimensional representation with only a few non-zero dimensions
- Types: `SPARSE_VECTOR_FP32`, `SPARSE_VECTOR_FP16`
- Suitable for: keyword matching, BM25 scoring

### Index Types

| Index Type | Characteristics | Use Case |
|---------|------|---------|
| **FLAT** | Brute force search, exact results | Small scale data (<100k) |
| **HNSW** | Approximate nearest neighbor, graph structure | Large scale data (recommended default) |
| **IVF** | Inverted file index | Very large scale data |

## Available Topics

### Python

- [Quick Start](./quick-start/python.md) - Quick start with Zvec Python API
- [Collection Management](./collection-management/python.md) - Create, open, and manage Collections
- [Data Operations](./data-operations/python.md) - Insert, update, and delete documents
- [Vector Search](./vector-search/python.md) - Single-vector, multi-vector, and hybrid search
- [RAG System](./rag-system/python.md) - Build document retrieval system
- [Hybrid Search](./hybrid-search/python.md) - Vector similarity + scalar filtering
- [Multimodal Search](./multimodal-search/python.md) - Image + text joint search

### Node.js

- [Quick Start](./quick-start/typescript.md) - Quick start with Zvec Node.js API
- [Collection Management](./collection-management/typescript.md) - Create, open, and manage Collections
- [Data Operations](./data-operations/typescript.md) - Insert, update, and delete documents
- [Vector Search](./vector-search/typescript.md) - Single-vector, multi-vector, and hybrid search
- [RAG System](./rag-system/typescript.md) - Build document retrieval system
- [Hybrid Search](./hybrid-search/typescript.md) - Vector similarity + scalar filtering
- [Multimodal Search](./multimodal-search/typescript.md) - Image + text joint search

### General

- [Configuration](./configuration.md) - Global configuration and initialization
- [Data Model](./data-model.md) - Zvec data model overview
- [Embedding](./embedding.md) - Text embedding functions (Python only)
- [Reranker](./reranker.md) - Result reranking functions (Python only)
- [API Cheatsheet](./api-cheatsheet.md) - Python & Node.js API quick reference
- [Troubleshooting](./troubleshooting.md) - Common issues and solutions

## Available Topics

### Python

- [Collection Management](./collection-management/python.md)
- [Data Operations](./data-operations/python.md)
- [Hybrid Search](./hybrid-search/python.md)
- [Multimodal Search](./multimodal-search/python.md)
- [Quick Start](./quick-start/python.md)
- [Rag System](./rag-system/python.md)
- [Vector Search](./vector-search/python.md)

### Node.js

- [Collection Management](./collection-management/typescript.md)
- [Data Operations](./data-operations/typescript.md)
- [Hybrid Search](./hybrid-search/typescript.md)
- [Multimodal Search](./multimodal-search/typescript.md)
- [Quick Start](./quick-start/typescript.md)
- [Rag System](./rag-system/typescript.md)
- [Vector Search](./vector-search/typescript.md)

### General

- [Configuration](./configuration.md)
- [Data Model](./data-model.md)
- [Embedding](./embedding.md)
- [Reranker](./reranker.md)
- [Api Cheatsheet](./api-cheatsheet.md)
- [Troubleshooting](./troubleshooting.md)
