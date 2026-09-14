# Multimodal Search

Use multiple vector types (e.g., image + text) for joint search.

## Overview

Multimodal search is suitable for:
- E-commerce: search by image + text description
- Content platforms: multimodal content recommendation
- Cross-modal retrieval: image to text, text to image

## Create Multi-Vector Schema

```python
schema = zvec.CollectionSchema(
    name="multimodal_items",
    fields=[
        zvec.FieldSchema(name="title", data_type=zvec.DataType.STRING),
        zvec.FieldSchema(name="description", data_type=zvec.DataType.STRING),
    ],
    vectors=[
        zvec.VectorSchema(
            name="image_vec",
            data_type=zvec.DataType.VECTOR_FP32,
            dimension=512,
            index_param=zvec.HnswIndexParam(
                metric_type=zvec.MetricType.COSINE,
                M=16,
            ),
        ),
        zvec.VectorSchema(
            name="text_vec",
            data_type=zvec.DataType.VECTOR_FP32,
            dimension=768,
            index_param=zvec.HnswIndexParam(
                metric_type=zvec.MetricType.COSINE,
                M=16,
            ),
        ),
    ],
)
collection = zvec.create_and_open("./multimodal", schema)
```

## Insert Multimodal Data

```python
items = [
    zvec.Doc(
        id="item_1",
        vectors={
            "image_vec": [0.1] * 512,
            "text_vec": [0.2] * 768,
        },
        fields={
            "title": "Red Dress",
            "description": "Elegant red evening dress",
        },
    ),
]
collection.upsert(items)
```

## Multi-Vector Search

### Image-Dominant Search

```python
results = collection.query(
    vectors=zvec.VectorQuery(field_name="image_vec", vector=image_query),
    topk=10,
)
```

### Text-Dominant Search

```python
results = collection.query(
    vectors=zvec.VectorQuery(field_name="text_vec", vector=text_query),
    topk=10,
)
```

### Joint Search

```python
results = collection.query(
    vectors=[
        zvec.VectorQuery(field_name="image_vec", vector=image_query),
        zvec.VectorQuery(field_name="text_vec", vector=text_query),
    ],
    reranker=zvec.WeightedReRanker(
        topn=10,
        metric=zvec.MetricType.COSINE,
        weights={"image_vec": 0.5, "text_vec": 0.5},
    ),
)
```

## Weight Tuning

```python
# Image dominant
weights = {"image_vec": 0.7, "text_vec": 0.3}

# Text dominant
weights = {"image_vec": 0.3, "text_vec": 0.7}

# Balanced
weights = {"image_vec": 0.5, "text_vec": 0.5}
```

## Complete Example

```python
import zvec

schema = zvec.CollectionSchema(
    name="multimodal_items",
    fields=[
        zvec.FieldSchema(name="title", data_type=zvec.DataType.STRING),
    ],
    vectors=[
        zvec.VectorSchema(
            name="image_vec",
            data_type=zvec.DataType.VECTOR_FP32,
            dimension=512,
            index_param=zvec.HnswIndexParam(
                metric_type=zvec.MetricType.COSINE,
            ),
        ),
        zvec.VectorSchema(
            name="text_vec",
            data_type=zvec.DataType.VECTOR_FP32,
            dimension=768,
            index_param=zvec.HnswIndexParam(
                metric_type=zvec.MetricType.COSINE,
            ),
        ),
    ],
)
collection = zvec.create_and_open("./multimodal", schema)

def multimodal_search(
    image_vector: list = None,
    text_vector: list = None,
    image_weight: float = 0.5,
    text_weight: float = 0.5,
    topn: int = 10,
):
    vectors = []
    weights = {}
    
    if image_vector is not None:
        vectors.append(zvec.VectorQuery(
            field_name="image_vec", vector=image_vector
        ))
        weights["image_vec"] = image_weight
    
    if text_vector is not None:
        vectors.append(zvec.VectorQuery(
            field_name="text_vec", vector=text_vector
        ))
        weights["text_vec"] = text_weight
    
    if not vectors:
        raise ValueError("At least one vector must be provided")
    
    return collection.query(
        vectors=vectors,
        reranker=zvec.WeightedReRanker(
            topn=topn,
            metric=zvec.MetricType.COSINE,
            weights=weights,
        ),
    )
```
