# RAG System

Build a RAG (Retrieval-Augmented Generation) document retrieval system based on Zvec.

## Overview

RAG systems combine vector retrieval and LLM generation to improve answer accuracy. Zvec serves as the vector storage layer, responsible for:
- Storing document chunks and embedding vectors
- Fast retrieval of relevant documents
- Supporting semantic similarity search

## Create RAG Collection

```typescript
const ragSchema = new ZVecCollectionSchema({
  name: "rag_docs",
  fields: [
    new ZVecFieldSchema({ name: "content", dataType: ZVecDataType.STRING }),
    new ZVecFieldSchema({ name: "source", dataType: ZVecDataType.STRING }),
    new ZVecFieldSchema({ name: "chunk_id", dataType: ZVecDataType.INT32 }),
  ],
  vectors: [
    new ZVecVectorSchema({
      name: "embedding",
      dataType: ZVecDataType.VECTOR_FP32,
      dimension: 1536,
      indexParams: new ZVecHnswIndexParams({
        metricType: ZVecMetricType.COSINE,
        M: 16,
        efConstruction: 200,
      }),
    }),
  ],
});
const ragCollection = ZVecCreateAndOpen("./rag_collection", ragSchema);
```

## Generate Embeddings

```typescript
// Use OpenAI API to generate embeddings
async function getEmbedding(text: string): Promise<number[]> {
  const response = await fetch("https://api.openai.com/v1/embeddings", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`,
    },
    body: JSON.stringify({
      input: text,
      model: "text-embedding-3-small",
    }),
  });
  const data = await response.json();
  return data.data[0].embedding;
}
```

## Add Documents

```typescript
async function addDocumentChunk(content: string, source: string, chunkId: number) {
  const embedding = await getEmbedding(content);
  const doc = {
    id: `${source}_${chunkId}`,
    vectors: { embedding },
    fields: { content, source, chunk_id: chunkId },
  };
  ragCollection.upsertSync(doc);
}
```

## Retrieve Relevant Documents

```typescript
async function retrieveRelevantDocs(query: string, topk: number = 5) {
  const queryVec = await getEmbedding(query);
  return ragCollection.querySync({
    vectors: [{ fieldName: "embedding", vector: queryVec }],
    topk,
    outputFields: ["content", "source"],
  });
}
```

## Complete Example

```typescript
// Complete RAG system example
import { ZVecCreateAndOpen, ZVecCollectionSchema, ZVecFieldSchema, ZVecVectorSchema, ZVecDataType, ZVecHnswIndexParams, ZVecMetricType } from "@zvec/zvec";

const fullRagSchema = new ZVecCollectionSchema({
  name: "rag_docs",
  fields: [
    new ZVecFieldSchema({ name: "content", dataType: ZVecDataType.STRING }),
    new ZVecFieldSchema({ name: "source", dataType: ZVecDataType.STRING }),
  ],
  vectors: [
    new ZVecVectorSchema({
      name: "embedding",
      dataType: ZVecDataType.VECTOR_FP32,
      dimension: 1536,
      indexParams: new ZVecHnswIndexParams({
        metricType: ZVecMetricType.COSINE,
      }),
    }),
  ],
});
const fullRagCollection = ZVecCreateAndOpen("./rag", fullRagSchema);

async function addDoc(content: string, source: string) {
  const embedding = await getEmbedding(content);
  fullRagCollection.upsertSync({
    id: source,
    vectors: { embedding },
    fields: { content, source },
  });
}

async function search(query: string, topk: number = 3) {
  const queryVec = await getEmbedding(query);
  return fullRagCollection.querySync({
    vectors: [{ fieldName: "embedding", vector: queryVec }],
    topk,
    outputFields: ["content", "source"],
  });
}
```

## Best Practices

1. **Document Chunking**: Split long documents into appropriately sized chunks (recommended 500-1000 characters)
2. **Overlap Handling**: Keep some overlap between adjacent chunks to avoid information loss
3. **Metadata Storage**: Save document source, page number, etc. for traceability
4. **Batch Operations**: Use batch insert to improve efficiency
5. **Regular Optimization**: Call `optimize()` after large batch writes
