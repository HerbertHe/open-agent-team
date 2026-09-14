# Zvec Data Model

## Overview

Zvec is an in-process vector database using a document-oriented data model. Core concepts include Collection, Document, and Schema.

## Collection

Collection is a container for storing, organizing, and querying data, similar to a table in relational databases.

### Characteristics

- Each Collection has an independent Schema defining its structure
- Each Collection is independently persisted in a dedicated directory on disk
- Cross-Collection queries (Join/Union) are not supported
- Can be created and deleted at any time

### Best Practices

- Create separate Collections for different business scenarios
- Partition Collections by data isolation requirements (e.g., by user, tenant)
- Collection names should be descriptive

## Document

Document is the basic unit of data storage, similar to a row in a relational table.

### Structure

```
Document
├── id: string (unique identifier)
├── vectors: { [name]: vector }
│   ├── dense vector: float[]
│   └── sparse vector: { [index]: float }
└── fields: { [name]: scalar }
    ├── string
    ├── bool
    ├── int32/64, uint32/64
    ├── float/double
    └── array types
```

### ID Rules

- Must be string type (integer IDs should be converted to strings, e.g., `"123"`)
- Unique within the Collection
- Cannot be changed after insertion
- Recommended formats:
  - Integer-based strings: `"1"`, `"2"`, `"10001"` (simple and efficient)
  - Prefixed strings: `"user_123"`, `"doc_456"` (semantic with integer ID)
  - UUID strings: `"550e8400-e29b-41d4-a716-446655440000"` (globally unique)

## Schema

Schema defines the structure of a Collection, including scalar fields and vector fields.

### Dynamic Schema

- Scalar fields can be added or removed at any time
- New vector fields can be added at any time
- Existing data automatically adapts to Schema changes

### Strong Type System

Each field must declare a DataType:

**Scalar Types:**
- `STRING`, `BOOL`
- `INT32`, `INT64`, `UINT32`, `UINT64`
- `FLOAT`, `DOUBLE`
- Array types: `ARRAY_STRING`, `ARRAY_BOOL`, `ARRAY_INT32`, etc.

**Vector Types:**
- `VECTOR_FP16`, `VECTOR_FP32`, `VECTOR_INT8` (dense vectors)
- `SPARSE_VECTOR_FP32`, `SPARSE_VECTOR_FP16` (sparse vectors)

## Vector Types in Detail

### Dense Vector

- Fixed-length real-valued embeddings
- Each dimension carries semantic information
- Example: `[0.012, -0.034, 0.005, ..., 0.018]` (384-dim)
- Suitable for: semantic understanding, context capture, similarity calculation

### Sparse Vector

- High-dimensional representation with only a few non-zero dimensions
- Example: `{42: 1.25, 1337: 0.8, 2999: 0.63}`
- Only stores non-zero dimensions, saving storage space
- Suitable for: keyword matching, BM25 scoring

## Index Types

### FLAT (Brute Force Search)

- Calculates distance between query vector and all document vectors
- Returns exact results
- Suitable for: small scale data (<100k), requiring 100% accuracy

### HNSW (Approximate Nearest Neighbor)

- Graph-based approximate search algorithm
- Balances speed and accuracy
- Suitable for: large scale data (recommended default)

**Key Parameters:**
- `M`: maximum connections per node (default 16, larger = higher accuracy)
- `efConstruction`: search depth during build (default 100)
- `ef`: search depth during query (larger = higher accuracy)

### IVF (Inverted File Index)

- Divides vector space into multiple clusters
- Only searches nearest clusters during query
- Suitable for: very large scale data, memory-constrained scenarios

**Key Parameters:**
- `nlist`: number of cluster centers
- `nprobe`: number of clusters to search during query

## Distance Metrics

- **COSINE**: Cosine similarity (most commonly used, suitable for semantic search)
- **IP**: Inner Product (suitable for sparse vectors)
- **L2**: Euclidean distance

## Data Persistence

- Collection data is persisted in the specified disk directory
- Supports flush to disk at any time
- Collection can be reopened after process restart

## Schema Evolution

Zvec supports dynamic schema evolution, allowing you to modify a collection's structure after it has been created — without downtime, data re-ingestion, or reindexing.

### Supported Operations

- **Add or drop scalar fields**: Add new fields to existing documents or remove unused fields
- **Rename fields**: Change field names while preserving data
- **Change data types**: Modify field types if the change is safe (e.g., INT32 to INT64)
- **Create or drop indexes**: Add or remove indexes on fields to optimize query performance

### DDL Operations

Schema changes in Zvec are performed using Data Definition Language (DDL) methods:

**Column DDL** — defines what data you store:
- `add_column()` / `addColumnSync()`: Add a new scalar field
- `drop_column()` / `dropColumnSync()`: Remove a scalar field
- `alter_column()` / `alterColumnSync()`: Rename or modify a field

**Index DDL** — defines how you search that data:
- `create_index()` / `createIndexSync()`: Create an index on a field
- `drop_index()` / `dropIndexSync()`: Remove an index from a scalar field

### Indexing Rules

- **Every vector field must be indexed** using an appropriate vector index (`HnswIndexParam`, `IVFIndexParam`, or `FlatIndexParam`) to enable similarity search
- **Scalar fields are optionally indexed** — but you should build inverted indexes (`InvertIndexParam`) on any scalar field you plan to use in filtering queries (e.g., `WHERE category = 'music'`)

### Best Practices

1. **Plan ahead**: Design your schema with future growth in mind
2. **Use meaningful names**: Field names should clearly describe the data they contain
3. **Index filter fields**: Create inverted indexes on fields used in filter conditions
4. **Test changes**: Validate schema changes in a development environment before applying to production
5. **Monitor performance**: After adding indexes, monitor query performance to ensure improvements
