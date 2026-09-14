# Multimodal Search

Use multiple vector types (e.g., image + text) for joint search.

## Overview

Multimodal search is suitable for:
- E-commerce: search by image + text description
- Content platforms: multimodal content recommendation
- Cross-modal retrieval: image to text, text to image

## Create Multi-Vector Schema

```typescript
const multimodalSchema = new ZVecCollectionSchema({
  name: "multimodal_items",
  fields: [
    new ZVecFieldSchema({ name: "title", dataType: ZVecDataType.STRING }),
    new ZVecFieldSchema({ name: "description", dataType: ZVecDataType.STRING }),
  ],
  vectors: [
    new ZVecVectorSchema({
      name: "image_vec",
      dataType: ZVecDataType.VECTOR_FP32,
      dimension: 512,
      indexParams: new ZVecHnswIndexParams({
        metricType: ZVecMetricType.COSINE,
        M: 16,
      }),
    }),
    new ZVecVectorSchema({
      name: "text_vec",
      dataType: ZVecDataType.VECTOR_FP32,
      dimension: 768,
      indexParams: new ZVecHnswIndexParams({
        metricType: ZVecMetricType.COSINE,
        M: 16,
      }),
    }),
  ],
});
const multimodalCollection = ZVecCreateAndOpen("./multimodal", multimodalSchema);
```

## Insert Multimodal Data

```typescript
const items = [
  {
    id: "item_1",
    vectors: {
      image_vec: new Array(512).fill(0.1),
      text_vec: new Array(768).fill(0.2),
    },
    fields: {
      title: "Red Dress",
      description: "Elegant red evening dress",
    },
  },
];
multimodalCollection.upsertSync(items);
```

## Multi-Vector Search

### Image-Dominant Search

```typescript
const imageResults = multimodalCollection.querySync({
  vectors: [{ fieldName: "image_vec", vector: new Array(512).fill(0.1) }],
  topk: 10,
});
```

### Text-Dominant Search

```typescript
const textResults = multimodalCollection.querySync({
  vectors: [{ fieldName: "text_vec", vector: new Array(768).fill(0.2) }],
  topk: 10,
});
```

### Joint Search

```typescript
const jointResults = multimodalCollection.querySync({
  vectors: [
    { fieldName: "image_vec", vector: new Array(512).fill(0.1) },
    { fieldName: "text_vec", vector: new Array(768).fill(0.2) },
  ],
  reranker: {
    type: "weighted",
    topn: 10,
    metric: ZVecMetricType.COSINE,
    weights: { image_vec: 0.5, text_vec: 0.5 },
  },
});
```

## Weight Tuning

```typescript
// Image dominant
const imageWeights = { image_vec: 0.7, text_vec: 0.3 };

// Text dominant
const textWeights = { image_vec: 0.3, text_vec: 0.7 };

// Balanced
const balancedWeights = { image_vec: 0.5, text_vec: 0.5 };
```

## Complete Example

```typescript
import { ZVecCreateAndOpen, ZVecCollectionSchema, ZVecFieldSchema, ZVecVectorSchema, ZVecDataType, ZVecHnswIndexParams, ZVecMetricType } from "@zvec/zvec";

const fullMultimodalSchema = new ZVecCollectionSchema({
  name: "multimodal_items",
  fields: [
    new ZVecFieldSchema({ name: "title", dataType: ZVecDataType.STRING }),
  ],
  vectors: [
    new ZVecVectorSchema({
      name: "image_vec",
      dataType: ZVecDataType.VECTOR_FP32,
      dimension: 512,
      indexParams: new ZVecHnswIndexParams({
        metricType: ZVecMetricType.COSINE,
      }),
    }),
    new ZVecVectorSchema({
      name: "text_vec",
      dataType: ZVecDataType.VECTOR_FP32,
      dimension: 768,
      indexParams: new ZVecHnswIndexParams({
        metricType: ZVecMetricType.COSINE,
      }),
    }),
  ],
});
const fullMultimodalCollection = ZVecCreateAndOpen("./multimodal", fullMultimodalSchema);

function multimodalSearch(
  imageVector?: number[],
  textVector?: number[],
  imageWeight: number = 0.5,
  textWeight: number = 0.5,
  topn: number = 10
) {
  const vectors: Array<{ fieldName: string; vector: number[] }> = [];
  const weights: Record<string, number> = {};
  
  if (imageVector) {
    vectors.push({ fieldName: "image_vec", vector: imageVector });
    weights.image_vec = imageWeight;
  }
  
  if (textVector) {
    vectors.push({ fieldName: "text_vec", vector: textVector });
    weights.text_vec = textWeight;
  }
  
  if (vectors.length === 0) {
    throw new Error("At least one vector must be provided");
  }
  
  return fullMultimodalCollection.querySync({
    vectors,
    reranker: {
      type: "weighted",
      topn,
      metric: ZVecMetricType.COSINE,
      weights,
    },
  });
}
```
