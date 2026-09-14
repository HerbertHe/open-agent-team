# Vector Search

Zvec provides powerful vector search capabilities, supporting single-vector, multi-vector, and hybrid search.

## Single Vector Search

```typescript
const singleVectorResults = collection.querySync({
  vectors: [{
    fieldName: "embedding",
    vector: new Array(768).fill(0.1),
    params: new ZVecHnswQueryParams({ ef: 100 }),
  }],
  topk: 10,
});
```

## Multi-Vector Search

```typescript
const multiVectorResults = collection.querySync({
  vectors: [
    { fieldName: "image_vec", vector: new Array(512).fill(0.1) },
    { fieldName: "text_vec", vector: new Array(768).fill(0.2) },
  ],
  topk: 50,
});
```

## Hybrid Search (Vector + Filter)

```typescript
const hybridResults = collection.querySync({
  vectors: [{
    fieldName: "embedding",
    vector: new Array(768).fill(0.1),
  }],
  filter: "price >= 100 AND price <= 500 AND in_stock == true",
  topk: 10,
});
```

## Reranking

### Weighted Reranking

```typescript
const weightedResults = collection.querySync({
  vectors: [
    { fieldName: "image_vec", vector: new Array(512).fill(0.1) },
    { fieldName: "text_vec", vector: new Array(768).fill(0.2) },
  ],
  reranker: {
    type: "weighted",
    topn: 10,
    metric: ZVecMetricType.COSINE,
    weights: { image_vec: 0.7, text_vec: 0.3 },
  },
});
```

### RRF Reranking

```typescript
const rrfResults = collection.querySync({
  vectors: [
    { fieldName: "vec1", vector: new Array(768).fill(0.1) },
    { fieldName: "vec2", vector: new Array(768).fill(0.2) },
  ],
  reranker: {
    type: "rrf",
    topn: 10,
    rankConstant: 60,
  },
});
```

## Filter Syntax

```typescript
// Comparison
"price == 100"
"price != 100"
"price > 100"
"price >= 100"
"price < 100"
"price <= 100"

// Range
"price BETWEEN 10 AND 100"

// Logical operations
"price < 100 AND category == 'book'"
"category == 'book' OR category == 'movie'"
"NOT deleted"

// Array contains
"'tag1' IN tags"

// String matching
"title LIKE 'Python%'"

// Null check
"description IS NULL"
"description IS NOT NULL"
```
