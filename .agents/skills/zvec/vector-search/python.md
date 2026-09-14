# Vector Search

Zvec provides powerful vector search capabilities, supporting single-vector, multi-vector, and hybrid search.

## Prerequisites

To generate embeddings from text, use Zvec's embedding functions:
- See [Embedding](../embedding.md) for text-to-vector conversion options
- See [Reranker](../reranker.md) for result reranking options

## Single Vector Search

```python
results = collection.query(
    vectors=zvec.VectorQuery(
        field_name="embedding",
        vector=[0.1] * 768,
        param=zvec.HnswQueryParam(ef=100),
    ),
    topk=10,
)
```

## Multi-Vector Search

```python
results = collection.query(
    vectors=[
        zvec.VectorQuery(field_name="image_vec", vector=[0.1] * 512),
        zvec.VectorQuery(field_name="text_vec", vector=[0.2] * 768),
    ],
    topk=50,
)
```

## Hybrid Search (Vector + Filter)

```python
results = collection.query(
    vectors=zvec.VectorQuery(
        field_name="embedding",
        vector=[0.1] * 768,
    ),
    filter="price >= 100 AND price <= 500 AND in_stock == true",
    topk=10,
)
```

## Reranking

Reranking improves search relevance by re-ordering retrieval results. Zvec provides built-in rerankers and supports custom implementations.

For more reranking options, see [Reranker](../reranker.md).

### Weighted Reranking

Fuses multiple scored retrieval results according to weights.

```python
results = collection.query(
    vectors=[
        zvec.VectorQuery(field_name="image_vec", vector=[0.1] * 512),
        zvec.VectorQuery(field_name="text_vec", vector=[0.2] * 768),
    ],
    reranker=zvec.WeightedReRanker(
        topn=10,
        metric=zvec.MetricType.COSINE,
        weights={"image_vec": 0.7, "text_vec": 0.3},
    ),
)
```

### RRF Reranking

Reciprocal Rank Fusion for multi-vector retrieval results.

```python
results = collection.query(
    vectors=[
        zvec.VectorQuery(field_name="vec1", vector=[0.1] * 768),
        zvec.VectorQuery(field_name="vec2", vector=[0.2] * 768),
    ],
    reranker=zvec.RRFReRanker(
        topn=10,
        rank_constant=60,
    ),
)
```

## Filter Syntax

```python
# Comparison
"price == 100"
"price != 100"
"price > 100"
"price >= 100"
"price < 100"
"price <= 100"

# Range
"price BETWEEN 10 AND 100"

# Logical operations
"price < 100 AND category == 'book'"
"category == 'book' OR category == 'movie'"
"NOT deleted"

# Array contains
"'tag1' IN tags"

# String matching
"title LIKE 'Python%'"

# Null check
"description IS NULL"
"description IS NOT NULL"
```
