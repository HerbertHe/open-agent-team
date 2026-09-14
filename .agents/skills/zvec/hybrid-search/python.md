# Hybrid Search

Combine vector similarity and structured filtering for precise search.

## Overview

Hybrid search is suitable for e-commerce, content platforms, and other scenarios:
- Vector part: understands semantics, finds similar content
- Filter part: precisely filters by price, category, status, etc.

## Create Schema with Filter Fields

```python
schema = zvec.CollectionSchema(
    name="products",
    fields=[
        zvec.FieldSchema(name="name", data_type=zvec.DataType.STRING),
        zvec.FieldSchema(name="category", data_type=zvec.DataType.STRING),
        zvec.FieldSchema(
            name="price",
            data_type=zvec.DataType.INT32,
            index_param=zvec.InvertIndexParam(enable_range_optimization=True),
        ),
        zvec.FieldSchema(
            name="in_stock",
            data_type=zvec.DataType.BOOL,
            index_param=zvec.InvertIndexParam(),
        ),
    ],
    vectors=[
        zvec.VectorSchema(
            name="description_vec",
            data_type=zvec.DataType.VECTOR_FP32,
            dimension=768,
            index_param=zvec.HnswIndexParam(
                metric_type=zvec.MetricType.COSINE,
            ),
        ),
    ],
)
collection = zvec.create_and_open("./products", schema)
```

## Hybrid Search Example

```python
results = collection.query(
    vectors=zvec.VectorQuery(
        field_name="description_vec",
        vector=query_vector,
    ),
    filter="price >= 100 AND price <= 500 AND in_stock == true",
    topk=10,
)
```

## Complex Filter Conditions

```python
# Multiple conditions
filter_str = "category == 'electronics' AND price BETWEEN 100 AND 500 AND in_stock == true"

# Using OR
filter_str = "category == 'book' OR category == 'movie'"

# Using NOT
filter_str = "NOT discontinued"

# Array contains
filter_str = "'sale' IN tags"

# String matching
filter_str = "name LIKE 'iPhone%'"
```

## Performance Optimization

1. **Create indexes for filter fields**: Use `InvertIndexParam`
2. **Range query optimization**: Enable `enable_range_optimization` for numeric range fields
3. **Set topk appropriately**: Get more candidates first, then filter

## Complete Example

```python
import zvec

schema = zvec.CollectionSchema(
    name="products",
    fields=[
        zvec.FieldSchema(name="name", data_type=zvec.DataType.STRING),
        zvec.FieldSchema(name="category", data_type=zvec.DataType.STRING),
        zvec.FieldSchema(
            name="price",
            data_type=zvec.DataType.INT32,
            index_param=zvec.InvertIndexParam(enable_range_optimization=True),
        ),
        zvec.FieldSchema(
            name="in_stock",
            data_type=zvec.DataType.BOOL,
            index_param=zvec.InvertIndexParam(),
        ),
    ],
    vectors=[
        zvec.VectorSchema(
            name="description_vec",
            data_type=zvec.DataType.VECTOR_FP32,
            dimension=768,
            index_param=zvec.HnswIndexParam(
                metric_type=zvec.MetricType.COSINE,
            ),
        ),
    ],
)
collection = zvec.create_and_open("./products", schema)

def search_products(
    query_vector: list,
    min_price: int = 0,
    max_price: int = 10000,
    in_stock_only: bool = True,
    topk: int = 10
):
    filters = [f"price >= {min_price}", f"price <= {max_price}"]
    if in_stock_only:
        filters.append("in_stock == true")
    filter_str = " AND ".join(filters)
    
    return collection.query(
        vectors=zvec.VectorQuery(
            field_name="description_vec",
            vector=query_vector,
        ),
        filter=filter_str,
        topk=topk,
    )
```
