# RAG System

Build a RAG (Retrieval-Augmented Generation) document retrieval system based on Zvec.

## Overview

RAG systems combine vector retrieval and LLM generation to improve answer accuracy. Zvec serves as the vector storage layer, responsible for:
- Storing document chunks and embedding vectors
- Fast retrieval of relevant documents
- Supporting semantic similarity search

## Embedding Options

Zvec provides multiple embedding functions for converting text to vectors. Choose the one that best fits your needs:

| Embedding Type | Implementation | Best For |
|----------------|----------------|----------|
| **Local Dense** | `DefaultLocalDenseEmbedding` | Offline use, 384 dimensions, ~80MB |
| **OpenAI** | `OpenAIDenseEmbedding` | High quality, cloud-based |
| **Qwen** | `QwenDenseEmbedding` | Chinese text, Dashscope API |
| **Jina** | `JinaDenseEmbedding` | Multilingual, Matryoshka support |
| **Local Sparse** | `DefaultLocalSparseEmbedding` | Lexical matching, hybrid search |
| **BM25** | `BM25EmbeddingFunction` | Keyword-based retrieval, no API key |

See [Embedding](../embedding.md) for detailed documentation on all embedding options.

## Reranker Options

Improve retrieval relevance with reranking:

| Reranker Type | Implementation | Best For |
|---------------|----------------|----------|
| **Local** | `DefaultLocalReRanker` | Offline use, Cross-Encoder model |
| **Qwen** | `QwenReRanker` | API-based reranking |
| **RRF** | `RrfReRanker` | Fusing multiple retrieval results |
| **Weighted** | `WeightedReRanker` | Weighted fusion of results |

See [Reranker](../reranker.md) for detailed documentation on all reranking options.

## Create RAG Collection

```python
schema = zvec.CollectionSchema(
    name="rag_docs",
    fields=[
        zvec.FieldSchema(name="content", data_type=zvec.DataType.STRING),
        zvec.FieldSchema(name="source", data_type=zvec.DataType.STRING),
        zvec.FieldSchema(name="chunk_id", data_type=zvec.DataType.INT32),
    ],
    vectors=[
        zvec.VectorSchema(
            name="embedding",
            data_type=zvec.DataType.VECTOR_FP32,
            dimension=1536,
            index_param=zvec.HnswIndexParam(
                metric_type=zvec.MetricType.COSINE,
                M=16,
                ef_construction=200,
            ),
        ),
    ],
)
collection = zvec.create_and_open("./rag_collection", schema)
```

## Generate Embeddings

### Option 1: Using Zvec Local Embedding (Recommended for Offline Use)

```python
from zvec.extension import DefaultLocalDenseEmbedding

# Initialize embedding function (384 dimensions, ~80MB)
embedding_func = DefaultLocalDenseEmbedding()

# For Chinese text, use ModelScope
# embedding_func = DefaultLocalDenseEmbedding(model_source="modelscope")

def get_embedding(text: str) -> list:
    return embedding_func.embed(text)
```

### Option 2: Using OpenAI API

```python
from openai import OpenAI

client = OpenAI()

def get_embedding(text: str) -> list:
    response = client.embeddings.create(
        input=text,
        model="text-embedding-3-small"
    )
    return response.data[0].embedding
```

### Option 3: Using Zvec OpenAI Embedding

```python
from zvec.extension import OpenAIDenseEmbedding

embedding_func = OpenAIDenseEmbedding(
    api_key="your-openai-api-key",
    dimension=1536,
)

def get_embedding(text: str) -> list:
    return embedding_func.embed(text)
```

### Option 4: Using Qwen Embedding (For Chinese Text)

```python
from zvec.extension import QwenDenseEmbedding

embedding_func = QwenDenseEmbedding(
    api_key="your-dashscope-api-key",
    dimension=1536,
)

def get_embedding(text: str) -> list:
    return embedding_func.embed(text)
```

## Add Documents

```python
def add_document_chunk(content: str, source: str, chunk_id: int):
    embedding = get_embedding(content)
    doc = zvec.Doc(
        id=f"{source}_{chunk_id}",
        vectors={"embedding": embedding},
        fields={
            "content": content,
            "source": source,
            "chunk_id": chunk_id,
        },
    )
    collection.upsert(doc)
```

