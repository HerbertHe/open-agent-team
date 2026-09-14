# Hybrid Search

Combine vector similarity and structured filtering for precise search.

## Overview

Hybrid search is suitable for e-commerce, content platforms, and other scenarios:
- Vector part: understands semantics, finds similar content
- Filter part: precisely filters by price, category, status, etc.

## Create Schema with Filter Fields

```typescript
const hybridSchema = new ZVecCollectionSchema({
  name: "products",
  fields: [
    new ZVecFieldSchema({ name: "name", dataType: ZVecDataType.STRING }),
    new ZVecFieldSchema({ name: "category", dataType: ZVecDataType.STRING }),
    new ZVecFieldSchema({
      name: "price",
      dataType: ZVecDataType.INT32,
      indexParams: new ZVecInvertIndexParams({ enableRangeOptimization: true }),
    }),
    new ZVecFieldSchema({
      name: "in_stock",
      dataType: ZVecDataType.BOOL,
      indexParams: new ZVecInvertIndexParams(),
    }),
  ],
  vectors: [
    new ZVecVectorSchema({
      name: "description_vec",
      dataType: ZVecDataType.VECTOR_FP32,
      dimension: 768,
      indexParams: new ZVecHnswIndexParams({
        metricType: ZVecMetricType.COSINE,
      }),
    }),
  ],
});
const productCollection = ZVecCreateAndOpen("./products", hybridSchema);
```

## Hybrid Search Example

```typescript
const hybridQueryResults = productCollection.querySync({
  vectors: [{
    fieldName: "description_vec",
    vector: new Array(768).fill(0.1),
  }],
  filter: "price >= 100 AND price <= 500 AND in_stock == true",
  topk: 10,
});
```

## Complex Filter Conditions

```typescript
// Multiple conditions
const complexFilter = "category == 'electronics' AND price BETWEEN 100 AND 500 AND in_stock == true";

// Using OR
const orFilter = "category == 'book' OR category == 'movie'";

// Using NOT
const notFilter = "NOT discontinued";

// Array contains
const arrayFilter = "'sale' IN tags";

// String matching
const likeFilter = "name LIKE 'iPhone%'";
```

## Performance Optimization

1. **Create indexes for filter fields**: Use `InvertIndexParam`
2. **Range query optimization**: Enable `enable_range_optimization` for numeric range fields
3. **Set topk appropriately**: Get more candidates first, then filter

## Complete Example

```typescript
import { ZVecCreateAndOpen, ZVecCollectionSchema, ZVecFieldSchema, ZVecVectorSchema, ZVecDataType, ZVecHnswIndexParams, ZVecInvertIndexParams, ZVecMetricType } from "@zvec/zvec";

const fullHybridSchema = new ZVecCollectionSchema({
  name: "products",
  fields: [
    new ZVecFieldSchema({ name: "name", dataType: ZVecDataType.STRING }),
    new ZVecFieldSchema({ name: "category", dataType: ZVecDataType.STRING }),
    new ZVecFieldSchema({
      name: "price",
      dataType: ZVecDataType.INT32,
      indexParams: new ZVecInvertIndexParams({ enableRangeOptimization: true }),
    }),
    new ZVecFieldSchema({
      name: "in_stock",
      dataType: ZVecDataType.BOOL,
      indexParams: new ZVecInvertIndexParams(),
    }),
  ],
  vectors: [
    new ZVecVectorSchema({
      name: "description_vec",
      dataType: ZVecDataType.VECTOR_FP32,
      dimension: 768,
      indexParams: new ZVecHnswIndexParams({
        metricType: ZVecMetricType.COSINE,
      }),
    }),
  ],
});
const fullProductCollection = ZVecCreateAndOpen("./products", fullHybridSchema);

function searchProducts(
  queryVector: number[],
  minPrice: number = 0,
  maxPrice: number = 10000,
  inStockOnly: boolean = true,
  topk: number = 10
) {
  const filters: string[] = [`price >= ${minPrice}`, `price <= ${maxPrice}`];
  if (inStockOnly) {
    filters.push("in_stock == true");
  }
  const filterStr = filters.join(" AND ");
  
  return fullProductCollection.querySync({
    vectors: [{
      fieldName: "description_vec",
      vector: queryVector,
    }],
    filter: filterStr,
    topk,
  });
}
```
