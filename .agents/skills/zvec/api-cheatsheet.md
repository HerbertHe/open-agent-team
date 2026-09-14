# Zvec API Cheatsheet

## Python API

### Installation
```bash
pip install zvec
```

### Global Configuration
```python
import zvec

# Initialize with defaults
zvec.init()

# Initialize with custom settings
zvec.init(
    log_type=zvec.LogType.CONSOLE,      # or LogType.FILE
    log_level=zvec.LogLevel.WARN,       # DEBUG, INFO, WARN, ERROR, FATAL
    query_threads=4,
    optimize_threads=2,
    memory_limit_mb=2048,
)
```

### Core Classes
```python
import zvec
```

### Data Types

**Scalar Types:**
- `zvec.DataType.STRING`
- `zvec.DataType.BOOL`
- `zvec.DataType.INT32`, `INT64`, `UINT32`, `UINT64`
- `zvec.DataType.FLOAT`, `DOUBLE`
- Arrays: `ARRAY_STRING`, `ARRAY_BOOL`, `ARRAY_INT32`, etc.

**Vector Types:**
- `zvec.DataType.VECTOR_FP16`, `VECTOR_FP32`, `VECTOR_INT8`
- `zvec.DataType.SPARSE_VECTOR_FP32`, `SPARSE_VECTOR_FP16`

**Distance Metrics:**
- `zvec.MetricType.COSINE`
- `zvec.MetricType.IP`
- `zvec.MetricType.L2`

### Index Parameters

```python
# HNSW
zvec.HnswIndexParam(
    metric_type=zvec.MetricType.COSINE,
    M=16,
    ef_construction=100,
)

# FLAT
zvec.FlatIndexParam(metric_type=zvec.MetricType.COSINE)

# IVF
zvec.IVFIndexParam(
    metric_type=zvec.MetricType.COSINE,
    nlist=100,
    nprobe=10,
)

# Scalar index
zvec.InvertIndexParam(enable_range_optimization=True)
```

### Collection Operations

```python
# Create/Open
collection = zvec.create_and_open(path, schema, option)
collection = zvec.open(path, option)

# Properties
collection.path
collection.schema
collection.stats
collection.option

# Data Write
collection.insert(doc)
collection.insert([doc1, doc2])  # batch
collection.upsert(doc)
collection.update(ids, vectors, fields)

# Data Query
doc = collection.fetch(id)
results = collection.query(vectors, topk, filter)

# Data Delete
collection.delete(ids)
collection.delete_by_filter(filter)

# Schema Modify
collection.add_column(field, expression="default_value")
collection.drop_column(name)
collection.alter_column(old_name="old", new_name="new")
collection.alter_column(field_schema=updated_field)
collection.create_index(field_name, index_param)
collection.drop_index(field_name)

# Maintenance
collection.optimize()
collection.flush()
collection.destroy()
```

### Document Structure

```python
doc = zvec.Doc(
    id="unique_id",
    vectors={
        "dense_vec": [0.1, 0.2, ...],
        "sparse_vec": {42: 1.25, 1337: 0.8},
    },
    fields={
        "string_field": "value",
        "int_field": 123,
        "bool_field": True,
    },
)
```

### Query Structure

```python
# Vector query
zvec.VectorQuery(
    field_name="vector_name",
    vector=[0.1, 0.2, ...],
    param=zvec.HnswQueryParam(ef=100),
)

# Reranker
zvec.WeightedReRanker(
    topn=10,
    metric=zvec.MetricType.IP,
    weights={"vec1": 1.0, "vec2": 0.8},
)

zvec.RRFReRanker(topn=10, rank_constant=60)
```

---

## Node.js API

### Installation
```bash
npm install @zvec/zvec
```

### Global Configuration
```typescript
import { ZVecInitialize, ZVecLogType, ZVecLogLevel } from "@zvec/zvec";

// Initialize with defaults
ZVecInitialize();

// Initialize with custom settings
ZVecInitialize({
  logType: ZVecLogType.CONSOLE,       // or ZVecLogType.FILE
  logLevel: ZVecLogLevel.WARN,        // DEBUG, INFO, WARN, ERROR, FATAL
  queryThreads: 4,
  optimizeThreads: 2,
  memoryLimitMb: 2048,
});
```