## Retrieve Relevant Documents

### Basic Retrieval

```python
def retrieve_relevant_docs(query: str, topk: int = 5):
    query_vec = get_embedding(query)
    results = collection.query(
        vectors=zvec.VectorQuery(
            field_name="embedding",
            vector=query_vec,
        ),
        topk=topk,
        output_fields=["content", "source"],
    )
    return results
```

### Retrieval with Reranking

Improve results by reranking retrieved documents:

```python
from zvec.extension import DefaultLocalReRanker

def retrieve_and_rerank(query: str, topk: int = 5, rerank_topn: int = 3):
    # Initial retrieval: get more candidates
    query_vec = get_embedding(query)
    initial_results = collection.query(
        vectors=zvec.VectorQuery(
            field_name="embedding",
            vector=query_vec,
        ),
        topk=topk * 2,  # Retrieve more for reranking
        output_fields=["content", "source"],
    )
    
    # Prepare documents for reranking
    documents = {
        "vector1": [
            zvec.Doc(
                id=result.id,
                fields={"content": result.fields["content"], "source": result.fields["source"]},
            )
            for result in initial_results
        ]
    }
    
    # Rerank
    reranker = DefaultLocalReRanker(
        query=query,
        topn=rerank_topn,
        rerank_field="content"
    )
    reranked_docs = reranker.rerank(documents)
    
    return reranked_docs
```

## Complete Example

### Example 1: Using Local Embedding (Offline)

```python
# Complete RAG system with local embedding
import zvec
from zvec.extension import DefaultLocalDenseEmbedding

# Initialize embedding function
embedding_func = DefaultLocalDenseEmbedding()

# Create Collection (384 dimensions for local model)
schema = zvec.CollectionSchema(
    name="rag_docs",
    fields=[
        zvec.FieldSchema(name="content", data_type=zvec.DataType.STRING),
        zvec.FieldSchema(name="source", data_type=zvec.DataType.STRING),
    ],
    vectors=[
        zvec.VectorSchema(
            name="embedding",
            data_type=zvec.DataType.VECTOR_FP32,
            dimension=384,  # Local model dimension
            index_param=zvec.HnswIndexParam(
                metric_type=zvec.MetricType.COSINE,
            ),
        ),
    ],
)
collection = zvec.create_and_open("./rag_local", schema)

# Add documents
def add_doc(content: str, source: str):
    embedding = embedding_func.embed(content)
    doc = zvec.Doc(
        id=source,
        vectors={"embedding": embedding},
        fields={"content": content, "source": source},
    )
    collection.upsert(doc)

# Search
def search(query: str, topk: int = 3):
    query_vec = embedding_func.embed(query)
    return collection.query(
        vectors=zvec.VectorQuery(
            field_name="embedding", vector=query_vec
        ),
        topk=topk,
        output_fields=["content", "source"],
    )
```

### Example 2: Using OpenAI API

```python
# Complete RAG system example with OpenAI
import zvec
from openai import OpenAI

client = OpenAI()

# Create Collection
schema = zvec.CollectionSchema(
    name="rag_docs",
    fields=[
        zvec.FieldSchema(name="content", data_type=zvec.DataType.STRING),
        zvec.FieldSchema(name="source", data_type=zvec.DataType.STRING),
    ],
    vectors=[
        zvec.VectorSchema(
            name="embedding",
            data_type=zvec.DataType.VECTOR_FP32,
            dimension=1536,
            index_param=zvec.HnswIndexParam(
                metric_type=zvec.MetricType.COSINE,
            ),
        ),
    ],
)
collection = zvec.create_and_open("./rag", schema)

# Add documents
def add_doc(content: str, source: str):
    response = client.embeddings.create(
        input=content, model="text-embedding-3-small"
    )
    embedding = response.data[0].embedding
    doc = zvec.Doc(
        id=source,
        vectors={"embedding": embedding},
        fields={"content": content, "source": source},
    )
    collection.upsert(doc)

# Search
def search(query: str, topk: int = 3):
    response = client.embeddings.create(
        input=query, model="text-embedding-3-small"
    )
    query_vec = response.data[0].embedding
    return collection.query(
        vectors=zvec.VectorQuery(
            field_name="embedding", vector=query_vec
        ),
        topk=topk,
        output_fields=["content", "source"],
    )
```

### Example 3: Hybrid RAG with Dense + Sparse + Reranking

```python
# Advanced RAG with hybrid retrieval and reranking
import zvec
from zvec.extension import (
    DefaultLocalDenseEmbedding,
    DefaultLocalSparseEmbedding,
    DefaultLocalReRanker
)

# Initialize embedding functions
dense_embed = DefaultLocalDenseEmbedding()
sparse_embed = DefaultLocalSparseEmbedding(encoding_type="query")

# Create Collection with both dense and sparse vectors
schema = zvec.CollectionSchema(
    name="rag_hybrid",
    fields=[
        zvec.FieldSchema(name="content", data_type=zvec.DataType.STRING),
        zvec.FieldSchema(name="source", data_type=zvec.DataType.STRING),
    ],
    vectors=[
        zvec.VectorSchema(
            name="dense_embedding",
            data_type=zvec.DataType.VECTOR_FP32,
            dimension=384,
            index_param=zvec.HnswIndexParam(
                metric_type=zvec.MetricType.COSINE,
            ),
        ),
        zvec.VectorSchema(
            name="sparse_embedding",
            data_type=zvec.DataType.SPARSE_VECTOR_FP32,
        ),
    ],
)
collection = zvec.create_and_open("./rag_hybrid", schema)

# Add documents with both embeddings
def add_doc(content: str, source: str):
    dense_vec = dense_embed.embed(content)
    sparse_vec = sparse_embed.embed(content)
    
    doc = zvec.Doc(
        id=source,
        vectors={
            "dense_embedding": dense_vec,
            "sparse_embedding": sparse_vec,
        },
        fields={"content": content, "source": source},
    )
    collection.upsert(doc)

# Hybrid search with reranking
def search_hybrid(query: str, topk: int = 5):
    # Get query embeddings
    dense_query = dense_embed.embed(query)
    sparse_query = sparse_embed.embed(query)
    
    # Multi-vector retrieval
    results = collection.query(
        vectors=[
            zvec.VectorQuery(field_name="dense_embedding", vector=dense_query),
            zvec.VectorQuery(field_name="sparse_embedding", vector=sparse_query),
        ],
        reranker=zvec.WeightedReRanker(
            topn=topk,
            metric=zvec.MetricType.IP,
            weights={"dense_embedding": 1.0, "sparse_embedding": 0.8},
        ),
        output_fields=["content", "source"],
    )
    
    return results

# Search with additional reranking
def search_with_rerank(query: str, topk: int = 5):
    # Initial hybrid retrieval
    initial_results = search_hybrid(query, topk=topk * 2)
    
    # Prepare for reranking
    documents = {
        "vector1": [
            zvec.Doc(
                id=result.id,
                fields={"content": result.fields["content"], "source": result.fields["source"]},
            )
            for result in initial_results
        ]
    }
    
    # Rerank with cross-encoder
    reranker = DefaultLocalReRanker(
        query=query,
        topn=topk,
        rerank_field="content"
    )
    reranked = reranker.rerank(documents)
    
    return reranked
```

## Best Practices

1. **Document Chunking**: Split long documents into appropriately sized chunks (recommended 500-1000 characters)
2. **Overlap Handling**: Keep some overlap between adjacent chunks to avoid information loss
3. **Metadata Storage**: Save document source, page number, etc. for traceability
4. **Batch Operations**: Use batch insert to improve efficiency
5. **Regular Optimization**: Call `optimize()` after large batch writes
6. **Choose Right Embedding**: 
   - Use `DefaultLocalDenseEmbedding` for offline/隐私场景 (384维, ~80MB)
   - Use `OpenAIDenseEmbedding` for highest quality cloud-based embeddings
   - Use `QwenDenseEmbedding` for Chinese text optimization
   - Use `DefaultLocalSparseEmbedding` + dense for hybrid retrieval
7. **Use Reranking**: Apply `DefaultLocalReRanker` for better relevance on retrieved results
8. **Dependencies**: Install required packages: `pip install openai dashscope dashtext sentence-transformers`