### Core Imports

```typescript
import {
  ZVecInitialize,
  ZVecCollectionSchema,
  ZVecFieldSchema,
  ZVecVectorSchema,
  ZVecDataType,
  ZVecHnswIndexParams,
  ZVecMetricType,
  ZVecCreateAndOpen,
  ZVecOpen,
} from "@zvec/zvec";
```

### Data Type Enums

**Scalar Types:**
- `ZVecDataType.STRING`
- `ZVecDataType.BOOL`
- `ZVecDataType.INT32`, `INT64`, `UINT32`, `UINT64`
- `ZVecDataType.FLOAT`, `DOUBLE`

**Vector Types:**
- `ZVecDataType.VECTOR_FP16`, `VECTOR_FP32`, `VECTOR_INT8`
- `ZVecDataType.SPARSE_VECTOR_FP32`, `SPARSE_VECTOR_FP16`

**Distance Metrics:**
- `ZVecMetricType.COSINE`
- `ZVecMetricType.IP`
- `ZVecMetricType.L2`

### Index Parameters

```typescript
// HNSW
new ZVecHnswIndexParams({
  metricType: ZVecMetricType.COSINE,
  M: 16,
  efConstruction: 100,
});

// FLAT
new ZVecFlatIndexParams({ metricType: ZVecMetricType.COSINE });

// IVF
new ZVecIVFIndexParams({
  metricType: ZVecMetricType.COSINE,
  nlist: 100,
  nprobe: 10,
});

// Scalar index
new ZVecInvertIndexParams({ enableRangeOptimization: true });
```

### Collection Operations

```typescript
// Create/Open
const collection = ZVecCreateAndOpen(path, schema, option);
const collection = ZVecOpen(path, option);

// Properties
collection.path;
collection.schema;
collection.stats;
collection.option;

// Data Write
collection.upsertSync(doc);
collection.upsertSync([doc1, doc2]);  // batch
collection.updateSync({ ids, vectors, fields });

// Data Query
const doc = collection.fetchSync(id);
const results = collection.querySync({ vectors, topk, filter });

// Data Delete
collection.deleteSync({ ids });
collection.deleteByFilterSync(filter);

// Schema Modify
collection.addColumnSync({ field, expression: "default_value" });
collection.dropColumnSync(name);
collection.alterColumnSync({ oldName: "old", newName: "new" });
collection.alterColumnSync({ field: updatedField });
collection.createIndexSync({ fieldName, indexParams });
collection.dropIndexSync(fieldName);

// Maintenance
collection.optimizeSync();
collection.flushSync();
collection.destroySync();
```

### Document Structure

```typescript
interface ZVecDocInput {
  id: string;
  vectors: {
    [name: string]: number[] | { [index: number]: number };
  };
  fields: {
    [name: string]: any;
  };
}

// Example
const doc: ZVecDocInput = {
  id: "unique_id",
  vectors: {
    dense_vec: [0.1, 0.2, 0.3],
    sparse_vec: { 42: 1.25, 1337: 0.8 },
  },
  fields: {
    string_field: "value",
    int_field: 123,
    bool_field: true,
  },
};
```

### Query Structure

```typescript
// Vector query
interface ZVecQuery {
  fieldName: string;
  vector?: number[] | { [index: number]: number };
  id?: string;
  params?: ZVecHnswQueryParams | ZVecIVFQueryParams;
}

// Example
const query: ZVecQuery = {
  fieldName: "vector_name",
  vector: [0.1, 0.2, ...],
  params: new ZVecHnswQueryParams({ ef: 100 }),
};
```

---

## Filter Syntax (Common)

```
# Comparison
field == value
field != value
field > value
field >= value
field < value
field <= value

# Range
field BETWEEN min AND max

# Logical operations
condition1 AND condition2
condition1 OR condition2
NOT condition

# Array contains
'value' IN array_field

# String matching
field LIKE 'prefix%'
field LIKE '%suffix'
field LIKE '%contains%'

# Null check
field IS NULL
field IS NOT NULL
```
